// Homelander — Electron main process.
// Manages app lifecycle, BrowserWindow, daemon child process,
// Chrome lifecycle, config, and IPC bridge to renderer.

import { app, BrowserWindow, ipcMain, Notification, Tray, Menu, shell, clipboard, safeStorage, powerSaveBlocker } from 'electron';
import { fork, spawnSync, spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, readdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { homedir, platform } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ChromeManager } from './chrome.js';
import { MessageComposer, DEFAULT_AI_PROMPT, PROMPT_VARIABLES } from '../engine/message-composer.js';
import { detectHarnesses } from '../engine/harness-detect.js';
import { createProvider } from '../engine/ai-providers.js';
import { createSupportId, rawErrorText, redact, toUserError } from '../src/shared/userErrors.js';
import { openSharedDb, closeSharedDb, db } from './db-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// ── Chromium anti-throttling for background Spaces ──────────────
// These flags target the Chromium engine embedded inside Electron
// (the renderer hosting the React UI).  Without them, Electron's
// renderer accepts macOS native occlusion signals and throttles,
// which cascades to delayed IPC and stalled daemon communications.
// Anti-throttling for background Spaces / virtual desktops.
// CalculateNativeWinOcclusion — Windows DWM suspends compositing for
//   windows on inactive virtual desktops.  Must disable so the renderer
//   keeps producing frames even when the user switches desktops.
// NativeWindowOcclusion — cross-platform; both macOS WindowServer and
//   Windows DWM mark windows as occluded.  Disable so Chromium ignores it.
// MacWindowOcclusion — macOS-specific WindowServer occlusion signal.
// IntensiveWakeUpThrottling — macOS-specific timer coalescing.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion,NativeWindowOcclusion,MacWindowOcclusion,IntensiveWakeUpThrottling',
);

// Single-instance lock — prevents duplicate Electron processes
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  // Focus existing window instead of opening a second one
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── Paths ──────────────────────────────────────────────────────

const DATA_DIR = join(homedir(), '.homelander');
const DB_PATH = join(DATA_DIR, 'homelander.db');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const DAEMON_SCRIPT = join(__dirname, '..', 'engine', 'daemon.js');
const DAEMON_LOG = join(DATA_DIR, 'daemon.log');
const CDP_URL = 'http://localhost:9222';
const PAUSE_FLAG = join(DATA_DIR, '.apply-paused');
const SUPPORT_DIR = join(DATA_DIR, 'support-bundles');
const CHROME_LOG = join(DATA_DIR, 'chrome.log');
openSharedDb(DB_PATH);
const DEBUG_DIR = join(DATA_DIR, 'debug');
const APP_ICON_PNG = process.resourcesPath
  ? join(process.resourcesPath, 'icon.png')
  : join(__dirname, '..', 'resources', 'icon.png');

// ── State ──────────────────────────────────────────────────────

let mainWindow = null;
let daemonProcess = null;
let daemonStatus = 'stopped'; // stopped | running | paused | restarting | session_expired | perimeter_captcha
let daemonStartedAt = 0;      // timestamp of last startDaemon() call
let _powerSaveBlockerId = null; // macOS App Nap prevention
let latestNextPollAt = null;  // last future next_poll_at emitted by daemon poll loop
let latestNachrichtenSync = { duplicateProtectionStatus: 'ready' };
let daemonStopping = false;   // true only during an explicit user stop/SIGTERM window
let _stopKillTimer = null;    // SIGKILL timeout handle — cleared on start to prevent cross-fire

// ── Belt-and-suspenders: release the IOPMAssertion on ANY exit path ──
// Electron's before-quit does NOT fire on Cmd+R (dev reload) or
// autoUpdater.quitAndInstall() — the JS heap is dumped while the Darwin
// kernel keeps the assertion open.  process.on('exit') fires on every
// termination path (normal, crash, reload, OTA update, SIGTERM).
// powerSaveBlocker.stop() is synchronous (IOPMAssertionRelease) so it
// works in the exit callback's restricted context.
process.on('exit', () => {
  if (_powerSaveBlockerId != null) {
    try { powerSaveBlocker.stop(_powerSaveBlockerId); } catch (err) {}
  }
});
let chromeManager = new ChromeManager();
chromeManager._chromeLogPath = CHROME_LOG;

let config = null;
let setupComplete = false;

// ── Config ─────────────────────────────────────────────────────

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  ensureDataDir();
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
    setupComplete = config._setupComplete || false;
    // Decrypt secrets that were encrypted with safeStorage
    if (safeStorage.isEncryptionAvailable()) {
      decryptConfigSecrets(config);
    }
    return config;
  } catch {
    config = getDefaultConfig();
    setupComplete = false;
    return config;
  }
}

function saveConfig() {
  ensureDataDir();
  const toWrite = JSON.parse(JSON.stringify(config));  // deep clone
  // Encrypt secrets before writing to disk
  if (safeStorage.isEncryptionAvailable()) {
    encryptConfigSecrets(toWrite);
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2), 'utf8');
}

// ── safeStorage wrappers for secrets ─────────────────────────────

const ENCRYPTED_PREFIX = '_safeStorage:';

function encryptConfigSecrets(cfg) {
  const secretFields = [
    ['captcha', 'api_key'],
    ['is24', 'password'],
    ['ai', 'api_key'],
  ];
  for (const [section, key] of secretFields) {
    const val = cfg[section]?.[key];
    if (val && typeof val === 'string' && !val.startsWith(ENCRYPTED_PREFIX)) {
      try {
        cfg[section][key] = ENCRYPTED_PREFIX + safeStorage.encryptString(val).toString('base64');
      } catch (err) {
        swallow(err, 'config/encrypt-secret');
      }
    }
  }
}

function decryptConfigSecrets(cfg) {
  const secretFields = [
    ['captcha', 'api_key'],
    ['is24', 'password'],
    ['ai', 'api_key'],
  ];
  for (const [section, key] of secretFields) {
    const val = cfg[section]?.[key];
    if (val && typeof val === 'string' && val.startsWith(ENCRYPTED_PREFIX)) {
      try {
        const buf = Buffer.from(val.slice(ENCRYPTED_PREFIX.length), 'base64');
        cfg[section][key] = safeStorage.decryptString(buf);
      } catch (err) {
        swallow(err, 'config/decrypt-secret');
        cfg[section][key] = '';  // clear unrecoverable ciphertext
      }
    }
  }
}


/** Logged-catch replacement — never throws, logs to daemon log. */
function swallow(err, context) {
  try { logRawError(context, err, { code: 'SWALLOW' }); } catch {}
}

function logRawError(operation, err, context = {}) {
  ensureDataDir();
  const supportId = context.supportId || createSupportId();
  const raw = redact(rawErrorText(err));
  const stack = redact(err?.stack || '');
  const ctx = redact(JSON.stringify(context));
  const line = `[${new Date().toISOString()}] [${supportId}] ${operation} failed raw=${raw} context=${ctx}`;
  try { appendFileSync(DAEMON_LOG, `${line}${stack ? `\\n${stack}` : ''}\\n`, 'utf8'); } catch (err) { swallow(err, 'main/append-error-log'); }
  console.error(`[main] ${operation} failed [${supportId}]:`, raw);
  return supportId;
}

function gracefulFailure(operation, err, context = {}) {
  const supportId = logRawError(operation, err, context);
  const userError = toUserError(err, { ...context, operation, supportId });
  return { error: userError.message, userError, supportId };
}

function redactSupportText(text = '') {
  let out = String(text || '');
  const sensitive = [];
  const collect = (obj, path = []) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      const nextPath = [...path, key];
      if (value && typeof value === 'object') collect(value, nextPath);
      else if (typeof value === 'string' && value.trim().length >= 3) {
        const keyPath = nextPath.join('.');
        if (/email|mail|phone|telefon|tel|name|vorname|nachname|strasse|straße|hausnummer|api[_-]?key|token|secret|password/i.test(keyPath)) {
          sensitive.push([key, value.trim()]);
        }
      }
    }
  };
  collect(config || {});
  for (const [key, value] of sensitive) out = out.split(value).join(`[REDACTED:${key}]`);
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED:email]');
  out = out.replace(/(clientKey|api[_-]?key|password|token|secret)(["'\s:=]+)([^"'\s,}]+)/gi, '$1$2[REDACTED]');
  return out;
}

function redactHtmlSnapshot(text = '') {
  // HTML pages are multi-MB and often minified. Keep this deliberately linear:
  // targeted exact replacements + email/API-key patterns only. Broad phone-like
  // regexes and config-wide replacements can lock the Electron main process.
  return redactSupportText(String(text || ''));
}

function redactedConfigSnapshot() {
  const clone = JSON.parse(JSON.stringify(config || {}));
  const scrub = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      if (/password|api[_-]?key|token|secret/i.test(key)) obj[key] = value ? '[REDACTED]' : '';
      else if (value && typeof value === 'object') scrub(value);
      else if (typeof value === 'string') obj[key] = redactSupportText(value);
    }
  };
  scrub(clone);
  return clone;
}

function safeBundleName(value, fallback = 'global') {
  return String(value || fallback).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback;
}

function writeSupportFile(root, relativePath, content) {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

async function copySupportArtifact(src, root, relativePath, { redactTextFile = false, htmlSnapshot = false } = {}) {
  if (!existsSync(src)) return false;
  const dest = join(root, relativePath);
  mkdirSync(dirname(dest), { recursive: true });
  if (redactTextFile) {
    const raw = await readFile(src, 'utf8');
    await writeFile(dest, htmlSnapshot ? redactHtmlSnapshot(raw) : redactSupportText(raw), 'utf8');
  } else cpSync(src, dest);
  return true;
}

function tailTextFile(path, maxBytes = 400_000) {
  if (!existsSync(path)) return '';
  const raw = readFileSync(path);
  return raw.slice(Math.max(0, raw.length - maxBytes)).toString('utf8');
}

function listDebugArtifacts(exposeId = null, limit = 80) {
  const dirs = [join(DEBUG_DIR, 'screenshots'), join(DEBUG_DIR, 'html')];
  const files = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        if (exposeId && !name.includes(String(exposeId))) continue;
        files.push({ path, name, dir: basename(dir), mtimeMs: st.mtimeMs, size: st.size });
      } catch (err) { swallow(err, 'main/list-debug-artifacts'); }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, exposeId ? 40 : limit);
}

function trimArtifactsByBudget(files, maxBytes) {
  let used = 0;
  const kept = [];
  for (const file of files) {
    if (used + file.size > maxBytes) continue;
    kept.push(file);
    used += file.size;
  }
  return kept;
}

function matchingLogLines(exposeId, contextLines = 8) {
  if (!exposeId || !existsSync(DAEMON_LOG)) return '';
  const lines = tailTextFile(DAEMON_LOG, 1_000_000).split(/\r?\n/);
  const keep = new Set();
  lines.forEach((line, i) => {
    if (line.includes(String(exposeId))) {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j += 1) keep.add(j);
    }
  });
  return [...keep].sort((a, b) => a - b).map(i => lines[i]).join('\n');
}

async function createSupportBundle(payload = {}) {
  ensureDataDir();
  mkdirSync(SUPPORT_DIR, { recursive: true });
  const scope = payload?.scope === 'entry' ? 'entry' : 'global';
  const listing = payload?.listing || null;
  const exposeId = listing?.expose_id || listing?.exposeId || null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bundleBase = `homelander-${scope}${exposeId ? `-${safeBundleName(exposeId)}` : ''}-${stamp}`;
  const tempRoot = join(SUPPORT_DIR, `${bundleBase}.tmp`);
  const zipPath = join(SUPPORT_DIR, `${bundleBase}.zip`);
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });

  let dbListing = null;
  if (exposeId) {
    try {
      try { dbListing = db().getHistory(5000, 0).find((row) => String(row.expose_id) === String(exposeId)) || null; }
      catch (err) { swallow(err, 'main/support-bundle-db-lookup'); }
    } catch (err) { swallow(err, 'main/support-bundle-db-lookup'); }
  }

  const chromeStatus = await chromeManager.isHealthy()
    .then(async (healthy) => ({
      running: healthy || chromeManager.isManualLoginRunning?.() || false,
      manualLogin: chromeManager.isManualLoginRunning?.() || false,
      cdpHealthy: healthy,
      tabCount: healthy ? await chromeManager.getTabCount() : -1,
      maxTabs: browserOptions().maxTabs,
      visibility: browserOptions().visibility,
      manualLoginCrash: chromeManager._lastManualLoginCrash || null,
    }))
    .catch((err) => ({ error: redactSupportText(err?.message || String(err)) }));

  const gitCommit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: join(__dirname, '..'), encoding: 'utf8' });
  const gitStatus = spawnSync('git', ['status', '--short'], { cwd: join(__dirname, '..'), encoding: 'utf8' });
  const metadata = {
    created_at: new Date().toISOString(),
    scope,
    expose_id: exposeId,
    listing: dbListing || listing,
    app: { version: app.getVersion(), isPackaged: app.isPackaged, gitCommit: gitCommit.status === 0 ? gitCommit.stdout.trim() : null },
    daemon: { status: daemonStatus, processAlive: !!daemonProcess, logPath: DAEMON_LOG },
    chrome: chromeStatus,
    configPath: CONFIG_PATH,
    debugDir: DEBUG_DIR,
  };
  writeSupportFile(tempRoot, 'metadata.json', JSON.stringify(JSON.parse(redactSupportText(JSON.stringify(metadata))), null, 2));
  writeSupportFile(tempRoot, 'config.redacted.json', JSON.stringify(redactedConfigSnapshot(), null, 2));
  writeSupportFile(tempRoot, 'git-status.txt', redactSupportText(gitStatus.stdout || gitStatus.stderr || ''));

  if (existsSync(PAUSE_FLAG)) writeSupportFile(tempRoot, 'apply-paused.json', redactSupportText(readFileSync(PAUSE_FLAG, 'utf8')));
  if (existsSync(DAEMON_LOG)) {
    writeSupportFile(tempRoot, 'logs/daemon-tail.log', redactSupportText(tailTextFile(DAEMON_LOG)));
    if (exposeId) writeSupportFile(tempRoot, 'logs/entry-context.log', redactSupportText(matchingLogLines(exposeId) || `No daemon.log lines matched expose ${exposeId}.`));
  }
  if (existsSync(CHROME_LOG)) {
    writeSupportFile(tempRoot, 'logs/chrome.log', redactSupportText(tailTextFile(CHROME_LOG)));
  }
  // Include Chrome's own --enable-logging output from the profile dir
  try {
    const profilesDir = join(DATA_DIR, 'chrome-profiles');
    if (existsSync(profilesDir)) {
      for (const dir of readdirSync(profilesDir)) {
        const logPath = join(profilesDir, dir, 'chrome_debug.log');
        if (existsSync(logPath)) {
          writeSupportFile(tempRoot, 'logs/chrome-debug.log', redactSupportText(tailTextFile(logPath)));
          break; // one is enough
        }
      }
    }
  } catch { /* best-effort */ }

  const allCandidates = listDebugArtifacts(scope === 'entry' ? exposeId : null, scope === 'entry' ? 40 : 60);

  if (scope === 'entry') {
    // Per-entry: raw copy everything (instant). Logs/config redacted separately.
    for (const artifact of allCandidates) {
      const dest = join(tempRoot, `debug/${artifact.dir}/${artifact.name}`);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(artifact.path, dest);
    }
    writeSupportFile(tempRoot, 'included-files.txt', allCandidates.map((f) => `debug/${f.dir}/${f.name} (${Math.round(f.size / 1024)} KB)`).join('\n') || 'No debug artifacts found.');
  } else {
    // Global: screenshots raw (instant), HTML listed by name only
    const screenshots = trimArtifactsByBudget(allCandidates.filter((f) => f.dir === 'screenshots'), 100 * 1024 * 1024);
    const htmlList = allCandidates.filter((f) => f.dir === 'html');
    for (const artifact of screenshots) {
      cpSync(artifact.path, join(tempRoot, `debug/${artifact.dir}/${artifact.name}`));
    }
    writeSupportFile(
      tempRoot,
      'included-files.txt',
      [
        ...screenshots.map((f) => `debug/${f.dir}/${f.name} (${Math.round(f.size / 1024)} KB)`),
        '',
        `HTML snapshots not included in global bundle (use per-entry Export Debug Bundle).`,
        `Found ${htmlList.length} recent HTML snapshots:`,
        ...htmlList.map((f) => `  debug/${f.dir}/${f.name} (${Math.round(f.size / 1024)} KB)`),
      ].join('\n')
    );
  }

  await new Promise((resolve, reject) => {
    const args = platform() === 'win32'
      ? ['-NoProfile', '-Command', `Compress-Archive -Path "${tempRoot}\\*" -DestinationPath "${zipPath}" -Force`]
      : ['-qr', zipPath, '.'];
    const cmd = platform() === 'win32' ? 'powershell' : (existsSync('/usr/bin/zip') ? '/usr/bin/zip' : 'zip');
    const opts = platform() === 'win32' ? {} : { cwd: tempRoot };
    const child = spawn(cmd, args, opts);
    child.on('close', (code) => {
      rmSync(tempRoot, { recursive: true, force: true });
      if (code !== 0) reject(new Error(`zip exited ${code}`));
      else resolve();
    });
    child.on('error', reject);
  });
  clipboard.writeText(zipPath);
  shell.showItemInFolder(zipPath);
  return { ok: true, path: zipPath, fileName: basename(zipPath), copiedToClipboard: true, files: allCandidates.length };
}

function getDefaultConfig() {
  return {
    persona: {
      anrede: '',
      vorname: '',
      nachname: '',
      email: '',
      telefon: '',
      strasse: '',
      hausnummer: '',
      plz: '',
      ort: '',
      einzug: '',
      personen: '',
      haustiere: '',
      haustiere_zusatz: '',
      beschaeftigung: '',
      einkommen: '',
      unterlagen: '',
    },
    is24: {
      email: '',
      password: '',
    },
    captcha: {
      api_key: '',
    },
    message_template: [
      'Sehr geehrte Damen und Herren,',
      '',
      'ich interessiere mich für {{title}} in {{address}}.',
      '',
      'Mit freundlichen Grüßen',
      '{{name}}',
    ].join('\n'),
    // AI message composition. Disabled by default — when off (or on any
    // failure) the daemon uses message_template unchanged.
    //
    // `primary` and `fallback` are independent attempts: each picks its own
    // harness, model, and reasoning level, so the fallback can be a different
    // agent entirely. Model/thought level start empty — the real values come
    // from whatever the chosen harness advertises (ACP session config options).
    ai: {
      enabled: false,
      provider: 'acp',          // 'acp' | 'openai-compatible'
      timeout_seconds: 90,
      prompt: '',               // blank = built-in layout instructions
      primary: { harness_id: '', command: '', args: [], model: '', thought_level: '' },
      fallback: { harness_id: '', command: '', args: [], model: '', thought_level: '' },
      // provider: acp
      cwd: '',
      env: {},
      auth_method_id: '',
      // provider: openai-compatible
      base_url: '',
      api_key: '',
      headers: {},
      max_tokens: 1024,
    },
    timing: {
      speed: 'balanced',
      overrides: {},
    },
    polling: {
      interval_seconds: 600,
      exclude_tauschwohnungen: true,
    },
    browser: {
      visibility: 'always_show',
      max_tabs: 5,
    },
    _setupComplete: false,
  };
}

function browserOptions() {
  return {
    visibility: config?.browser?.visibility || 'hidden_unless_needed',
    maxTabs: Math.min(5, Math.max(1, Number(config?.browser?.max_tabs || 5))),
  };
}

// ── Daemon ────────────────────────────────────────────────────

function startDaemon() {
  if (daemonProcess) return;

  // Cancel any pending stop-SIGKILL to prevent cross-firing on this new daemon
  daemonStopping = false;
  if (_stopKillTimer) { clearTimeout(_stopKillTimer); _stopKillTimer = null; }

  // Write current config for daemon to read
  ensureDataDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');

  daemonProcess = fork(DAEMON_SCRIPT, [
    `--db=${DB_PATH}`,
    `--cdp-url=${CDP_URL}`,
    `--config=${CONFIG_PATH}`,
    `--poll-interval=${config.polling?.interval_seconds || 120}`,
  ], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    detached: true,  // Break out of parent Job Object (Windows) / process group (macOS)
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOMELANDER_DEBUG_DIR: join(DATA_DIR, 'debug'),
    },
  });

  daemonStatus = 'running';
  daemonStartedAt = Date.now();
  latestNextPollAt = new Date(Date.now() + pollIntervalMs()).toISOString();

  if (mainWindow) {
    mainWindow.webContents.send('homelander:event', { type: 'daemon_started' });
  }

  // Receive daemon events via the dedicated IPC channel (FD 3).
  // This uv_pipe_t is completely independent of stdout — App Nap
  // on Electron Main cannot block the daemon through this channel.
  daemonProcess.on('message', (event) => {
    try {
      handleDaemonEvent(event);
    } catch (err) {
      swallow(err, 'main/daemon-ipc-event');
    }
  });

  daemonProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    console.error('[daemon]', text);
    try { appendFileSync(DAEMON_LOG, text + '\n', 'utf8'); } catch (err) { swallow(err, 'main/append-daemon-stderr'); }
  });

  daemonProcess.on('exit', (code) => {
    console.log(`[daemon] exited with code ${code}`);
    daemonProcess = null;
    daemonStopping = false;
    // Clear any pending SIGKILL timer — process already exited cleanly
    if (_stopKillTimer) { clearTimeout(_stopKillTimer); _stopKillTimer = null; }
    const wasRunning = daemonStatus === 'running' || daemonStatus === 'paused';
    daemonStatus = 'stopped';
    latestNextPollAt = null;

    if (mainWindow) {
      mainWindow.webContents.send('homelander:event', {
        type: 'daemon_stopped',
        code,
      });
    }
    // Auto-restart on unexpected exit (not user-requested stop).
    // Only auto-restart if the daemon ran for at least 3 seconds —
    // immediate crashes indicate a startup bug and restarting would loop.
    const ranLongEnough = (Date.now() - daemonStartedAt) > 3000;
    if (wasRunning && !app.isQuitting && ranLongEnough) {
      console.log('[daemon] auto-restarting in 5s...');
      daemonStatus = 'restarting';
      if (mainWindow) {
        mainWindow.webContents.send('homelander:event', { type: 'daemon_restarting' });
      }
      setTimeout(() => {
        if (!daemonProcess && !app.isQuitting) {
          console.log('[daemon] restarting...');
          startDaemon();
        }
      }, 5000);
    }
  });

  daemonProcess.on('error', (err) => {
    logRawError('daemon spawn', err, { code: 'DAEMON_ACTION_FAILED' });
    daemonProcess = null;
    daemonStopping = false;
    daemonStatus = 'stopped';
    latestNextPollAt = null;
  });
}

function stopDaemon() {
  if (!daemonProcess) return Promise.resolve();

  // Clear any previous stop timer
  if (_stopKillTimer) { clearTimeout(_stopKillTimer); _stopKillTimer = null; }

  daemonStopping = true;
  const proc = daemonProcess; // capture reference — never cross-fire on a newer daemon

  const isWin = platform() === 'win32';

  // Return a Promise that resolves when daemon actually exits
  const exitPromise = new Promise((resolve) => {
    const onExit = () => {
      proc.removeListener('exit', onExit);
      resolve();
    };
    proc.on('exit', onExit);
  });

  const timeoutMs = isWin ? 3000 : 5000;
  // Safety: resolve after timeout even if exit handler never fires
  const safetyTimer = setTimeout(() => {
    try { proc.removeListener('exit', resolve); } catch (_) {}
    resolve();
  }, timeoutMs + 1000);

  // Clean up safety timer on real exit
  const onRealExit = () => { clearTimeout(safetyTimer); };
  proc.once('exit', onRealExit);

  if (isWin) {
    // Windows: POSIX signals don't exist. Send IPC shutdown message for graceful
    // cleanup, then force-kill after a short grace period.
    if (proc.connected) {
      try { proc.send({ type: 'shutdown' }); } catch (err) { swallow(err, 'main/daemon-shutdown-ipc'); }
    }
    _stopKillTimer = setTimeout(() => {
      _stopKillTimer = null;
      if (daemonProcess === proc) {
        try { proc.kill(); } catch (err) { swallow(err, 'main/daemon-force-kill'); }
        daemonProcess = null;
        daemonStopping = false;
        latestNextPollAt = null;
      }
    }, timeoutMs);
  } else {
    proc.kill('SIGTERM');
    _stopKillTimer = setTimeout(() => {
      _stopKillTimer = null;
      // Only SIGKILL if this is still the SAME process AND still alive
      if (daemonProcess === proc) {
        try { proc.kill('SIGKILL'); } catch (err) { swallow(err, 'main/sigkill-fallback'); }
        daemonProcess = null;
        daemonStopping = false;
        latestNextPollAt = null;
      }
    }, timeoutMs);
  }
  daemonStatus = 'stopped';
  latestNextPollAt = null;

  return exitPromise;
}

function pollIntervalMs() {
  return (config?.polling?.interval_seconds || 120) * 1000;
}

function daemonAlive() {
  return !!daemonProcess && daemonProcess.exitCode === null && !daemonProcess.killed;
}

function effectiveDaemonStatus() {
  if (daemonStopping) return 'stopped';
  if (!daemonAlive()) return 'stopped';
  if (daemonStatus === 'paused' || daemonStatus === 'session_expired' || daemonStatus === 'perimeter_captcha' || daemonStatus === 'restarting') return daemonStatus;
  return 'running';
}

function markDaemonAlive(reason = 'daemon_activity') {
  if (daemonStopping || !daemonAlive()) return;
  if (daemonStatus === 'stopped') {
    daemonStatus = 'running';
    if (mainWindow) mainWindow.webContents.send('homelander:event', { type: 'daemon_started', reason });
  }
}

function resetDaemonPollSchedule(reason = 'schedule_reset') {
  if (daemonProcess && daemonProcess.connected) {
    try { daemonProcess.send({ type: 'reset_poll_schedule', reason }); } catch (err) { swallow(err, 'main/daemon-ipc-send'); }
  }
}

function setNextPollFromNow(reason = 'schedule_reset') {
  if (!daemonAlive()) return null;
  markDaemonAlive(reason);
  latestNextPollAt = new Date(Date.now() + pollIntervalMs()).toISOString();
  return latestNextPollAt;
}

function broadcastStats(stats = {}) {
  const nextPollAt = stats.nextPollAt || stats.next_poll_at || latestNextPollAt || null;
  const payload = {
    ...stats,
    ...latestNachrichtenSync,
    type: 'stats',
    daemonStatus: effectiveDaemonStatus(),
    next_poll_at: nextPollAt,
    nextPollAt,
  };
  if (mainWindow) mainWindow.webContents.send('homelander:stats', payload);
}

function getNextPollAt(db) {
  if (!daemonAlive()) return null;
  markDaemonAlive('next_poll_lookup');

  // Prefer the daemon poll loop's own schedule. This is the only source that
  // stays correct while the apply loop is processing a backlog.
  if (latestNextPollAt && new Date(latestNextPollAt).getTime() > Date.now()) {
    return latestNextPollAt;
  }

  const pollIntervalMsValue = pollIntervalMs();
  try {
    const filters = db().getFilters();
    const lastPoll = filters.reduce((max, f) => {
      const t = f.last_polled_at ? new Date(f.last_polled_at).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    if (lastPoll > 0) {
      const fromDb = new Date(lastPoll + pollIntervalMsValue).toISOString();
      if (new Date(fromDb).getTime() > Date.now()) return fromDb;
    }
  } catch (err) { swallow(err, 'main/get-next-poll-at-fallback'); }

  // Startup / first-cycle fallback: daemon is alive but no future schedule has
  // arrived yet. Show a real countdown instead of the useless "bald" state.
  const fallback = new Date(Date.now() + pollIntervalMsValue).toISOString();
  latestNextPollAt = fallback;
  return fallback;
}

function handleDaemonEvent(event) {
  if (event?.type && event.type !== 'daemon_stopped' && event.type !== 'error') {
    markDaemonAlive(event.type);
  }

  if (event?.type === 'stats') {
    const next = event.next_poll_at || event.nextPollAt || null;
    if (next && new Date(next).getTime() > Date.now()) {
      latestNextPollAt = next;
    }
  }

  if (!mainWindow) return;

  switch (event.type) {
    case 'stats':
      broadcastStats(event);
      break;
    case 'listing':
      mainWindow.webContents.send('homelander:listing', event);
      break;
    case 'perimeter_captcha':
      daemonStatus = 'perimeter_captcha';
      if (latestNachrichtenSync.duplicateProtectionStatus === 'checking') {
        latestNachrichtenSync = {
          ...latestNachrichtenSync,
          duplicateProtectionStatus: 'failed',
          messengerSyncError: event.reason || 'PERIMETER_CAPTCHA',
        };
      }
      try { writeFileSync(PAUSE_FLAG, JSON.stringify({ paused_at: new Date().toISOString(), reason: 'perimeter_captcha' }), 'utf8'); } catch (err) { swallow(err, 'main/write-pause-flag'); }
      mainWindow.webContents.send('homelander:event', {
        type: 'perimeter_captcha',
        reason: event.reason,
      });
      if (config.notifications !== false) {
        new Notification({
          title: '🛡 Captcha-Prüfung nötig',
          body: 'IS24 verlangt eine Sicherheitsabfrage — öffne Chromium um sie zu lösen',
          silent: false,
          icon: APP_ICON_PNG,
        }).show();
      }
      break;
    case 'session_expired':
      daemonStatus = 'session_expired';
      if (latestNachrichtenSync.duplicateProtectionStatus === 'checking') {
        latestNachrichtenSync = {
          ...latestNachrichtenSync,
          duplicateProtectionStatus: 'failed',
          messengerSyncError: event.reason || 'SESSION_EXPIRED',
        };
      }
      try { writeFileSync(PAUSE_FLAG, JSON.stringify({ paused_at: new Date().toISOString(), reason: 'session_expired' }), 'utf8'); } catch (err) { swallow(err, 'main/write-pause-flag'); }
      mainWindow.webContents.send('homelander:event', {
        type: 'session_expired',
        reason: event.reason,
      });
      if (config.notifications !== false) {
        new Notification({
          title: '⚠ IS24-Anmeldung abgelaufen',
          body: 'Melde dich erneut über Einstellungen → IS24-Konto an',
          silent: false,
          icon: APP_ICON_PNG,
        }).show();
      }
      break;
    case 'nachrichten_sync_checking':
      latestNachrichtenSync = {
        ...latestNachrichtenSync,
        duplicateProtectionStatus: 'checking',
        messengerSyncError: null,
      };
      mainWindow.webContents.send('homelander:event', event);
      try { broadcastStats(db().getTodayStats()); } catch (err) { swallow(err, 'main/nachrichten-sync-stats'); }
      break;
    case 'nachrichten_sync_complete':
      latestNachrichtenSync = {
        duplicateProtectionStatus: 'active',
        messengerCheckedAt: new Date().toISOString(),
        messengerExposeIdsSeen: event.seen || 0,
        messengerConversationsChecked: event.seen || 0,
        messengerPendingRowsProtected: event.protected || 0,
        messengerNewFutureSkips: event.future_skips || 0,
        messengerPagesScanned: event.pages || 0,
        messengerSource: event.source || 'api',
        messengerSyncError: null,
      };
      mainWindow.webContents.send('homelander:event', event);
      try { broadcastStats(db().getTodayStats()); } catch (err) { swallow(err, 'main/nachrichten-sync-stats'); }
      break;
    case 'nachrichten_sync_error':
      latestNachrichtenSync = {
        ...latestNachrichtenSync,
        duplicateProtectionStatus: 'failed',
        messengerCheckedAt: new Date().toISOString(),
        messengerSyncError: event.error || event.reason || 'Nachrichten sync failed',
      };
      mainWindow.webContents.send('homelander:event', event);
      try { broadcastStats(db().getTodayStats()); } catch (err) { swallow(err, 'main/nachrichten-sync-stats'); }
      break;
    case 'poll_complete':
      mainWindow.webContents.send('homelander:event', event);
      try { broadcastStats(db().getTodayStats()); } catch (err) { swallow(err, 'main/poll-complete-stats'); }
      break;
    case 'error': {
      const supportId = logRawError('daemon event', new Error(event.message || 'Daemon error'), { type: event.type });
      const userError = toUserError(event.message || event, { operation: 'daemon', supportId });
      mainWindow.webContents.send('homelander:error', { ...event, message: userError.message, userError, supportId });
      break;
    }
    case 'paused':
      daemonStatus = 'paused';
      mainWindow.webContents.send('homelander:event', event);
      break;
    case 'resumed':
      daemonStatus = 'running';
      mainWindow.webContents.send('homelander:event', event);
      break;
    case 'chrome_dead':
      console.log(`[daemon] chrome_dead: ${event.detail || ''}`);
      daemonStatus = 'stopped';
      daemonStopping = true; // prevent exit handler auto-restart
      try { writeFileSync(PAUSE_FLAG, ''); } catch (err) { swallow(err, 'main/clear-pause-flag'); }
      mainWindow.webContents.send('homelander:event', {
        type: 'daemon_stopped',
        reason: 'chrome_closed',
      });
      // Daemon already exiting via process.exit(0) — just clean up
      if (daemonProcess) {
        daemonProcess = null;
      }
      latestNextPollAt = null;
      break;
    case 'fatal':
      console.log(`[daemon] fatal: ${event.reason} — ${event.detail || ''}`);
      mainWindow.webContents.send('homelander:event', event);
      break;
    case 'config_applied':
      mainWindow.webContents.send('homelander:event', { ...event, daemonStatus: effectiveDaemonStatus() });
      break;
    default:
      mainWindow.webContents.send('homelander:event', event);
  }
}

// ── Window ─────────────────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1030,
    height: 680,
    minWidth: 720,
    minHeight: 500,
    title: 'Homelander',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0b',
    icon: APP_ICON_PNG,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  // Load renderer
  if (isDev) {
    // Wait for Vite dev server to be ready (retry up to 30s)
    const deadline = Date.now() + 30000;
    let loaded = false;
    while (Date.now() < deadline) {
      try {
        await mainWindow.loadURL('http://localhost:5173');
        loaded = true;
        break;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!loaded) {
      // Show helpful error in the window instead of Electron's default screen
      mainWindow.loadURL(`data:text/html,<html><body style="background:#0a0a0b;color:#ededef;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>Homelander</h2><p style="color:#9d9da5">Vite dev server not running.</p><p style="color:#63636b;font-size:13px">Run <code style="background:#1c1c1f;padding:2px 6px;border-radius:4px">npm run dev:renderer</code> in another terminal, then restart.</p></div></body></html>`);
    }
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    try {
      await mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'));
    } catch {
      mainWindow.loadURL(`data:text/html,<html><body style="background:#0a0a0b;color:#ededef;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>Homelander</h2><p style="color:#9d9da5">App not built.</p><p style="color:#63636b;font-size:13px">Run <code style="background:#1c1c1f;padding:2px 6px;border-radius:4px">npm run build</code> then restart.</p></div></body></html>`);
    }
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Close = quit the app
  mainWindow.on('close', () => {
    app.quit();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── IPC Handlers ───────────────────────────────────────────────

function registerIpcHandlers() {
  // Daemon
  ipcMain.handle('daemon:start', async () => {
    try {
      // Start means run now. Never inherit a stale persisted pause from an old
      // stop/restart/debug session; Pause is the only action allowed to create it.
      try { unlinkSync(PAUSE_FLAG); } catch (err) { swallow(err, 'main/unlink-pause-flag'); }

      // Launch Chrome first
      const email = config?.is24?.email || config?.persona?.email || 'default';
      await chromeManager.launch(email, browserOptions());
      // Then start the daemon
      startDaemon();
    } catch (err) {
      return { status: daemonStatus, ...gracefulFailure('daemon:start chrome launch', err, { code: 'BROWSER_START_FAILED' }) };
    }
    return { status: effectiveDaemonStatus() };
  });

  ipcMain.handle('daemon:stop', () => {
    daemonStatus = 'stopped'; // must be set BEFORE kill — exit handler checks this
    latestNextPollAt = null;
    try { unlinkSync(PAUSE_FLAG); } catch (err) { swallow(err, 'main/unlink-pause-flag-stop'); } // clear pause flag so restart doesn't inherit pause
    stopDaemon();
    return { status: effectiveDaemonStatus() };
  });

  ipcMain.handle('daemon:pause', () => {
    if (daemonProcess && daemonProcess.connected) {
      // Write filesystem flag so daemon can check it as belt-and-suspenders
      writeFileSync(PAUSE_FLAG, JSON.stringify({ paused_at: new Date().toISOString(), reason: 'manual' }), 'utf8');
      daemonProcess.send({ type: 'pause_apply' });
      daemonStatus = 'paused';
    } else if (!daemonProcess) {
      // Daemon not running — write flag for when it starts
      writeFileSync(PAUSE_FLAG, JSON.stringify({ paused_at: new Date().toISOString(), reason: 'manual' }), 'utf8');
      daemonStatus = 'paused';
    }
    return { status: effectiveDaemonStatus() };
  });

  ipcMain.handle('daemon:resume', () => {
    try { unlinkSync(PAUSE_FLAG); } catch (err) { swallow(err, 'main/unlink-pause-flag'); }
    if (daemonProcess && daemonProcess.connected) {
      daemonProcess.send({ type: 'resume_apply' });
      daemonStatus = 'running';
    } else {
      daemonStatus = 'stopped';
    }
    return { status: effectiveDaemonStatus() };
  });

  ipcMain.handle('daemon:status', () => {
    return { status: effectiveDaemonStatus(), version: app.getVersion() };
  });

  ipcMain.handle('daemon:poll-now', async (_event, filterId) => {
    try {
      const filter = db().getFilter(filterId);
      if (!filter) return { ok: false, error: 'Suche nicht gefunden' };
      if (!filter.enabled || filter.archived) return { ok: false, error: 'Suche ist pausiert' };

      // If the daemon is alive, it is the single writer for poll operations.
      // This avoids racing Electron main against the daemon poll loop.
      if (daemonProcess && daemonProcess.connected && daemonStatus !== 'stopped') {
        resetDaemonPollSchedule('manual_poll_started');
        daemonProcess.send({ type: 'poll_now', filterId });
        return { ok: true, pending: true, ...latestNachrichtenSync };
      }

      const { fetchListings } = await import('../engine/url-translator.js');
      const MAX_PAGES = 5, PAGE_SIZE = 20;
      let allInserted = 0, allFetched = 0, duplicateProtected = 0, tauschExcluded = 0, firstPollCapped = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { listings, error } = await fetchListings(filter.web_url, page);
        if (error) break;
        const excludeTausch = config.polling?.exclude_tauschwohnungen ?? true;
        const filteredListings = excludeTausch
          ? listings.filter((listing) => !String(listing.title || '').toLowerCase().includes('tauschwohnung'))
          : listings;
        if (excludeTausch) {
          tauschExcluded += Math.max(0, listings.length - filteredListings.length);
        }
        const dedupedListings = filteredListings.filter(
          (l) => !db().isManuallyApplied(l.expose_id)
        );
        duplicateProtected += Math.max(0, filteredListings.length - dedupedListings.length);
        allFetched += dedupedListings.length;
        const firstPollLimit = 10;
        const isFirstPoll = !filter.first_poll_done;
        const listingsToInsert = isFirstPoll
          ? dedupedListings.slice(0, Math.max(0, firstPollLimit - allInserted))
          : dedupedListings;
        if (isFirstPoll && dedupedListings.length > firstPollLimit) firstPollCapped = true;
        const inserted = db().insertListings(listingsToInsert, filter.id);
        allInserted += inserted;
        if (isFirstPoll && allInserted >= firstPollLimit) break;
        if (listings.length < PAGE_SIZE) break;
        if (inserted === 0) break;
      }

      db().incrementFilterSeen(filter.id, allInserted);

      const nextPollAt = setNextPollFromNow('manual_poll');
      resetDaemonPollSchedule('manual_poll_finished');
      const stats = { ...db().getTodayStats(), nextPollAt, next_poll_at: nextPollAt };
      broadcastStats(stats);
      if (mainWindow && (allInserted > 0 || allFetched > 0)) {
        mainWindow.webContents.send('homelander:event', {
          type: 'poll_complete',
          filter_id: filter.id,
          inserted: allInserted,
          fetched: allFetched,
          duplicate_protected: duplicateProtected,
          tauschwohnungen_excluded: tauschExcluded,
          first_poll_capped: firstPollCapped,
        });
      }

      return { ok: true, inserted: allInserted, fetched: allFetched, duplicate_protected: duplicateProtected, tauschwohnungen_excluded: tauschExcluded, first_poll_capped: firstPollCapped, ...latestNachrichtenSync };
    } catch (err) {
      return { ok: false, ...gracefulFailure('daemon:poll-now', err, { code: 'SEARCH_POLL_FAILED' }) };
    }
  });

  ipcMain.handle('daemon:clear-queue', async (_event, filterId) => {
    if (daemonProcess && daemonStatus !== 'stopped') {
      daemonProcess.send({ type: 'clear_queue', filterId });
      return { ok: true };
    }
    try {
      const result = db().clearQueue(filterId);
      return { ok: true, cleared: result.cleared };
    } catch (err) {
      return { ok: false, ...gracefulFailure('daemon:clear-queue', err, { code: 'DATABASE_ERROR', filterId }) };
    }
  });

  // Retry a failed listing via the daemon
  ipcMain.handle('daemon:retry-listing', async (_event, exposeId) => {
    if (daemonProcess && daemonProcess.connected) {
      daemonProcess.send({ type: 'retry_listing', exposeId });
      return { ok: true, pending: true };
    }
    // Fallback: direct DB access when daemon not running
    try {
            try {
        const result = db().retryListing(exposeId);
        if (result.error) return { ok: false, ...gracefulFailure('daemon:retry-listing', new Error(result.error), { code: 'LISTING_RETRY_FAILED', exposeId }) };
        return { ok: true, queued: !result.already_seen, error: null };
      } finally { }
    } catch (err) {
      return { ok: false, ...gracefulFailure('daemon:retry-listing', err, { code: 'LISTING_RETRY_FAILED', exposeId }) };
    }
  });

  // Retry ALL failed listings at once
  ipcMain.handle('daemon:retry-all-failed', async (_event, filterId) => {
    if (daemonProcess && daemonProcess.connected) {
      daemonProcess.send({ type: 'retry_all_failed', filterId: filterId || null });
      return { ok: true };
    }
    // Fallback: direct DB access
    try {
      const result = db().retryAllFailed(filterId || null);
      return { ok: true, changed: result.changed, error: null };
    } catch (err) {
      return { ok: false, ...gracefulFailure('daemon:retry-all-failed', err, { code: 'LISTING_RETRY_FAILED' }) };
    }
  });

  // Filters
  ipcMain.handle('filters:list', async () => {
    try {
            const filters = db().getFilters();
      return { filters, error: null };
    } catch (err) {
      return { filters: [], ...gracefulFailure('filters:list', err, { code: 'DATABASE_ERROR' }) };
    }
  });

  ipcMain.handle('filters:get', async (_e, id) => {
    try {
      const filter = db().getFilter(id);
      return { filter: filter || null, error: null };
    } catch (err) {
      return { filter: null, ...gracefulFailure('filters:get', err, { code: 'DATABASE_ERROR' }) };
    }
  });

  ipcMain.handle('filters:add', async (_e, webUrl, name) => {
    try {
      const { validateSearchUrl } = await import('../engine/url-translator.js');
      const validation = validateSearchUrl(webUrl);
      if (!validation.ok) {
        return {
          validation,
          ...gracefulFailure('filters:add validate', new Error(validation.error), { code: 'SEARCH_URL_INVALID' }),
        };
      }

            const id = randomUUID();
      db().addFilter({
        id,
        name: name || '',
        web_url: webUrl,
        mobile_params: validation.mobileUrl,
      });
      const filter = db().getFilter(id);
      return { filter, error: null };
    } catch (err) {
      return gracefulFailure('ipc action', err);
    }
  });

  ipcMain.handle('filters:remove', async (_e, id) => {
    try {
            db().removeFilter(id);
      return { error: null };
    } catch (err) {
      return gracefulFailure('filters:remove', err, { code: 'DATABASE_ERROR', filterId: id });
    }
  });

  ipcMain.handle('filters:update', async (_e, id, patch) => {
    try {
            db().updateFilter(id, patch);
      return { error: null };
    } catch (err) {
      return gracefulFailure('filters:update', err, { code: 'DATABASE_ERROR', filterId: id });
    }
  });

  ipcMain.handle('filters:test', async (_e, webUrl, locale = 'en') => {
    try {
      const { getTotalResults } = await import('../engine/url-translator.js');
      const result = await getTotalResults(webUrl, { locale });
      if (result.error) {
        return {
          total: 0,
          validation: result.validation,
          ...gracefulFailure('filters:test', new Error(result.error), { code: 'SEARCH_URL_INVALID' }),
        };
      }
      return result;
    } catch (err) {
      return { total: 0, ...gracefulFailure('filters:test', err, { code: 'SEARCH_POLL_FAILED' }) };
    }
  });

  // Listings
  ipcMain.handle('listings:mark-applied', async (_event, exposeUrl) => {
    const match = typeof exposeUrl === 'string' ? exposeUrl.match(/expose\/(\d+)/) : null;
    if (!match) return { ok: false, error: 'Invalid IS24 exposé URL' };

    const exposeId = match[1];
    try {
      const result = db().markAlreadyApplied(exposeId);
      return { ok: true, exposeId, wasNew: !result.found };
    } catch (err) {
      return { ok: false, ...gracefulFailure('listings:mark-applied', err, { code: 'DATABASE_ERROR', exposeId }) };
    }
  });

  ipcMain.handle('listings:history', async (_e, limit, offset, filterId, outcome) => {
    try {
            const listings = db().getHistory(limit || 100, offset || 0, filterId, outcome);
      return { listings, error: null };
    } catch (err) {
      return { listings: [], ...gracefulFailure('listings:history', err, { code: 'DATABASE_ERROR' }) };
    }
  });

  ipcMain.handle('listings:stats', async (_event, filterId) => {
    try {
            const stats = db().getStats(filterId || null);
      const recent = db().getRecentActivity(20);
      const nextPollAt = getNextPollAt(db);
      return { stats: { ...stats, ...latestNachrichtenSync, nextPollAt }, recent, error: null };
    } catch (err) {
      return { stats: { total: 0, sent: 0, failed: 0, deactivated: 0, premium: 0, captcha: 0, seen_unapplied: 0, today: 0, nextPollAt: null }, recent: [], ...gracefulFailure('listings:stats', err, { code: 'DATABASE_ERROR' }) };
    }
  });

  ipcMain.handle('listings:todayStats', async (_event, filterId) => {
    try {
            const stats = db().getTodayStats(filterId || null);
      const nextPollAt = getNextPollAt(db);
      return { stats: { ...stats, ...latestNachrichtenSync, nextPollAt }, error: null };
    } catch (err) {
      return { stats: { total: 0, sent: 0, failed: 0, deactivated: 0, premium: 0, captcha: 0, seen_unapplied: 0, today: 0, nextPollAt: null }, ...gracefulFailure('listings:todayStats', err, { code: 'DATABASE_ERROR' }) };
    }
  });

  // Support bundles
  ipcMain.handle('support:bundle', async (_event, payload) => {
    try {
      return await createSupportBundle(payload || { scope: 'global' });
    } catch (err) {
      return { ok: false, ...gracefulFailure('support:bundle', err, { code: 'SUPPORT_BUNDLE_FAILED', scope: payload?.scope, exposeId: payload?.listing?.expose_id || payload?.listing?.exposeId }) };
    }
  });

  // Config
  ipcMain.handle('config:get', () => {
    return config;
  });

  ipcMain.handle('config:update', async (_e, patch) => {
    try {
      // Deep merge patch into config
      config = deepMerge(config, patch);
      saveConfig();

      const pollIntervalChanged = patch.polling?.interval_seconds !== undefined;
      if (pollIntervalChanged) {
        const nextPollAt = setNextPollFromNow('poll_interval_changed');
        if (nextPollAt) {
                    try {
            broadcastStats({ ...db().getStats(), nextPollAt, next_poll_at: nextPollAt, reason: 'poll_interval_changed' });
          } finally {
          }
        }
      }

    // Hot-reload everything into the running daemon — no restart needed
    if (daemonProcess) {
      const msg = { type: 'config_update' };

      if (patch.message_template !== undefined) msg.message_template = config.message_template;
      if (patch.ai) msg.ai = config.ai;
      if (patch.captcha) msg.captcha = config.captcha;
      if (patch.polling?.interval_seconds !== undefined) msg.poll_interval = config.polling.interval_seconds;
      if (patch.polling?.exclude_tauschwohnungen !== undefined) msg.exclude_tauschwohnungen = config.polling.exclude_tauschwohnungen;
      if (patch.browser) msg.browser = config.browser;

      const personaChanged = patch.persona && Object.keys(patch.persona).length > 0;
      const timingChanged = patch.timing && Object.keys(patch.timing).length > 0;
      if (personaChanged) msg.persona = config.persona;
      if (timingChanged) msg.timing = config.timing;

      if (Object.keys(msg).length > 1) { // more than just 'type'
        console.log('[main] Hot-reloading config into running daemon');
        daemonProcess.send(msg);
      }
    }

      return { error: null };
    } catch (err) {
      return gracefulFailure('config:update', err, { code: 'CONFIG_SAVE_FAILED', patchKeys: Object.keys(patch || {}) });
    }
  });

  // Chrome
  ipcMain.handle('chrome:status', async () => {
    const healthy = await chromeManager.isHealthy();
    const manualLogin = chromeManager.isManualLoginRunning?.() || false;
    const tabCount = healthy ? await chromeManager.getTabCount() : -1;
    return { running: healthy || manualLogin, manualLogin, cdpHealthy: healthy, tabCount, maxTabs: browserOptions().maxTabs, visibility: browserOptions().visibility, manualLoginCrash: chromeManager._lastManualLoginCrash || null };
  });

  ipcMain.handle('chrome:launch', async () => {
    try {
      const email = config?.is24?.email || config?.persona?.email || 'default';
      const result = await chromeManager.launch(email, browserOptions());
      return { ...result, error: null };
    } catch (err) {
      return gracefulFailure('chrome:launch', err, { code: 'BROWSER_START_FAILED' });
    }
  });

  ipcMain.handle('chrome:openLogin', async () => {
    try {
      const email = config?.is24?.email || config?.persona?.email || 'default';
      const result = await chromeManager.openLoginPage(email, browserOptions());
      return { ...result, error: null };
    } catch (err) {
      return gracefulFailure('chrome:openLogin', err, { code: 'BROWSER_START_FAILED' });
    }
  });

  ipcMain.handle('chrome:focus', async () => {
    try {
      // Cross-platform: use CDP Page.bringToFront which works on all OSes.
      // If the daemon is running and has a contactor page, use that.
      // Otherwise fall back to platform-specific activation.
      const result = await chromeManager.bringToFront();
      return { focused: true, ...result, error: null };
    } catch (err) {
      return { focused: false, error: err.message };
    }
  });

  ipcMain.handle('chrome:finalizeManualLogin', async () => {
    try {
      const email = config?.is24?.email || config?.persona?.email || 'default';
      const result = await chromeManager.finalizeManualLogin(email, browserOptions());
      return { ...result, error: null };
    } catch (err) {
      return gracefulFailure('chrome:finalizeManualLogin', err, { code: 'BROWSER_START_FAILED' });
    }
  });

  ipcMain.handle('chrome:openListing', async (_event, exposeIdOrUrl) => {
    try {
      const email = config?.is24?.email || config?.persona?.email || 'default';
      const result = await chromeManager.openListing(exposeIdOrUrl, email, browserOptions());
      return { ...result, error: null };
    } catch (err) {
      return gracefulFailure('chrome:openListing', err, { code: 'BROWSER_START_FAILED', exposeIdOrUrl });
    }
  });

  ipcMain.handle('chrome:checkIs24Login', async () => {
    try {
      if (chromeManager.isManualLoginRunning?.() && !(await chromeManager.isHealthy())) {
        return { loggedIn: false, manualLogin: true, cookies: [], error: null };
      }
      const result = await chromeManager.checkIs24Login();
      return { ...result, error: null };
    } catch (err) {
      return { loggedIn: false, ...gracefulFailure('chrome:checkIs24Login', err, { code: 'BROWSER_NOT_RESPONDING' }) };
    }
  });

  ipcMain.handle('chrome:getIs24Email', async () => {
    try {
      const result = await chromeManager.getIs24Email();
      return { ...result, error: null };
    } catch (err) {
      return { email: null, ...gracefulFailure('chrome:getIs24Email', err, { code: 'BROWSER_NOT_RESPONDING' }) };
    }
  });

  // 2captcha
  ipcMain.handle('captcha:validate', async (_e, apiKey) => {
    try {
      const resp = await fetch('https://api.2captcha.com/getBalance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      if (data.errorId === 0) {
        return { valid: true, balance: data.balance, error: null };
      }
      return { valid: false, balance: 0, ...gracefulFailure('captcha:validate response', new Error(data.errorDescription || data.errorText || 'Invalid API key'), { code: 'CAPTCHA_KEY_INVALID' }) };
    } catch (err) {
      return { valid: false, balance: 0, ...gracefulFailure('captcha:validate', err, { code: 'CAPTCHA_KEY_INVALID' }) };
    }
  });
  // Which ACP harnesses are installed on this machine (PATH scan, no spawn).
  ipcMain.handle('ai:detect-harnesses', () => {
    try {
      return { harnesses: detectHarnesses(), error: null };
    } catch (err) {
      return { harnesses: [], ...gracefulFailure('ai:detect-harnesses', err, { code: 'AI_DETECT_FAILED' }) };
    }
  });

  // The built-in prompt, so Settings can show and reset to it. The renderer
  // cannot import engine modules (they pull in node:fs), hence the IPC.
  ipcMain.handle('ai:default-prompt', () => ({
    prompt: DEFAULT_AI_PROMPT,
    variables: PROMPT_VARIABLES,
    error: null,
  }));

  // Ask a harness what it offers for a session: models and reasoning levels
  // (ACP session config options). This does spawn the harness, unlike
  // detection, so it only runs on demand.
  ipcMain.handle('ai:probe-harness', async (_e, payload) => {
    const { ai: aiPatch, attempt } = payload || {};
    const ai = { ...(config.ai || {}), ...(aiPatch || {}) };
    let provider = null;
    try {
      provider = createProvider({ ai, attempt: attempt || {}, log: (m) => console.log(`[ai:probe] ${m}`) });
      const result = await provider.listConfig();
      return { ...result, error: null };
    } catch (err) {
      return { models: [], thoughtLevels: [], ...gracefulFailure('ai:probe-harness', err, { code: 'AI_PROBE_FAILED' }) };
    } finally {
      try { provider?.dispose(); } catch { /* already gone */ }
    }
  });

  // Dry-run the AI message composition against a sample listing so the user
  // can verify the harness/endpoint before it runs on a real application.
  ipcMain.handle('ai:test', async (_e, payload) => {
    const { ai: aiPatch, listing } = payload || {};
    const composer = new MessageComposer({
      config: {
        ...config,
        ai: { ...(config.ai || {}), ...(aiPatch || {}), enabled: true },
      },
      log: (m) => console.log(`[ai:test] ${m}`),
    });
    try {
      const result = await composer.compose(listing || {
        title: 'Schöne 3-Zimmer-Wohnung mit Balkon',
        address: 'Musterstraße 42, 10115 Berlin',
        price: '1.250 € warm',
        size: '78 m²',
        rooms: '3',
        _contact: config.persona || {},
      });
      if (result.source !== 'ai') {
        return {
          ok: false,
          ...gracefulFailure('ai:test', new Error(result.errors.join('; ') || 'AI returned no usable message'), { code: 'AI_TEST_FAILED' }),
        };
      }
      return { ok: true, text: result.text, attempt: result.attempt, language: result.language, error: null };
    } catch (err) {
      return { ok: false, ...gracefulFailure('ai:test', err, { code: 'AI_TEST_FAILED' }) };
    } finally {
      composer.dispose();
    }
  });

  ipcMain.handle('setup:complete', () => {
    return { complete: setupComplete };
  });

  ipcMain.handle('setup:done', () => {
    setupComplete = true;
    config._setupComplete = true;
    saveConfig();
    return { error: null };
  });

  ipcMain.handle('app:quit', () => {
    app.isQuitting = true;
    app.quit();
    return { ok: true };
  });

  ipcMain.handle('data:clean', async (_event, confirmEmail) => {
    // Verify email matches configured email
    const configuredEmail = config?.persona?.email || config?.is24?.email || '';
    if (!configuredEmail || confirmEmail !== configuredEmail) {
      return gracefulFailure('data:clean confirm', new Error('Email does not match.'), { code: 'CLEANUP_CONFIRMATION_FAILED' });
    }

    // Stop daemon first
    daemonStatus = 'stopped';
    latestNextPollAt = null;
    try { unlinkSync(PAUSE_FLAG); } catch (err) { swallow(err, 'main/unlink-pause-flag'); }
    await stopDaemon();

    // Shutdown Chrome and wait for it
    await chromeManager.shutdown().catch((err) => { swallow(err, 'main/chrome-shutdown-clean'); });

    // Small grace period for OS to release file handles (Windows especially)
    await new Promise(r => setTimeout(r, 500));

    // Close main-process DB handle before unlinking (Windows can't delete open files)
    closeSharedDb();

    // Delete data files
    try { unlinkSync(DB_PATH); } catch (err) { logRawError('data:clean db delete', err, { code: 'DATABASE_ERROR' }); }
    try { unlinkSync(CONFIG_PATH); } catch (err) { logRawError('data:clean config delete', err, { code: 'CONFIG_SAVE_FAILED' }); }
    try { unlinkSync(PAUSE_FLAG); } catch (err) { swallow(err, 'main/unlink-pause-flag'); }

    // Delete logs
    try { unlinkSync(DAEMON_LOG); } catch (err) { swallow(err, 'main/clean-daemon-log'); }
    try { unlinkSync(CHROME_LOG); } catch (err) { swallow(err, 'main/clean-chrome-log'); }

    // Delete Chrome profiles (session cookies, browser state)
    const chromeProfilesDir = join(DATA_DIR, 'chrome-profiles');
    try { rmSync(chromeProfilesDir, { recursive: true, force: true }); } catch (err) { swallow(err, 'main/clean-chrome-profiles'); }

    // Delete support bundles
    try { rmSync(SUPPORT_DIR, { recursive: true, force: true }); } catch (err) { swallow(err, 'main/clean-support-bundles'); }

    // Delete debug directory
    try { rmSync(DEBUG_DIR, { recursive: true, force: true }); } catch (err) { swallow(err, 'main/clean-debug-dir'); }

    // Relaunch fresh — config will be recreated with defaults
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  // ── Reset application data only (keep config + chrome profiles) ─
  ipcMain.handle('data:reset-applications', async (_event, confirmEmail) => {
    const configuredEmail = config?.persona?.email || config?.is24?.email || '';
    if (!configuredEmail || confirmEmail !== configuredEmail) {
      return gracefulFailure('data:reset-applications confirm', new Error('Email does not match.'), { code: 'CLEANUP_CONFIRMATION_FAILED' });
    }

    // Stop daemon first
    daemonStatus = 'stopped';
    latestNextPollAt = null;
    try { unlinkSync(PAUSE_FLAG); } catch (err) { swallow(err, 'main/unlink-pause-flag'); }
    await stopDaemon();

    // Close main-process DB handle before unlinking
    closeSharedDb();

    // Small grace period for OS to release file handles
    await new Promise(r => setTimeout(r, 500));

    // Delete only the database — config and chrome profiles stay
    try { unlinkSync(DB_PATH); } catch (err) { logRawError('data:reset-applications db delete', err, { code: 'DATABASE_ERROR' }); }
    // Also clean up SQLite WAL/SHM companion files
    try { unlinkSync(DB_PATH + '-wal'); } catch (_) {}
    try { unlinkSync(DB_PATH + '-shm'); } catch (_) {}

    // Delete daemon log (will be recreated on next start)
    try { unlinkSync(DAEMON_LOG); } catch (err) { swallow(err, 'main/reset-daemon-log'); }

    // Relaunch — config is intact, fresh DB will be created on start
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
}

// ── Helpers ────────────────────────────────────────────────────

function deepMerge(target, patch) {
  const result = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── App Lifecycle ──────────────────────────────────────────────

app.whenReady().then(async () => {
  // ── Prevent macOS App Nap on the Electron process itself ──────
  // powerSaveBlocker prevents system sleep but NOT App Nap.
  // NSAppSleepDisabled tells base::mac::IsAppNapEnabled() to skip
  // process throttling at the Darwin kernel level.
  // ONLY set in production — in dev, the Electron binary is shared
  // (com.github.Electron) and we don't contaminate other projects.
  if (process.platform === 'darwin' && app.isPackaged) {
    try {
      execSync('defaults write com.homelander.app NSAppSleepDisabled -bool YES', { timeout: 2000 });
    } catch (err) { swallow(err, 'main/app-nap-defaults'); }
  }

  // Prevent macOS system sleep from the moment the app launches.
  // (App Nap is prevented separately via NSAppSleepDisabled above.)
  try { _powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension'); } catch (err) {}

  app.setName('Homelander');

  loadConfig();
  registerIpcHandlers();
  await createWindow();

  // Don't auto-launch Chrome or daemon — user clicks "Start" when ready
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  // Don't quit on macOS — app stays in background
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  closeSharedDb();
  app.isQuitting = true;

  // Explicitly release the IOPMAssertion before the JS heap dies.
  if (_powerSaveBlockerId != null && powerSaveBlocker.isStarted(_powerSaveBlockerId)) {
    try { powerSaveBlocker.stop(_powerSaveBlockerId); } catch (err) {}
    _powerSaveBlockerId = null;
  }

  stopDaemon();
  chromeManager.shutdown().catch((err) => { swallow(err, 'main/chrome-shutdown-close'); });
});
