# AGENTS.md — Homelander

Desktop app for automated IS24 apartment applications. Paste an IS24 search URL — Homelander polls for new listings and auto-applies for you via a bundled Chromium browser.

- **Repo:** `https://github.com/B1Z0N/homelander`
- **Author:** Mykola Fedurko (B1Z0N)
- **License:** MIT

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop shell | Electron 42, Node 24 |
| Renderer | React 19, Vite 6, Tailwind CSS 4 |
| State | Zustand 5 (single store, no Redux) |
| Browser automation | Puppeteer 24 (bundled Chromium), Chrome CDP |
| Database | better-sqlite3 12, WAL mode, single-file SQLite |
| Auth / captcha | 2captcha, IS24 session cookies in Chromium profile |
| Build / package | electron-builder, macOS `.dmg` + `.zip`, Windows `.exe` (NSIS), Linux `.deb` + `.AppImage` |
| CI | GitHub Actions, `macos-latest`, Node 22 |
| Release | `workflow_dispatch` with version tag + platform matrix |

## Architecture

Homelander is an **Electron app** with a **forked daemon process** for background work.

```
┌─ Electron main (electron/main.js) ─────────────────────────────────┐
│  • App lifecycle, BrowserWindow, Tray                              │
│  • Chrome lifecycle (electron/chrome.js) — Puppeteer + CDP         │
│  • Config load/save (JSON at ~/.homelander/config.json)            │
│  • IPC bridge (electron/preload.cjs) — contextBridge               │
│  • Support bundle generation                                       │
│                                                                     │
│  ┌─ Daemon child process (engine/daemon.js) ──────────────────┐    │
│  │  Forked via child_process.fork(), communicates via stdout   │    │
│  │  JSON lines + IPC                                            │    │
│  │                                                               │    │
│  │  Two independent async loops:                                │    │
│  │    pollLoop  — hits IS24 Mobile API every N seconds,         │    │
│  │                writes new listings to SQLite                 │    │
│  │    applyLoop — reads pending listings from SQLite,           │    │
│  │                drives CDP browser to fill + submit forms     │    │
│  │                                                               │    │
│  │  Uses: engine/is24-contactor.js (IS24Contactor class)        │    │
│  │        engine/url-translator.js (web URL → mobile API)       │    │
│  │        engine/db.js (HomelanderDB — better-sqlite3 wrapper)  │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─ Renderer (src/) ──────────────────────────────────────────┐    │
│  │  React 19 SPA built with Vite, styled with Tailwind CSS 4   │    │
│  │                                                               │    │
│  │  Tabs: Searches | History | Settings                         │    │
│  │  Setup wizard on first launch (5 steps)                      │    │
│  │  IPC via window.homelander.* (preload bridge)                │    │
│  └───────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

### Key Flows

1. **User adds search** → URL validated → translated to mobile API params → saved in SQLite
2. **Poll loop** → `engine/url-translator.js` → `fetchListings()` → IS24 Mobile API (`api.mobile.immobilienscout24.de/search/list`) → new listings written to SQLite with `status='seen'`
3. **Apply loop** → picks one pending listing per filter → `MessageComposer.compose()` drafts the message (AI, else template) → `IS24Contactor.apply()` → opens expose page via CDP → fills contact form → submits → records outcome in SQLite
   - **AI drafting** → `ai-providers.js` picks a provider (`acp` spawns an agent harness and speaks Agent Client Protocol over stdio; `openai-compatible` POSTs to any `/chat/completions` endpoint) → `primary` attempt, then `fallback` attempt, then the template. Each attempt carries its own harness + model + reasoning level, so the fallback can be a different agent entirely.
4. **Captcha wall** → 5 consecutive captcha failures → apply pauses for 15 min → auto-resumes
5. **Session expiry** → IS24 login detected as expired → apply pauses → user re-logs in → resumes

### Chrome/Browser

- **One bundled Chromium profile** owned by Puppeteer (not system Chrome)
- Profile stored at `~/.homelander/chrome-profiles/profile-<hash>/`
- Manual login: plain Chromium process (no CDP, no `--enable-automation`) to avoid bot detection on IS24 SSO
- After login, CDP launches on port 9222 for the daemon to use
- Browser visibility: `hidden_unless_needed` by default; shows when user needs to interact
- Max 5 tabs; restart throttle: 3/hour

## Source Tree

```
homelander/
├── electron/             # Electron main process
│   ├── main.js           # App lifecycle, IPC handlers, daemon management, config
│   ├── chrome.js         # ChromeManager — Puppeteer/Chromium lifecycle, CDP
│   └── preload.cjs       # contextBridge (must be CommonJS): window.homelander.*
├── engine/               # Daemon (forked child process)
│   ├── daemon.js         # pollLoop + applyLoop, IPC, pause/captcha logic
│   ├── db.js             # HomelanderDB — SQLite via better-sqlite3, WAL mode
│   ├── is24-contactor.js # IS24Contactor — CDP form filling, captcha solving
│   ├── url-translator.js # IS24 web URL → mobile API params + fetchListings()
│   ├── message-composer.js # MessageComposer — AI draft with template fallback
│   ├── ai-providers.js   # Provider registry: acp | openai-compatible
│   ├── acp-client.js     # AcpClient — Agent Client Protocol over stdio
│   └── harness-detect.js # Finds installed ACP CLIs (Claude Code, Codex, Gemini)
├── src/                  # Renderer (React SPA)
│   ├── main.jsx          # React entry point
│   ├── App.jsx           # Tab nav, daemon controls, event listeners
│   ├── stores/appStore.js      # Zustand store (single source of truth)
│   ├── screens/
│   │   ├── SearchTab.jsx       # Manage searches (add/remove/pause/poll-now)
│   │   ├── HistoryTab.jsx      # Outcome feed with filters + retry
│   │   ├── SettingsTab.jsx     # Persona, timing, message, captcha config
│   │   └── SetupWizard.jsx     # First-launch 5-step wizard
│   ├── components/
│   │   ├── ActivityFeed.jsx    # Listing activity list component
│   │   ├── FilterCard.jsx      # Per-search status card + controls
│   │   └── StatusDot.jsx       # Colored status indicator
│   ├── locales/
│   │   ├── de.json, en.json    # i18n strings
│   │   └── LocaleContext.jsx   # React context for locale
│   └── shared/
│       ├── is24FormOptions.js  # IS24 form field options (anrede, etc.)
│       ├── searchUrlUi.js      # URL parsing helpers
│       └── userErrors.js       # Error formatting + support ID generation
├── config/
│   └── autoapply.config.example.yaml  # OLD v2 format — DO NOT USE
├── brand/                # Brand assets (gold key icon, #D9A441)
├── resources/            # App icon files (icon.icns, icon.ico, icon.png)
├── scripts/              # Debug scripts, autoapply.sh, i18n checker
├── test/                 # Unit tests: db.test.js, is24-contactor.test.js, url-translator.test.js, acp-client.test.js, message-composer.test.js, harness-detect.test.js, smoke-db.mjs
├── .github/workflows/
│   ├── ci.yml            # PR + push: test, build, whitespace check (macOS)
│   └── release.yml       # workflow_dispatch: platform matrix, electron-builder, upload to release
├── vite.config.js        # Vite config: root=src, outDir=dist, port 5173
├── electron-builder.yml  # Packaging: dmg/zip (macOS), nsis (Windows), deb+AppImage (Linux)
└── package.json          # v1.1.4, "type": "module"
```

## Config (v3)

Runtime config at `~/.homelander/config.json` — read/written by Electron main process:

```json
{
  "persona": { "anrede": "", "vorname": "", "nachname": "", "email": "", "telefon": "",
               "strasse": "", "hausnummer": "", "plz": "", "ort": "", "einzug": "",
               "personen": "", "haustiere": "", "haustiere_zusatz": "", "beschaeftigung": "",
               "einkommen": "", "unterlagen": "" },
  "is24": { "email": "", "password": "" },
  "captcha": { "api_key": "" },
  "message_template": "... {{title}} {{address}} {{name}} ...",
  "ai": { "enabled": false, "provider": "acp", "timeout_seconds": 90, "prompt": "",
          "primary":  { "harness_id": "", "command": "", "args": [], "model": "", "thought_level": "" },
          "fallback": { "harness_id": "", "command": "", "args": [], "model": "", "thought_level": "" },
          "cwd": "", "env": {}, "auth_method_id": "",
          "base_url": "", "api_key": "", "headers": {}, "max_tokens": 1024 },
  "timing": { "speed": "balanced", "overrides": {} },
  "polling": { "interval_seconds": 600 },
  "browser": { "visibility": "hidden_unless_needed", "max_tabs": 5 },
  "_setupComplete": false
}
```

Config is **NOT** the old `autoapply.config.yaml` — that file in `config/` is obsolete.

## Data

- **SQLite DB:** `~/.homelander/homelander.db` (WAL mode, `filters`, `listings`, `results` tables)
- **Config:** `~/.homelander/config.json`
- **Daemon log:** `~/.homelander/daemon.log`
- **Debug artifacts:** `~/.homelander/debug/{html,screenshots}/`
- **Pause flag:** `~/.homelander/.apply-paused`
- **Support bundles:** `~/.homelander/support-bundles/`

## Brand

- **Primary color:** Gold `#D9A441` on solid white `#FFFFFF` background
- **macOS:** `.icns` must be opaque white (not transparent → renders gray/dusty)
- **Never** use `app.dock.setIcon()` — bypasses macOS squircle mask → renders square
- **Logo:** gold Homelander key on transparent/white canvas
- **Master:** `brand/icon.svg` (vector), `brand/icon.png` (2048×2048 raster)

## Development

```bash
npm install                    # includes Puppeteer bundled Chromium
npm run dev                    # Vite + Electron concurrently
npm run dev:renderer           # Vite only (port 5173)
npm run dev:electron           # Electron only

npm test                       # unit tests + i18n check
npm run test:unit              # Node test runner (HOMELANDER_TEST_FAST=1)
npm run test:i18n              # Hardcoded string checker
npm run smoke:db               # DB smoke test

npm run build                  # Vite production build
npm run dist:mac               # macOS .dmg + .zip
npm run dist:win               # Windows .exe
npm run dist:linux             # Linux .deb + .AppImage
```

## Key Invariants

- **ContextBridge is CommonJS** — `electron/preload.cjs` MUST stay `.cjs`; ESM breaks `contextBridge.exposeInMainWorld()`
- **Single-instance lock** — Electron `requestSingleInstanceLock()` prevents duplicate processes
- **Daemon communicates via stdout JSON** — types: `stats`, `listing`, `paused`, `resumed`, `error`, `poll_error`, `session_expired`, `chrome_dead`, `ready_for_restart`
- **Config is mutable at runtime** — daemon receives config patches via IPC `mergePatch()`, no restart needed
- **Test flag:** `HOMELANDER_TEST_FAST=1` disables all jitter/timeouts in the contactor
- **Puppeteer downloads skipped in CI:** `PUPPETEER_SKIP_DOWNLOAD=true`
- **Never use system Chrome** — always the Puppeteer-bundled Chromium
- **Do not poll IS24 login pages** — login flow is bot-sensitive; use plain Chromium process without CDP
- **Tauschwohnung listings immune to captcha wall** — recognized in URL translator, ideal for reliable sends
- **Per-form login check** — daemon checks IS24 login state before each apply, not just at startup
- **HTML snapshots are raw-copied in support bundles (no redaction)** — blocked on Electron main thread if regex-heavy

## Release Process

Releases are `workflow_dispatch` only (never triggered automatically):
1. Bump version in `package.json`
2. Commit, tag (`vX.Y.Z`)
3. `gh release create vX.Y.Z --title "Homelander vX.Y.Z"`
4. `gh workflow run release.yml -f version=vX.Y.Z -f platforms=mac`

**Never** trigger a release without explicit user request. The `version` input field is required — without `-f version=vTAG`, it defaults to `v1.0.5` (wrong).

## Common Pitfalls

- **`npm install` must run without `--ignore-scripts` in dev** — `better-sqlite3` native addon must compile
- **`electron-rebuild` needed after install** — `npm run postinstall` handles this (but `npm ci --ignore-scripts` skips it)
- **IS24 session detection:** check `innerText` for "angemeldet als" (logged in) vs "Anmelden" (logged out); do NOT trust cookie presence alone
- **AI message composition never blocks an application** — provider failure, timeout, refusal, or an unusable draft falls back to `message_template`; the daemon emits `ai_fallback` and applies anyway
- **PATH must be augmented before spawning a harness** — an Electron app launched from Finder/Dock inherits a minimal PATH (`/usr/bin:/bin:...`), so Homebrew/nvm/npm-global installs are invisible; `augmentedPath()` in `harness-detect.js` is used for both detection and spawning
- **Harness detection never spawns** — it is a PATH scan only, so it proves the binary exists, not that it speaks ACP; the Settings "Test" button is the real check
- **Model and reasoning level come from the harness** — both are ACP *session config options* (`category: "model"` / `"thought_level"`) read from the `session/new` response and set with `session/set_config_option`; there is no `session/set_model`. Homelander stores no model list of its own, so a Codex slot never offers Sonnet
- **The whole prompt is one editable template** — `DEFAULT_AI_PROMPT` in `message-composer.js` is what Settings shows and Reset restores; `buildPrompt()` only substitutes `{{listing}}`, `{{persona}}`, `{{template}}`, `{{language}}`. It is framed as a first-person request because a coding harness treats section headers, bullet dumps and unexpanded placeholders as untrusted tool output and answers with a refusal instead of a draft
- **A refusal must never reach the contact form** — `looksLikeRefusal()` rejects agent-talking-to-us replies in `sanitizeDraft()`, so they count as a failed attempt and fall through to the next attempt or the template
- **Message language follows the listing** — `detectListingLanguage()` picks de/en from the listing text and the prompt pins the reply language; German is the default when signals are weak
- **ACP client advertises no capabilities** — filesystem/terminal requests from the harness are refused and permission requests cancelled, so a coding harness can't touch the user's disk while drafting
- **Contactor → about:blank after every apply** — fresh page for next listing to avoid SPA state carryover
