// The channel end to end through the real owner `start` (#619, layer 2): the descriptor handed to `start` reaches the core it starts,
// the core asks the NATIVE verifier (not the stub of layer 1) about each credential line, and this test process, which created the
// socketpair and is not the installed app, is refused. A fake HOME keeps it away from the real console folder.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INSTALLED_APP_PATH } from '../permissions/adapters/native-peer-verifier.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const HOOKS_ONLY = ['--no-history', '--no-desktop', '--no-github', '--no-telemetry'];
const CREDENTIAL = 'd4'.repeat(32);

/* Where the installed app is present, the native check would run it (an older one without the helper mode would open its window), so the
   test does not run there; the verifier's own tests and the app's helper test cover that side. Elsewhere the check cannot look. */
const installed = process.platform === 'darwin' && existsSync(INSTALLED_APP_PATH);

test('the channel handed to start reaches the core, which refuses this process and never holds the credential (#619)', { skip: installed ? 'the installed app is present: the check would run it' : false }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'ahrena-window-e2e-'));
  const dir = join(home, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: home };
  const args = ['--disable-warning=ExperimentalWarning', CLI, 'start', '--installation', 'dev', '--data-dir', dir, '--port', '0', '--window-channel', '3', '--json', '--', ...HOOKS_ONLY];
  try {
    const p = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'inherit', 'pipe'] });
    const channel = p.stdio[3] as Socket;
    let out = '';
    p.stdout?.setEncoding('utf8').on('data', (d: string) => (out += d));
    await new Promise((r) => p.once('exit', r));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((JSON.parse(out.trim()) as { state: string }).state, 'up');
    channel.write(`${CREDENTIAL}\n`);
    // macOS: the line reaches the native verifier, which cannot find the app (unavailable). Elsewhere the descriptor cannot be reopened.
    const expected = process.platform === 'darwin' ? /window channel refused peer=unavailable/ : /window channel unavailable reason=reopen/;
    let log = '';
    for (let i = 0; i < 100 && !expected.test(log); i++) {
      await new Promise((r) => setTimeout(r, 100));
      log = readFileSync(join(dir, 'nucleo.log'), 'utf8');
    }
    assert.match(log, expected);
    assert.doesNotMatch(log, /window channel accepted/);
    assert.ok(!log.includes(CREDENTIAL));
    channel.destroy();
  } finally {
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'stop', '--installation', 'dev', '--data-dir', dir], { env, stdio: 'ignore' });
    rmSync(home, { recursive: true, force: true });
  }
});
