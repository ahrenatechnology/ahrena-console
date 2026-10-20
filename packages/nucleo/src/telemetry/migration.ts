// SQLite schema for the telemetry samples (#175). It goes into the adapter's migration list
// (adapters/sqlite/migrations.ts) as a migration of its own, additive: a new table.
//
// One row per sample and machine. The columns are what the series and the load alert read without
// opening the reading; `reading` is the whole reading as JSON, for the "current reading" and for
// what the screen shows beyond the series. 12 h every 30 s is 1440 rows per machine, pruned on each
// write.

export const TELEMETRY_MIGRATION_DESCRIPTION = 'amostras da telemetria das máquinas (#175)';

export const TELEMETRY_MIGRATION_SQL = `
  CREATE TABLE telemetry_samples (
    machine_id TEXT NOT NULL,
    taken_at INTEGER NOT NULL,
    cpu_used_pct REAL,
    load1 REAL NOT NULL,
    cores INTEGER NOT NULL,
    memory_used_bytes INTEGER NOT NULL,
    swap_used_bytes INTEGER,
    rx_bytes_per_sec REAL,
    tx_bytes_per_sec REAL,
    gpu_used_pct REAL,
    reading TEXT NOT NULL,
    PRIMARY KEY (machine_id, taken_at)
  ) STRICT;
`;
