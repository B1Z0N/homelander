// AI providers — vendor-agnostic seam behind MessageComposer.
//
// A provider is anything that can turn one prompt string into one message
// string. Two ship in-box:
//
//   acp                 Spawns an agent harness (claude-code-acp, codex-acp,
//                       gemini --experimental-acp, …) and talks Agent Client
//                       Protocol over stdio. Reuses whatever the user already
//                       has installed and logged in — no API key in our config.
//
//   openai-compatible   POSTs to any /chat/completions endpoint. Covers
//                       OpenAI, OpenRouter, Groq, Together, Mistral, Ollama,
//                       LM Studio, vLLM, and Anthropic's compatibility
//                       endpoint — one code path, vendor chosen by base_url.
//
// Adding a third provider means adding one entry to PROVIDERS; nothing in the
// composer, daemon, or UI needs to know about it beyond the dropdown.
//
// Providers are built from an *attempt*: one slot's harness + model + thought
// level (see message-composer.js → attemptChain). Primary and fallback are
// independent attempts, so they may use entirely different harnesses.

import { AcpClient, CONFIG_KINDS } from './acp-client.js';

const DEFAULT_TIMEOUT_MS = 90000;

function timeoutMsFor(ai) {
  const seconds = Number(ai?.timeout_seconds);
  return seconds > 0 ? seconds * 1000 : DEFAULT_TIMEOUT_MS;
}

// ── ACP provider ────────────────────────────────────────────────

class AcpProvider {
  constructor({ ai, attempt, log, spawn }) {
    this.ai = ai;
    this.attempt = attempt;
    this.log = log;
    this._spawn = spawn;
    this.client = null;
    this._sessionUsed = false;
  }

  async _connect() {
    if (this.client) return this.client;
    if (!this.attempt.command) throw new Error('no ACP harness configured');
    this.client = new AcpClient({
      command: this.attempt.command,
      args: Array.isArray(this.attempt.args) ? this.attempt.args : [],
      cwd: this.ai.cwd || process.cwd(),
      env: this.ai.env || {},
      model: this.attempt.model || '',
      thoughtLevel: this.attempt.thought_level || '',
      authMethodId: this.ai.auth_method_id || '',
      timeoutMs: timeoutMsFor(this.ai),
      log: this.log,
      spawn: this._spawn,
    });
    await this.client.connect();
    this._sessionUsed = false;
    return this.client;
  }

  async draft(prompt) {
    const client = await this._connect();
    // Each listing gets a fresh session so earlier drafts can't bias the next
    // one — without paying the process-spawn cost again.
    if (this._sessionUsed) await client.newSession();
    this._sessionUsed = true;
    const { text } = await client.prompt(prompt);
    return text;
  }

  /**
   * What this harness offers for a session: models and reasoning levels.
   * Either list may be empty — that is normal, not an error.
   */
  async listConfig() {
    const client = await this._connect();
    return {
      models: client.availableModels(),
      thoughtLevels: client.availableThoughtLevels(),
      currentModel: client.currentValueFor(CONFIG_KINDS.model),
      currentThoughtLevel: client.currentValueFor(CONFIG_KINDS.thoughtLevel),
    };
  }

  dispose() {
    try { this.client?.dispose(); } catch { /* already gone */ }
    this.client = null;
    this._sessionUsed = false;
  }
}

// ── OpenAI-compatible provider ──────────────────────────────────

class OpenAiCompatibleProvider {
  constructor({ ai, attempt, log, fetchImpl }) {
    this.ai = ai;
    this.attempt = attempt;
    this.log = log;
    this._fetch = fetchImpl || globalThis.fetch;
  }

  async draft(prompt) {
    if (!this.ai.base_url) throw new Error('no base_url configured');
    if (!this.attempt.model) throw new Error('no model configured');
    if (typeof this._fetch !== 'function') throw new Error('fetch is unavailable in this runtime');

    const url = `${String(this.ai.base_url).replace(/\/+$/, '')}/chat/completions`;
    const headers = { 'content-type': 'application/json', ...(this.ai.headers || {}) };
    // Local runtimes (Ollama, LM Studio) need no key — only send one if set.
    if (this.ai.api_key) headers.authorization = `Bearer ${this.ai.api_key}`;

    const body = {
      model: this.attempt.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: Number(this.ai.max_tokens) > 0 ? Number(this.ai.max_tokens) : 1024,
    };
    // OpenAI-compatible reasoning knob; ignored by endpoints that don't have it.
    if (this.attempt.thought_level) body.reasoning_effort = this.attempt.thought_level;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMsFor(this.ai));
    let response;
    try {
      response = await this._fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(err.name === 'AbortError' ? 'request timed out' : `request failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }

    const payload = await response.json();
    const choice = payload?.choices?.[0];
    if (choice?.finish_reason === 'content_filter') throw new Error('response blocked by content filter');
    return String(choice?.message?.content || '').trim();
  }

  /** HTTP endpoints have no ACP-style config discovery. */
  async listConfig() {
    return { models: [], thoughtLevels: [] };
  }

  dispose() {
    // Stateless — nothing to tear down.
  }
}

// ── Registry ────────────────────────────────────────────────────

const PROVIDERS = {
  acp: AcpProvider,
  'openai-compatible': OpenAiCompatibleProvider,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const DEFAULT_PROVIDER = 'acp';

/**
 * @param {object} opts
 * @param {object} opts.ai       The config.ai block (shared settings)
 * @param {object} opts.attempt  One slot: {command, args, model, thought_level}
 * @param {Function} [opts.log]
 * @param {Function} [opts.spawn]      Injectable spawn (tests, acp only)
 * @param {Function} [opts.fetchImpl]  Injectable fetch (tests, http only)
 */
export function createProvider({ ai = {}, attempt = {}, log = () => {}, spawn, fetchImpl } = {}) {
  const id = ai.provider || DEFAULT_PROVIDER;
  const Provider = PROVIDERS[id];
  if (!Provider) throw new Error(`unknown AI provider '${id}'`);
  return new Provider({ ai, attempt, log, spawn, fetchImpl });
}
