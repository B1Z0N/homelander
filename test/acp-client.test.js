// Unit tests for the ACP client — handshake, streaming, model selection,
// and the refusals we owe an agent that asks for capabilities we don't have.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { AcpClient, substituteVars, ACP_PROTOCOL_VERSION, CONFIG_KINDS } from '../engine/acp-client.js';

/**
 * A fake agent process: collects what the client writes and lets the test
 * push JSON-RPC lines back.
 */
function makeFakeAgent({ onRequest } = {}) {
  const child = new EventEmitter();
  const written = [];

  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => { child.killed = true; };

  const emit = (obj) => child.stdout.emit('data', `${JSON.stringify(obj)}\n`);

  child.stdin = {
    writable: true,
    end: () => {},
    write: (line) => {
      const msg = JSON.parse(line);
      written.push(msg);
      // Reply asynchronously, like a real process would.
      setImmediate(() => onRequest?.(msg, emit));
      return true;
    },
  };

  return { child, written, emit, spawn: () => child };
}

/** Default agent: successful handshake, echoes a two-chunk message. */
function defaultAgent(overrides = {}) {
  const { sessionResult = { sessionId: 'sess-1' }, chunks = ['Sehr geehrte ', 'Damen und Herren'] } = overrides;
  const agent = makeFakeAgent({
    onRequest: (msg, emit) => {
      switch (msg.method) {
        case 'initialize':
          emit({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
          break;
        case 'session/new':
          emit({ jsonrpc: '2.0', id: msg.id, result: sessionResult });
          break;
        case 'session/set_config_option':
          // Agents reply with the COMPLETE option list, not just the one that
          // changed — mirror that so tests catch code which assumes otherwise.
          emit({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              configOptions: (sessionResult.configOptions || []).map((o) => (
                (o.configId || o.id) === msg.params.configId
                  ? { ...o, currentValue: msg.params.value }
                  : o
              )),
            },
          });
          break;
        case 'session/prompt':
          for (const text of chunks) {
            emit({
              jsonrpc: '2.0',
              method: 'session/update',
              params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
            });
          }
          emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          break;
        default:
          emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } });
      }
    },
  });
  return agent;
}

function clientFor(agent, opts = {}) {
  return new AcpClient({ command: 'fake-agent', timeoutMs: 2000, spawn: agent.spawn, ...opts });
}

describe('substituteVars', () => {
  it('substitutes into strings, arrays, and object values', () => {
    assert.equal(substituteVars('--model={{model}}', { model: 'opus' }), '--model=opus');
    assert.deepEqual(substituteVars(['-m', '{{model}}'], { model: 'opus' }), ['-m', 'opus']);
    assert.deepEqual(substituteVars({ MODEL: '{{model}}' }, { model: 'opus' }), { MODEL: 'opus' });
  });

  it('leaves unknown placeholders alone', () => {
    assert.equal(substituteVars('{{other}}', { model: 'opus' }), '{{other}}');
  });
});

describe('AcpClient handshake', () => {
  it('initializes with the current protocol version and no client capabilities', async () => {
    const agent = defaultAgent();
    const client = clientFor(agent);
    await client.connect();

    const init = agent.written.find((m) => m.method === 'initialize');
    assert.equal(init.params.protocolVersion, ACP_PROTOCOL_VERSION);
    assert.equal(init.params.clientCapabilities.fs.readTextFile, false);
    assert.equal(init.params.clientCapabilities.fs.writeTextFile, false);
    assert.equal(init.params.clientCapabilities.terminal, false);
    assert.equal(client.sessionId, 'sess-1');
    client.dispose();
  });

  it('authenticates and retries session/new when the agent demands auth', async () => {
    let sessionAttempts = 0;
    const agent = makeFakeAgent({
      onRequest: (msg, emit) => {
        if (msg.method === 'initialize') {
          emit({ jsonrpc: '2.0', id: msg.id, result: { authMethods: [{ id: 'oauth' }] } });
        } else if (msg.method === 'session/new') {
          sessionAttempts += 1;
          if (sessionAttempts === 1) {
            emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'auth_required' } });
          } else {
            emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-auth' } });
          }
        } else if (msg.method === 'authenticate') {
          emit({ jsonrpc: '2.0', id: msg.id, result: {} });
        }
      },
    });

    const client = clientFor(agent);
    await client.connect();

    const auth = agent.written.find((m) => m.method === 'authenticate');
    assert.equal(auth.params.methodId, 'oauth');
    assert.equal(sessionAttempts, 2);
    assert.equal(client.sessionId, 'sess-auth');
    client.dispose();
  });

  it('fails when the agent returns no sessionId', async () => {
    const agent = defaultAgent({ sessionResult: {} });
    const client = clientFor(agent);
    await assert.rejects(() => client.connect(), /no sessionId/);
    client.dispose();
  });
});

describe('AcpClient model selection', () => {
  const modelSelector = (currentValue = 'claude-sonnet-5') => ({
    sessionId: 'sess-1',
    configOptions: [{
      configId: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: [
        { value: 'claude-opus-5', name: 'Opus 5', description: 'Most capable' },
        { value: 'claude-sonnet-5', name: 'Sonnet 5' },
      ],
    }],
  });

  it('exposes the models the agent advertises in configOptions', async () => {
    const agent = defaultAgent({ sessionResult: modelSelector() });
    const client = clientFor(agent);
    await client.connect();

    assert.deepEqual(client.availableModels(), [
      { value: 'claude-opus-5', name: 'Opus 5', description: 'Most capable' },
      { value: 'claude-sonnet-5', name: 'Sonnet 5', description: '' },
    ]);
    assert.equal(client.currentValueFor(CONFIG_KINDS.model), 'claude-sonnet-5');
    client.dispose();
  });

  it('reports no models when the agent offers no selector', async () => {
    const agent = defaultAgent();
    const client = clientFor(agent);
    await client.connect();
    assert.deepEqual(client.availableModels(), []);
    client.dispose();
  });

  it('ignores non-model config options', async () => {
    const agent = defaultAgent({
      sessionResult: {
        sessionId: 'sess-1',
        configOptions: [{ configId: 'thinking', category: 'other', type: 'select', options: [{ value: 'on' }] }],
      },
    });
    const client = clientFor(agent);
    await client.connect();
    assert.deepEqual(client.availableModels(), []);
    client.dispose();
  });

  it('switches model via session/set_config_option', async () => {
    const agent = defaultAgent({ sessionResult: modelSelector() });
    const client = clientFor(agent, { model: 'claude-opus-5' });
    const result = await client.connect();

    const call = agent.written.find((m) => m.method === 'session/set_config_option');
    assert.equal(call.params.configId, 'model');
    assert.equal(call.params.value, 'claude-opus-5');
    assert.equal(call.params.sessionId, 'sess-1');
    assert.equal(result.modelSelection, 'session');
    assert.equal(client.currentValueFor(CONFIG_KINDS.model), 'claude-opus-5');
    client.dispose();
  });

  it('accepts the v1 `id` key as well as the v2 `configId` key', async () => {
    const session = modelSelector();
    delete session.configOptions[0].configId;
    session.configOptions[0].id = 'model';

    const agent = defaultAgent({ sessionResult: session });
    const client = clientFor(agent, { model: 'claude-opus-5' });
    await client.connect();

    assert.equal(agent.written.find((m) => m.method === 'session/set_config_option').params.configId, 'model');
    client.dispose();
  });

  it('does not send the v2 `type` field when the agent negotiated v1', async () => {
    const agent = defaultAgent({ sessionResult: modelSelector() });
    const client = clientFor(agent, { model: 'claude-opus-5' });
    await client.connect();

    const call = agent.written.find((m) => m.method === 'session/set_config_option');
    assert.equal(call.params.type, undefined);
    client.dispose();
  });

  it('skips the call when the requested model is already current', async () => {
    const agent = defaultAgent({ sessionResult: modelSelector('claude-opus-5') });
    const client = clientFor(agent, { model: 'claude-opus-5' });
    const result = await client.connect();

    assert.equal(agent.written.some((m) => m.method === 'session/set_config_option'), false);
    assert.equal(result.modelSelection, 'session');
    client.dispose();
  });

  it('falls back to spawn-time selection when the model is not offered', async () => {
    const agent = defaultAgent({ sessionResult: modelSelector() });
    const client = clientFor(agent, { model: 'some-other-model', args: ['--model', '{{model}}'] });
    const result = await client.connect();

    assert.equal(result.modelSelection, 'spawn');
    assert.equal(agent.written.some((m) => m.method === 'session/set_config_option'), false);
    client.dispose();
  });

  it('falls back to spawn-time selection when there is no selector at all', async () => {
    const agent = defaultAgent();
    const client = clientFor(agent, { model: 'claude-opus-5', args: ['--model', '{{model}}'] });
    const result = await client.connect();
    assert.equal(result.modelSelection, 'spawn');
    client.dispose();
  });

  it('treats a refused switch as non-fatal', async () => {
    const agent = makeFakeAgent({
      onRequest: (msg, emit) => {
        if (msg.method === 'initialize') emit({ jsonrpc: '2.0', id: msg.id, result: {} });
        else if (msg.method === 'session/new') emit({ jsonrpc: '2.0', id: msg.id, result: modelSelector() });
        else if (msg.method === 'session/set_config_option') {
          emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'nope' } });
        }
      },
    });
    const client = clientFor(agent, { model: 'claude-opus-5' });
    const result = await client.connect();
    assert.equal(result.modelSelection, 'spawn');
    assert.equal(client.sessionId, 'sess-1');
    client.dispose();
  });

  it('applies a thought level when the agent offers one', async () => {
    const session = {
      sessionId: 'sess-1',
      configOptions: [
        {
          configId: 'model', category: 'model', type: 'select', currentValue: 'claude-opus-5',
          options: [{ value: 'claude-opus-5', name: 'Opus 5' }],
        },
        {
          configId: 'thinking', category: 'thought_level', type: 'select', currentValue: 'low',
          options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
        },
      ],
    };
    const agent = defaultAgent({ sessionResult: session });
    const client = clientFor(agent, { model: 'claude-opus-5', thoughtLevel: 'high' });
    await client.connect();

    assert.deepEqual(client.availableThoughtLevels(), [
      { value: 'low', name: 'Low', description: '' },
      { value: 'high', name: 'High', description: '' },
    ]);
    const call = agent.written.find((m) => m.method === 'session/set_config_option' && m.params.configId === 'thinking');
    assert.equal(call.params.value, 'high');
    client.dispose();
  });

  it('recognises a thought-level option by id when category is missing', async () => {
    const agent = defaultAgent({
      sessionResult: {
        sessionId: 'sess-1',
        configOptions: [{ configId: 'reasoning_effort', type: 'select', options: [{ value: 'high', name: 'High' }] }],
      },
    });
    const client = clientFor(agent);
    await client.connect();
    assert.deepEqual(client.availableThoughtLevels().map((l) => l.value), ['high']);
    client.dispose();
  });

  it('ignores a thought level the harness does not offer', async () => {
    const agent = defaultAgent();
    const client = clientFor(agent, { thoughtLevel: 'ultra' });
    await client.connect();
    assert.equal(agent.written.some((m) => m.method === 'session/set_config_option'), false);
    assert.equal(client.sessionId, 'sess-1');
    client.dispose();
  });

  it('substitutes the model into spawn args', async () => {
    const agent = defaultAgent();
    let spawnArgs = null;
    const client = new AcpClient({
      command: 'fake-agent',
      args: ['--model', '{{model}}'],
      model: 'claude-sonnet-5',
      timeoutMs: 2000,
      spawn: (_cmd, args) => { spawnArgs = args; return agent.child; },
    });
    await client.connect();
    assert.deepEqual(spawnArgs, ['--model', 'claude-sonnet-5']);
    client.dispose();
  });
});

describe('AcpClient prompting', () => {
  it('joins agent_message_chunk updates into one message', async () => {
    const agent = defaultAgent();
    const client = clientFor(agent);
    await client.connect();

    const { text, stopReason } = await client.prompt('write a message');
    assert.equal(text, 'Sehr geehrte Damen und Herren');
    assert.equal(stopReason, 'end_turn');
    client.dispose();
  });

  it('ignores thoughts and tool output', async () => {
    const agent = makeFakeAgent({
      onRequest: (msg, emit) => {
        if (msg.method === 'initialize') emit({ jsonrpc: '2.0', id: msg.id, result: {} });
        else if (msg.method === 'session/new') emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
        else if (msg.method === 'session/prompt') {
          const push = (update) => emit({ jsonrpc: '2.0', method: 'session/update', params: { update } });
          push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
          push({ sessionUpdate: 'tool_call', title: 'read file' });
          push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hallo' } });
          emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      },
    });
    const client = clientFor(agent);
    await client.connect();
    const { text } = await client.prompt('x');
    assert.equal(text, 'Hallo');
    client.dispose();
  });

  it('rejects a refused turn', async () => {
    const agent = makeFakeAgent({
      onRequest: (msg, emit) => {
        if (msg.method === 'initialize') emit({ jsonrpc: '2.0', id: msg.id, result: {} });
        else if (msg.method === 'session/new') emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
        else if (msg.method === 'session/prompt') emit({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'refusal' } });
      },
    });
    const client = clientFor(agent);
    await client.connect();
    await assert.rejects(() => client.prompt('x'), /refused/);
    client.dispose();
  });

  it('times out when the agent never answers', async () => {
    const agent = makeFakeAgent({
      onRequest: (msg, emit) => {
        if (msg.method === 'initialize') emit({ jsonrpc: '2.0', id: msg.id, result: {} });
        else if (msg.method === 'session/new') emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
        // session/prompt: silence
      },
    });
    const client = clientFor(agent, { timeoutMs: 60 });
    await client.connect();
    await assert.rejects(() => client.prompt('x'), /timed out/);
    client.dispose();
  });

  it('rejects in-flight requests when the harness exits', async () => {
    const agent = makeFakeAgent({
      onRequest: (msg, emit) => {
        if (msg.method === 'initialize') emit({ jsonrpc: '2.0', id: msg.id, result: {} });
        else if (msg.method === 'session/new') emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
        else if (msg.method === 'session/prompt') {
          agent.child.stderr.emit('data', 'boom');
          agent.child.emit('exit', 1, null);
        }
      },
    });
    const client = clientFor(agent);
    await client.connect();
    await assert.rejects(() => client.prompt('x'), /harness exited.*boom/s);
    client.dispose();
  });

  it('survives non-JSON banner lines on stdout', async () => {
    const agent = defaultAgent();
    const client = clientFor(agent);
    agent.child.stdout.emit('data', 'starting agent v1.2.3\n');
    await client.connect();
    const { text } = await client.prompt('x');
    assert.equal(text, 'Sehr geehrte Damen und Herren');
    client.dispose();
  });

  it('reassembles messages split across stdout chunks', async () => {
    const agent = makeFakeAgent({
      onRequest: (msg, emit) => {
        if (msg.method === 'initialize') {
          const line = `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`;
          agent.child.stdout.emit('data', line.slice(0, 12));
          agent.child.stdout.emit('data', line.slice(12));
        } else if (msg.method === 'session/new') {
          emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's' } });
        }
      },
    });
    const client = clientFor(agent);
    await client.connect();
    assert.equal(client.sessionId, 's');
    client.dispose();
  });
});

describe('AcpClient agent requests', () => {
  it('cancels permission requests instead of granting tool use', async () => {
    const agent = defaultAgent();
    const client = clientFor(agent);
    await client.connect();

    agent.emit({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: {} });
    await new Promise((r) => setImmediate(r));

    const reply = agent.written.find((m) => m.id === 99);
    assert.deepEqual(reply.result, { outcome: { outcome: 'cancelled' } });
    client.dispose();
  });

  it('refuses filesystem requests it never advertised', async () => {
    const agent = defaultAgent();
    const client = clientFor(agent);
    await client.connect();

    agent.emit({ jsonrpc: '2.0', id: 42, method: 'fs/read_text_file', params: { path: '/etc/passwd' } });
    await new Promise((r) => setImmediate(r));

    const reply = agent.written.find((m) => m.id === 42);
    assert.equal(reply.error.code, -32601);
    client.dispose();
  });
});

describe('AcpClient sessions', () => {
  it('opens a fresh session per newSession() call', async () => {
    let n = 0;
    const agent = makeFakeAgent({
      onRequest: (msg, emit) => {
        if (msg.method === 'initialize') emit({ jsonrpc: '2.0', id: msg.id, result: {} });
        else if (msg.method === 'session/new') {
          n += 1;
          emit({ jsonrpc: '2.0', id: msg.id, result: { sessionId: `sess-${n}` } });
        }
      },
    });
    const client = clientFor(agent);
    await client.connect();
    assert.equal(client.sessionId, 'sess-1');
    await client.newSession();
    assert.equal(client.sessionId, 'sess-2');
    client.dispose();
  });

  it('kills the harness on dispose', async () => {
    const agent = defaultAgent();
    const client = clientFor(agent);
    await client.connect();
    client.dispose();
    assert.equal(agent.child.killed, true);
    assert.equal(client.sessionId, null);
  });
});
