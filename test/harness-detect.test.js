// Unit tests for ACP harness detection — PATH scanning, the Electron
// minimal-PATH workaround, Windows extensions, and catalog fallbacks.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  whichSync,
  detectHarnesses,
  extraSearchDirs,
  augmentedPath,
  HARNESS_CATALOG,
} from '../engine/harness-detect.js';

/** existsSync stub over a fixed set of absolute paths. */
const fakeFs = (paths) => (p) => new Set(paths).has(p);

const posix = (paths, PATH = '/usr/bin:/bin') => ({
  env: { PATH, HOME: '/Users/tester' },
  platform: 'darwin',
  existsSync: fakeFs(paths),
  homedir: () => '/Users/tester',
});

describe('whichSync', () => {
  it('finds a command on PATH', () => {
    assert.equal(whichSync('codex', posix(['/usr/bin/codex'])), '/usr/bin/codex');
  });

  it('returns null when the command is absent', () => {
    assert.equal(whichSync('codex', posix(['/usr/bin/git'])), null);
  });

  it('returns null for a blank command', () => {
    assert.equal(whichSync('', posix(['/usr/bin/codex'])), null);
  });

  it('honours PATH order', () => {
    const deps = posix(['/usr/bin/claude', '/opt/homebrew/bin/claude'], '/opt/homebrew/bin:/usr/bin');
    assert.equal(whichSync('claude', deps), '/opt/homebrew/bin/claude');
  });

  it('finds tools outside the minimal PATH an Electron app inherits', () => {
    // /opt/homebrew/bin is NOT in PATH here — this is the Finder-launch case.
    const deps = posix(['/opt/homebrew/bin/claude'], '/usr/bin:/bin');
    assert.equal(whichSync('claude', deps), '/opt/homebrew/bin/claude');
  });

  it('finds npm-global and volta installs under HOME', () => {
    assert.equal(
      whichSync('claude-code-acp', posix(['/Users/tester/.npm-global/bin/claude-code-acp'])),
      '/Users/tester/.npm-global/bin/claude-code-acp'
    );
    assert.equal(
      whichSync('codex', posix(['/Users/tester/.volta/bin/codex'])),
      '/Users/tester/.volta/bin/codex'
    );
  });

  it('tries PATHEXT suffixes on Windows', () => {
    const deps = {
      env: { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD', USERPROFILE: 'C:\\Users\\t' },
      platform: 'win32',
      existsSync: fakeFs(['C:\\bin\\npx.CMD']),
      homedir: () => 'C:\\Users\\t',
    };
    assert.equal(whichSync('npx', deps), 'C:\\bin\\npx.CMD');
  });

  it('does not invent extensions on posix', () => {
    assert.equal(whichSync('npx', posix(['/usr/bin/npx.CMD'])), null);
  });
});

describe('extraSearchDirs / augmentedPath', () => {
  it('includes both Homebrew prefixes on macOS', () => {
    const dirs = extraSearchDirs({ env: { HOME: '/Users/t' }, platform: 'darwin', homedir: () => '/Users/t' });
    assert.ok(dirs.includes('/opt/homebrew/bin'));
    assert.ok(dirs.includes('/usr/local/bin'));
  });

  it('uses APPDATA npm on Windows', () => {
    const dirs = extraSearchDirs({
      env: { APPDATA: 'C:\\Users\\t\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\t' },
      platform: 'win32',
      homedir: () => 'C:\\Users\\t',
    });
    assert.ok(dirs.includes('C:\\Users\\t\\AppData\\Roaming\\npm'));
  });

  it('keeps inherited PATH first and de-duplicates', () => {
    const path = augmentedPath({ env: { PATH: '/usr/bin:/opt/homebrew/bin', HOME: '/Users/t' }, platform: 'darwin', homedir: () => '/Users/t' });
    const dirs = path.split(':');
    assert.equal(dirs[0], '/usr/bin');
    assert.equal(dirs.filter((d) => d === '/opt/homebrew/bin').length, 1);
  });
});

describe('detectHarnesses', () => {
  it('reports every catalog harness, detected or not', () => {
    const found = detectHarnesses(posix([]));
    assert.equal(found.length, HARNESS_CATALOG.length);
    assert.equal(found.every((h) => h.detected === false), true);
    assert.deepEqual(found.map((h) => h.id), ['claude-code', 'codex', 'gemini']);
  });

  it('prefers a direct ACP binary over the npx adapter', () => {
    const deps = posix(['/usr/bin/npx', '/usr/bin/claude', '/usr/bin/claude-code-acp']);
    const claude = detectHarnesses(deps).find((h) => h.id === 'claude-code');
    assert.equal(claude.detected, true);
    assert.equal(claude.command, 'claude-code-acp');
    assert.deepEqual(claude.args, []);
    assert.equal(claude.via, 'direct');
  });

  it('falls back to the npx adapter when only the CLI is installed', () => {
    const deps = posix(['/usr/bin/npx', '/usr/bin/claude']);
    const claude = detectHarnesses(deps).find((h) => h.id === 'claude-code');
    assert.equal(claude.detected, true);
    assert.equal(claude.command, 'npx');
    assert.deepEqual(claude.args, ['-y', '@agentclientprotocol/claude-agent-acp']);
    assert.equal(claude.via, 'npx');
    assert.equal(claude.binPath, '/usr/bin/claude');
  });

  it('does not offer an npx-based harness when npx is missing', () => {
    const codex = detectHarnesses(posix(['/usr/bin/codex'])).find((h) => h.id === 'codex');
    assert.equal(codex.detected, false);
  });

  it('detects codex and gemini independently', () => {
    const deps = posix(['/usr/bin/npx', '/usr/bin/codex', '/usr/bin/gemini']);
    const found = detectHarnesses(deps);
    const codex = found.find((h) => h.id === 'codex');
    const gemini = found.find((h) => h.id === 'gemini');
    assert.equal(codex.detected, true);
    assert.equal(codex.command, 'npx');
    assert.equal(gemini.detected, true);
    assert.equal(gemini.command, 'gemini');
    assert.deepEqual(gemini.args, ['--experimental-acp']);
    assert.equal(found.find((h) => h.id === 'claude-code').detected, false);
  });

  it('suggests no models — those come from the harness itself', () => {
    const found = detectHarnesses(posix(['/usr/bin/npx', '/usr/bin/claude', '/usr/bin/codex']));
    assert.equal(found.find((h) => h.id === 'claude-code').models, undefined);
    assert.equal(found.find((h) => h.id === 'codex').models, undefined);
  });
});
