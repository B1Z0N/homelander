// AcpClient — minimal Agent Client Protocol (ACP) client.
//
// ACP is JSON-RPC 2.0 over stdio, newline-delimited: one JSON object per line
// on the agent's stdin/stdout. We act as the *client*, the spawned harness
// (claude-code-acp, gemini --experimental-acp, …) acts as the *agent*.
//
// Handshake we drive:
//   1. spawn the harness
//   2. initialize   → protocol version + agent capabilities + auth methods
//   3. authenticate → only if the agent rejects session/new with auth_required
//   4. session/new  → sessionId, and optionally configOptions (see below)
//   5. session/set_config_option → only if the agent offers a model selector
//   6. session/prompt → agent streams session/update notifications, then resolves
//
// Model and reasoning-level selection both go through ACP's *session config
// options*, not dedicated methods. An agent MAY return a `configOptions` array
// from session/new; each entry carries `options` (`{value, name, description}`)
// and `currentValue`, and a `category` giving its meaning. The two we use:
//
//   category: "model"         → which model to run
//   category: "thought_level" → reasoning/thinking depth
//
// Clients change one with `session/set_config_option`, which returns the full
// updated list. Categories are UX metadata and an open set: the spec says
// clients MUST handle missing/unknown categories gracefully, so we also fall
// back to matching the option id when a category is absent.
//
// All of this is optional — plenty of agents return only a sessionId. When
// there is no model selector, we fall back to selecting the model at spawn
// time via {{model}} substitution in the harness args/env.
//
// We declare *no* client capabilities (no fs, no terminal): the composer only
// needs one text turn, so every filesystem/terminal request from the agent is
// refused and every permission request is cancelled. That keeps a coding
// harness from touching the user's disk while drafting an IS24 message.

import { spawn as nodeSpawn } from 'node:child_process';
import { augmentedPath } from './harness-detect.js';

export const ACP_PROTOCOL_VERSION = 1;

// JSON-RPC reserved code for "method not found" — what we answer any agent
// request that would need a capability we never advertised.
const METHOD_NOT_FOUND = -32601;

class AcpError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.data = data;
  }
}

/**
 * How we recognise the two config options we care about. `category` is the
 * spec-reserved signal; the id patterns are a fallback for agents that omit it.
 */
export const CONFIG_KINDS = {
  model: { category: 'model', idPattern: /^model$/i },
  thoughtLevel: { category: 'thought_level', idPattern: /think|thought|reason|effort/i },
};

/** v1 keys a config option `id`, v2 keys it `configId` — accept either. */
function optionId(option) {
  return option?.configId || option?.id || null;
}

/** Find the model / thought-level selector in a configOptions array. */
export function findConfigOption(configOptions, kind) {
  const options = Array.isArray(configOptions) ? configOptions : [];
  return (
    options.find((o) => o?.category === kind.category) ||
    options.find((o) => !o?.category && kind.idPattern.test(optionId(o) || '')) ||
    null
  );
}

/** Agents signal "you must authenticate first" with this error code. */
function isAuthRequired(err) {
  if (!err) return false;
  if (err.code === -32000) return true;
  return /auth/i.test(String(err.message || ''));
}

/**
 * Substitute {{model}} (and any other provided vars) into a string, an array
 * of strings, or the values of a flat object. Used so a model can be selected
 * via harness CLI args or env when the agent has no session/set_model.
 */
export function substituteVars(value, vars) {
  const replaceOne = (str) =>
    String(str).replace(/\{\{(\w+)\}\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : match
    );

  if (typeof value === 'string') return replaceOne(value);
  if (Array.isArray(value)) return value.map(replaceOne);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = replaceOne(v);
    return out;
  }
  return value;
}

export class AcpClient {
  /**
   * @param {object} opts
   * @param {string} opts.command        Harness executable (e.g. 'npx')
   * @param {string[]} [opts.args]       Args; '{{model}}' is substituted
   * @param {string} [opts.cwd]          Working dir for session/new (absolute)
   * @param {object} [opts.env]          Extra env vars; values get '{{model}}'
   * @param {string} [opts.model]        Model id to request
   * @param {string} [opts.thoughtLevel] Reasoning-level option value to request
   * @param {string} [opts.authMethodId] Auth method to use if challenged
   * @param {number} [opts.timeoutMs]    Per-request timeout
   * @param {Function} [opts.log]        Logger
   * @param {Function} [opts.spawn]      Injectable spawn (tests)
   */
  constructor({
    command,
    args = [],
    cwd = process.cwd(),
    env = {},
    model = '',
    thoughtLevel = '',
    authMethodId = '',
    timeoutMs = 60000,
    log = () => {},
    spawn = nodeSpawn,
  }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.model = model;
    this.thoughtLevel = thoughtLevel;
    this.authMethodId = authMethodId;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this._spawn = spawn;

    this.child = null;
    this.sessionId = null;
    this.agentCapabilities = null;
    this.authMethods = [];
    this.protocolVersion = ACP_PROTOCOL_VERSION;
    this.modelSelection = 'none'; // none | session | spawn
    /** Raw configOptions from the last session/new or set_config_option. */
    this.configOptions = [];
    this._nextId = 1;
    this._pending = new Map();
    this._stdoutBuffer = '';
    this._stderrTail = '';
    this._chunks = [];
    this._disposed = false;
    this._exitReason = null;
  }

  // ── Process lifecycle ───────────────────────────────────────

  _launch() {
    const vars = { model: this.model };
    const args = substituteVars(this.args, vars);
    const extraEnv = substituteVars(this.env, vars);

    this.log(`ACP: spawning ${this.command} ${args.join(' ')}`);
    this.child = this._spawn(this.command, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // A packaged Electron app inherits a minimal PATH, so a bare command
      // like 'npx' or 'claude-code-acp' would not resolve without this.
      env: { ...process.env, PATH: augmentedPath(), ...extraEnv },
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      // Keep only the tail — harness stderr can be chatty and we surface it
      // only to explain a failure.
      this._stderrTail = (this._stderrTail + chunk).slice(-2000);
    });

    this.child.on('error', (err) => this._fail(new AcpError(`harness spawn failed: ${err.message}`)));
    this.child.on('exit', (code, signal) => {
      this._exitReason = signal ? `signal ${signal}` : `code ${code}`;
      if (!this._disposed) {
        this._fail(new AcpError(`harness exited (${this._exitReason})${this._stderrTail ? `: ${this._stderrTail.trim()}` : ''}`));
      }
    });
  }

  /** Reject every in-flight request — the transport is gone. */
  _fail(err) {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this._pending.clear();
  }

  // ── Wire protocol ───────────────────────────────────────────

  _onStdout(chunk) {
    this._stdoutBuffer += chunk;
    let newlineAt;
    while ((newlineAt = this._stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this._stdoutBuffer.slice(0, newlineAt).trim();
      this._stdoutBuffer = this._stdoutBuffer.slice(newlineAt + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Harnesses sometimes print banners on stdout before the JSON stream
        // starts; a non-JSON line is noise, not a protocol violation.
        continue;
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new AcpError(msg.error.message || 'agent error', { code: msg.error.code, data: msg.error.data }));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Request from the agent — must be answered
    if (msg.id !== undefined && msg.method) {
      this._handleAgentRequest(msg);
      return;
    }

    // Notification from the agent
    if (msg.method === 'session/update') {
      this._handleSessionUpdate(msg.params?.update);
    }
  }

  _handleAgentRequest(msg) {
    if (msg.method === 'session/request_permission') {
      // We want a text draft, not tool use. Cancelling tells the agent to stop
      // asking and finish the turn without the tool.
      this._send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    this._send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: METHOD_NOT_FOUND, message: `client does not support ${msg.method}` },
    });
  }

  _handleSessionUpdate(update) {
    if (!update) return;
    // Only the assistant's own message text counts — thoughts and tool output
    // must never leak into the IS24 contact form.
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      this._chunks.push(update.content.text || '');
    }
  }

  _send(payload) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  _request(method, params, timeoutMs = this.timeoutMs) {
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new AcpError(`timed out after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      // Don't let a pending ACP request hold the daemon's event loop open.
      timer.unref?.();
      this._pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  // ── Handshake ───────────────────────────────────────────────

  /** Spawn the harness and open a session. Safe to call once per client. */
  async connect() {
    if (this.child) throw new AcpError('client already connected');
    this._launch();

    const init = await this._request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    this.agentCapabilities = init?.agentCapabilities || {};
    this.authMethods = Array.isArray(init?.authMethods) ? init.authMethods : [];
    // The agent picks the version; it may negotiate down from what we asked for.
    if (Number.isInteger(init?.protocolVersion)) this.protocolVersion = init.protocolVersion;

    let session;
    try {
      session = await this._newSession();
    } catch (err) {
      if (!isAuthRequired(err) || this.authMethods.length === 0) throw err;
      const methodId = this.authMethodId || this.authMethods[0]?.id;
      this.log(`ACP: authenticating with method '${methodId}'`);
      await this._request('authenticate', { methodId });
      session = await this._newSession();
    }

    this.sessionId = session?.sessionId;
    if (!this.sessionId) throw new AcpError('agent returned no sessionId');

    await this._applySessionConfig(session);
    return { sessionId: this.sessionId, modelSelection: this.modelSelection };
  }

  _newSession() {
    return this._request('session/new', { cwd: this.cwd, mcpServers: [] });
  }

  /**
   * Open a fresh session on the already-running harness. Each listing gets its
   * own session so earlier drafts can't bias the next one, without paying the
   * process-spawn cost again.
   */
  async newSession() {
    if (!this.child) throw new AcpError('not connected');
    const session = await this._newSession();
    if (!session?.sessionId) throw new AcpError('agent returned no sessionId');
    this.sessionId = session.sessionId;
    await this._applySessionConfig(session);
    return this.sessionId;
  }

  /** Normalised choices for one config-option kind, or [] if not offered. */
  optionsFor(kind) {
    const selector = findConfigOption(this.configOptions, kind);
    return (Array.isArray(selector?.options) ? selector.options : [])
      .map((o) => ({ value: o?.value, name: o?.name || o?.value, description: o?.description || '' }))
      .filter((o) => o.value);
  }

  /** Whatever the agent currently has selected for one kind. */
  currentValueFor(kind) {
    const selector = findConfigOption(this.configOptions, kind);
    return selector?.currentValue ?? null;
  }

  /** Models this agent advertises. Empty is normal, not an error. */
  availableModels() {
    return this.optionsFor(CONFIG_KINDS.model);
  }

  /** Reasoning levels this agent advertises. Empty is normal, not an error. */
  availableThoughtLevels() {
    return this.optionsFor(CONFIG_KINDS.thoughtLevel);
  }

  /**
   * Set one config option by value.
   * @returns {Promise<boolean>} true if the agent accepted the change
   */
  async _setConfigOption(kind, value) {
    if (!value) return false;
    const selector = findConfigOption(this.configOptions, kind);
    const configId = optionId(selector);
    if (!configId) return false;
    // Only offer values the agent actually lists.
    if (!this.optionsFor(kind).some((o) => o.value === value)) return false;
    if (selector.currentValue === value) return true; // already there

    const params = { sessionId: this.sessionId, configId, value };
    // v2 tags the value kind; v1 has no such field.
    if (this.protocolVersion >= 2) params.type = 'id';

    try {
      const result = await this._request('session/set_config_option', params);
      // The agent replies with the full updated option list.
      if (Array.isArray(result?.configOptions)) this.configOptions = result.configOptions;
      return true;
    } catch (err) {
      this.log(`ACP: could not set ${configId}=${value} (${err.message})`);
      return false;
    }
  }

  /**
   * Apply the requested model and reasoning level to a fresh session.
   *
   * Model has two selection paths, in preference order:
   *   1. session/set_config_option — when the agent offers a model selector
   *      that lists the requested model
   *   2. spawn-time — the '{{model}}' substitution already applied to args/env
   */
  async _applySessionConfig(session) {
    this.configOptions = Array.isArray(session?.configOptions) ? session.configOptions : [];

    if (!this.model) {
      this.modelSelection = 'none';
    } else {
      const applied = await this._setConfigOption(CONFIG_KINDS.model, this.model);
      // Not offered, or refused — the spawn-time selection (if any) stands.
      this.modelSelection = applied ? 'session' : 'spawn';
    }

    if (this.thoughtLevel) {
      const applied = await this._setConfigOption(CONFIG_KINDS.thoughtLevel, this.thoughtLevel);
      if (!applied) this.log(`ACP: harness did not accept thought level '${this.thoughtLevel}'`);
    }
  }

  // ── Prompting ───────────────────────────────────────────────

  /**
   * Send one prompt and return the agent's full text response.
   * @returns {Promise<{text: string, stopReason: string}>}
   */
  async prompt(text) {
    if (!this.sessionId) throw new AcpError('not connected');
    this._chunks = [];
    const result = await this._request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    });
    const stopReason = result?.stopReason || 'end_turn';
    if (stopReason === 'refusal') throw new AcpError('agent refused the prompt');
    if (stopReason === 'cancelled') throw new AcpError('agent cancelled the turn');
    return { text: this._chunks.join('').trim(), stopReason };
  }

  /** Kill the harness and reject anything still in flight. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._fail(new AcpError('client disposed'));
    if (this.child) {
      try { this.child.stdin?.end(); } catch { /* already closed */ }
      try { this.child.kill(); } catch { /* already dead */ }
    }
    this.child = null;
    this.sessionId = null;
  }
}
