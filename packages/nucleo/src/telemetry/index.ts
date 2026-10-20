// Telemetria das máquinas (#175, decisão 0008): modelo, alertas, portas, amostrador, leitura das
// rotas, coletores do Mac e do Linux e o adaptador SQLite das amostras.
export * from './model.ts';
export * from './ports.ts';
export { AlertTracker, computeAlerts, formatBytes, loadHighSince, type AlertChange, type AlertUpdate } from './alerts.ts';
export { buildSeries, emptySeries } from './series.ts';
export { publishAlertChanges, systemTimers, TelemetrySampler, type SamplerTimers, type TelemetrySamplerOptions } from './sampler.ts';
export { localMachine, TelemetryService, type MachineEntry, type TelemetryResponse, type TelemetryServiceOptions } from './service.ts';
export { TELEMETRY_MIGRATION_DESCRIPTION, TELEMETRY_MIGRATION_SQL } from './migration.ts';
export { SqliteTelemetryStore } from './adapters/sqlite.ts';
export { DarwinCollector } from './adapters/darwin.ts';
export { LinuxCollector } from './adapters/linux.ts';
export { collectorFor, systemDeps, systemProbe, systemRunner } from './adapters/system.ts';
