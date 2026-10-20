// Adaptador SQLite da porta das amostras (#175). Usa o mesmo banco do adaptador de armazenamento
// (`SqliteStorage.db`), que já aplicou a migração da telemetria. A gravação e a poda vão na mesma
// transação: a tabela nunca passa das 12 h, nem por um instante.

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { samplePointOf, type SamplePoint, type TelemetryReading } from '../model.ts';
import type { TelemetryStore } from '../ports.ts';

type Row = Record<string, unknown>;

const inteiro = (n: number | null) => (n === null ? null : Math.round(n));

export class SqliteTelemetryStore implements TelemetryStore {
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private readonly prune: StatementSync;
  private readonly points: StatementSync;
  private readonly newest: StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_samples'").get();
    if (!ok) throw new Error('banco sem a tabela de telemetria: abra-o com o SqliteStorage, que aplica as migrações');
    this.insert = db.prepare(`
      INSERT OR REPLACE INTO telemetry_samples
        (machine_id, taken_at, cpu_used_pct, load1, cores, memory_used_bytes, swap_used_bytes, rx_bytes_per_sec, tx_bytes_per_sec, gpu_used_pct, reading)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.prune = db.prepare('DELETE FROM telemetry_samples WHERE machine_id = ? AND taken_at < ?');
    this.points = db.prepare(`
      SELECT taken_at, cpu_used_pct, load1, cores, memory_used_bytes, swap_used_bytes, rx_bytes_per_sec, tx_bytes_per_sec, gpu_used_pct
      FROM telemetry_samples WHERE machine_id = ? AND taken_at >= ? ORDER BY taken_at`);
    this.newest = db.prepare('SELECT reading FROM telemetry_samples WHERE machine_id = ? ORDER BY taken_at DESC LIMIT 1');
  }

  async putSample(machineId: string, reading: TelemetryReading, retentionMs: number): Promise<void> {
    const p = samplePointOf(reading);
    if (!Number.isFinite(p.takenAt)) throw new RangeError(`takenAt inválido: ${reading.takenAt}`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insert.run(
        machineId,
        p.takenAt,
        p.cpuUsedPct,
        p.load1,
        p.cores,
        inteiro(p.memoryUsedBytes),
        inteiro(p.swapUsedBytes),
        p.rxBytesPerSec,
        p.txBytesPerSec,
        p.gpuUsedPct,
        JSON.stringify(reading),
      );
      this.prune.run(machineId, p.takenAt - retentionMs);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async listPoints(machineId: string, sinceMs: number): Promise<SamplePoint[]> {
    return (this.points.all(machineId, Math.floor(sinceMs)) as Row[]).map((r) => ({
      takenAt: r.taken_at as number,
      cpuUsedPct: r.cpu_used_pct as number | null,
      load1: r.load1 as number,
      cores: r.cores as number,
      memoryUsedBytes: r.memory_used_bytes as number,
      swapUsedBytes: r.swap_used_bytes as number | null,
      rxBytesPerSec: r.rx_bytes_per_sec as number | null,
      txBytesPerSec: r.tx_bytes_per_sec as number | null,
      gpuUsedPct: r.gpu_used_pct as number | null,
    }));
  }

  async latest(machineId: string): Promise<TelemetryReading | null> {
    const r = this.newest.get(machineId) as Row | undefined;
    return r ? (JSON.parse(r.reading as string) as TelemetryReading) : null;
  }

  /** Quantas amostras a máquina tem (testes e `/api/carga`). */
  count(machineId: string): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM telemetry_samples WHERE machine_id = ?').get(machineId) as { n: number };
    return r.n;
  }
}
