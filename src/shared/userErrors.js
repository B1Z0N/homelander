// Central user-safe error handling for Homelander.
// Raw technical errors belong in logs; UI surfaces should use these messages.
// Locale-aware: when t() is provided, error text uses locale translations;
// otherwise falls back to English KNOWN map.

const KNOWN = {
  // Not failures — the daemon stores an outcome detail on success too, and every
  // detail string is routed through here. Without these, successes classify as GENERIC.
  SENT: {
    title: 'Contact request sent',
    message: 'IS24 confirmed the contact request for this listing.',
    action: 'No action needed',
  },
  DRY_RUN: {
    title: 'Dry run',
    message: 'Dry run mode is on, so Homelander prepared this application without sending it.',
    action: 'No action needed',
  },
  BACKEND_UNAVAILABLE: {
    title: 'Backend unavailable',
    message: 'Homelander is still starting up. Try again in a moment.',
    action: 'Try again',
  },
  BROWSER_START_FAILED: {
    title: 'Could not open Chromium',
    message: 'Homelander could not start its bundled browser. Restart the app and try again.',
    action: 'Restart app',
  },
  BROWSER_NOT_RESPONDING: {
    title: 'Chromium is not responding',
    message: 'The controlled Chromium session stopped responding. Restart Chromium or restart Homelander.',
    action: 'Restart Chromium',
  },
  SESSION_EXPIRED: {
    title: 'Login needed',
    message: 'Homelander needs you to log back into IS24 before it can continue applying.',
    action: 'Open Chromium',
  },
  SEARCH_URL_INVALID: {
    title: 'Search URL not accepted',
    message: 'This does not look like a usable IS24 search URL. Paste the full search results URL from IS24.',
    action: 'Check URL',
  },
  SEARCH_POLL_FAILED: {
    title: 'Could not poll this search',
    message: 'Homelander could not refresh listings for this search. IS24 or the network may be temporarily unavailable.',
    action: 'Try again',
  },
  CONFIG_SAVE_FAILED: {
    title: 'Could not save settings',
    message: 'Homelander could not save the settings. Try again or restart the app.',
    action: 'Try again',
  },
  DATABASE_ERROR: {
    title: 'Could not read saved data',
    message: 'Homelander could not read or write its local database. Restart the app; technical details were logged.',
    action: 'Restart app',
  },
  CAPTCHA_KEY_INVALID: {
    title: '2captcha key not accepted',
    message: '2captcha did not accept this key. Check the key or leave it empty to skip captcha solving.',
    action: 'Check key',
  },
  CLEANUP_CONFIRMATION_FAILED: {
    title: 'Email does not match',
    message: 'Type the configured email exactly to confirm deleting Homelander data.',
    action: 'Check email',
  },
  CSV_EXPORT_FAILED: {
    title: 'Could not export history',
    message: 'Homelander could not export the selected history rows. Try again.',
    action: 'Try again',
  },
  DAEMON_ACTION_FAILED: {
    title: 'Daemon action failed',
    message: 'Homelander could not change the daemon state. Try again or restart the app.',
    action: 'Try again',
  },
  LISTING_RETRY_FAILED: {
    title: 'Could not queue retry',
    message: 'Homelander could not queue this listing for retry. Try again.',
    action: 'Try again',
  },
  LISTING_DEACTIVATED: {
    title: 'Listing is no longer active',
    message: 'IS24 says this listing is no longer available. Homelander skipped it safely.',
    action: 'No action needed',
  },
  PREMIUM_ONLY: {
    title: 'MieterPlus required',
    message: 'IS24 requires MieterPlus/Suchen+ for this listing, so Homelander skipped it.',
    action: 'Open listing',
  },
  CAPTCHA_REQUIRED: {
    title: 'Security check required',
    message: 'IS24 asked for a captcha/security check. Homelander paused or skipped this attempt safely.',
    action: 'Try later',
  },
  FORM_NOT_FOUND: {
    title: 'Contact form unavailable',
    message: 'IS24 did not show a usable contact form for this listing.',
    action: 'Open listing',
  },
  SUBMIT_UNCONFIRMED: {
    title: 'Submit not confirmed',
    message: 'IS24 did not show a confirmation after submit, so Homelander did not count this as sent.',
    action: 'Open listing',
  },
  SERVER_ERROR: {
    title: 'IS24 rejected the submit',
    message: 'IS24 returned a temporary submit error. Try this listing again later.',
    action: 'Retry later',
  },
  GENERIC: {
    title: 'Something went wrong',
    message: 'Homelander could not complete that action. Technical details were logged.',
    action: 'Try again',
  },
};

// SNAKE_CASE → camelCase for locale key lookup
function codeToKey(code) {
  return code.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// Look up a translated error field (title, message, action) — uses t() when available
function tError(t, code, field) {
  if (!t) return null;
  const key = `errors.${codeToKey(code)}.${field}`;
  const translated = t(key, null);
  // t() returns the fallback (key) when not found; detect that
  if (translated && translated !== key && !translated.startsWith('errors.')) return translated;
  return null;
}

// SENT/DRY_RUN are outcomes, not failures — callers styling by severity must not paint them red.
function defaultSeverity(code) {
  return code === 'SENT' || code === 'DRY_RUN' ? 'info' : 'error';
}

export function createSupportId(prefix = 'HML') {
  try {
    const bytes = new Uint8Array(4);
    globalThis.crypto?.getRandomValues?.(bytes);
    if (bytes.some(Boolean)) {
      return `${prefix}-${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    }
  } catch (err) { /* intentional: drop circular/error-stringify failure */ }
  return `${prefix}-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
}

export function classifyError(input, context = {}) {
  const explicitCode = typeof input === 'object' && input?.code ? input.code : context.code;
  if (explicitCode && KNOWN[explicitCode]) return explicitCode;

  const operation = context.operation || '';
  const raw = rawErrorText(input).toLowerCase();

  // Success details first — they never carry an operation hint and would otherwise fall to GENERIC.
  // Sources: is24-contactor 'confirmed (modal)' / 'confirmed (success text)', daemon 'modal ✓'.
  if (/^confirmed\b/.test(raw) || raw.startsWith('modal ✓')) return 'SENT';
  if (raw.startsWith('dry run')) return 'DRY_RUN';

  if (operation.includes('chrome') || operation.includes('browser')) {
    if (raw.includes('not responding') || raw.includes('target closed') || raw.includes('websocket') || raw.includes('cdp')) return 'BROWSER_NOT_RESPONDING';
    return 'BROWSER_START_FAILED';
  }
  if (operation.includes('daemon')) return 'DAEMON_ACTION_FAILED';
  if (operation.includes('config')) return 'CONFIG_SAVE_FAILED';
  if (operation.includes('captcha')) return 'CAPTCHA_KEY_INVALID';
  if (operation.includes('csv') || operation.includes('export')) return 'CSV_EXPORT_FAILED';
  if (operation.includes('retry')) return 'LISTING_RETRY_FAILED';
  if (operation.includes('poll') || operation.includes('search')) {
    if (raw.includes('url') || raw.includes('/suche/') || raw.includes('non-is24') || raw.includes('invalid')) return 'SEARCH_URL_INVALID';
    return 'SEARCH_POLL_FAILED';
  }
  if (operation.includes('database') || raw.includes('sqlite') || raw.includes('database')) return 'DATABASE_ERROR';
  if (raw.includes('session_expired') || raw.includes('login required') || raw.includes('logged out')) return 'SESSION_EXPIRED';
  if (raw.includes('deactivated') || raw.includes('listing removed')) return 'LISTING_DEACTIVATED';
  if (raw.includes('premium') || raw.includes('suchen+') || raw.includes('mieterplus')) return 'PREMIUM_ONLY';
  if (raw.includes('captcha') || raw.includes('sicherheitsabfrage')) return 'CAPTCHA_REQUIRED';
  if (raw.includes('no_form') || raw.includes('form not found') || raw.includes('contact form')) return 'FORM_NOT_FOUND';
  if (raw.includes('submit_unconfirmed') || raw.includes('without confirmation')) return 'SUBMIT_UNCONFIRMED';
  if (raw.includes('server_error') || raw.includes('generic submit error') || raw.includes('http 5')) return 'SERVER_ERROR';
  if (raw.includes('api bridge') || raw.includes('backend') || raw.includes('homelander api unavailable')) return 'BACKEND_UNAVAILABLE';
  if (raw.includes('email does not match')) return 'CLEANUP_CONFIRMATION_FAILED';

  return 'GENERIC';
}

export function rawErrorText(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (input.userMessage) return input.userMessage;
  if (input.message) return input.message;
  if (input.error && typeof input.error === 'string') return input.error;
  if (input.error?.message) return input.error.message;
  try { return JSON.stringify(input); } catch { return String(input); }
}

export function redact(text) {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => {
      const [name, domain] = m.split('@');
      return `${name.slice(0, 2)}***@${domain}`;
    })
    .replace(/(api[_-]?key|clientKey|captcha[^\n:=]*key)(["'\s:=]+)([A-Za-z0-9_-]{8,})/gi, '$1$2[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED_TOKEN]');
}

export function toUserError(input, context = {}, t) {
  if (input && typeof input === 'object' && input.title && input.message) {
    const code = input.code || context.code || 'GENERIC';
    return {
      severity: input.severity || 'error',
      code,
      title: tError(t, code, 'title') || input.title,
      message: tError(t, code, 'message') || input.message,
      action: tError(t, code, 'action') || input.action,
      supportId: input.supportId,
    };
  }
  const code = classifyError(input, context);
  const base = KNOWN[code] || KNOWN.GENERIC;
  return {
    severity: context.severity || defaultSeverity(code),
    code,
    title: tError(t, code, 'title') || base.title,
    message: tError(t, code, 'message') || base.message,
    action: tError(t, code, 'action') || base.action,
    supportId: context.supportId,
  };
}

// t is optional — when provided (from useLocale), uses locale translations
export function userErrorText(input, context = {}, t) {
  const err = toUserError(input, context, t);
  return err.supportId ? `${err.message} Support ID: ${err.supportId}` : err.message;
}

export function userErrorTitleText(input, context = {}, t) {
  const err = toUserError(input, context, t);
  const suffix = err.supportId ? ` · ${err.supportId}` : '';
  return `${err.title}. ${err.message}${suffix}`;
}
