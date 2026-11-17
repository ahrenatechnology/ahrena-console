// Restart behaviour of the follower (#707): with the history already imported, a start loads only the
// sessions of the files that changed. Temporary directory and synthetic lines; no real transcript.

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openSqliteStorage } from '../../adapters/sqlite/sqlite-storage.ts';
import type { StoragePort } from '../../storage-port.ts';
import { followTranscripts } from './follower.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ahrena-follower-restart-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const sid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
let clock = Date.parse('2026-11-02T12:00:00.000Z');
const line = (sessionId: string, uuid: string, extra: Record<string, unknown> = {}) => {
  clock += 1000;
  const entry = { sessionId, type: 'user', uuid, cwd: '/x', isSidechain: false, timestamp: new Date(clock).toISOString(), message: { role: 'user', content: uuid }, ...extra };
  return JSON.stringify(entry) + '\n';
};

function fixture(name: string, sessions: number) {
  const root = join(tmp, name);
  mkdirSync(join(root, '-p'), { recursive: true });
  const files: string[] = [];
  for (let i = 0; i < sessions; i++) {
    const path = join(root, '-p', `${sid(i)}.jsonl`);
    writeFileSync(path, line(sid(i), `u${i}-1`) + line(sid(i), `u${i}-2`));
    files.push(path);
  }
  return { root, files };
}

/** Counts the sessions the importer loads: it loads one per file it was handed. */
function counting(storage: StoragePort) {
  const loaded: string[] = [];
  const proxy = new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop === 'getSession') {
        return (id: string) => {
          loaded.push(id);
          return target.getSession(id);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { proxy, loaded };
}

async function restart(root: string, storage: StoragePort) {
  const { proxy, loaded } = counting(storage);
  const follower = followTranscripts({ storage: proxy, root, watch: false, scanIntervalMs: 3_600_000 });
  const report = await follower.start();
  await follower.stop();
  return { report, loaded };
}

test('AC-2: a restart with the history imported reads only the files that changed', async () => {
  const { root, files } = fixture('changed', 5);
  // A subagent transcript, so the restart also has to match a marker kept on an agent row.
  const subDir = join(root, '-p', sid(0), 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'agent-a1.jsonl'), line(sid(0), 'a1-1', { isSidechain: true, agentId: 'a1' }));
  const storage = openSqliteStorage({ path: join(tmp, 'changed.sqlite') });
  try {
    const first = await restart(root, storage);
    assert.equal(first.report.filesRead, 6);

    const untouched = await restart(root, storage);
    assert.equal(untouched.report.filesFound, 0);
    assert.deepEqual(untouched.loaded, []);

    appendFileSync(files[2], line(sid(2), 'u2-3'));
    const grown = await restart(root, storage);
    assert.equal(grown.report.filesFound, 1);
    assert.equal(grown.report.filesRead, 1);
    assert.equal(grown.report.eventsAdded, 1);
    assert.deepEqual(grown.loaded, [sid(2)]);
  } finally {
    await storage.close();
  }
});

test('a new file and a truncated file are still imported on restart', async () => {
  const { root, files } = fixture('new-and-truncated', 3);
  const storage = openSqliteStorage({ path: join(tmp, 'new-and-truncated.sqlite') });
  try {
    await restart(root, storage);
    writeFileSync(join(root, '-p', `${sid(9)}.jsonl`), line(sid(9), 'u9-1'));
    truncateSync(files[0], 0);
    writeFileSync(files[0], line(sid(0), 'u0-9'));
    const second = await restart(root, storage);
    assert.deepEqual([...second.loaded].sort(), [sid(0), sid(9)].sort());
    assert.equal(second.report.eventsAdded, 2);
    assert.equal(second.report.filesRewound, 1);
  } finally {
    await storage.close();
  }
});
