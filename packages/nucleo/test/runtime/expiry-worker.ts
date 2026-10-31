import { parentPort, workerData } from 'node:worker_threads';
import { SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { SqliteRuntimeStore } from '../../src/runtime/sqlite.ts';
import { RuntimeError, type RuntimeScope } from '../../src/runtime/contracts.ts';

const { path, scope, runId, requestId, shared } = workerData as {
  path: string; scope: RuntimeScope; runId: string; requestId: string; shared: SharedArrayBuffer;
};
const barrier = new Int32Array(shared);
const storage = new SqliteStorage({ path });
try {
  const exec = storage.db.exec.bind(storage.db);
  storage.db.exec = (sql: string) => {
    if (sql === 'BEGIN IMMEDIATE') parentPort!.postMessage({ type: 'waiting' });
    return exec(sql);
  };
  parentPort!.postMessage({ type: 'ready' });
  if (Atomics.wait(barrier, 0, 0, 30_000) === 'timed-out') throw new Error('Expiry barrier timed out');
  const clock = () => { Atomics.add(barrier, 2, 1); return Atomics.load(barrier, 1); };
  try {
    new SqliteRuntimeStore(storage.db).claimResponse(scope, runId, requestId, { kind: 'approval', decision: 'approve' }, clock);
    throw new Error('Expired approval was accepted');
  } catch (error) {
    if (!(error instanceof RuntimeError) || error.code !== 'stale_request') throw error;
    parentPort!.postMessage({ type: 'result', code: error.code });
  }
} finally { await storage.close(); }
