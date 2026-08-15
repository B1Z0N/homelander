// SettingsTab — configuration screen for Homelander.
// Persona, Message Template, Timing, API keys.

import React, { useState, useEffect } from 'react';
import { useStore } from '../stores/appStore';
import {
  IS24_SALUTATION,
  IS24_MOVE_IN,
  IS24_PERSONS,
  IS24_PETS,
  IS24_EMPLOYMENT,
  IS24_INCOME,
  IS24_DOCUMENTS,
} from '../shared/is24FormOptions';
import { userErrorText } from '../shared/userErrors';
import { useLocale } from '../locales/LocaleContext';
import { FlagDE, FlagGB } from '../shared/Icons';

// ── Helpers ──────────────────────────────────────────────────────────

function renderPreview(template, sample, t) {
  if (!template) return <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.noTemplate', 'No template set.')}</span>;
  try {
    let result = template;
    for (const [k, v] of Object.entries(sample)) {
      result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'gi'), v || `{{${k}}}`);
    }
    return <span className="text-sm whitespace-pre-wrap">{result}</span>;
  } catch {
    return <span className="text-xs" style={{ color: 'var(--danger)' }}>{t('settings.invalidTemplate', 'Invalid template.')}</span>;
  }
}

// ── Section wrapper ─────────────────────────────────────────────────

function Section({ title, children }) {
  return (
    <section className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

// ── Main component ──────────────────────────────────────────────────

export default function SettingsTab() {
  const { t, locale, setLocale } = useLocale();
  const config = useStore((s) => s.config);
  const appVersion = useStore((s) => s.appVersion);
  const setConfig = useStore((s) => s.setConfig);

  // Local editing state
  const [personaDraft, setPersonaDraft] = useState(null);
  const [templateDraft, setTemplateDraft] = useState('');
  const [timingDraft, setTimingDraft] = useState({ speed: 'balanced', poll_interval: 10, exclude_tauschwohnungen: true });
  const [captchaDraft, setCaptchaDraft] = useState('');
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [aiDraft, setAiDraft] = useState(null);
  const [showAiKey, setShowAiKey] = useState(false);
  const [aiTest, setAiTest] = useState(null); // { busy } | { text } | { error }
  const [harnesses, setHarnesses] = useState([]);
  // Per-slot probe results: { [slot]: 'loading' | { models, thoughtLevels } }
  const [aiOptions, setAiOptions] = useState({});
  // The built-in prompt, fetched once so Reset has something to restore to.
  const [defaultPrompt, setDefaultPrompt] = useState(null);
  const [cleanupStep, setCleanupStep] = useState(null); // null | 'confirm' | 'purging'
  const [cleanupEmail, setCleanupEmail] = useState('');
  const [cleanupError, setCleanupError] = useState(null);
  const [appResetStep, setAppResetStep] = useState(null); // null | 'confirm' | 'purging'
  const [appResetEmail, setAppResetEmail] = useState('');
  const [appResetError, setAppResetError] = useState(null);
  const [supportBusy, setSupportBusy] = useState(false);
  const [feedback, setFeedback] = useState(null); // { type: 'success'|'error', msg }
  const [feedbackVisible, setFeedbackVisible] = useState(false);

  const showFeedback = (fb) => {
    setFeedback(fb);
    requestAnimationFrame(() => setFeedbackVisible(true));
    setTimeout(() => {
      setFeedbackVisible(false);
      setTimeout(() => setFeedback(null), 300);
    }, 2000);
  };

  // Initialize persona draft from config
  useEffect(() => {
    if (!config?.persona) return;
    if (personaDraft) return; // already initialized, don't overwrite user edits
    const p = config.persona;
    setPersonaDraft({
      anrede: p.anrede || '',
      vorname: p.vorname || '',
      nachname: p.nachname || '',
      email: p.email || '',
      telefon: p.telefon || '',
      strasse: p.strasse || '',
      hausnummer: p.hausnummer || '',
      plz: p.plz || '',
      ort: p.ort || '',
      einzug: p.einzug || '',
      einzug_datum: p.einzug_datum || '',
      personen: p.personen ?? '',
      haustiere: p.haustiere ?? '',
      haustiere_zusatz: p.haustiere_zusatz || '',
      beschaeftigung: p.beschaeftigung || '',
      einkommen: p.einkommen ?? '',
      unterlagen: p.unterlagen ?? '',
    });
  }, [config?.persona]);

  // Load config into local drafts on mount / config change
  useEffect(() => {
    if (!config) return;
    setTemplateDraft(config.message_template || '');
    setTimingDraft({
      speed: config.timing?.speed || 'balanced',
      poll_interval: Math.max(5, Math.round((config.polling?.interval_seconds ?? 600) / 60)),
      exclude_tauschwohnungen: config.polling?.exclude_tauschwohnungen ?? true,
    });
    setCaptchaDraft(config.captcha?.api_key || '');
    const ai = config.ai || {};
    const slot = (v = {}) => ({
      harness_id: v.harness_id || '',
      command: v.command || '',
      args: Array.isArray(v.args) ? v.args.join(' ') : (v.args || ''),
      model: v.model || '',
      thought_level: v.thought_level || '',
    });
    setAiDraft({
      enabled: Boolean(ai.enabled),
      provider: ai.provider || 'acp',
      timeout_seconds: ai.timeout_seconds ?? 90,
      prompt: ai.prompt || '',   // filled from the built-in default once fetched
      primary: slot(ai.primary),
      fallback: slot(ai.fallback),
      base_url: ai.base_url || '',
      api_key: ai.api_key || '',
    });
  }, [config]);

  // Scan for installed ACP harnesses once — a PATH scan, cheap and side-effect free.
  useEffect(() => {
    if (!window.homelander?.detectAiHarnesses) return;
    let cancelled = false;
    window.homelander.detectAiHarnesses().then((res) => {
      if (!cancelled) setHarnesses((res?.harnesses || []).filter((h) => h.detected));
    });
    window.homelander.getDefaultAiPrompt?.().then((res) => {
      if (!cancelled && res?.prompt) setDefaultPrompt(res);
    });
    return () => { cancelled = true; };
  }, []);

  const save = async (patch) => {
    if (!window.homelander) {
      showFeedback({ type: 'error', msg: userErrorText('Backend unavailable', { code: 'BACKEND_UNAVAILABLE' }, t) });
      return;
    }
    const res = await window.homelander.updateConfig(patch);
    if (res?.error) {
      showFeedback({ type: 'error', msg: userErrorText(res.userError || res, { operation: 'config:update' }, t) });
    } else {
      const fresh = await window.homelander.getConfig();
      setConfig(fresh);
      showFeedback({ type: 'success', msg: t('settings.saved', 'Saved') });
    }
  };

  // ── Persona handlers ─────────────────────────────────────────────

  const updatePersonaField = (field, value) => {
    setPersonaDraft((prev) => ({ ...prev, [field]: value }));
  };

  const savePersona = () => {
    const errors = [];
    const p = personaDraft;
    if (!p.anrede?.trim()) errors.push(t('setup.anredeRequired', 'Anrede is required'));
    if (!p.vorname?.trim()) errors.push(t('setup.vornameRequired', 'Vorname is required'));
    if (!p.nachname?.trim()) errors.push(t('setup.nachnameRequired', 'Nachname is required'));
    if (!p.email?.trim()) errors.push(t('setup.emailRequired', 'Email is required'));
    if (p.email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim())) {
      errors.push(t('setup.emailInvalid', 'Email format is invalid'));
    }
    if (!p.telefon?.trim()) errors.push(t('setup.telefonRequired', 'Telefon is required'));
    if (!p.strasse?.trim()) errors.push(t('setup.strasseRequired', 'Street is required'));
    if (!p.hausnummer?.trim()) errors.push(t('setup.hausnrRequired', 'Hausnr. is required'));
    if (!p.plz?.trim()) errors.push(t('setup.plzRequired', 'PLZ is required'));
    if (p.plz?.trim() && !/^\d{4,5}$/.test(String(p.plz).trim())) {
      errors.push(t('setup.plzDigits', 'PLZ must be 4-5 digits'));
    }
    if (!p.ort?.trim()) errors.push(t('setup.ortRequired', 'Ort is required'));
    if (!p.einzug?.trim()) errors.push(t('setup.einzugRequired', 'Einzug is required'));
    if (p.einzug === 'genaues Datum' && !p.einzug_datum?.trim()) errors.push(t('setup.einzugDatumRequired', 'Einzug Datum is required'));
    if (!p.personen?.trim()) errors.push(t('setup.personenRequired', 'Personen is required'));
    if (!p.haustiere?.trim()) errors.push(t('setup.haustiereRequired', 'Haustiere is required'));
    if (p.haustiere === 'Ja' && !p.haustiere_zusatz?.trim()) errors.push(t('setup.haustiereZusatzRequired', 'Anzahl und Tierart is required'));
    if (!p.beschaeftigung?.trim()) errors.push(t('setup.beschaeftigungRequired', 'Employment is required'));
    if (!p.einkommen?.trim()) errors.push(t('setup.einkommenRequired', 'Einkommen (netto) is required'));
    if (!p.unterlagen?.trim()) errors.push(t('setup.unterlagenRequired', 'Unterlagen is required'));
    if (errors.length > 0) {
      const msg = errors.length > 3 ? t('settings.personaFields.required') : errors.join('; ');
      showFeedback({ type: 'error', msg });
      return;
    }
    save({ persona: personaDraft });
  };

  // ── Template handlers ────────────────────────────────────────────

  const saveTemplate = () => save({ message_template: templateDraft });

  // ── AI handlers ──────────────────────────────────────────────────

  const aiPatchFromDraft = () => {
    const slot = (v) => ({
      harness_id: v.harness_id,
      command: v.command.trim(),
      // Args are edited as one line; split on whitespace (no shell quoting).
      args: v.args.trim() ? v.args.trim().split(/\s+/) : [],
      model: v.model,
      thought_level: v.thought_level,
    });
    return {
      ...aiDraft,
      primary: slot(aiDraft.primary),
      fallback: slot(aiDraft.fallback),
      timeout_seconds: Math.max(10, parseInt(aiDraft.timeout_seconds, 10) || 90),
    };
  };

  const updateAiField = (field, value) => {
    setAiDraft((prev) => ({ ...prev, [field]: value }));
    setAiTest(null);
  };

  const updateAiSlot = (slot, patch) => {
    setAiDraft((prev) => ({ ...prev, [slot]: { ...prev[slot], ...patch } }));
    setAiTest(null);
  };

  // Picking a harness clears model/thought level: the previous harness's
  // values are meaningless to the new one (Codex has no Sonnet).
  const selectHarness = (slot, harnessId) => {
    const harness = harnesses.find((h) => h.id === harnessId);
    setAiOptions((prev) => ({ ...prev, [slot]: undefined }));
    updateAiSlot(slot, {
      harness_id: harnessId,
      command: harness?.command || '',
      args: (harness?.args || []).join(' '),
      model: '',
      thought_level: '',
    });
  };

  /**
   * Ask the harness what it offers (spawns it, so it is explicit). Preselects
   * the first model when nothing valid is chosen yet.
   */
  const probeHarness = async (slot) => {
    if (!window.homelander?.probeAiHarness) return;
    setAiOptions((prev) => ({ ...prev, [slot]: 'loading' }));
    const patch = aiPatchFromDraft();
    const res = await window.homelander.probeAiHarness({ ai: patch, attempt: patch[slot] });
    const models = res?.models || [];
    const thoughtLevels = res?.thoughtLevels || [];
    setAiOptions((prev) => ({ ...prev, [slot]: { models, thoughtLevels, error: res?.error ? userErrorText(res.userError || res, { operation: 'ai:probe' }, t) : null } }));

    setAiDraft((prev) => {
      const current = prev[slot];
      const next = { ...current };
      if (models.length > 0 && !models.some((m) => m.value === current.model)) {
        next.model = res.currentModel && models.some((m) => m.value === res.currentModel)
          ? res.currentModel
          : models[0].value;
      }
      if (thoughtLevels.length > 0 && !thoughtLevels.some((l) => l.value === current.thought_level)) {
        next.thought_level = res.currentThoughtLevel && thoughtLevels.some((l) => l.value === res.currentThoughtLevel)
          ? res.currentThoughtLevel
          : thoughtLevels[0].value;
      }
      return { ...prev, [slot]: next };
    });
  };

  const resetAiPrompt = () => {
    if (defaultPrompt?.prompt) updateAiField('prompt', defaultPrompt.prompt);
  };

  const saveAi = () => save({ ai: aiPatchFromDraft() });

  const testAi = async () => {
    if (!window.homelander?.testAiMessage) {
      setAiTest({ error: userErrorText('Backend unavailable', { code: 'BACKEND_UNAVAILABLE' }, t) });
      return;
    }
    setAiTest({ busy: true });
    const res = await window.homelander.testAiMessage({ ai: aiPatchFromDraft() });
    if (res?.ok) setAiTest({ text: res.text, attempt: res.attempt, language: res.language });
    else setAiTest({ error: userErrorText(res?.userError || res, { operation: 'ai:test' }, t) });
  };

  // ── Timing handlers ──────────────────────────────────────────────
  // ── Timing handlers ──────────────────────────────────────────────
  const updateTimingField = (field, value) => {
    setTimingDraft((prev) => ({ ...prev, [field]: value }));
  };

  const saveTiming = () => {
    const mins = parseInt(timingDraft.poll_interval) || 10;
    const clamped = Math.max(5, mins);
    const seconds = clamped * 60;
    save({
      timing: { ...config?.timing, speed: timingDraft.speed },
      polling: {
        ...config?.polling,
        interval_seconds: seconds,
        exclude_tauschwohnungen: timingDraft.exclude_tauschwohnungen,
      },
    });
  };

  // ── Captcha handler ─────────────────────────────────────────────

  const saveCaptcha = () => save({ captcha: { api_key: captchaDraft } });

  const handleExportSupportBundle = async () => {
    if (!window.homelander?.createSupportBundle) {
      showFeedback({ type: 'error', msg: 'Support bundle unavailable' });
      return;
    }
    setSupportBusy(true);
    try {
      const res = await window.homelander.createSupportBundle({ scope: 'global' });
      if (res?.ok) showFeedback({ type: 'success', msg: `Bundle exported — path copied` });
      else showFeedback({ type: 'error', msg: userErrorText(res?.userError || res || 'Bundle export failed', { operation: 'support bundle' }, t) });
    } catch (err) {
      showFeedback({ type: 'error', msg: userErrorText(err, { operation: 'support bundle' }, t) });
    } finally {
      setSupportBusy(false);
    }
  };

  // ── Clean All Data ──────────────────────────────────────────────

  const handleCleanData = () => {
    setCleanupStep('confirm');
    setCleanupEmail('');
    setCleanupError(null);
  };

  const handleCancelClean = () => {
    setCleanupStep(null);
    setCleanupEmail('');
    setCleanupError(null);
  };

  const handleConfirmClean = async () => {
    if (!cleanupEmail.trim()) {
      setCleanupError(t('settings.cleanup.emailRequired', 'Enter your email to confirm.'));
      return;
    }
    setCleanupStep('purging');
    setCleanupError(null);
    if (window.homelander?.cleanData) {
      const res = await window.homelander.cleanData(cleanupEmail.trim());
      if (res?.error) {
        setCleanupStep('confirm');
        setCleanupError(userErrorText(res.userError || res, { operation: 'data cleanup' }, t));
      }
      // On success, app relaunches — no state update needed
    }
  };

  // ── Reset Applications Only ────────────────────────────────────

  const handleResetApps = () => {
    setAppResetStep('confirm');
    setAppResetEmail('');
    setAppResetError(null);
  };

  const handleCancelResetApps = () => {
    setAppResetStep(null);
    setAppResetEmail('');
    setAppResetError(null);
  };

  const handleConfirmResetApps = async () => {
    if (!appResetEmail.trim()) {
      setAppResetError(t('settings.resetApps.emailRequired', 'Enter your email to confirm.'));
      return;
    }
    setAppResetStep('purging');
    setAppResetError(null);
    if (window.homelander?.resetApplications) {
      const res = await window.homelander.resetApplications(appResetEmail.trim());
      if (res?.error) {
        setAppResetStep('confirm');
        setAppResetError(userErrorText(res.userError || res, { operation: 'app data reset' }, t));
      }
      // On success, app relaunches — no state update needed
    }
  };

  // ── Guard ────────────────────────────────────────────────────────

  if (!config) {
    return (
      <div className="py-12 text-center" style={{ color: 'var(--text-muted)' }}>
        <p className="text-sm">{t('settings.loadingConfig', 'Loading configuration…')}</p>
      </div>
    );
  }

  const persona = config.persona || {};
  const templateRows = Math.max(6, (templateDraft.match(/\n/g)?.length || 0) + 2);

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-4 pb-8">

      {/* Feedback toast — fixed overlay, always visible */}
      {feedback && (
        <div
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-lg text-xs font-medium shadow-lg"
          style={{
            background: feedback.type === 'success' ? 'rgba(34,197,94,0.85)' : 'rgba(239,68,68,0.85)',
            color: '#fff',
            opacity: feedbackVisible ? 1 : 0,
            transition: 'opacity 0.3s ease',
          }}
        >
          {feedback.msg}
        </div>
      )}

      {/* ── 1. Persona ──────────────────────────────────────────── */}
      <Section title={t("settings.persona")}>
        {personaDraft ? (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.anrede")}</label>
                <select className="select text-sm" value={personaDraft.anrede} onChange={(e) => updatePersonaField('anrede', e.target.value)}>
                  <option value="">-</option>
                  {IS24_SALUTATION.filter(Boolean).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.vorname")}</label>
                <input className="input text-sm" value={personaDraft.vorname} onChange={(e) => updatePersonaField('vorname', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.nachname")}</label>
                <input className="input text-sm" value={personaDraft.nachname} onChange={(e) => updatePersonaField('nachname', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.email")}</label>
                <input className="input text-sm" type="email" value={personaDraft.email} onChange={(e) => updatePersonaField('email', e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.telefon")}</label>
                <input className="input text-sm" value={personaDraft.telefon} onChange={(e) => updatePersonaField('telefon', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.strasse")}</label>
                <input className="input text-sm" value={personaDraft.strasse} onChange={(e) => updatePersonaField('strasse', e.target.value)} />
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.hausnr")}</label>
                <input className="input text-sm" value={personaDraft.hausnummer} onChange={(e) => updatePersonaField('hausnummer', e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.plz")}</label>
                  <input className="input text-sm" value={personaDraft.plz} onChange={(e) => updatePersonaField('plz', e.target.value)} />
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.ort")}</label>
                  <input className="input text-sm" value={personaDraft.ort} onChange={(e) => updatePersonaField('ort', e.target.value)} />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.einzug")}</label>
                <select className="select text-sm" value={personaDraft.einzug} onChange={(e) => updatePersonaField('einzug', e.target.value)}>
                  {IS24_MOVE_IN.filter(Boolean).map((o) => <option key={o} value={o}>{o}</option>)}
                  <option value="">—</option>
                </select>
                {personaDraft.einzug === 'genaues Datum' && (
                  <input
                    className="input mt-2 text-sm"
                    type="date"
                    value={personaDraft.einzug_datum || ''}
                    onChange={(e) => updatePersonaField('einzug_datum', e.target.value)}
                  />
                )}
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.personen")}</label>
                <select className="select text-sm" value={personaDraft.personen} onChange={(e) => updatePersonaField('personen', e.target.value)}>
                  {IS24_PERSONS.map((o) => <option key={o} value={o}>{o || '-'}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.haustiere")}</label>
                <select className="select text-sm" value={personaDraft.haustiere} onChange={(e) => updatePersonaField('haustiere', e.target.value)}>
                  {IS24_PETS.map((o) => <option key={o} value={o}>{o || '-'}</option>)}
                </select>
                {personaDraft.haustiere === 'Ja' && (
                  <input
                    className="input mt-2 text-sm"
                    type="text"
                    placeholder={t("settings.personaFields.haustiereZusatz")}
                    value={personaDraft.haustiere_zusatz}
                    onChange={(e) => updatePersonaField('haustiere_zusatz', e.target.value)}
                  />
                )}
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.beschaeftigung")}</label>
                <select className="select text-sm" value={personaDraft.beschaeftigung} onChange={(e) => updatePersonaField('beschaeftigung', e.target.value)}>
                  {IS24_EMPLOYMENT.map((o) => <option key={o} value={o}>{o || '-'}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.einkommen")}</label>
                <select className="select text-sm" value={personaDraft.einkommen} onChange={(e) => updatePersonaField('einkommen', e.target.value)}>
                  {IS24_INCOME.map((o) => <option key={o} value={o}>{o || '-'}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t("settings.personaFields.unterlagen")}</label>
                <select className="select text-sm" value={personaDraft.unterlagen} onChange={(e) => updatePersonaField('unterlagen', e.target.value)}>
                  {IS24_DOCUMENTS.map((o) => <option key={o} value={o}>{o || '-'}</option>)}
                </select>
              </div>
            </div>
            <div className="pt-1">
              <button className="btn btn-primary text-xs" onClick={savePersona}>
                {t('settings.save', 'Save')}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('settings.loadingPersona', 'Loading persona…')}</p>
        )}
      </Section>

      {/* ── 2. Message Template ──────────────────────────────────── */}
      <Section title={t("settings.messageTemplate")}>
        <textarea
          className="input resize-y text-sm font-mono leading-6"
          rows={templateRows}
          value={templateDraft}
          onChange={(e) => setTemplateDraft(e.target.value)}
          placeholder={"Sehr geehrte Damen und Herren,\nich interessiere mich für {{title}} in {{address}}...\n\nMit freundlichen Grüßen\n{{name}}"}
        />
        <div className="mt-2 flex gap-2 items-center mb-2">
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Variables:</span>
          <code className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }}>{'{{title}}'}</code>
          <code className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }}>{'{{address}}'}</code>
          <code className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }}>{'{{name}}'}</code>
        </div>
        <div className="mt-3 p-3 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>{t('settings.livePreview', 'Live preview:')}</p>
          {renderPreview(templateDraft, {
            title: 'Schöne 3-Zimmer-Wohnung',
            address: 'Musterstraße 42, 10115 Berlin',
            name: [persona.vorname, persona.nachname].filter(Boolean).join(' ') || 'Max Mustermann',
          }, t)}
        </div>
        <div className="pt-3">
          <button className="btn btn-primary text-xs" onClick={saveTemplate}>
            {t('settings.save', 'Save')}
          </button>
        </div>
      </Section>

      {/* ── 2b. AI message composition ───────────────────────────── */}
      <Section title={t('settings.ai.title')}>
        {aiDraft ? (
          <div className="space-y-3">
            <div>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={aiDraft.enabled}
                  onChange={(e) => updateAiField('enabled', e.target.checked)}
                  className="cursor-pointer"
                />
                {t('settings.ai.enable')}
              </label>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.enableDesc')}</p>
            </div>

            {aiDraft.enabled && (
              <>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.provider')}</label>
                    <select
                      className="select text-sm w-full"
                      value={aiDraft.provider}
                      onChange={(e) => updateAiField('provider', e.target.value)}
                    >
                      <option value="acp">{t('settings.ai.providerAcp')}</option>
                      <option value="openai-compatible">{t('settings.ai.providerOpenAi')}</option>
                    </select>
                  </div>
                  <div style={{ width: '9rem' }}>
                    <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.timeout')}</label>
                    <input
                      className="input text-sm w-full"
                      type="number"
                      min="10"
                      value={aiDraft.timeout_seconds}
                      onChange={(e) => updateAiField('timeout_seconds', e.target.value)}
                    />
                  </div>
                </div>

                {aiDraft.provider === 'openai-compatible' && (
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.baseUrl')}</label>
                      <input
                        className="input text-sm w-full font-mono"
                        value={aiDraft.base_url}
                        onChange={(e) => updateAiField('base_url', e.target.value)}
                        placeholder="https://api.openai.com/v1"
                      />
                    </div>
                    <div>
                      <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.apiKey')}</label>
                      <input
                        className="input text-sm w-full font-mono"
                        type={showAiKey ? 'text' : 'password'}
                        value={aiDraft.api_key}
                        onChange={(e) => updateAiField('api_key', e.target.value)}
                        placeholder={t('settings.ai.apiKeyPlaceholder')}
                      />
                      <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer text-xs" style={{ color: 'var(--text-muted)' }}>
                        <input type="checkbox" checked={showAiKey} onChange={(e) => setShowAiKey(e.target.checked)} />
                        {t('settings.showKey')}
                      </label>
                    </div>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.openAiDesc')}</p>
                  </div>
                )}

                {/* Primary and fallback: each its own harness + model + reasoning level */}
                <div className="flex gap-4">
                  {[
                    { slot: 'primary', label: t('settings.ai.slotPrimary') },
                    { slot: 'fallback', label: t('settings.ai.slotFallback') },
                  ].map(({ slot, label }) => {
                    const draft = aiDraft[slot];
                    const probe = aiOptions[slot];
                    const models = probe && probe !== 'loading' ? probe.models : [];
                    const levels = probe && probe !== 'loading' ? probe.thoughtLevels : [];
                    const isAcp = aiDraft.provider === 'acp';
                    return (
                      <div className="flex-1 space-y-2" key={slot}>
                        <p className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>{label}</p>

                        {isAcp && (
                          <div>
                            <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.harness')}</label>
                            <select
                              className="select text-sm w-full"
                              value={draft.harness_id}
                              onChange={(e) => selectHarness(slot, e.target.value)}
                            >
                              <option value="">{slot === 'fallback' ? t('settings.ai.harnessNoneOption') : t('settings.ai.harnessChoose')}</option>
                              {harnesses.map((h) => (
                                <option key={h.id} value={h.id}>{h.label}</option>
                              ))}
                            </select>
                          </div>
                        )}

                        <div>
                          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.model')}</label>
                          {models.length > 0 ? (
                            <select
                              className="select text-sm w-full"
                              value={draft.model}
                              onChange={(e) => updateAiSlot(slot, { model: e.target.value })}
                            >
                              {models.map((m) => (
                                <option key={m.value} value={m.value}>{m.name}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              className="input text-sm w-full font-mono"
                              value={draft.model}
                              onChange={(e) => updateAiSlot(slot, { model: e.target.value })}
                              placeholder={t('settings.ai.modelPlaceholder')}
                            />
                          )}
                        </div>

                        <div>
                          <label className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.thoughtLevel')}</label>
                          <select
                            className="select text-sm w-full"
                            value={draft.thought_level}
                            onChange={(e) => updateAiSlot(slot, { thought_level: e.target.value })}
                            disabled={levels.length === 0}
                          >
                            {/* The harness's own list only — it already ships
                                whatever default entry it wants to offer. */}
                            {levels.map((l) => (
                              <option key={l.value} value={l.value}>{l.name}</option>
                            ))}
                          </select>
                        </div>

                        {isAcp && draft.command && (
                          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {probe === 'loading' ? (
                              <span>{t('settings.ai.modelsLoading')}</span>
                            ) : probe && models.length === 0 ? (
                              <span>{probe.error || t('settings.ai.modelsNone')}</span>
                            ) : (
                              <button className="btn btn-ghost text-xs" onClick={() => probeHarness(slot)}>
                                {t('settings.ai.modelsLoad')}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {aiDraft.provider === 'acp' && (
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {harnesses.length === 0 ? t('settings.ai.harnessNone') : t('settings.ai.acpDesc')}
                  </p>
                )}

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.prompt')}</label>
                    <button
                      className="btn btn-ghost text-xs"
                      onClick={resetAiPrompt}
                      disabled={!defaultPrompt || aiDraft.prompt === defaultPrompt.prompt}
                    >
                      {t('settings.ai.promptReset')}
                    </button>
                  </div>
                  <textarea
                    className="input resize-y text-sm font-mono leading-6"
                    rows={16}
                    value={aiDraft.prompt || defaultPrompt?.prompt || ''}
                    onChange={(e) => updateAiField('prompt', e.target.value)}
                  />
                  <div className="mt-2 flex gap-2 items-center flex-wrap">
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.promptVariables')}</span>
                    {(defaultPrompt?.variables || []).map((v) => (
                      <code
                        key={v}
                        className="text-xs px-1.5 py-0.5 rounded"
                        style={{ background: 'var(--bg-secondary)', color: 'var(--accent)' }}
                      >
                        {`{{${v}}}`}
                      </code>
                    ))}
                  </div>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.promptDesc')}</p>
                </div>

                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.languageNote')}</p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.fallbackNote')}</p>

                {aiTest && (
                  <div className="p-3 rounded-lg" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                    {aiTest.busy && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.testing')}</p>}
                    {aiTest.error && <p className="text-xs" style={{ color: 'var(--danger)' }}>{aiTest.error}</p>}
                    {aiTest.text && (
                      <>
                        <p className="text-xs mb-1.5" style={{ color: 'var(--text-muted)' }}>{t('settings.ai.testResult')}</p>
                        <span className="text-sm whitespace-pre-wrap">{aiTest.text}</span>
                      </>
                    )}
                  </div>
                )}
              </>
            )}

            <div className="pt-1 flex gap-2">
              <button className="btn btn-primary text-xs" onClick={saveAi}>
                {t('settings.save', 'Save')}
              </button>
              {aiDraft.enabled && (
                <button className="btn text-xs" onClick={testAi} disabled={Boolean(aiTest?.busy)}>
                  {t('settings.ai.test')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{t('settings.loadingConfig', 'Loading configuration…')}</p>
        )}
      </Section>

      {/* ── 3. Timing ────────────────────────────────────────────── */}
      <Section title={t("settings.application")}>
        <div className="flex items-start justify-between">
          <div className="flex gap-4 flex-1">
            <div className="flex-1">
              <label className="text-xs mb-1.5 block" style={{ color: 'var(--text-muted)' }}>{t("settings.speed")}</label>
              <select
                className="select text-sm w-full"
                value={timingDraft.speed}
                onChange={(e) => updateTimingField('speed', e.target.value)}
              >
                <option value="slow">{t("settings.slow")}</option>
                <option value="balanced">{t("settings.balanced")}</option>
                <option value="fast">{t("settings.fast")}</option>
              </select>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {timingDraft.speed === 'fast' ? t('settings.speedFastDesc', 'Minimum delays, higher captcha risk') : timingDraft.speed === 'slow' ? t('settings.speedSlowDesc', 'Maximum delays, safest') : t('settings.speedBalancedDesc', 'Default balance')}
              </p>
            </div>
            <div className="flex-1">
              <label className="text-xs mb-1.5 block" style={{ color: 'var(--text-muted)' }}>{t("settings.pollInterval")}</label>
              <input
                className="input text-sm w-full"
                type="number"
                min={5}
                step={1}
                value={timingDraft.poll_interval}
                onChange={(e) => updateTimingField('poll_interval', e.target.value)}
              />
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{t('settings.pollIntervalDesc', 'How often to check for new listings')}</p>
            </div>
            <label className="flex items-center gap-1.5 text-xs mt-2 cursor-pointer select-none" style={{ color: 'var(--text-muted)' }}>
                <input
                  type="checkbox"
                  checked={timingDraft.exclude_tauschwohnungen}
                  onChange={(e) => updateTimingField('exclude_tauschwohnungen', e.target.checked)}
                  className="cursor-pointer"
                />
                {t('settings.excludeTauschwohnungen', 'Exclude Tauschwohnungen')}
              </label>
          </div>
          <div className="flex items-end ml-4" style={{ paddingTop: '1.65rem' }}>
            <button className="btn btn-primary text-xs" onClick={saveTiming}>
              {t('settings.save', 'Save')}
            </button>
          </div>
        </div>
      </Section>

      {/* ── 4. 2captcha API Key ──────────────────────────────────── */}
      <Section title={t("settings.captcha")}>
        <div className="flex items-center gap-3">
          <input
            className="input text-sm flex-1"
            type={showCaptcha ? 'text' : 'password'}
            placeholder={t("settings.placeholder.apiKey")}
            value={captchaDraft}
            onChange={(e) => setCaptchaDraft(e.target.value)}
          />
          <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none" style={{ color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              checked={showCaptcha}
              onChange={(e) => setShowCaptcha(e.target.checked)}
              className="cursor-pointer"
            />
            {t('settings.showKey', 'Show')}
          </label>
          <button className="btn btn-primary text-xs" onClick={saveCaptcha}>
            {t('settings.save', 'Save')}
          </button>
        </div>
      </Section>

      {/* ── 5. Support Bundle ──────────────────────────────────── */}
      <Section title={t("settings.support")}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.supportExportDesc', 'Export redacted logs, config, Chrome status, and recent debug screenshots/HTML.')}
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {t('settings.supportBundlePath', 'Creates a .zip in ~/.homelander/support-bundles, opens the folder, and copies the path.')}
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {t('settings.sendBundlesTo', 'Send debug bundles to')}{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); window.homelander?.openExternal('mailto:fedurkomykola@gmail.com'); }} style={{ color: 'var(--accent)', textDecoration: 'none', cursor: 'pointer' }} className="hover:underline">
                fedurkomykola@gmail.com
              </a>
            </p>
          </div>
          <button className="btn btn-primary text-xs flex-shrink-0" onClick={handleExportSupportBundle} disabled={supportBusy}>
            {supportBusy ? t('settings.supportExporting', 'Exporting…') : t('settings.supportExport', 'Export Support Bundle')}
          </button>
        </div>
      </Section>

      {/* ── 6. Language ──────────────────────────────────────────── */}
      <Section title={t("settings.language")}>
        <div className="flex items-center gap-2">
          {['de', 'en'].map((lang) => (
            <button
              key={lang}
              className="btn text-xs"
              onClick={() => setLocale(lang)}
              style={{
                background: locale === lang ? 'var(--accent)' : 'var(--bg-tertiary)',
                color: locale === lang ? '#fff' : 'var(--text-secondary)',
                border: locale === lang ? 'none' : '1px solid var(--border)',
                padding: '4px 14px',
                fontWeight: locale === lang ? 600 : 400,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {lang === 'en' ? <><FlagGB size={16} /><span className="ml-1">English</span></> : <><FlagDE size={16} /><span className="ml-1">Deutsch</span></>}
            </button>
          ))}
        </div>
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
          {t('setup.changeLater', 'You can change this later in Settings')}
        </p>
      </Section>

      {/* ── 7. Support Homelander ─────────────────────────────── */}
      <Section title={t("settings.donate.title", "Support ❤️")}>
        <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
          {t("settings.donate.desc", "Homelander is free and open source. Help keep development going.")}
        </p>
        <div className="flex gap-3">
          <button
            className="btn text-xs"
            onClick={() => window.homelander?.openExternal('https://github.com/sponsors/B1Z0N')}
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            ❤️ {t("settings.donate.github", "GitHub Sponsor")}
          </button>
          <button
            className="btn text-xs"
            onClick={() => window.homelander?.openExternal('https://www.buymeacoffee.com/b1z0n')}
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            ☕ {t("settings.donate.buymeacoffee", "Buy Me a Coffee")}
          </button>
          <button
            className="btn text-xs"
            onClick={() => window.homelander?.openExternal('https://ko-fi.com/b1z0n')}
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            🧡 {t("settings.donate.kofi", "Ko-fi")}
          </button>
        </div>
      </Section>

      {/* ── 8. Clean All Data ──────────────────────────────────── */}
      <div className="pt-2">
        {cleanupStep === null ? (
          <button className="btn btn-danger text-sm w-full" onClick={handleCleanData}>
            {t('settings.cleanAllData', 'Clean All Data')}
          </button>
        ) : cleanupStep === 'confirm' ? (
          <div className="p-4 rounded-lg" style={{ border: '1px solid var(--danger)', background: 'rgba(239,68,68,0.06)' }}>
            <p className="text-sm mb-3" style={{ color: 'var(--danger)' }}>
              {t('settings.cleanConfirm', 'This will delete all data — listings, config, API keys. Type your email to confirm.')}
            </p>
            <div className="flex items-center gap-3">
              <input
                className="input text-sm flex-1"
                type="email"
                placeholder={config?.persona?.email || 'your@email.com'}
                value={cleanupEmail}
                onChange={(e) => { setCleanupEmail(e.target.value); setCleanupError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmClean(); }}
              />
              <button
                className="btn btn-danger text-xs"
                onClick={handleConfirmClean}
                disabled={cleanupStep === 'purging'}
              >
                {cleanupStep === 'purging' ? t('settings.purging', 'Purging…') : t('settings.continue', 'Continue')}
              </button>
              <button className="btn btn-ghost text-xs" onClick={handleCancelClean}>
                {t('settings.cancel', 'Cancel')}
              </button>
            </div>
            {cleanupError && (
              <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{cleanupError}</p>
            )}
          </div>
        ) : (
          <button className="btn btn-danger text-sm w-full" disabled>
            {t('settings.purgingAll', 'Purging all data…')}
          </button>
        )}
      </div>

      {/* ── 9. Reset Application Data ──────────────────────────── */}
      <div className="pt-2">
        {appResetStep === null ? (
          <button
            className="btn text-sm w-full"
            onClick={handleResetApps}
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            {t('settings.resetApplications', 'Reset Application Data')}
          </button>
        ) : appResetStep === 'confirm' ? (
          <div className="p-4 rounded-lg" style={{ border: '1px solid var(--warning)', background: 'rgba(245,158,11,0.06)' }}>
            <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
              {t('settings.resetAppsConfirm', 'Removes all listings, searches, and history. Your settings and IS24 login are kept. Type your email to confirm.')}
            </p>
            <div className="flex items-center gap-3">
              <input
                className="input text-sm flex-1"
                type="email"
                placeholder={config?.persona?.email || 'your@email.com'}
                value={appResetEmail}
                onChange={(e) => { setAppResetEmail(e.target.value); setAppResetError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmResetApps(); }}
              />
              <button
                className="btn text-xs"
                onClick={handleConfirmResetApps}
                disabled={appResetStep === 'purging'}
                style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--warning)', border: '1px solid rgba(245,158,11,0.3)' }}
              >
                {appResetStep === 'purging' ? t('settings.purging', 'Purging…') : t('settings.continue', 'Continue')}
              </button>
              <button className="btn btn-ghost text-xs" onClick={handleCancelResetApps}>
                {t('settings.cancel', 'Cancel')}
              </button>
            </div>
            {appResetError && (
              <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{appResetError}</p>
            )}
          </div>
        ) : (
          <button
            className="btn text-sm w-full"
            disabled
            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
          >
            {t('settings.purgingApps', 'Purging application data…')}
          </button>
        )}
      </div>

      <div className="pt-6 border-t text-center" style={{ borderColor: 'var(--border)' }}>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Homelander v{appVersion}</span>
      </div>
    </div>
  );
}
