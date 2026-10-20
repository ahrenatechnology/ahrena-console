// Machine telemetry (#175, decision 0008): model, alerts, ports, sampler, the routes' reads, the Mac
// and Linux collectors and the SQLite adapter for the samples; the remote machines (#176).
export * from './model.ts';
export * from './ports.ts';
export { AlertTracker, computeAlerts, formatBytes, loadHighSince, machineUnreachableAlert, type AlertChange, type AlertUpdate } from './alerts.ts';
export { buildSeries, emptySeries } from './series.ts';
export { publishAlertChanges, systemTimers, TelemetrySampler, type SamplerTimers, type TelemetrySamplerOptions } from './sampler.ts';
export { localMachine, TelemetryService, type MachineEntry, type MachineStatus, type TelemetryResponse, type TelemetryServiceOptions } from './service.ts';
export {
  DEFAULT_RECONNECT_TIMEOUT_SECONDS,
  defaultMachinesFile,
  loadMachinesConfig,
  MachinesFileSource,
  parseMachinesConfig,
  parseReconnect,
  type MachinesConfig,
  type ReconnectConfig,
  type RemoteMachineConfig,
} from './machines-config.ts';
export { RemoteMachines, type ManagedMachine, type RemoteMachinesOptions } from './remote-machines.ts';
export { INVALID_MACHINES_FILE, publishReconnectChanges, reconnectEnv, reconnectLogFile, ReconnectRunner, type CancelResult, type ReconnectControl, type ReconnectRunnerOptions, type StartResult } from './reconnect.ts';
export { publishRemoteAttentionChanges, RemoteMachine, type RemoteMachineOptions, type RemoteSessionChange } from './remote.ts';
export { loopbackGet, REMOTE_HOST_HEADER, REMOTE_TIMEOUT_MS } from './adapters/loopback-http.ts';
export { TELEMETRY_MIGRATION_DESCRIPTION, TELEMETRY_MIGRATION_SQL } from './migration.ts';
export { SqliteTelemetryStore } from './adapters/sqlite.ts';
export { DarwinCollector } from './adapters/darwin.ts';
export { LinuxCollector } from './adapters/linux.ts';
export { collectorFor, systemDeps, systemProbe, systemRunner } from './adapters/system.ts';
