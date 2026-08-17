#!/usr/bin/env node
// Homelander Daemon — polls IS24 mobile API for new listings,
// then auto-applies to them via Chrome CDP. Runs continuously.
//
// Two independent async loops:
//   pollLoop  — discovers new listings on a fixed schedule
//   applyLoop — applies to pending listings round‑robin (respects pauses)
//
// Usage: node engine/daemon.js --db=<path> --cdp-url=<url> --config=<path>
//
// Communicates status via stdout JSON lines:
//   {"type":"stats",...}
//   {"type":"listing","outcome":"SENT",...}
//   {"type":"paused","reason":"session_expired"}
//   {"type":"resumed"}
//   {"type":"error","message":"..."}
//   {"type":"poll_error","filter_id":"...","error":"..."}
//   {"type":"ready_for_restart"}  // emitted when graceful restart is ready

import { readFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setPriority, constants as osConstants } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db = null; // module-level ref for exit cleanup

// Parse CLI args
const { values: args } = parseArgs({
  options: {
    db: { type: 'string' },
    'cdp-url': { type: 'string', default: 'http://localhost:9222' },
    config: { type: 'string' },
    'poll-interval': { type: 'string', default: '120' }, // seconds
    'dry-run': { type: 'boolean', default: false },
  },
});

const DB_PATH = args.db || join(process.env.HOME || '/tmp', '.homelander', 'homelander.db');
const CDP_URL = args['cdp-url'];
const CONFIG_PATH = args.config;
const DRY_RUN = args['dry-run'];
const PAUSE_FLAG = join(dirname(DB_PATH), '.apply-paused');
const DAEMON_LOG = join(dirname(DB_PATH), 'daemon.log');

// Mutable poll interval — updated via IPC when user changes it in Settings
let pollIntervalSec = parseInt(args['poll-interval'], 10);
let nextPollDueAt = 0; // ms timestamp; reset by settings save and manual poll

// Elevate OS scheduling priority so the daemon's event loop stays responsive
// even when the parent Electron window is occluded or on another desktop.
// Windows: SetPriorityClass(ABOVE_NORMAL) — prevents EcoQoS starvation.
// macOS: setpriority(PRIO_PROCESS, nice=-7) — harmless scheduling hint.
try { setPriority(osConstants.priority.PRIORITY_ABOVE_NORMAL); } catch (err) { /* non-fatal */ }

// ── Windows: disable OS-level power throttling + force 1ms timer resolution ──
// Chromium flags prevent app-level throttling but the Windows NT kernel scheduler
// applies EcoQoS (Efficiency Mode) and drops timer resolution to 15.6ms when DWM
// marks the process group as invisible (occluded / virtual desktop switch).
// These Win32 API calls opt the daemon out of BOTH mechanisms.
if (process.platform === 'win32') {
  try {
    const koffi = (await import('koffi')).default;
    const kernel32 = koffi.load('kernel32.dll');

    // Fix C: Disable Efficiency Mode / Power Throttling
    // PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 1, StateMask = 0 = disabled
    const PT = koffi.struct('PROCESS_POWER_THROTTLING_STATE', {
      Version: 'uint32', ControlMask: 'uint32', StateMask: 'uint32',
    });
    const SetProcessInformation = kernel32.func(
      'SetProcessInformation', 'bool',
      ['void *', 'int', 'PROCESS_POWER_THROTTLING_STATE *', 'uint32'],
    );
    const GetCurrentProcess = kernel32.func('GetCurrentProcess', 'void *', []);
    SetProcessInformation(GetCurrentProcess(), 4, // ProcessPowerThrottling = 4
      { Version: 1, ControlMask: 1, StateMask: 0 }, koffi.sizeof(PT));

    // Fix D: Force 1ms OS timer resolution (default is 15.6ms)
    const winmm = koffi.load('winmm.dll');
    const timeBeginPeriod = winmm.func('timeBeginPeriod', 'uint32', ['uint32']);
    timeBeginPeriod(1);
    const timeEndPeriod = winmm.func('timeEndPeriod', 'uint32', ['uint32']);
    process.on('exit', () => { try { timeEndPeriod(1); } catch {} });
  } catch (err) {
    process.stderr.write(`[daemon] win-power-throttle: ${err.message}\n`);
  }
}

// Dynamic imports
const { HomelanderDB } = await import('./db.js');
const { IS24Contactor, DEBUG } = await import('./is24-contactor.js');
const { fetchListings } = await import('./url-translator.js');

// ── Helpers ────────────────────────────────────────────────────

function emit(obj) {
  // IPC channel (FD 3) — non-blocking uv_pipe_t.
  // App Nap on the parent cannot back up the daemon's event loop
  // through this channel.  Fallback to stdout for standalone runs.
  if (process.send) {
    process.send(obj);
    // Debug echo to stderr so CLI dev runs still show daemon output.
    // The parent already captures stderr → console + daemon.log.
    process.stderr.write(`[daemon] ${JSON.stringify(obj)}\n`);
    return;
  }
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function log(msg) {
  const ts = new Date().toLocaleTimeString('de-DE', { hour12: false });
  const line = `[${ts}] ${msg}`;
  process.stderr.write(line + '\n');
  // Main process catches stderr and persists to DAEMON_LOG – no double-write here.
}
/** Logged-catch replacement for bare catch {} — never throws, always logs to daemon log. */
function swallow(err, context) {
  try { log(`[swallow] ${context}: ${err?.message || err}`); } catch {}
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resetNextPollDue() {
  nextPollDueAt = Date.now() + pollIntervalSec * 1000;
  return new Date(nextPollDueAt).toISOString();
}

async function sleepUntilNextPoll() {
  while (true) {
    const remaining = nextPollDueAt - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(1000, remaining));
  }
}

function jitter(min, max) {
  return sleep(min + Math.random() * (max - min));
}

function personaliseMessage(template, listing) {
  return template
    .replace(/\{\{title\}\}/g, listing.title || '')
    .replace(/\{\{address\}\}/g, listing.address || '')
    .replace(/\{\{name\}\}/g, [listing._contact?.vorname, listing._contact?.nachname].filter(Boolean).join(' ').trim());
}

/** Shallow merge for config patches received via IPC. */
function mergePatch(target, patch) {
  for (const key of Object.keys(patch)) {
    if (patch[key] !== undefined) {
      target[key] = patch[key];
    }
  }
}

/** Check filesystem pause flag — belt-and-suspenders for IPC pauses. */
function checkPauseFlag() {
  try {
    return existsSync(PAUSE_FLAG);
  } catch {
    return false;
  }
}

/** Write the filesystem pause flag so restarts remember the pause. */
function writePauseFlag(reason = 'manual') {
  try {
    writeFileSync(PAUSE_FLAG, JSON.stringify({ paused_at: new Date().toISOString(), reason }), 'utf8');
  } catch (err) {
    log(`Failed to write pause flag: ${err.message}`);
  }
}

/** Remove the filesystem pause flag. */
function removePauseFlag() {
  try {
    unlinkSync(PAUSE_FLAG);
  } catch {
    // file doesn't exist — that's fine
  }
}

function filterIsStillEnabled(db, filterId) {
  const current = db.getFilter(filterId);
  return !!current?.enabled && !current?.archived;
}

// ── Config loading ─────────────────────────────────────────────

function loadConfig() {
  if (!CONFIG_PATH || !existsSync(CONFIG_PATH)) {
    log('ERROR: config file not found at ' + CONFIG_PATH);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

// ── Shared state between loops ─────────────────────────────────
// JS is single-threaded — no locks needed.

let applyPaused = false;
let pauseResumeTime = null;   // null = manual pause (session_expired, perimeter_captcha)

// contactor is a shared reference so the apply loop can reconnect
let contactor = null;

// last-tick timestamp for sleep/wake detection — both loops update this
let lastTick = Date.now();

// consecutive CDP connect failures — escalate to Electron after threshold
let cdpFailCount = 0;

// Mutable config — all fields hot-reload without restart
let currentConfig = null;

// Nachrichten pre-flight runs before apply work on every daemon run/resume.
let nachrichtenSyncDone = false;
let nachrichtenSyncInFlight = false;

async function ensureNachrichtenSync(db) {
  if (nachrichtenSyncDone) return true;
  if (nachrichtenSyncInFlight) return false;
  if (!contactor || !contactor.browser || !contactor.browser.isConnected()) return false;

  nachrichtenSyncInFlight = true;
  try {
    log('Nachrichten pre-flight: checking already-sent applications...');
    emit({ type: 'nachrichten_sync_checking' });
    const result = await contactor.scrapeNachrichtenExposeIds();
    const ids = Array.isArray(result.exposeIds) ? result.exposeIds : [];
    let pendingRowsProtected = 0;
    let newFutureSkips = 0;
    for (const exposeId of ids) {
      const mark = db.markAlreadyApplied(exposeId);
      pendingRowsProtected += mark.pendingRowsProtected || 0;
      newFutureSkips += mark.manualSkipInserted || 0;
    }

    if (!result.ok) {
      const reason = result.reason || 'Nachrichten sync failed';
      const reasonLower = reason.toLowerCase();
      if (reasonLower.includes('session_expired')) {
        log('*** IS24 SESSION EXPIRED — Nachrichten pre-flight requires login ***');
        emit({ type: 'session_expired', reason });
        applyPaused = true;
        pauseResumeTime = null;
        writePauseFlag('session_expired');
        return false;
      }
      if (reasonLower.includes('perimeter_captcha')) {
        log('*** AWS WAF PERIMETER CAPTCHA — Nachrichten pre-flight paused ***');
        emit({ type: 'perimeter_captcha', reason });
        applyPaused = true;
        pauseResumeTime = null;
        writePauseFlag('perimeter_captcha');
        try { await contactor.page?.bringToFront(); } catch (err) { swallow(err, 'nachrichten/perimeter-captcha-bring-to-front'); }
        return false;
      }
      log(`Nachrichten pre-flight warning: ${reason}`);
    }

    nachrichtenSyncDone = true;
    log(`Nachrichten pre-flight complete — ${ids.length} expose IDs seen, ${pendingRowsProtected} pending queue row(s) protected, ${newFutureSkips} new future skip(s) recorded`);
    emit({
      type: 'nachrichten_sync_complete',
      seen: ids.length,
      protected: pendingRowsProtected,
      future_skips: newFutureSkips,
      pages: result.pagesScanned || 0,
      source: result.source || 'api',
    });
    return true;
  } catch (err) {
    log(`Nachrichten pre-flight error: ${err.message}`);
    emit({ type: 'nachrichten_sync_error', error: err.message });
    // Fail closed: do not apply until a later loop/resume can complete the sync.
    return false;
  } finally {
    nachrichtenSyncInFlight = false;
  }
}

// ── Apply one listing ──────────────────────────────────────────

async function applyOne(listing, filterId, db) {
  // Use currentConfig so template/captcha edits take effect immediately
  const message = personaliseMessage(currentConfig.message_template, {
    ...listing,
    _contact: currentConfig.persona,
  });

  if (DRY_RUN) {
    log(`  [DRY RUN] Would apply to: ${listing.title} (${listing.expose_id})`);
    emit({
      type: 'listing',
      sentAt: new Date().toISOString(),
      outcome: 'DRY_RUN',
      exposeId: listing.expose_id,
      title: listing.title,
      price: listing.price,
      address: listing.address,
      imageUrl: listing.image_url,
      detail: 'dry run — not sent',
    });
    return;
  }

  try {
    const result = await contactor.apply(
      listing.expose_id,
      message,
      currentConfig.captcha?.api_key || '',
      currentConfig.browser?.max_tabs || 5,
      { shouldAbort: () => db.isManuallyApplied(listing.expose_id) || !filterIsStillEnabled(db, filterId) }
    );

    if (result.success) {
      const captchaSolved = result.captcha?.solved || result.captcha?.attempts > 0;
      const failureReason = captchaSolved ? 'captcha_solved' : '';
      db.markSent(listing.hash, 'SENT', result.detail || 'modal ✓', failureReason);
      log(`  ✓ SENT | ${listing.expose_id} | ${listing.title} | ${result.detail || ''}${captchaSolved ? ' (captcha solved)' : ''}`);
      emit({
        type: 'listing',
        sentAt: new Date().toISOString(),
        outcome: 'SENT',
        exposeId: listing.expose_id,
        title: listing.title,
        price: listing.price,
        address: listing.address,
        imageUrl: listing.image_url,
        detail: result.detail || '',
        failureReason,
      });
    } else {
      const reason = result.reason || '';
      if (reason.startsWith('ABORTED')) {
        if (db.isManuallyApplied(listing.expose_id)) {
          log(`  ◌ SKIPPED | ${listing.expose_id} | ${reason}`);
          db.deleteByHash(listing.hash);
        } else {
          log(`  ◌ REQUEUED | ${listing.expose_id} | ${reason}`);
          db.db.prepare("UPDATE listings SET status = 'seen' WHERE hash = ? AND status = 'processing'").run(listing.hash);
        }
        emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: new Date(nextPollDueAt).toISOString() });
        return;
      }
      const reasonLower = reason.toLowerCase();
      const isDeactivated = reasonLower.includes('deactivated');
      const isPremium = reasonLower.includes('premium') || reasonLower.includes('suchen+');
      const isSessionExpired = reasonLower.includes('session_expired');
      const isPerimeterCaptcha = reasonLower.includes('perimeter_captcha');
      const isError = reason.startsWith('ERROR:');
      const failureReason = isPerimeterCaptcha ? 'perimeter_captcha'
        : isSessionExpired ? 'session_expired'
        : isDeactivated ? 'deactivated'
        : isPremium ? 'premium'
        : reasonLower.includes('captcha') ? 'captcha'
        : reasonLower.includes('server_error') || reasonLower.includes('server error') ? 'server_error'
        : reasonLower.includes('no_form') ? 'no_form'
        : isError ? 'error'
        : 'unknown';

      const outcome = isDeactivated ? 'DEACTIVATED' : isPremium ? 'PREMIUM' : isError ? 'ERROR' : 'FAIL';
      db.markSent(listing.hash, outcome, reason, failureReason);
      const logIcon = isDeactivated ? '◌' : isPremium ? '💎' : '✗';
      log(`  ${logIcon} ${outcome} | ${listing.expose_id} | ${listing.title} | ${reason}`);

      if (isSessionExpired) {
        log('*** IS24 SESSION EXPIRED — pausing apply ***');
        emit({ type: 'session_expired', reason });
        applyPaused = true;
        pauseResumeTime = null;
        writePauseFlag('session_expired');
        // Navigate to IS24 homepage so the user can log in
        try {
          await contactor.page?.evaluate(() => { window.location.href = 'https://www.immobilienscout24.de/'; });
          await contactor.page?.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch (err) { swallow(err, 'apply/session-expiry-redirect2'); }
      }

      if (isPerimeterCaptcha) {
        log('*** AWS WAF PERIMETER CAPTCHA — pausing apply + poll ***');
        emit({ type: 'perimeter_captcha', reason });
        applyPaused = true;
        pauseResumeTime = null;
        writePauseFlag('perimeter_captcha');
        // Show the Chromium window so the user can solve the captcha.
        // Do NOT navigate away — the captcha page must stay visible.
        try {
          await contactor.page?.bringToFront();
        } catch (err) { swallow(err, 'apply/perimeter-captcha-bring-to-front'); }
      }

      emit({
        type: 'listing',
        sentAt: new Date().toISOString(),
        outcome,
        exposeId: listing.expose_id,
        title: listing.title,
        price: listing.price,
        address: listing.address,
        imageUrl: listing.image_url,
        detail: reason,
        failureReason,
      });
    }
  } catch (err) {
    const errMsg = err?.message || String(err);
    log(`  ERROR | ${listing.expose_id} | ${errMsg}`);

    // CDP/browser infrastructure failures before confirmed submit are transient.
    // Put the listing back in the queue instead of burning it as a terminal FAIL.
    const cdpFatal = /Target closed|Session closed|Protocol error|WebSocket is not open|Connection closed|Detached from target|Browser has been disconnected|timed out|protocolTimeout/i;
    const isCdpFatal = cdpFatal.test(errMsg) || (contactor?.browser && !contactor.browser.isConnected());
    if (isCdpFatal) {
      log('  CDP connection lost — re-queueing listing and nulling contactor for reconnect');
      db.db.prepare(`
        UPDATE listings
        SET status = 'seen', outcome = NULL, detail = NULL,
          failure_reason = NULL, sent_at = NULL
        WHERE hash = ? AND status = 'processing'
      `).run(listing.hash);
      contactor = null;
      emit({
        type: 'transient_apply_error',
        exposeId: listing.expose_id,
        title: listing.title,
        detail: errMsg,
      });
      return;
    }

    db.markSent(listing.hash, 'ERROR', `ERROR: ${errMsg}`, 'error');
    consecutiveCaptchas = 0;

    emit({
      type: 'listing',
      outcome: 'ERROR',
      exposeId: listing.expose_id,
      title: listing.title,
      price: listing.price,
      address: listing.address,
      imageUrl: listing.image_url,
      detail: `ERROR: ${err.message}`,
    });
  }
}

// ── Apply loop ─────────────────────────────────────────────────
// Runs continuously, processing one listing per enabled filter per round.
// Respects applyPaused / captcha wall / session expiry / pendingRestart.
// Polling is completely independent — it runs in pollLoop().

async function applyLoop(db) {
  // Prune debug artifacts on startup (keep 50 most recent per subdir)
  DEBUG.prune(50);

  log('Apply loop started');

  while (true) {
    // ── Detect wake from sleep — force CDP reconnect ──────────
    if (Date.now() - lastTick > (pollIntervalSec * 3000)) {
      log(`Time jump detected (${Math.round((Date.now() - lastTick) / 1000)}s) — forcing CDP reconnect`);
      contactor = null;
    }
    lastTick = Date.now();

    // ── Wait if paused ───────────────────────────────────────
    // Honour both in-memory flag (IPC set) and filesystem flag (belt-and-suspenders)
    if (applyPaused || checkPauseFlag()) {
      if (!applyPaused && checkPauseFlag()) {
        // Filesystem flag found but in-memory not set — sync
        applyPaused = true;
        pauseResumeTime = null;
        log('Apply paused via filesystem flag');
        emit({ type: 'paused', reason: 'manual' });
      }
      // Periodically re-check the filesystem flag even when paused in-memory.
      // If the flag was removed externally (e.g. resume IPC), auto-resume.
      if (applyPaused && !checkPauseFlag() && pauseResumeTime === null) {
        log('Pause flag removed — auto-resuming');
        applyPaused = false;
        emit({ type: 'resumed' });
        continue;
      }
      await sleep(1000);
      continue;
    }

    // ── Ensure contactor is connected ────────────────────────
    if (!contactor || !contactor.browser || !contactor.browser.isConnected()) {
      log(`CDP check — contactor=${!!contactor} browser=${!!contactor?.browser} connected=${!!contactor?.browser?.isConnected?.()}`);
      if (contactor) {
        try {
          await contactor.connect();
          cdpFailCount = 0;
          // Verify the renderer is actually alive — puppeteer.connect()
          // succeeds even when Chrome is a GPU-compositor zombie
          // (WebSocket still open, but CDP commands won't resolve).
          const alive = await contactor.pingRenderer().catch(() => false);
          if (!alive) {
            log('CDP reconnected but renderer dead (zombie) — restarting Chrome');
            emit({ type: 'chrome_dead', detail: 'Renderer unresponsive after CDP reconnect' });
            process.exit(0);
          }
          log('CDP reconnected');
        } catch (err) {
          cdpFailCount++;
          const isFatal = err.message.includes('CDP_FAILED') || err.message.includes('ECONNREFUSED');
          log(`CDP reconnect failed (#${cdpFailCount}): ${err.message}${isFatal ? ' [chrome dead]' : ''}`);
          if (isFatal) {
            log('*** Chrome unreachable — stopping daemon ***');
            emit({ type: 'chrome_dead', detail: err.message });
            process.exit(0);
          }
          await sleep(5000);
          continue;
        }
      } else {
        // Contactor was nulled (e.g. CDP died mid-apply). Try to re-create it.
        try {
          contactor = new IS24Contactor(
            CDP_URL,
            currentConfig.persona || {},
            currentConfig.timing?.speed || 'balanced',
            currentConfig.timing?.overrides || {},
            { api_key: currentConfig.captcha?.api_key || '' }
          );
          await contactor.connect();
          cdpFailCount = 0;
          const alive = await contactor.pingRenderer().catch(() => false);
          if (!alive) {
            log('Contactor re-created but renderer dead (zombie) — restarting Chrome');
            emit({ type: 'chrome_dead', detail: 'Renderer unresponsive after contactor recreate' });
            process.exit(0);
          }
          log('Contactor re-created and CDP reconnected');
        } catch (err) {
          const isFatal = err.message.includes('CDP_FAILED') || err.message.includes('ECONNREFUSED');
          log(`Contactor re-create failed: ${err.message}${isFatal ? ' [chrome dead]' : ''}`);
          if (isFatal) {
            log('*** Chrome unreachable — stopping daemon ***');
            emit({ type: 'chrome_dead', detail: err.message });
            process.exit(0);
          }
          contactor = null;
          await sleep(5000);
          continue;
        }
      }
    }

    // Block applying until the Nachrichten pre-flight has protected all
    // already-sent expose IDs for this run/resume. Polling may continue, but
    // the apply loop fails closed to avoid duplicate applications.
    if (!(await ensureNachrichtenSync(db))) {
      await sleep(2000);
      continue;
    }

    // ── Gather pending listings (round‑robin across filters) ─
    const filters = db.getFilters().filter(f => f.enabled);
    if (filters.length === 0) {
      await sleep(5000);
      continue;
    }

    // Quick CDP health check before processing listings — fresh
    // TCP connection, not the stale Puppeteer WebSocket.
    try {
      await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(3000) });
    } catch {
      log('CDP ping failed at round start — waiting for recovery');
      await sleep(5000);
      continue;
    }

    // Renderer liveness check — the HTTP ping above passes even when
    // Chrome is a zombie (GPU compositor deadlock).  This sends a real
    // CDP command to verify the renderer can still process messages.
    if (contactor) {
      const rendererAlive = await contactor.pingRenderer().catch(() => false);
      if (!rendererAlive) {
        log('Renderer unresponsive (zombie) — requesting Chrome restart');
        emit({ type: 'chrome_dead', detail: 'Renderer unresponsive after CDP reconnect (GPU compositor deadlock)' });
        process.exit(0);
      }
    }

    let didWork = false;
    for (const filter of filters) {
      if (applyPaused || checkPauseFlag()) break;
      if (!filterIsStillEnabled(db, filter.id)) {
        log(`Apply skipped — filter paused/disabled: ${filter.name || filter.id}`);
        continue;
      }

      const queue = db.getSeenListings(filter.id);
      if (queue.length === 0) continue;

      const listing = queue[0];
      if (applyPaused || checkPauseFlag() || !filterIsStillEnabled(db, filter.id)) {
        log(`Apply skipped before send — filter paused/disabled: ${filter.name || filter.id}`);
        continue;
      }
      // Check CDP alive before every listing — catches Cmd+Q instantly
      if (!contactor || !contactor.browser || !contactor.browser.isConnected()) {
        log('CDP disconnected — breaking filter loop');
        break;
      }

      // Quick CDP HTTP ping — fresh TCP connection, bypasses the
      // long-lived Puppeteer WebSocket.  If macOS QoS-downgraded the
      // daemon on a Space switch, the WebSocket can stall even though
      // Chromium itself is responsive to new connections.  This catches
      // that state and skips the listing instead of timing out.
      try {
        await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(3000) });
      } catch {
        log(`CDP ping failed (Space throttled?) — skipping ${listing.expose_id}`);
        // Don't burn a listing — break the filter loop so ensureCDPHealthy
        // handles reconnection at the top of the next iteration.
        break;
      }
      // Atomic claim — only one writer processes a listing at a time.
      // If Electron marked it MANUAL or cleared the queue between the
      // getSeenListings read and now, changes=0 and we skip.
      {
        const claim = db.db.prepare(
          "UPDATE listings SET status = 'processing' WHERE hash = ? AND status = 'seen'"
        ).run(listing.hash);
        if (claim.changes === 0) {
          log(`Skipping ${listing.expose_id} — claimed by another writer or no longer 'seen'`);
          continue;
        }
      }
      if (applyPaused || checkPauseFlag() || !filterIsStillEnabled(db, filter.id)) {
        log(`Apply skipped after claim — filter paused/deleted: ${filter.name || filter.id}`);
        db.db.prepare("UPDATE listings SET status = 'seen' WHERE hash = ? AND status = 'processing'").run(listing.hash);
        continue;
      }
      // Belt-and-suspenders: skip manually-applied listings even if they
      // slipped past the poll filter (retry, race, etc.)
      if (db.isManuallyApplied(listing.expose_id)) {
        log(`Skipping ${listing.expose_id} — already applied manually, removing from queue`);
        db.deleteByHash(listing.hash);
        continue;
      }
      log(`Applying to ${listing.expose_id} — ${(listing.title || '').slice(0, 60)}`);
      await applyOne(listing, filter.id, db);
      emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: new Date(nextPollDueAt).toISOString() });
      didWork = true;

      // If CDP died inside applyOne (contactor nulled), break the filter
      // loop so ensureCDPHealthy can handle it at the top of the next iteration.
      if (!contactor) {
        log('Contactor lost during apply — breaking filter loop');
        break;
      }

      if (!applyPaused) await jitter(2000, 5000);
    }

    if (!didWork) await sleep(5000);
  }
}

// ── Poll loop ──────────────────────────────────────────────────

async function pollLoop(db) {
  log('Poll loop started');

  // Emit an immediate heartbeat so the UI countdown appears right away
  const nextPollAt = resetNextPollDue();
  emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });

  while (true) {
    // ── Honour pause flag (perimeter_captcha, session_expired, manual) ──
    if (checkPauseFlag()) {
      await sleep(5000);
      continue;
    }

    // ── Detect wake from sleep ────────────────────────────────
    if (Date.now() - lastTick > (pollIntervalSec * 3000)) {
      log(`Time jump detected (${Math.round((Date.now() - lastTick) / 1000)}s) — poll cycle resuming after suspend`);
    }
    lastTick = Date.now();
    const cycleStart = Date.now();

    // ── Poll all enabled filters ─────────────────────────────
    log('Polling for new listings...');
    const filters = db.getFilters().filter(f => f.enabled);

    let totalNew = 0;
    for (const filter of filters) {
      if (!filterIsStillEnabled(db, filter.id)) {
        log(`Poll skipped — filter paused/disabled: ${filter.name || filter.id}`);
        continue;
      }
      try {
        const MAX_PAGES = 5, PAGE_SIZE = 20;
        let filterNew = 0, filterFetched = 0;
        for (let page = 1; page <= MAX_PAGES; page++) {
          if (!filterIsStillEnabled(db, filter.id)) {
            log(`Poll stopped — filter paused/disabled: ${filter.name || filter.id}`);
            break;
          }
          const { listings, error } = await fetchListings(filter.web_url, page);
          if (error) {
            if (page === 1) {
              log(`Poll error [${filter.id}]: ${error}`);
              emit({ type: 'poll_error', filter_id: filter.id, error });
            }
            // Perimeter captcha affects all filters — pause everything
            if (error.toLowerCase().includes('perimeter_captcha')) {
              log('*** AWS WAF PERIMETER CAPTCHA (poll) — pausing apply + poll ***');
              emit({ type: 'perimeter_captcha', reason: error });
              applyPaused = true;
              pauseResumeTime = null;
              writePauseFlag('perimeter_captcha');
            }
            break;
          }
          const filteredListings = (currentConfig.polling?.exclude_tauschwohnungen ?? true)
            ? listings.filter((listing) => !String(listing.title || '').toLowerCase().includes('tauschwohnung'))
            : listings;
          const dedupedListings = filteredListings.filter(
            (l) => !db.isManuallyApplied(l.expose_id)
          );
          filterFetched += dedupedListings.length;
          const firstPollLimit = 10;
          const isFirstPoll = !filter.first_poll_done;
          const listingsToInsert = isFirstPoll
            ? dedupedListings.slice(0, Math.max(0, firstPollLimit - filterNew))
            : dedupedListings;
          if (!filterIsStillEnabled(db, filter.id)) break;
          const inserted = db.insertListings(listingsToInsert, filter.id);
          filterNew += inserted;
          if (isFirstPoll && filterNew >= firstPollLimit) break;
          if (listings.length < PAGE_SIZE) break;
          if (inserted === 0) break;
        }

        if (filterNew > 0) {
          log(`  ${filter.name || filter.id}: ${filterNew} new listings (${filterFetched} fetched across pages)`);
          totalNew += filterNew;
        }

        if (filterIsStillEnabled(db, filter.id)) {
          db.incrementFilterSeen(filter.id, filterNew);
        }
      } catch (err) {
        log(`Poll error [${filter.id}]: ${err.message}`);
        emit({ type: 'poll_error', filter_id: filter.id, error: err.message });
      }
    }

    log(`Poll complete — ${totalNew} new listings across ${filters.length} filters`);

    // ── Emit stats with next_poll_at based on poll schedule ──
    const elapsed = Date.now() - cycleStart;
    const delayMs = Math.max(0, (pollIntervalSec * 1000) - elapsed);
    nextPollDueAt = Date.now() + delayMs;
    const nextPollAt = new Date(nextPollDueAt).toISOString();
    emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });

    // ── Sleep until next scheduled poll; settings/manual poll may reset deadline ──
    await sleepUntilNextPoll();
  }
}

// ── IPC message handler (from Electron parent) ──────────────────

function setupIpc(db) {
  process.on('message', async (msg) => {
    if (!msg) return;

    // ── Manual poll-now for a specific filter ────────────────
    if (msg.type === 'poll_now' && msg.filterId) {
      try {
        const filter = db.getFilter(msg.filterId);
        if (!filter) { log(`Poll-now: filter ${msg.filterId} not found`); return; }
        if (!filterIsStillEnabled(db, filter.id)) { log(`Poll-now skipped — filter paused/deleted: ${filter.name || filter.id}`); return; }
        log(`Manual poll for: ${filter.name || filter.id}`);

        const MAX_PAGES = 5, PAGE_SIZE = 20;
        let allInserted = 0, allFetched = 0, duplicateProtected = 0, tauschExcluded = 0, firstPollCapped = false;
        for (let page = 1; page <= MAX_PAGES; page++) {
          const { listings, error } = await fetchListings(filter.web_url, page);
          if (error) {
            if (page === 1) {
              log(`Poll-now error [${filter.id}]: ${error}`);
              emit({ type: 'poll_error', filter_id: filter.id, error });
            }
            break;
          }
          const excludeTausch = currentConfig.polling?.exclude_tauschwohnungen ?? true;
          const filteredListings = excludeTausch
            ? listings.filter((listing) => !String(listing.title || '').toLowerCase().includes('tauschwohnung'))
            : listings;
          if (excludeTausch) {
            tauschExcluded += Math.max(0, listings.length - filteredListings.length);
          }
          const dedupedPn = filteredListings.filter(
            (l) => !db.isManuallyApplied(l.expose_id)
          );
          duplicateProtected += Math.max(0, filteredListings.length - dedupedPn.length);
          allFetched += dedupedPn.length;
          const firstPollLimit = 10;
          const isFirstPoll = !filter.first_poll_done;
          const listingsToInsert = isFirstPoll
            ? dedupedPn.slice(0, Math.max(0, firstPollLimit - allInserted))
            : dedupedPn;
          if (isFirstPoll && dedupedPn.length > firstPollLimit) firstPollCapped = true;
          if (!filterIsStillEnabled(db, filter.id)) break;
          const inserted = db.insertListings(listingsToInsert, filter.id);
          allInserted += inserted;
          if (isFirstPoll && allInserted >= firstPollLimit) break;
          if (listings.length < PAGE_SIZE) break;
          if (inserted === 0) break;
        }
        if (allInserted > 0) log(`  ${filter.name || filter.id}: ${allInserted} new listings (${allFetched} fetched across pages)`);
        if (filterIsStillEnabled(db, filter.id)) {
          db.incrementFilterSeen(filter.id, allInserted);
        }
        const nextPollAt = resetNextPollDue();
        emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });
        emit({ type: 'poll_complete', filter_id: filter.id, inserted: allInserted, fetched: allFetched, duplicate_protected: duplicateProtected, tauschwohnungen_excluded: tauschExcluded, first_poll_capped: firstPollCapped });
      } catch (err) {
        log(`Poll-now error [${msg.filterId}]: ${err.message}`);
        emit({ type: 'poll_error', filter_id: msg.filterId, error: err.message });
      }
    }

    if (msg.type === 'clear_queue' && msg.filterId) {
      const result = db.clearQueue(msg.filterId);
      log(`Clear queue [${msg.filterId}]: ${result.cleared} listings skipped`);
      emit({ type: 'queue_cleared', filter_id: msg.filterId, cleared: result.cleared });
      emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: new Date(nextPollDueAt).toISOString() });
    }

    // ── Reset automatic all-search poll deadline ─────────────
    if (msg.type === 'reset_poll_schedule') {
      const nextPollAt = resetNextPollDue();
      log(`Poll schedule reset (${msg.reason || 'manual'}): next poll at ${nextPollAt}`);
      emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });
      return;
    }

    // ── Retry a failed listing ───────────────────────────────
    if (msg.type === 'retry_listing' && msg.exposeId) {
      const result = db.retryListing(msg.exposeId);
      if (result.error) {
        log(`Retry: ${result.error} for expose ${msg.exposeId}`);
        emit({ type: 'retry_error', exposeId: msg.exposeId, error: result.error });
      } else if (result.already_seen) {
        log(`Retry: expose ${msg.exposeId} already in queue`);
      } else {
        log(`Retry: expose ${msg.exposeId} reset to seen`);
        emit({ type: 'retry_queued', exposeId: msg.exposeId, hash: result.hash });
        const nextPollAt = resetNextPollDue();
        emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });
      }
    }

    // ── Retry ALL failed listings ─────────────────────────────
    if (msg.type === 'retry_all_failed') {
      const result = db.retryAllFailed(msg.filterId || null);
      log(`Retry all: ${result.changed} listings reset to seen`);
      emit({ type: 'retry_all_queued', changed: result.changed });
      const nextPollAt = resetNextPollDue();
      emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });
    }

    // ── Pause applying (polling continues) ───────────────────
    if (msg.type === 'pause_apply') {
      log('Apply paused by user');
      applyPaused = true;
      pauseResumeTime = null;
      writePauseFlag();
      emit({ type: 'paused', reason: 'manual' });
    }

    // ── Resume applying ──────────────────────────────────────
    if (msg.type === 'resume_apply') {
      log('Apply resumed by user');
      applyPaused = false;
      consecutiveCaptchas = 0;
      nachrichtenSyncDone = false;
      removePauseFlag();
      emit({ type: 'resumed' });
    }

    // ── Config update (hot-reload all fields, no restart needed) ──
    if (msg.type === 'config_update') {
      let changed = false;
      if (msg.message_template !== undefined) {
        currentConfig.message_template = msg.message_template;
        log('Config hot-reload: message template updated');
        changed = true;
      }
      if (msg.captcha) {
        if (!currentConfig.captcha) currentConfig.captcha = {};
        mergePatch(currentConfig.captcha, msg.captcha);
        if (contactor) contactor.updateCaptcha(currentConfig.captcha);
        log('Config hot-reload: captcha config updated');
        changed = true;
      }
      if (msg.browser) {
        if (!currentConfig.browser) currentConfig.browser = {};
        mergePatch(currentConfig.browser, msg.browser);
        const maxTabs = Math.min(5, Math.max(1, Number(currentConfig.browser.max_tabs || 5)));
        currentConfig.browser.max_tabs = maxTabs;
        log(`Config hot-reload: browser config updated (max_tabs=${maxTabs})`);
        changed = true;
      }
      if (msg.poll_interval !== undefined) {
        pollIntervalSec = msg.poll_interval;
        log(`Config hot-reload: poll interval → ${pollIntervalSec}s`);
        const nextPollAt = resetNextPollDue();
        emit({ type: 'stats', ...db.getTodayStats(), next_poll_at: nextPollAt });
        changed = true;
      }
      if (msg.exclude_tauschwohnungen !== undefined) {
        if (!currentConfig.polling) currentConfig.polling = {};
        if (msg.exclude_tauschwohnungen !== undefined) {
          currentConfig.polling.exclude_tauschwohnungen = Boolean(msg.exclude_tauschwohnungen);
        }
        log('Config hot-reload: polling filters updated');
        changed = true;
      }
      if (msg.persona) {
        currentConfig.persona = msg.persona;
        if (contactor) contactor.updateContact(msg.persona);
        log('Config hot-reload: persona updated');
        changed = true;
      }
      if (msg.timing) {
        currentConfig.timing = msg.timing;
        if (contactor) contactor.updateTiming(msg.timing.speed || 'balanced', msg.timing.overrides || {});
        log('Config hot-reload: timing updated');
        changed = true;
      }
      if (changed) {
        emit({ type: 'config_applied' });
      }
    }
  });
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  log('Homelander daemon starting...');

  // Ensure data directory exists
  const dataDir = dirname(DB_PATH);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  // Set debug output directory
  const debugDir = join(dataDir, 'debug');
  if (!existsSync(debugDir)) mkdirSync(debugDir, { recursive: true });
  process.env.HOMELANDER_DEBUG_DIR = debugDir;

  // Load config
  currentConfig = loadConfig();
  log(`Config loaded: ${currentConfig.persona?.email || 'unknown'}, speed=${currentConfig.timing?.speed || 'balanced'}`);

  // Open database
  const db = new HomelanderDB(DB_PATH);
  // Store reference for exit handler (clean close prevents EBUSY on Windows)
  _db = db;
  log('Database opened');

  // Reset stale processing listings — if the daemon crashed mid-apply,
  // these would be stuck in 'processing' forever and never get retried.
  const staleCount = db.db.prepare(
    "UPDATE listings SET status = 'seen' WHERE status = 'processing'"
  ).run().changes;
  if (staleCount > 0) log(`Reset ${staleCount} stale processing listing(s) to seen`);

  // First-poll state is persisted per filter. Do not reset it on daemon
  // startup; otherwise a crash/restart repeatedly reapplies the startup cap.

  // Connect to Chrome
  try {
    contactor = new IS24Contactor(
      CDP_URL,
      currentConfig.persona || {},
      currentConfig.timing?.speed || 'balanced',
      currentConfig.timing?.overrides || {},
      { api_key: currentConfig.captcha?.api_key || '' }
    );
    await contactor.connect();
    log('Chrome CDP connected');
  } catch (err) {
    log(`Chrome CDP connection failed: ${err.message}`);
    emit({ type: 'error', message: `Chrome unavailable: ${err.message}` });
    contactor = null;
  }

  // Set up IPC from Electron parent
  setupIpc(db);

  // ── Check for persisted pause flag ─────────────────────────
  if (checkPauseFlag()) {
    applyPaused = true;
    pauseResumeTime = null;
    log('Starting in paused state (pause flag found on disk)');
    emit({ type: 'paused', reason: 'manual' });
  }

  // ── Start both independent loops ───────────────────────────
  log('Starting poll + apply loops...');
  await Promise.all([
    pollLoop(db),
    applyLoop(db),
  ]);

  // If we get here, it was a graceful shutdown (pendingRestart or manual stop)
  log('Both loops exited — daemon shutting down cleanly');
}

// ── Startup ────────────────────────────────────────────────────

// Prevent unhandled promise rejections from crashing the daemon
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason?.message || reason}`);
});

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  emit({ type: 'error', message: `Daemon crashed: ${err.message}` });
  process.exit(1);
});

// Forceful shutdown (user clicked Stop)
process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down');
  process.exit(0);
});
process.on('SIGINT', () => {
  log('SIGINT received — shutting down');
  process.exit(0);
});
// Windows: POSIX signals don't exist — Electron sends IPC shutdown message instead.
process.on('message', (msg) => {
  if (msg?.type === 'shutdown') {
    log('IPC shutdown received — shutting down');
    process.exit(0);
  }
});

// Ensure DB handles are closed before the process exits (prevents EBUSY on Windows)
process.on('exit', () => {
  try { _db?.close?.(); } catch (_) {}
});
