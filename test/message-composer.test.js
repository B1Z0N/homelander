// Unit tests for message composition: prompt assembly, draft sanitising,
// the model → fallback-model → template chain, and the HTTP provider.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  MessageComposer,
  buildPrompt,
  sanitizeDraft,
  attemptChain,
  attemptLabel,
  detectListingLanguage,
  looksLikeRefusal,
  DEFAULT_AI_PROMPT,
  PROMPT_VARIABLES,
  renderTemplate,
} from '../engine/message-composer.js';
import { createProvider, PROVIDER_IDS } from '../engine/ai-providers.js';

const LISTING = {
  title: 'Schöne 3-Zimmer-Wohnung',
  address: 'Musterstraße 42, 10115 Berlin',
  price: '1.250 €',
  _contact: { vorname: 'Max', nachname: 'Mustermann', email: 'max@example.com', einkommen: '3.500 €' },
};

const TEMPLATE = 'Hallo,\nich interessiere mich für {{title}} in {{address}}.\n{{name}}';

/** Provider stub: returns queued replies, throws queued errors. */
function stubProvider(replies) {
  const calls = [];
  let disposed = 0;
  const makeProvider = ({ attempt }) => ({
    async draft(prompt) {
      calls.push({ attempt, prompt });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error('no reply queued');
      return next;
    },
    dispose() { disposed += 1; },
  });
  return { makeProvider, calls, disposedCount: () => disposed };
}

describe('renderTemplate', () => {
  it('substitutes listing fields and the applicant name', () => {
    const out = renderTemplate(TEMPLATE, LISTING);
    assert.match(out, /Schöne 3-Zimmer-Wohnung/);
    assert.match(out, /Musterstraße 42, 10115 Berlin/);
    assert.match(out, /Max Mustermann/);
    assert.doesNotMatch(out, /\{\{/);
  });

  it('replaces missing fields with empty strings rather than crashing', () => {
    assert.equal(renderTemplate('{{title}}|{{address}}|{{name}}', {}), '||');
  });
});

describe('buildPrompt', () => {
  it('fills the built-in prompt with this listing', () => {
    const prompt = buildPrompt({ listing: LISTING, persona: LISTING._contact, template: TEMPLATE });
    assert.match(prompt, /^Ich bewerbe mich/);
    assert.match(prompt, /Titel: Schöne 3-Zimmer-Wohnung/);
    assert.match(prompt, /Vorname: Max/);
    // Template shown already filled in, so no placeholder survives.
    assert.match(prompt, /ich interessiere mich für Schöne 3-Zimmer-Wohnung/);
    assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
  });

  it('uses a custom prompt verbatim, substituting only its variables', () => {
    const prompt = buildPrompt({
      listing: LISTING,
      persona: LISTING._contact,
      template: TEMPLATE,
      prompt: 'MY PROMPT\n{{listing}}\n{{persona}}\n{{template}}\nSprache: {{language}}',
    });
    assert.match(prompt, /^MY PROMPT/);
    assert.match(prompt, /Titel: Schöne 3-Zimmer-Wohnung/);
    assert.match(prompt, /Vorname: Max/);
    assert.match(prompt, /Sprache: Deutsch/);
    assert.doesNotMatch(prompt, /Ich bewerbe mich/); // built-in text not appended
  });

  it('pins the reply language to the listing language', () => {
    const english = { title: 'Bright furnished apartment', description: 'Spacious bedroom, rent includes utilities.' };
    assert.match(buildPrompt({ listing: english, persona: {}, template: '' }), /auf English/);
    assert.match(buildPrompt({ listing: LISTING, persona: {}, template: '' }), /auf Deutsch/);
  });

  it('leaves unknown variables alone', () => {
    assert.match(buildPrompt({ listing: LISTING, prompt: 'x {{nope}} y' }), /\{\{nope\}\}/);
  });

  it('says so plainly when a section has nothing to show', () => {
    const prompt = buildPrompt({ listing: {}, persona: {}, template: '' });
    assert.match(prompt, /keinen Standardtext/);
    assert.match(prompt, /\(keine Angaben\)/);
  });

  it('omits blank fields instead of emitting empty labels', () => {
    const prompt = buildPrompt({ listing: { title: 'A', address: '' }, persona: {}, template: '' });
    assert.doesNotMatch(prompt, /Adresse:/);
  });

  it('documents every variable the built-in prompt uses', () => {
    const used = [...DEFAULT_AI_PROMPT.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    for (const name of used) assert.ok(PROMPT_VARIABLES.includes(name), `${name} not documented`);
  });
});

describe('sanitizeDraft', () => {
  const long = 'Sehr geehrte Damen und Herren, ich interessiere mich sehr für Ihre Wohnung.';

  it('accepts a normal message', () => {
    assert.deepEqual(sanitizeDraft(`  ${long}  `), { ok: true, text: long });
  });

  it('unwraps fenced code blocks', () => {
    assert.deepEqual(sanitizeDraft('```\n' + long + '\n```'), { ok: true, text: long });
    assert.deepEqual(sanitizeDraft('```text\n' + long + '\n```'), { ok: true, text: long });
  });

  it('rejects empty, too-short, and too-long responses', () => {
    assert.equal(sanitizeDraft('').ok, false);
    assert.equal(sanitizeDraft('   ').ok, false);
    assert.equal(sanitizeDraft('too short').ok, false);
    assert.equal(sanitizeDraft('x'.repeat(4001)).ok, false);
  });

  it('rejects an agent that answered us instead of drafting', () => {
    const refusal = "This looks like output from a local command (a rendered AI prompt template), not an actual request. I won't act on it. Let me know what you'd like me to do.";
    const result = sanitizeDraft(refusal);
    assert.equal(result.ok, false);
    assert.match(result.reason, /replied to us/);

    assert.equal(sanitizeDraft('Ich kann dir dabei nicht helfen, das sieht nach einem Prompt-Dump aus. Was möchtest du stattdessen?').ok, false);
    assert.equal(looksLikeRefusal('As an AI, I cannot write this message for you at all.'), true);
  });

  it('does not mistake a real message for a refusal', () => {
    const real = [
      'Sehr geehrte Damen und Herren,',
      '',
      'Ihre 3-Zimmer-Wohnung in der Musterstraße hat mich sofort angesprochen.',
      'Ich bin angestellt und würde gern zum 01.10.2026 einziehen.',
      '',
      'Viele Grüße',
      'Max Mustermann',
    ].join('\n');
    assert.equal(looksLikeRefusal(real), false);
    assert.equal(sanitizeDraft(real).ok, true);

    const english = 'Dear Sir or Madam, I would like to apply for your flat and can move in on 1 October. I am employed full time and can provide all documents. Kind regards, Max';
    assert.equal(sanitizeDraft(english).ok, true);
  });

  it('rejects a response that still has template placeholders', () => {
    const echoed = sanitizeDraft(`${long} {{title}}`);
    assert.equal(echoed.ok, false);
    assert.match(echoed.reason, /placeholder/);
  });
});

describe('attemptChain', () => {
  const acp = (primary, fallback) => ({ provider: 'acp', primary, fallback });

  it('tries primary then fallback', () => {
    const chain = attemptChain(acp(
      { harness_id: 'claude-code', command: 'claude-code-acp', model: 'opus', thought_level: 'high' },
      { harness_id: 'codex', command: 'codex-acp', model: 'gpt' },
    ));
    assert.deepEqual(chain.map((a) => a.slot), ['primary', 'fallback']);
    assert.equal(chain[0].thought_level, 'high');
    assert.equal(chain[1].harness_id, 'codex');
  });

  it('lets each slot use a different harness', () => {
    const chain = attemptChain(acp(
      { command: 'claude-code-acp', model: 'opus' },
      { command: 'codex-acp', model: 'gpt' },
    ));
    assert.deepEqual(chain.map((a) => a.command), ['claude-code-acp', 'codex-acp']);
  });

  it('skips a slot with no harness configured', () => {
    const chain = attemptChain(acp({ command: 'claude-code-acp' }, { command: '' }));
    assert.deepEqual(chain.map((a) => a.slot), ['primary']);
  });

  it('returns nothing when nothing is configured', () => {
    assert.deepEqual(attemptChain(acp({}, {})), []);
    assert.deepEqual(attemptChain({}), []);
  });

  it('drops a fallback identical to the primary', () => {
    const slot = { command: 'claude-code-acp', model: 'opus', thought_level: 'high' };
    assert.equal(attemptChain(acp({ ...slot }, { ...slot })).length, 1);
  });

  it('keeps a fallback that differs only by model or reasoning level', () => {
    assert.equal(attemptChain(acp(
      { command: 'x', model: 'opus' },
      { command: 'x', model: 'sonnet' },
    )).length, 2);
    assert.equal(attemptChain(acp(
      { command: 'x', model: 'opus', thought_level: 'high' },
      { command: 'x', model: 'opus', thought_level: 'low' },
    )).length, 2);
  });

  it('splits args given as a string', () => {
    const [attempt] = attemptChain(acp({ command: 'npx', args: '-y  pkg' }, {}));
    assert.deepEqual(attempt.args, ['-y', 'pkg']);
  });

  it('judges an HTTP provider slot by model, not command', () => {
    const chain = attemptChain({ provider: 'openai-compatible', primary: { model: 'gpt-x' }, fallback: {} });
    assert.deepEqual(chain.map((a) => a.model), ['gpt-x']);
  });

  it('labels an attempt by harness, model, and level', () => {
    assert.equal(attemptLabel({ harness_id: 'codex', model: 'gpt', thought_level: 'high' }), 'codex / gpt / high');
    assert.equal(attemptLabel({ command: 'my-agent' }), 'my-agent');
  });
});

describe('detectListingLanguage', () => {
  it('detects German listings', () => {
    assert.equal(detectListingLanguage({ title: 'Schöne 3-Zimmer-Wohnung mit Balkon', address: 'Musterstraße 42' }), 'de');
    assert.equal(detectListingLanguage({ title: 'Helle Wohnung, provisionsfrei', description: 'Die Küche ist neu.' }), 'de');
  });

  it('detects English listings', () => {
    assert.equal(detectListingLanguage({ title: 'Bright furnished apartment with balcony', description: 'Spacious bedroom, rent includes utilities.' }), 'en');
  });

  it('defaults to German when there is nothing to go on', () => {
    assert.equal(detectListingLanguage({}), 'de');
    assert.equal(detectListingLanguage({ title: '   ' }), 'de');
    assert.equal(detectListingLanguage({ title: 'Hauptstr. 5' }), 'de');
  });

  it('treats umlauts as a German signal even in a mixed title', () => {
    assert.equal(detectListingLanguage({ title: 'Apartment mit Küche und Wohnfläche' }), 'de');
  });

});

describe('MessageComposer', () => {
  const baseConfig = (ai) => ({
    message_template: TEMPLATE,
    persona: LISTING._contact,
    ai: { provider: 'acp', ...ai },
  });
  const slot = (over = {}) => ({ command: 'fake', ...over });
  const DRAFT = 'Sehr geehrte Damen und Herren, die Wohnung in Berlin passt perfekt zu uns.';

  it('uses the template when AI is disabled and never spawns a provider', async () => {
    const stub = stubProvider([]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: false, primary: slot() }),
      makeProvider: stub.makeProvider,
    });

    const result = await composer.compose(LISTING);
    assert.equal(result.source, 'template');
    assert.equal(result.text, renderTemplate(TEMPLATE, LISTING));
    assert.equal(stub.calls.length, 0);
  });

  it('uses the template when AI is enabled but nothing is configured', async () => {
    const stub = stubProvider([]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, primary: {}, fallback: {} }),
      makeProvider: stub.makeProvider,
    });

    const result = await composer.compose(LISTING);
    assert.equal(result.source, 'template');
    assert.equal(stub.calls.length, 0);
    assert.match(result.errors[0], /no attempt configured/);
  });

  it('uses the AI draft when the primary attempt succeeds', async () => {
    const stub = stubProvider([DRAFT]);
    const composer = new MessageComposer({
      config: baseConfig({
        enabled: true,
        primary: slot({ harness_id: 'claude-code', model: 'opus', thought_level: 'high' }),
        fallback: slot({ harness_id: 'codex', model: 'gpt' }),
      }),
      makeProvider: stub.makeProvider,
    });

    const result = await composer.compose(LISTING);
    assert.equal(result.source, 'ai');
    assert.equal(result.text, DRAFT);
    assert.equal(result.slot, 'primary');
    assert.equal(result.attempt, 'claude-code / opus / high');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].attempt.thought_level, 'high');
  });

  it('falls back to the second attempt, which may be a different harness', async () => {
    const stub = stubProvider([new Error('harness exited'), DRAFT]);
    const composer = new MessageComposer({
      config: baseConfig({
        enabled: true,
        primary: slot({ harness_id: 'claude-code', command: 'claude-code-acp', model: 'opus' }),
        fallback: slot({ harness_id: 'codex', command: 'codex-acp', model: 'gpt' }),
      }),
      makeProvider: stub.makeProvider,
    });

    const result = await composer.compose(LISTING);
    assert.equal(result.source, 'ai');
    assert.equal(result.slot, 'fallback');
    assert.deepEqual(stub.calls.map((c) => c.attempt.command), ['claude-code-acp', 'codex-acp']);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /claude-code \/ opus: harness exited/);
  });

  it('falls back to the template when every attempt fails', async () => {
    const stub = stubProvider([new Error('boom'), new Error('also boom')]);
    const composer = new MessageComposer({
      config: baseConfig({
        enabled: true,
        primary: slot({ model: 'opus' }),
        fallback: slot({ model: 'sonnet' }),
      }),
      makeProvider: stub.makeProvider,
    });

    const result = await composer.compose(LISTING);
    assert.equal(result.source, 'template');
    assert.equal(result.text, renderTemplate(TEMPLATE, LISTING));
    assert.equal(result.errors.length, 2);
  });

  it('falls back to the template when the AI returns an unusable draft', async () => {
    const stub = stubProvider(['ok', 'ok']); // too short to be a message
    const composer = new MessageComposer({
      config: baseConfig({
        enabled: true,
        primary: slot({ model: 'opus' }),
        fallback: slot({ model: 'sonnet' }),
      }),
      makeProvider: stub.makeProvider,
    });

    const result = await composer.compose(LISTING);
    assert.equal(result.source, 'template');
    assert.match(result.errors[0], /too short/);
  });

  it('discards a provider that failed so the next listing starts clean', async () => {
    const stub = stubProvider([new Error('boom'), new Error('boom')]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, primary: slot({ model: 'opus' }) }),
      makeProvider: stub.makeProvider,
    });

    await composer.compose(LISTING);
    await composer.compose(LISTING);
    assert.equal(stub.calls.length, 2);
    assert.ok(stub.disposedCount() >= 2);
  });

  it('reuses a healthy provider across listings', async () => {
    const stub = stubProvider([DRAFT, DRAFT]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, primary: slot({ model: 'opus' }) }),
      makeProvider: stub.makeProvider,
    });

    await composer.compose(LISTING);
    await composer.compose(LISTING);
    assert.equal(stub.disposedCount(), 0);
  });

  it('drops live providers on config hot-reload', async () => {
    const stub = stubProvider([DRAFT]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, primary: slot({ model: 'opus' }) }),
      makeProvider: stub.makeProvider,
    });

    await composer.compose(LISTING);
    composer.updateConfig(baseConfig({ enabled: true, primary: slot({ model: 'sonnet' }) }));
    assert.equal(stub.disposedCount(), 1);
  });

  it('passes the current template, persona, and language into the prompt', async () => {
    const stub = stubProvider([DRAFT]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, primary: slot({ model: 'opus' }), prompt: 'CUSTOM {{listing}} {{persona}} {{language}}' }),
      makeProvider: stub.makeProvider,
    });

    await composer.compose(LISTING);
    const { prompt } = stub.calls[0];
    assert.match(prompt, /^CUSTOM/);         // the user's prompt is used verbatim
    assert.match(prompt, /Deutsch/);         // {{language}} substituted
    assert.match(prompt, /Vorname: Max/);
    assert.match(prompt, /Schöne 3-Zimmer-Wohnung/);
  });

  it('asks for English when the listing is English', async () => {
    const stub = stubProvider([DRAFT]);
    const composer = new MessageComposer({
      config: baseConfig({ enabled: true, primary: slot({ model: 'opus' }) }),
      makeProvider: stub.makeProvider,
    });

    const english = { title: 'Bright furnished apartment', description: 'Spacious bedroom, rent includes utilities.' };
    const result = await composer.compose(english);
    assert.equal(result.language, 'en');
    assert.match(stub.calls[0].prompt, /auf English/);
  });

  it('reports the listing language even on the template path', async () => {
    const composer = new MessageComposer({ config: baseConfig({ enabled: false }) });
    assert.equal((await composer.compose(LISTING)).language, 'de');
  });
});

describe('ai-providers', () => {
  it('ships acp and an openai-compatible provider', () => {
    assert.deepEqual(PROVIDER_IDS.sort(), ['acp', 'openai-compatible']);
  });

  it('rejects an unknown provider id', () => {
    assert.throws(() => createProvider({ ai: { provider: 'nope' }, attempt: {} }), /unknown AI provider/);
  });

  it('defaults to acp', () => {
    const provider = createProvider({ ai: {}, attempt: { model: 'x' } });
    assert.equal(provider.constructor.name, 'AcpProvider');
  });

  describe('openai-compatible', () => {
    const ai = { provider: 'openai-compatible', base_url: 'https://api.example.com/v1', api_key: 'sk-test' };

    it('posts to /chat/completions and returns the message content', async () => {
      let seen = null;
      const fetchImpl = async (url, init) => {
        seen = { url, init };
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: '  Guten Tag  ' }, finish_reason: 'stop' }] }),
        };
      };
      const provider = createProvider({ ai, attempt: { model: 'gpt-x' }, fetchImpl });
      const text = await provider.draft('PROMPT');

      assert.equal(text, 'Guten Tag');
      assert.equal(seen.url, 'https://api.example.com/v1/chat/completions');
      assert.equal(seen.init.headers.authorization, 'Bearer sk-test');
      const body = JSON.parse(seen.init.body);
      assert.equal(body.model, 'gpt-x');
      assert.deepEqual(body.messages, [{ role: 'user', content: 'PROMPT' }]);
    });

    it('passes the reasoning level through as reasoning_effort', async () => {
      let seen = null;
      const fetchImpl = async (_url, init) => {
        seen = JSON.parse(init.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'hallo' } }] }) };
      };
      await createProvider({ ai, attempt: { model: 'gpt-x', thought_level: 'high' }, fetchImpl }).draft('x');
      assert.equal(seen.reasoning_effort, 'high');

      await createProvider({ ai, attempt: { model: 'gpt-x' }, fetchImpl }).draft('x');
      assert.equal(seen.reasoning_effort, undefined);
    });

    it('omits the auth header when no key is set (local models)', async () => {
      let seen = null;
      const fetchImpl = async (url, init) => {
        seen = init;
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'hallo' } }] }) };
      };
      const provider = createProvider({ ai: { ...ai, api_key: '' }, attempt: { model: 'llama' }, fetchImpl });
      await provider.draft('x');
      assert.equal(seen.headers.authorization, undefined);
    });

    it('surfaces HTTP errors', async () => {
      const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
      const provider = createProvider({ ai, attempt: { model: 'gpt-x' }, fetchImpl });
      await assert.rejects(() => provider.draft('x'), /HTTP 429.*rate limited/);
    });

    it('surfaces a content-filter block', async () => {
      const fetchImpl = async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }),
      });
      const provider = createProvider({ ai, attempt: { model: 'gpt-x' }, fetchImpl });
      await assert.rejects(() => provider.draft('x'), /content filter/);
    });

    it('requires a base_url and a model', async () => {
      await assert.rejects(
        () => createProvider({ ai: { provider: 'openai-compatible' }, attempt: { model: 'm' }, fetchImpl: async () => {} }).draft('x'),
        /base_url/
      );
      await assert.rejects(
        () => createProvider({ ai, attempt: { model: '' }, fetchImpl: async () => {} }).draft('x'),
        /no model/
      );
    });
  });
});
