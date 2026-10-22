// `--demo --demo-github <state>` through cli.ts (#241): the core boots the connection in the state the
// /ui is built against, on the fake GitHub, and the GitHub-backed screens follow it (409 while not
// connected). `--demo-project none` leaves the kanban without a Project.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

const CLI = fileURLToPath(new URL('../../src/api/cli.ts', import.meta.url));
const children: ChildProcess[] = [];
after(() => children.forEach((c) => c.kill('SIGTERM')));

async function demo(...args: string[]): Promise<string> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, '--demo', '--port', '0', '--no-telemetry', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let err = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no core: ${err}`)), 20_000);
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (part: string) => {
      err += part;
      const m = /local API at (http:\/\/127\.0\.0\.1:\d+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
  });
}

const get = async (base: string, path: string) => {
  const r = await fetch(`${base}${path}`);
  return { status: r.status, json: (await r.json()) as any };
};

describe('#241 --demo-github through the command line', () => {
  test('connected (default): the screens answer and the kanban shows the demo Project', async () => {
    const base = await demo();
    const c = await get(base, '/api/connections');
    assert.deepEqual([c.json.github.state, c.json.github.login], ['connected', 'dev-sintetico']);
    assert.equal((await get(base, '/api/repos')).status, 200);
    const board = await get(base, '/api/project');
    assert.equal(board.status, 200);
    assert.deepEqual(board.json.selection, { owner: 'exemplo', number: 3, field: 'Status', from: 'demo' });
  });

  test('disconnected: 409 github-not-connected on the screens; --demo-project none', async () => {
    const base = await demo('--demo-github', 'disconnected', '--demo-project', 'none');
    assert.equal((await get(base, '/api/connections')).json.github.state, 'disconnected');
    for (const path of ['/api/repos', '/api/project', '/api/dev-console', '/api/adrs']) {
      assert.deepEqual(await get(base, path), { status: 409, json: { error: 'github-not-connected' } }, path);
    }
  });

  test('pending boots with a user code; no-client-id is unavailable', async () => {
    const pending = await get(await demo('--demo-github', 'pending'), '/api/connections');
    assert.equal(pending.json.github.state, 'pending');
    assert.match(pending.json.github.userCode, /^FAKE-/);
    const none = await get(await demo('--demo-github', 'no-client-id'), '/api/connections');
    assert.deepEqual([none.json.github.state, none.json.github.reason], ['unavailable', 'no-client-id']);
  });

  test('an unknown state, or --demo-github without --demo, stops the core', () => {
    const bad = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, '--demo', '--port', '0', '--demo-github', 'conectado'], { encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /--demo-github: one of connected/);
    const real = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, '--no-lock', '--port', '0', '--demo-github', 'pending'], { encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(real.status, 0);
    assert.match(real.stderr, /only apply with --demo/);
  });
});
