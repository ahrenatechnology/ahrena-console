// Single-owner core (issue #86): the lock, adoption and exiting when the parent is gone. One core per
// installation, on a random port, with the instance registry (decision 0010, issue #221).
export {
  examine,
  planStart,
  claimLock,
  stopCore,
  watchParent,
  compareCode,
  codeWarning,
  PARENT_CHECK_INTERVAL_MS,
  ReplaceError,
  type Examination,
  type StartPlan,
  type StartPlanOptions,
  type CodeIdentity,
  type CodeComparison,
} from './owner.ts';
export { startOrAdopt, runningOutput, type StartOutput, type StartOptions } from './start.ts';
export { codeCommit, isOlderCommit } from './commit.ts';
export { readLock, writeLock, createLock, removeLock, releaseLock, prepareDir, lockFilePath, defaultDir, newToken, LOCK_FILE_NAME, type Lock } from './lock.ts';
export { registerClient, removeClient, liveClients } from './clients.ts';
export { isPidAlive, probe, probeCore, waitForCore, compareVersions, reservePort, releasePort, CORE_NAME, type CoreView } from './probe.ts';
export {
  INSTALLATIONS,
  DEFAULT_INSTALLATION,
  APP_IDENTIFIER,
  isInstallation,
  parseInstallation,
  consoleHome,
  defaultDataDir,
  resolveDataDir,
  resolvePort,
  type Installation,
} from './installation.ts';
export {
  INSTANCES_DIR_NAME,
  instancesDir,
  instanceId,
  writeInstance,
  removeInstance,
  listInstances,
  pickInstance,
  verifyInstance,
  type Instance,
} from './registry.ts';
export { acquireStartGuard, START_GUARD_FILE_NAME, type StartGuard } from './start-guard.ts';
