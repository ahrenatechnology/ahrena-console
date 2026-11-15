// How the owner `start` spawns the core (#619, layer 1): the window channel is fd 3 of a core it STARTS, never of an adopted one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTALLED_APP_PATH } from '../permissions/adapters/native-peer-verifier.ts';
import { coreSpawn, startOrAdopt } from './start.ts';

const base = { api: '/x/api/cli.ts', port: 0, installation: 'app' as const, dir: '/d', parent: null };

test('without a channel the core gets no fourth descriptor and no option', () => {
  const s = coreSpawn({ ...base }, 9);
  assert.deepEqual(s.stdio, ['ignore', 9, 9]);
  assert.ok(!s.args.includes('--window-channel'));
});

test('with a channel the core gets it as fd 3 and is told so', () => {
  const s = coreSpawn({ ...base, windowChannelFd: 5 }, 9);
  assert.deepEqual(s.stdio, ['ignore', 9, 9, 5]);
  const i = s.args.indexOf('--window-channel');
  assert.equal(s.args[i + 1], '3');
});

test('the channel cannot arrive through the API options after --', () => {
  assert.throws(() => coreSpawn({ ...base, apiArgs: ['--window-channel', '3'] }, 9), /--window-channel/);
  assert.throws(() => coreSpawn({ ...base, apiArgs: ['--window-channel=3'] }, 9), /--window-channel/);
});

test('bad API options throw before any plan or open: no data directory, no log file (#619)', async () => {
  const dir = join(tmpdir(), `ahrena-start-guard-${process.pid}-${Date.now()}`);
  await assert.rejects(startOrAdopt({ port: 0, installation: 'app', dir, parent: null, apiArgs: ['--window-channel', '3'] }), /--window-channel/);
  assert.equal(existsSync(dir), false);
});

/* The channel end to end through the real owner `start` (#619, layer 2): the descriptor handed to `start` reaches the core it starts, the
   core asks the NATIVE verifier (not the stub of layer 1) about each credential line, and this test process, which created the
   socketpair and is not the installed app, is refused. A fake HOME keeps it away from the real console folder. */
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const HOOKS_ONLY = ['--no-history', '--no-desktop', '--no-github', '--no-telemetry'];
const CREDENTIAL = 'd4'.repeat(32);
const ON_MACOS = process.platform === 'darwin';

/* Where the installed app is present, the native check would run it (an older one without the helper mode would open its window), so the
   test does not run there; the verifier's own tests and the app's helper test cover that side. Elsewhere the check cannot look. (#619) */
const installed = ON_MACOS && existsSync(INSTALLED_APP_PATH);

/** What `start --json` printed, as the one field this test reads. (#619) */
function startedState(out: string): string {
  const parsed: unknown = JSON.parse(out.trim());
  if (typeof parsed !== 'object' || parsed === null || !('state' in parsed) || typeof parsed.state !== 'string') assert.fail('start printed no state');
  return String(parsed.state);
}

test('the channel handed to start reaches the core, which refuses this process and never holds the credential (#619)', { skip: installed ? 'the installed app is present: the check would run it' : false }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ahrena-window-e2e-'));
  const dir = join(home, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: home };
  const args = ['--disable-warning=ExperimentalWarning', CLI, 'start', '--installation', 'dev', '--data-dir', dir, '--port', '0', '--window-channel', '3', '--json', '--', ...HOOKS_ONLY];
  try {
    // Off macOS the descriptor cannot be reopened: the owner reports that on its own stderr, not in the core's log (#619).
    const p = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', ON_MACOS ? 'inherit' : 'pipe', 'pipe'] });
    const channel = p.stdio[3] as Socket;
    let out = '';
    let err = '';
    p.stdout?.setEncoding('utf8').on('data', (d: string) => (out += d));
    p.stderr?.setEncoding('utf8').on('data', (d: string) => (err += d));
    await new Promise((r) => p.once('exit', r));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(startedState(out), 'up');
    channel.write(`${CREDENTIAL}\n`);
    const logPath = join(dir, 'nucleo.log');
    let log = '';
    if (ON_MACOS) {
      // The line reaches the native verifier, which cannot find the app: a closed cause, in the core's log. (#619)
      const expected = /window channel refused peer=unavailable reason=spawn/;
      for (let i = 0; i < 100 && !expected.test(log); i++) {
        await new Promise((r) => setTimeout(r, 100));
        log = readFileSync(logPath, 'utf8');
      }
      assert.match(log, expected);
    } else {
      assert.match(err, /window channel unavailable reason=reopen/);
      log = readFileSync(logPath, 'utf8');
      assert.doesNotMatch(log, /window channel/);
    }
    assert.doesNotMatch(log, /window channel accepted/);
    assert.ok(!log.includes(CREDENTIAL));
    assert.ok(!err.includes(CREDENTIAL));
    channel.destroy();
  } finally {
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'stop', '--installation', 'dev', '--data-dir', dir], { env, stdio: 'ignore' });
    rmSync(home, { recursive: true, force: true });
  }
});
