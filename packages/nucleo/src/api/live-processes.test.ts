/* The registry as a list (#722, #720): the live `claude` processes with the fields attribution reads. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { LiveClaudeProcesses } from './live-processes.ts';

const A = '0f8c1a52-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const B = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

describe('LiveClaudeProcesses.listLive', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahrena-live-list-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  test('#720/AC-2 Given two sessions registered and one pid dead, Then only the live one is listed, with its folder and procStart', async () => {
    const dir = join(root, 'cfg');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    writeFileSync(join(dir, 'sessions', '101.json'), JSON.stringify({ pid: 101, sessionId: A, cwd: '/w/a', procStart: 'Tue Oct 20 04:00:34 2026' }));
    writeFileSync(join(dir, 'sessions', '202.json'), JSON.stringify({ pid: 202, sessionId: B, cwd: '/w/b', procStart: 'Tue Oct 20 05:00:00 2026' }));
    const live = new LiveClaudeProcesses({ folders: () => [dir], isAlive: (pid) => pid === 101 });
    await live.refresh();
    assert.deepEqual(live.listLive(), [{ pid: 101, sessionId: A, cwd: '/w/a', procStart: 'Tue Oct 20 04:00:34 2026', configDir: dir }]);
  });

  test('#720/AC-2 Given no scan yet, Then the list is empty', () => {
    assert.deepEqual(new LiveClaudeProcesses({ folders: () => [], isAlive: () => true }).listLive(), []);
  });
});
