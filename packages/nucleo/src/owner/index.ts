// Single-owner core (issue #86): the lock, adoption and exiting when the parent is gone.
export {
  examine,
  planStart,
  claimLock,
  stopCore,
  watchParent,
  compareCode,
  codeWarning,
  PARENT_CHECK_INTERVAL_MS,
  type Examination,
  type StartPlan,
  type StartPlanOptions,
  type CodeIdentity,
  type CodeComparison,
} from './owner.ts';
export { startOrAdopt, type StartOutput, type StartOptions } from './start.ts';
export { codeCommit, isOlderCommit } from './commit.ts';
export { readLock, writeLock, createLock, removeLock, releaseLock, prepareDir, lockFilePath, defaultDir, newToken, LOCK_FILE_NAME, type Lock } from './lock.ts';
export { registerClient, removeClient, liveClients } from './clients.ts';
export { isPidAlive, probe, probeCore, waitForCore, compareVersions, reservePort, releasePort, CORE_NAME, type CoreView } from './probe.ts';
