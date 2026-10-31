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
  // Both workers open independent SQLite connections before either may claim the request.
  Atomics.add(barrier, 0, 1);
  parentPort!.postMessage({ type: 'ready' });
  if (Atomics.wait(barrier, 1, 0, 30_000) === 'timed-out') throw new Error('Claim barrier timed out');
  const store = new SqliteRuntimeStore(storage.db);
  try {
    store.claimResponse(scope, runId, requestId, { kind: 'approval', decision: 'approve' }, 1003);
    parentPort!.postMessage({ type: 'result', status: 'accepted' });
  } catch (error) {
    if (!(error instanceof RuntimeError) || error.code !== 'stale_request') throw error;
    parentPort!.postMessage({ type: 'result', status: 'rejected', code: error.code });
  }
} finally {
  await storage.close();
}
