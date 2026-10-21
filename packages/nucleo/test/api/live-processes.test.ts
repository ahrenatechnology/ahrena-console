// #285: the live `claude` processes of this machine, from `<config>/sessions/<pid>.json` in every
// configuration folder (decision 0006). Fake folders and a fake liveness check: no real process is touched.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { LiveClaudeProcesses, pidIsAlive } from '../../src/api/live-processes.ts';

const A = '0f8c1a52-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const B = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

describe('LiveClaudeProcesses', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahrena-live-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const folder = (name: string) => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    return dir;
  };
  const write = (dir: string, file: string, body: unknown) => writeFileSync(join(dir, 'sessions', file), typeof body === 'string' ? body : JSON.stringify(body));

  test('reads every configuration folder and keeps only live pids', async () => {
    const one = folder('one');
    const two = folder('two');
    write(one, '101.json', { pid: 101, sessionId: A, cwd: '/w/a', procStart: 'Tue Oct 20 04:00:34 2026', status: 'busy' });
    write(two, '202.json', { pid: 202, sessionId: B, cwd: '/w/b' });
    const alive = new Set([101]);
    const live = new LiveClaudeProcesses({ folders: async () => [one, two], isAlive: (pid) => alive.has(pid) });
    await live.refresh();
    assert.deepEqual(live.find(A), { pid: 101, sessionId: A, cwd: '/w/a', procStart: 'Tue Oct 20 04:00:34 2026' });
    assert.equal(live.find(B), null, 'the file outlived its process');
    alive.add(202);
    assert.equal(live.find(B)?.pid, 202, 'liveness is checked on each find');
  });

  test('refuses a file whose pid differs from its name, a non-UUID session id, junk and other names', async () => {
    const dir = folder('junk');
    write(dir, '303.json', { pid: 304, sessionId: A });
    write(dir, '305.json', { pid: 305, sessionId: 'not-a-uuid' });
    write(dir, '306.json', '{not json');
    write(dir, 'x.json', { pid: 307, sessionId: B });
    const live = new LiveClaudeProcesses({ folders: () => [dir], isAlive: () => true });
    await live.refresh();
    assert.equal(live.find(A), null);
    assert.equal(live.find(B), null);
  });

  test('re-reads only after the interval; a removed file goes away', async () => {
    const dir = folder('interval');
    write(dir, '401.json', { pid: 401, sessionId: A, cwd: '/w/a' });
    let now = 0;
    const live = new LiveClaudeProcesses({ folders: () => [dir], isAlive: () => true, now: () => now, intervalMs: 5_000 });
    await live.refresh();
    assert.equal(live.find(A)?.pid, 401);
    rmSync(join(dir, 'sessions', '401.json'));
    await live.refresh();
    assert.equal(live.find(A)?.pid, 401, 'within the interval, the last reading');
    now = 6_000;
    await live.refresh();
    assert.equal(live.find(A), null);
  });

  test('two files for one session: the newest wins', async () => {
    const dir = folder('newest');
    write(dir, '501.json', { pid: 501, sessionId: A });
    write(dir, '502.json', { pid: 502, sessionId: A });
    utimesSync(join(dir, 'sessions', '501.json'), new Date(1_000), new Date(1_000));
    const live = new LiveClaudeProcesses({ folders: () => [dir], isAlive: () => true });
    await live.refresh();
    assert.equal(live.find(A)?.pid, 502);
  });

  test('a missing folder is no process', async () => {
    const live = new LiveClaudeProcesses({ folders: () => [join(root, 'absent')], isAlive: () => true });
    await live.refresh();
    assert.equal(live.find(A), null);
  });

  test('pidIsAlive: this process is alive; an absurd pid is not', () => {
    assert.equal(pidIsAlive(process.pid), true);
    assert.equal(pidIsAlive(2 ** 30), false);
  });
});
