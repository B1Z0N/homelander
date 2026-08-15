// Harness detection — finds ACP-capable agent CLIs already installed on the
// machine so Settings can offer them as a dropdown instead of making the user
// type a command line.
//
// Detection is a PATH scan, not a spawn: we never execute a candidate to see
// whether it exists. That keeps detection fast, side-effect free, and unit
// testable, at the cost of only proving the binary is *there* — whether it
// actually speaks ACP is what the Test button in Settings is for.

import { existsSync as fsExistsSync } from 'node:fs';
import path from 'node:path';
import { homedir as osHomedir } from 'node:os';

/**
 * Path semantics follow the *injected* platform, not the host's. At runtime
 * these are identical; the difference is that it makes Windows behaviour
 * (backslashes, ';' PATH delimiter) testable from a posix CI machine.
 */
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Known harnesses, each with candidate launch specs tried in order.
 *
 * `bin` is what must exist on PATH; `command`/`args` are what we actually
 * spawn. The two differ when a harness needs a separate ACP adapter: finding
 * the `claude` CLI means Claude Code is installed, but the thing that speaks
 * ACP is the adapter we run through npx.
 */
export const HARNESS_CATALOG = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    candidates: [
      { bin: 'claude-code-acp', command: 'claude-code-acp', args: [], via: 'direct' },
      { bin: 'claude', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'], via: 'npx', requires: 'npx' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    candidates: [
      { bin: 'codex-acp', command: 'codex-acp', args: [], via: 'direct' },
      { bin: 'codex', command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'], via: 'npx', requires: 'npx' },
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    candidates: [
      { bin: 'gemini', command: 'gemini', args: ['--experimental-acp'], via: 'direct' },
    ],
  },
];

/**
 * Where CLI tools actually live, beyond whatever PATH we inherited.
 *
 * An Electron app launched from Finder/Dock gets a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) — none of Homebrew, nvm, npm-global, volta,
 * or bun is on it. Without this, detection finds nothing on exactly the
 * machines where the harness *is* installed, and spawning a bare command name
 * later fails with ENOENT.
 */
export function extraSearchDirs({ env = process.env, platform = process.platform, homedir = osHomedir } = {}) {
  const { join } = pathFor(platform);
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === 'win32') {
    return [
      env.APPDATA ? join(env.APPDATA, 'npm') : null,
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'nodejs') : null,
      join(home, '.volta', 'bin'),
      join(home, '.bun', 'bin'),
    ].filter(Boolean);
  }
  return [
    '/opt/homebrew/bin',        // Apple Silicon Homebrew
    '/usr/local/bin',           // Intel Homebrew, node.org installer
    '/usr/bin',
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.local', 'share', 'pnpm'),
  ];
}

/** PATH plus the extra dirs above, de-duplicated. Use for detection and spawning. */
export function augmentedPath(deps = {}) {
  const env = deps.env || process.env;
  const { delimiter } = pathFor(deps.platform || process.platform);
  const inherited = String(env.PATH || '').split(delimiter).filter(Boolean);
  const merged = [...inherited, ...extraSearchDirs(deps)];
  return [...new Set(merged)].join(delimiter);
}

/** Executable extensions to try on Windows, where PATH entries are extensionless. */
function windowsExtensions(env) {
  const pathext = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return pathext.split(';').filter(Boolean);
}

/**
 * Resolve a bare command name against PATH — a dependency-free `which`.
 * @returns {string|null} Absolute path to the executable, or null.
 */
export function whichSync(command, deps = {}) {
  const { env = process.env, existsSync = fsExistsSync, platform = process.platform } = deps;
  if (!command) return null;
  const { join, delimiter } = pathFor(platform);
  const dirs = augmentedPath(deps).split(delimiter).filter(Boolean);
  const isWindows = platform === 'win32';
  const suffixes = isWindows ? ['', ...windowsExtensions(env)] : [''];

  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, command + suffix);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // Unreadable PATH entry — keep looking.
      }
    }
  }
  return null;
}

/**
 * Scan for every catalog harness.
 *
 * @returns {Array<{id, label, detected, command, args, binPath, via}>}
 *          One entry per catalog harness, detected or not, in catalog order.
 */
export function detectHarnesses(deps = {}) {
  const hasNpx = Boolean(whichSync('npx', deps));

  return HARNESS_CATALOG.map((harness) => {
    for (const candidate of harness.candidates) {
      if (candidate.requires === 'npx' && !hasNpx) continue;
      const binPath = whichSync(candidate.bin, deps);
      if (!binPath) continue;
      return {
        id: harness.id,
        label: harness.label,
        detected: true,
        command: candidate.command,
        args: candidate.args,
        binPath,
        via: candidate.via,
      };
    }
    return {
      id: harness.id,
      label: harness.label,
      detected: false,
      command: '',
      args: [],
      binPath: null,
      via: null,
    };
  });
}
