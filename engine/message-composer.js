// MessageComposer — turns a listing + persona + template into the text that
// goes into the IS24 contact form.
//
// Two paths:
//   AI path       — hand the listing context, persona context and the template
//                   (as the desired layout) to an AI provider (see
//                   ai-providers.js), get one message back, use it verbatim.
//   Template path — the original {{title}}/{{address}}/{{name}} substitution.
//
// The template path is always the floor: if AI is disabled, misconfigured,
// times out, refuses, or returns something that doesn't look like a message,
// the composer falls back to it rather than skipping the application.

import { createProvider } from './ai-providers.js';

const MIN_DRAFT_CHARS = 40;
const MAX_DRAFT_CHARS = 4000;

/**
 * The whole prompt, as a template the user can edit in Settings.
 *
 * Placeholders are filled in per listing:
 *   {{listing}}   facts about the flat
 *   {{persona}}   facts about the applicant
 *   {{template}}  the message template, already filled in for this listing
 *   {{language}}  the listing's language, so the reply matches it
 *
 * It is deliberately phrased as a person asking for help: a coding harness
 * treats section headers, bullet dumps and placeholders left unexpanded as
 * untrusted tool output and answers with a refusal instead of a draft.
 */
export const DEFAULT_AI_PROMPT = [
  'Ich bewerbe mich auf eine Mietwohnung auf ImmobilienScout24 und brauche den Text für das Kontaktformular.',
  '',
  'Das ist die Wohnung:',
  '{{listing}}',
  '',
  'Das bin ich:',
  '{{persona}}',
  '',
  'So schreibe ich solche Nachrichten normalerweise:',
  '{{template}}',
  '',
  'Bitte halte dich an Folgendes:',
  '- Nimm meinen bisherigen Text als Vorbild für Aufbau, Ton und Länge.',
  '- Schreib flüssig und natürlich, nicht schematisch.',
  '- Geh konkret auf die Wohnung und auf mich ein.',
  '- Erfinde nichts dazu, was nicht in meinen Angaben steht.',
  '- Höflich, sachlich, höchstens 200 Wörter.',
  '',
  'Schreib mir bitte die Nachricht an den Vermieter auf {{language}}. Antworte nur mit dem Nachrichtentext selbst — keine Einleitung, keine Erklärung, keine Rückfrage, kein Markdown.',
].join('\n');

/** Placeholders the prompt may use — shown in Settings. */
export const PROMPT_VARIABLES = ['listing', 'persona', 'template', 'language'];

// ── Listing language ────────────────────────────────────────────
//
// IS24 is a German site but plenty of listings are written in English (and a
// landlord who advertises in English generally wants to be answered in
// English). We detect from the listing text and tell the agent which language
// to write in — the AI would otherwise default to whatever its prompt is in.

const LANGUAGE_HINTS = {
  de: /\b(wohnung|zimmer|miete|kaltmiete|warmmiete|balkon|wohnfläche|stellplatz|küche|bad|altbau|neubau|etage|erdgeschoss|provisionsfrei|nebenkosten|geeignet|gelegen|befindet)\b/gi,
  en: /\b(apartment|flat|room|rent|rental|kitchen|bathroom|balcony|furnished|floor|available|located|deposit|utilities|spacious|bedroom)\b/gi,
};

export const LANGUAGE_NAMES = { de: 'Deutsch', en: 'English' };

/**
 * Guess the language a listing is written in.
 * German is the default: on a German portal an ambiguous listing (or one with
 * nothing but a street name) is far more likely German than English.
 * @returns {'de'|'en'}
 */
export function detectListingLanguage(listing = {}) {
  const text = [listing.title, listing.address, listing.description, listing.subtitle]
    .filter(Boolean).join(' ');
  if (!text.trim()) return 'de';

  const score = (rx) => (text.match(rx) || []).length;
  const de = score(LANGUAGE_HINTS.de);
  const en = score(LANGUAGE_HINTS.en);
  // Umlauts and ß are a strong German signal that survives short titles.
  const umlauts = (text.match(/[äöüßÄÖÜ]/g) || []).length;

  if (en > de + umlauts) return 'en';
  return 'de';
}

/** The original template substitution — unchanged behaviour, now shared. */
export function renderTemplate(template, listing) {
  return String(template || '')
    .replace(/\{\{title\}\}/g, listing.title || '')
    .replace(/\{\{address\}\}/g, listing.address || '')
    .replace(/\{\{name\}\}/g, [listing._contact?.vorname, listing._contact?.nachname].filter(Boolean).join(' ').trim());
}

const PERSONA_LABELS = {
  anrede: 'Anrede',
  vorname: 'Vorname',
  nachname: 'Nachname',
  email: 'E-Mail',
  telefon: 'Telefon',
  strasse: 'Straße',
  hausnummer: 'Hausnummer',
  plz: 'PLZ',
  ort: 'Ort',
  einzug: 'Einzug',
  einzug_datum: 'Einzugsdatum',
  personen: 'Personen im Haushalt',
  haustiere: 'Haustiere',
  haustiere_zusatz: 'Haustiere (Details)',
  beschaeftigung: 'Beschäftigung',
  einkommen: 'Nettoeinkommen',
  unterlagen: 'Unterlagen',
};

const LISTING_LABELS = {
  title: 'Titel',
  address: 'Adresse',
  price: 'Preis',
  size: 'Größe',
  rooms: 'Zimmer',
  url: 'Link',
};

function labelledLines(source, labels) {
  return Object.entries(labels)
    .map(([key, label]) => [label, source?.[key]])
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([label, value]) => `- ${label}: ${String(value).trim()}`);
}

/**
 * Fill the prompt template with this listing's facts.
 * @param {object} opts
 * @param {string} [opts.prompt] The user's prompt; falls back to DEFAULT_AI_PROMPT
 */
export function buildPrompt({ listing = {}, persona = {}, template = '', prompt = '', language }) {
  const lang = language || detectListingLanguage(listing);
  const listingLines = labelledLines(listing, LISTING_LABELS);
  const personaLines = labelledLines(persona, PERSONA_LABELS);
  // Render the template so the example reads as a message, not as a file.
  const example = renderTemplate(template, listing).trim();

  const values = {
    listing: listingLines.length ? listingLines.join('\n') : '- (keine Angaben)',
    persona: personaLines.length ? personaLines.join('\n') : '- (keine Angaben)',
    template: example || '(Ich habe noch keinen Standardtext.)',
    language: LANGUAGE_NAMES[lang] || LANGUAGE_NAMES.de,
  };

  return String(prompt || DEFAULT_AI_PROMPT)
    .replace(/\{\{(\w+)\}\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
    ))
    .trim();
}

/**
 * Phrases a message to a landlord would never contain, but an agent that
 * declined the task routinely does. A coding harness sometimes classifies the
 * prompt as tool output and answers with a refusal or a follow-up question;
 * that text is well-formed enough to pass every other check, so it has to be
 * caught by name or it ends up in the contact form.
 */
const REFUSAL_MARKERS = [
  /\bi (?:won'?t|will not|can'?t|cannot|am unable to)\b/i,
  /\b(?:let me know what|what would you like|how (?:can|may) i help)\b/i,
  /\blooks like (?:output|the output|a rendered)\b/i,
  /\boutput from a (?:local )?command\b/i,
  /\b(?:prompt|message) template\b/i,
  /\bsystem (?:prompt|reminder)\b/i,
  /\bas an ai\b/i,
  /\bich (?:kann|werde) (?:dir )?(?:dabei |hierbei )?nicht\b/i,
  /\bwas möchtest du\b/i,
  /\bsoll ich (?:das|dir|stattdessen)\b/i,
];

/** Does this read as the agent talking to us rather than to the landlord? */
export function looksLikeRefusal(text) {
  return REFUSAL_MARKERS.some((rx) => rx.test(text));
}

/**
 * Clean up a harness reply and decide whether it is usable as a message.
 * @returns {{ok: true, text: string} | {ok: false, reason: string}}
 */
export function sanitizeDraft(raw) {
  let text = String(raw || '').trim();
  if (!text) return { ok: false, reason: 'empty response' };

  // Harnesses habitually wrap prose in a fenced block.
  const fenced = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fenced) text = fenced[1].trim();

  if (text.length < MIN_DRAFT_CHARS) return { ok: false, reason: `response too short (${text.length} chars)` };
  if (text.length > MAX_DRAFT_CHARS) return { ok: false, reason: `response too long (${text.length} chars)` };
  // Unsubstituted placeholders mean the agent echoed the template instead of
  // writing a message.
  if (/\{\{\w+\}\}/.test(text)) return { ok: false, reason: 'response still contains template placeholders' };
  // The agent answered us instead of drafting — treat as a failed attempt.
  if (looksLikeRefusal(text)) return { ok: false, reason: 'agent replied to us instead of writing the message' };

  return { ok: true, text };
}

/** One attempt slot, normalised. */
function normaliseAttempt(slot, raw) {
  if (!raw) return null;
  return {
    slot,
    harness_id: String(raw.harness_id || '').trim(),
    command: String(raw.command || '').trim(),
    args: Array.isArray(raw.args) ? raw.args : String(raw.args || '').trim().split(/\s+/).filter(Boolean),
    model: String(raw.model || '').trim(),
    thought_level: String(raw.thought_level || '').trim(),
  };
}

/** Does this attempt have enough configured to be worth trying? */
function attemptIsUsable(attempt, provider) {
  if (!attempt) return false;
  // ACP needs a harness to spawn; an HTTP endpoint needs a model to request.
  return provider === 'acp' ? Boolean(attempt.command) : Boolean(attempt.model);
}

/**
 * Attempts to try, in order: primary, then fallback.
 *
 * Each slot carries its own harness, model, and reasoning level, so the
 * fallback can be a completely different agent — e.g. Claude Code at high
 * reasoning first, Codex second.
 */
export function attemptChain(ai = {}) {
  const provider = ai.provider || 'acp';
  const chain = [normaliseAttempt('primary', ai.primary), normaliseAttempt('fallback', ai.fallback)]
    .filter((a) => attemptIsUsable(a, provider));

  // A fallback identical to the primary would just repeat the same failure.
  const seen = new Set();
  return chain.filter((a) => {
    const key = JSON.stringify([a.command, a.args, a.model, a.thought_level]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Human-readable label for logs and the UI. */
export function attemptLabel(attempt) {
  const parts = [attempt.harness_id || attempt.command || 'harness'];
  if (attempt.model) parts.push(attempt.model);
  if (attempt.thought_level) parts.push(attempt.thought_level);
  return parts.join(' / ');
}

export class MessageComposer {
  /**
   * @param {object} opts
   * @param {object} opts.config  Full daemon config (reads .ai, .persona, .message_template)
   * @param {Function} [opts.log]
   * @param {Function} [opts.spawn]        Injectable spawn (tests, ACP provider)
   * @param {Function} [opts.fetchImpl]    Injectable fetch (tests, HTTP providers)
   * @param {Function} [opts.makeProvider] Injectable provider factory (tests)
   */
  constructor({ config, log = () => {}, spawn, fetchImpl, makeProvider } = {}) {
    this.config = config || {};
    this.log = log;
    this._spawn = spawn;
    this._fetch = fetchImpl;
    this._makeProvider = makeProvider || createProvider;
    /** @type {Map<string, object>} model → live provider */
    this._providers = new Map();
  }

  get ai() {
    return this.config.ai || {};
  }

  /** Called on config hot-reload — drops live providers (and their processes). */
  updateConfig(config) {
    this.config = config || {};
    this.disposeProviders();
  }

  disposeProviders() {
    for (const provider of this._providers.values()) {
      try { provider.dispose?.(); } catch { /* already gone */ }
    }
    this._providers.clear();
  }

  dispose() {
    this.disposeProviders();
  }

  _providerFor(attempt) {
    const key = JSON.stringify([attempt.command, attempt.args, attempt.model, attempt.thought_level]);
    const cached = this._providers.get(key);
    if (cached) return { key, provider: cached };
    const provider = this._makeProvider({
      ai: this.ai,
      attempt,
      log: this.log,
      spawn: this._spawn,
      fetchImpl: this._fetch,
    });
    this._providers.set(key, provider);
    return { key, provider };
  }

  async _draftWith(attempt, prompt) {
    const { provider } = this._providerFor(attempt);
    const text = await provider.draft(prompt);
    const clean = sanitizeDraft(text);
    if (!clean.ok) throw new Error(clean.reason);
    return clean.text;
  }

  /**
   * Compose the message for one listing.
   * @param {object} listing  Listing row; `_contact` carries the persona
   * @returns {Promise<{text, source: 'ai'|'template', attempt?, language, errors: string[]}>}
   */
  async compose(listing) {
    const template = this.config.message_template || '';
    const persona = listing?._contact || this.config.persona || {};
    const language = detectListingLanguage(listing);
    const fallback = () => renderTemplate(template, listing);

    if (!this.ai.enabled) return { text: fallback(), source: 'template', language, errors: [] };

    const chain = attemptChain(this.ai);
    if (chain.length === 0) {
      this.log('AI enabled but no harness/model configured — using the message template');
      return { text: fallback(), source: 'template', language, errors: ['no attempt configured'] };
    }

    const prompt = buildPrompt({
      listing,
      persona,
      template,
      prompt: this.ai.prompt,
      language,
    });

    const errors = [];
    for (const attempt of chain) {
      const label = attemptLabel(attempt);
      try {
        const text = await this._draftWith(attempt, prompt);
        this.log(`AI message composed (${attempt.slot}: ${label}, language: ${language})`);
        return { text, source: 'ai', attempt: label, slot: attempt.slot, language, errors };
      } catch (err) {
        errors.push(`${label}: ${err.message}`);
        this.log(`AI compose failed (${attempt.slot}: ${label}): ${err.message}`);
        // A broken provider (e.g. a dead harness process) must not be reused
        // for the next attempt.
        const key = JSON.stringify([attempt.command, attempt.args, attempt.model, attempt.thought_level]);
        const provider = this._providers.get(key);
        if (provider) {
          try { provider.dispose?.(); } catch { /* already gone */ }
          this._providers.delete(key);
        }
      }
    }

    this.log('AI compose exhausted every attempt — falling back to the message template');
    return { text: fallback(), source: 'template', language, errors };
  }
}
