# Homelander

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
3. **Apply loop** → picks one pending listing per filter → `IS24Contactor.apply()` → opens expose page via CDP → fills contact form → submits → records outcome in SQLite
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
│   └── url-translator.js # IS24 web URL → mobile API params + fetchListings()
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
├── test/                 # Unit tests: db.test.js, is24-contactor.test.js, url-translator.test.js, smoke-db.mjs
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
- **never use system Chrome** — always the Puppeteer-bundled Chromium
- **do not poll IS24 login pages** — login flow is bot-sensitive; use plain Chromium process without CDP
- **Tauschwohnung listings immune to captcha wall** — recognized in URL translator, ideal for reliable sends
- **Picked-area `geocodes=` replace the path region** — the mobile API unions comma-separated geocodes, so sending both widens the search back to the whole city; `bbox` intersects with them and 412s without any geocode
- **Drawn `shape=` must be decoded, `bbox=` must not** — both are IS24 base64 (`/`→`-`, `+`→`_`, `=`→`.`) over encoded polylines, but the mobile API takes `bbox` in either form and answers 400 for an encoded `shape`; multiple drawn areas travel as one `;`-joined value (repeating the param is a 412)
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
- **Contactor → about:blank after every apply** — fresh page for next listing to avoid SPA state carryover
