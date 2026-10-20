// Esquema SQLite das amostras da telemetria (#175). Entra na lista de migrações do adaptador
// (adapters/sqlite/migrations.ts) como uma migração própria, aditiva: tabela nova.
//
// Uma linha por amostra e máquina. As colunas são o que as séries e o alerta de carga leem sem abrir
// a leitura; `reading` é a leitura inteira em JSON, para a "leitura atual" e para o que a tela
// mostra além das séries. 12 h a cada 30 s são 1440 linhas por máquina, podadas a cada gravação.

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
