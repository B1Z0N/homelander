// Homelander — Electron preload script.
// Bridges main process ↔ renderer via contextBridge.
// This MUST be CommonJS (.cjs) for contextBridge to work.

const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('homelander', {
  // ── Daemon ────────────────────────────────────────────────
  startDaemon: () => ipcRenderer.invoke('daemon:start'),
  stopDaemon: () => ipcRenderer.invoke('daemon:stop'),
  pauseDaemon: () => ipcRenderer.invoke('daemon:pause'),
  resumeDaemon: () => ipcRenderer.invoke('daemon:resume'),
  getDaemonStatus: () => ipcRenderer.invoke('daemon:status'),
  pollNow: (filterId) => ipcRenderer.invoke('daemon:poll-now', filterId),
  clearQueue: (filterId) => ipcRenderer.invoke('daemon:clear-queue', filterId),
  retryListing: (exposeId) => ipcRenderer.invoke('daemon:retry-listing', exposeId),
  retryAllFailed: (filterId) => ipcRenderer.invoke('daemon:retry-all-failed', filterId),

  // ── Filters ───────────────────────────────────────────────
  getFilters: () => ipcRenderer.invoke('filters:list'),
  getFilter: (id) => ipcRenderer.invoke('filters:get', id),
  addFilter: (webUrl, name) => ipcRenderer.invoke('filters:add', webUrl, name),
  removeFilter: (id) => ipcRenderer.invoke('filters:remove', id),
  updateFilter: (id, patch) => ipcRenderer.invoke('filters:update', id, patch),
  testFilter: (webUrl, locale) => ipcRenderer.invoke('filters:test', webUrl, locale),

  // ── Listings / History ────────────────────────────────────
  getHistory: (limit, offset, filterId, outcome) =>
    ipcRenderer.invoke('listings:history', limit, offset, filterId, outcome),
  getStats: (filterId) => ipcRenderer.invoke('listings:stats', filterId),
  getTodayStats: (filterId) => ipcRenderer.invoke('listings:todayStats', filterId),
  markApplied: (url) => ipcRenderer.invoke('listings:mark-applied', url),
  createSupportBundle: (payload) => ipcRenderer.invoke('support:bundle', payload || { scope: 'global' }),

  // ── Config ────────────────────────────────────────────────
  getConfig: () => ipcRenderer.invoke('config:get'),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),

  // ── Chrome ────────────────────────────────────────────────
  getChromeStatus: () => ipcRenderer.invoke('chrome:status'),
  launchChrome: () => ipcRenderer.invoke('chrome:launch'),
  openLoginPage: () => ipcRenderer.invoke('chrome:openLogin'),
  focusBrowser: () => ipcRenderer.invoke('chrome:focus'),
  finalizeManualLogin: () => ipcRenderer.invoke('chrome:finalizeManualLogin'),
  openListingInChrome: (exposeIdOrUrl) => ipcRenderer.invoke('chrome:openListing', exposeIdOrUrl),
  checkIs24Login: () => ipcRenderer.invoke('chrome:checkIs24Login'),
  getIs24Email: () => ipcRenderer.invoke('chrome:getIs24Email'),

  // ── Setup ─────────────────────────────────────────────────
  getSetupComplete: () => ipcRenderer.invoke('setup:complete'),
  completeSetup: () => ipcRenderer.invoke('setup:done'),

  // ── Captcha ───────────────────────────────────────────────
  validateCaptchaKey: (key) => ipcRenderer.invoke('captcha:validate', key),

  // ── AI message composition ────────────────────────────────
  testAiMessage: (payload) => ipcRenderer.invoke('ai:test', payload),
  detectAiHarnesses: () => ipcRenderer.invoke('ai:detect-harnesses'),
  probeAiHarness: (payload) => ipcRenderer.invoke('ai:probe-harness', payload),
  getDefaultAiPrompt: () => ipcRenderer.invoke('ai:default-prompt'),

  // ── Events (main → renderer) ──────────────────────────────
  onEvent: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('homelander:event', handler);
    return () => ipcRenderer.removeListener('homelander:event', handler);
  },
  onStats: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('homelander:stats', handler);
    return () => ipcRenderer.removeListener('homelander:stats', handler);
  },
  onListing: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('homelander:listing', handler);
    return () => ipcRenderer.removeListener('homelander:listing', handler);
  },
  onError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('homelander:error', handler);
    return () => ipcRenderer.removeListener('homelander:error', handler);
  },

  // ── App lifecycle ───────────────────────────────────────────
  quit: () => ipcRenderer.invoke('app:quit'),
  cleanData: (email) => ipcRenderer.invoke('data:clean', email),
  resetApplications: (email) => ipcRenderer.invoke('data:reset-applications', email),
  openExternal: (url) => {
    // Allowlist: only https and mailto URLs
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
        shell.openExternal(url);
      }
    } catch {
      // Invalid URL — silently ignore
    }
  },
});
