// As portas da telemetria (#175). O resto do núcleo depende só destas interfaces:
//
// - `TelemetryCollector`: mede a máquina. Um adaptador por plataforma (adapters/darwin.ts,
//   adapters/linux.ts) e o do simulador; cada um recebe o executor de comandos, a leitura de arquivo,
//   os dados do `node:os` e a sonda de porta, para os testes nunca chamarem o sistema.
// - `TelemetryStore`: guarda as amostras (adapters/sqlite.ts), com as mesmas regras da porta de
//   armazenamento (tudo assíncrono, gravação do registro inteiro, consulta por padrão de acesso).

import type { SamplePoint, TelemetryReading } from './model.ts';

export interface TelemetryCollector {
  /** Uma leitura agora. Nunca rejeita por um comando que falta: o grupo sai `null`. */
  collect(): Promise<TelemetryReading>;
}

export interface TelemetryStore {
  /**
   * Grava a amostra (cria ou substitui pela hora) e apaga as da máquina com `retentionMs` ou mais
   * de idade em relação a ela (12 h são 1440 amostras, não 1441).
   */
  putSample(machineId: string, reading: TelemetryReading, retentionMs: number): Promise<void>;
  /** Os pontos da máquina desde `sinceMs` (inclusive), do mais velho ao mais novo. */
  listPoints(machineId: string, sinceMs: number): Promise<SamplePoint[]>;
  /** A leitura mais nova da máquina; `null` sem nenhuma. */
  latest(machineId: string): Promise<TelemetryReading | null>;
}

// ---------------------------------------------------------------------------------------------
// O que os coletores recebem de fora

/**
 * Roda um comando sem shell e devolve a saída. `null` quando o comando não existe, falha, ou passa
 * de `timeoutMs`: o campo que dependia dele fica ausente.
 */
export type CommandRunner = (command: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<string | null>;

/** Lê um arquivo de texto (o `/proc` do Linux); `null` quando não existe ou não dá para ler. */
export type FileReader = (path: string) => Promise<string | null>;

/** O tamanho de um sistema de arquivos montado, pelo `fs.statfs`. `null` quando falha. */
export type StatFs = (mount: string) => Promise<{ totalBytes: number; freeBytes: number; availableBytes: number } | null>;

/**
 * Sonda de uma porta local, para o estado do túnel:
 * - `open`: conectou e a conexão ficou aberta;
 * - `closed`: conectou e fechou logo (o `ssh` aceitou e o outro lado não tinha ninguém);
 * - `refused`: ninguém escuta aqui.
 */
/**
 * Dono e modo de um arquivo, pelo `fs.stat` (segue o link). `null` quando não existe ou não dá
 * para ler. Serve para o `-F` de um `ssh`: só se repassa ao `ssh -G` o arquivo do próprio usuário.
 */
export type FileOwner = (path: string) => Promise<{ uid: number; mode: number } | null>;

export type PortProbe = (port: number) => Promise<'open' | 'closed' | 'refused'>;

export interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

/** O que o `node:os` dá, injetável. */
export interface OsFacts {
  hostname(): string;
  arch(): string;
  uptime(): number;
  totalmem(): number;
  freemem(): number;
  loadavg(): number[];
  cpus(): { model: string; times: CpuTimes }[];
  /** O uid de quem roda o núcleo (`process.getuid`); `null` onde não há (Windows). */
  uid(): number | null;
}

export interface CollectorDeps {
  run: CommandRunner;
  readFile: FileReader;
  statfs: StatFs;
  fileOwner: FileOwner;
  probe: PortProbe;
  os: OsFacts;
  /** Relógio, para `takenAt` e as taxas. */
  now?: () => number;
  /** A espera da primeira leitura (CPU e rede precisam de duas medidas). Nos testes, nada. */
  sleep?: (ms: number) => Promise<void>;
}
