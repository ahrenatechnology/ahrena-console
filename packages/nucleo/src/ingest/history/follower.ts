// Real-time transcript follower (item 1.3): watches `~/.claude/projects` and imports only what
// changed, reusing the importer's cursor and idempotence.
//
// Two sources of notice:
// - recursive `fs.watch`, which gives the path that changed and keeps latency at a few hundred ms;
// - a periodic scan, as a fallback: the watch loses events on macOS (FSEvents merges or drops
//   notices, folders created later sometimes do not notify) and fails if the root does not exist yet.
//
// Cost: the follower keeps each file's size and mtime in memory. A round only runs `stat` (on the
// notified paths, or on all of them in a scan) and calls the importer only with the files whose
// `stat` changed. An idle file costs no read and no database query.
//
// Half-written lines, truncated or rewritten files and new subagents are handled by the importer
// (cursor with a fingerprint) and by discovery; the follower only decides when and what to import.

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { StoragePort } from '../../storage-port.ts';
import { classifyTranscript, defaultProjectsRoot, discoverTranscripts, fileStat, type FileStat, type TranscriptFile } from './files.ts';
import { importHistory, type ImportOptions, type ImportReport } from './importer.ts';

export interface FollowOptions {
  storage: StoragePort;
  /** Padrão: `~/.claude/projects`. */
  root?: string;
  /** Intervalo da varredura de reserva. Padrão 5 s. */
  scanIntervalMs?: number;
  /** Espera depois de um aviso do watch, para juntar as escritas em rajada. Padrão 150 ms. */
  debounceMs?: number;
  /** Usar `fs.watch`. Padrão `true`; com `false`, fica só a varredura. */
  watch?: boolean;
  /** Repassado ao importador: cada sessão que ganhou eventos. */
  onSession?: ImportOptions['onSession'];
  /** Chamado depois de cada rodada que importou algo. */
  onImport?: (report: ImportReport) => void;
  /** Erro de uma rodada. O seguidor continua; os arquivos da rodada são tentados de novo. */
  onError?: (error: unknown) => void;
}

export interface FollowerStats {
  /** Rodadas feitas (avisos e varreduras). */
  rounds: number;
  /** Varreduras completas da raiz. */
  scans: number;
  /** Arquivos entregues ao importador, somando as rodadas. */
  filesImported: number;
  /** Arquivos conhecidos agora. */
  filesKnown: number;
  /** Se o `fs.watch` está ativo. */
  watching: boolean;
}

export interface TranscriptFollower {
  /** Faz a primeira importação completa e passa a seguir. Chamar de novo com ele rodando não faz nada. */
  start(): Promise<ImportReport>;
  /** Para de seguir e espera a rodada em andamento terminar. Pode recomeçar com `start()`. */
  stop(): Promise<void>;
  /** Varre a raiz agora e importa o que mudou, sem esperar o próximo intervalo. */
  sync(): Promise<ImportReport>;
  readonly running: boolean;
  stats(): FollowerStats;
}

const emptyReport = (): ImportReport => ({
  filesFound: 0,
  filesRead: 0,
  filesUnchanged: 0,
  filesOrphaned: 0,
  sessionsTouched: 0,
  eventsAdded: 0,
  eventsExisting: 0,
  linesInvalid: 0,
  filesRewound: 0,
});

const sameStat = (a: FileStat | undefined, b: FileStat) => a !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs;

export function followTranscripts(options: FollowOptions): TranscriptFollower {
  const root = options.root ?? defaultProjectsRoot();
  const scanIntervalMs = options.scanIntervalMs ?? 5000;
  const debounceMs = options.debounceMs ?? 150;
  const useWatch = options.watch ?? true;

  /** Último `stat` visto de cada arquivo, por caminho absoluto. */
  const known = new Map<string, FileStat>();
  /** Caminhos avisados pelo watch desde a última rodada. */
  const dirty = new Set<string>();
  /** Pastas que já têm transcript conhecido, relativas à raiz; aviso delas não pede varredura. */
  const knownDirs = new Set<string>();
  const rootName = basename(root);
  let fullScanPending = false;
  let running = false;
  let watcher: FSWatcher | null = null;
  let scanTimer: NodeJS.Timeout | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  /** Rodada em andamento; as rodadas nunca se sobrepõem. */
  let current: Promise<ImportReport> = Promise.resolve(emptyReport());
  const stats = { rounds: 0, scans: 0, filesImported: 0 };

  const startWatch = () => {
    if (!useWatch || watcher || !existsSync(root)) return;
    try {
      watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (filename) dirty.add(String(filename));
        else fullScanPending = true;
        schedule();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
        // O que aconteceu durante a falha só a varredura acha.
        fullScanPending = true;
        schedule();
      });
    } catch {
      watcher = null;
    }
  };

  const schedule = () => {
    if (!running || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void enqueue(false);
    }, debounceMs);
  };

  /** Os transcripts avisados pelo watch. Marca varredura se veio aviso de pasta. */
  function fromDirty(): TranscriptFile[] {
    const out: TranscriptFile[] = [];
    for (const rel of dirty) {
      const file = classifyTranscript(root, rel, existsSync);
      if (file) out.push(file);
      // Pasta nova (projeto, sessão, `subagents`): o que está dentro pode não ter avisado.
      // Os nomes dessas pastas não têm ponto; os de arquivo têm. Pasta já conhecida avisa à toa
      // (o FSEvents avisa a pasta quando um arquivo dela muda), e os arquivos avisam por si.
      // O FSEvents também avisa a própria raiz, pelo nome dela: a pasta nova avisa por si.
      else if (!basename(rel).includes('.') && !knownDirs.has(rel) && rel !== rootName) fullScanPending = true;
    }
    dirty.clear();
    return out;
  }

  async function round(full: boolean): Promise<ImportReport> {
    stats.rounds++;
    let files = full || fullScanPending ? [] : fromDirty();
    const scan = full || fullScanPending;
    if (scan) {
      fullScanPending = false;
      dirty.clear();
      stats.scans++;
      files = await discoverTranscripts(root);
      knownDirs.clear();
      for (const f of files) {
        for (let d = dirname(f.relPath); d !== '.' && !knownDirs.has(d); d = dirname(d)) knownDirs.add(d);
      }
    }

    const changed: TranscriptFile[] = [];
    const seen = new Map<string, FileStat>();
    for (const file of files) {
      const st = await fileStat(file.path);
      if (!st) {
        known.delete(file.path);
        continue;
      }
      seen.set(file.path, st);
      if (!sameStat(known.get(file.path), st)) changed.push(file);
    }
    if (scan) {
      for (const path of known.keys()) if (!seen.has(path)) known.delete(path);
    }
    if (changed.length === 0) return emptyReport();

    // O `stat` é anotado antes de importar: o que mudar durante a importação aparece na próxima rodada.
    for (const file of changed) known.set(file.path, seen.get(file.path)!);
    try {
      const report = await importHistory({ storage: options.storage, root, files: changed, onSession: options.onSession });
      stats.filesImported += changed.length;
      if (report.filesRead > 0) options.onImport?.(report);
      return report;
    } catch (error) {
      for (const file of changed) known.delete(file.path);
      throw error;
    }
  }

  function enqueue(full: boolean): Promise<ImportReport> {
    const next = current.then(
      () => round(full),
      () => round(full),
    );
    current = next.catch((error: unknown) => {
      options.onError?.(error);
      return emptyReport();
    });
    return next;
  }

  const tick = () => {
    startWatch();
    void enqueue(true);
  };

  return {
    get running() {
      return running;
    },

    async start() {
      if (running) return emptyReport();
      running = true;
      startWatch();
      const first = enqueue(true);
      scanTimer = setInterval(tick, scanIntervalMs);
      return first;
    },

    async stop() {
      running = false;
      if (scanTimer) clearInterval(scanTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      scanTimer = debounceTimer = null;
      watcher?.close();
      watcher = null;
      dirty.clear();
      await current;
    },

    sync() {
      return enqueue(true);
    },

    stats() {
      return { ...stats, filesKnown: known.size, watching: watcher !== null };
    },
  };
}
