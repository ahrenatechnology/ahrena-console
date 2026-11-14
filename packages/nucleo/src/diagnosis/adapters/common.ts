/*
 * The diagnosis collectors' shared part (#565, epic #563): the ports a collector reads the machine
 * through, and `DiagnosisCollector`, which implements the use case's `SectionCollector` port for the
 * sections that are the same on every OS. A subclass per OS (`darwin.ts`, `linux.ts`) adds the swap
 * and the cache paths that differ.
 *
 * - The runner is a port, so tests run without the real tools. It is richer than the telemetry one
 *   (`telemetry/ports.ts`): it must tell a missing tool from a failed one, honour an abort signal and
 *   run in a working directory, and the telemetry runner reports all three as `null`.
 * - A section whose tool is missing, slow or aborted is `{ unavailable: true, reason }`: it never throws.
 * - The mount of `largest-folders` is matched against the mounts `df` lists and the core's own value is
 *   used; an unknown mount is unavailable. The request's text never becomes a command argument.
 */

import { join } from 'node:path';
import type { CollectContext, CollectResult } from '../diagnose.ts';
import type { CacheActionId, CacheItem, SectionId, WorktreeItem } from '../model.ts';
import { isRealVolume, parseDfP } from '../../telemetry/adapters/common.ts';
import type { FileReader } from '../../telemetry/ports.ts';
import { CATALOG, type CatalogId } from './catalog.ts';
import { parseDockerDf, parseDuSize, parseDuTree, parseJournalUsage, parsePsProcesses } from './parsers.ts';

export interface RunOptions {
  timeoutMs: number;
  maxBytes: number;
  cwd?: string;
  signal: AbortSignal;
}
export type RunResult = { ok: true; stdout: string } | { ok: false; why: 'missing' | 'timeout' | 'aborted' | 'too-large' | 'failed' };
/** Runs one executable with an argv list, no shell. */
export type DiagnosisRunner = (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

export interface DiagnosisFs {
  isDirectory(path: string): Promise<boolean>;
  /** The names of the directories directly under `path`; empty when it cannot be read. */
  listDirs(path: string): Promise<string[]>;
  modifiedAtMs(path: string): Promise<number | null>;
}

export interface DiagnosisDeps {
  run: DiagnosisRunner;
  readFile: FileReader;
  fs: DiagnosisFs;
  home: string;
  /** The directories that hold worktrees, found by the núcleo itself. */
  worktreeRoots(): Promise<string[]>;
  nowMs(): number;
}

/** A worktree untouched for this long is old. */
export const OLD_WORKTREE_DAYS = 14;
/** The most worktrees one diagnosis looks into: each costs a `du` and two `git` runs. */
export const MAX_WORKTREES = 20;

/** Where the núcleo looks for worktrees: `<home>/Workspace/<owner>/<repo>/.claude/worktrees`. */
export async function defaultWorktreeRoots(fs: DiagnosisFs, home: string): Promise<string[]> {
  const workspace = join(home, 'Workspace');
  const roots: string[] = [];
  for (const owner of await fs.listDirs(workspace)) {
    for (const repo of await fs.listDirs(join(workspace, owner))) {
      const root = join(workspace, owner, repo, '.claude', 'worktrees');
      if (await fs.isDirectory(root)) roots.push(root);
    }
  }
  return roots;
}

const unavailable = (reason: string): { unavailable: true; reason: string } => ({ unavailable: true, reason });

export abstract class DiagnosisCollector {
  protected readonly deps: DiagnosisDeps;

  constructor(deps: DiagnosisDeps) {
    this.deps = deps;
  }

  /** The swap used and total; differs by OS. */
  protected abstract swap(signal: AbortSignal): Promise<CollectResult<'swap'>>;
  /** The known cache folders under the home directory, with the cleanup action each one has. */
  protected abstract cacheFolders(): { path: string; actionId: CacheActionId }[];

  /** The `SectionCollector` port of the use case. */
  readonly collect = async <K extends SectionId>(id: K, context: CollectContext): Promise<CollectResult<K>> => {
    const result = await this.section(id, context);
    return result as CollectResult<K>;
  };

  private async section(id: SectionId, { mount, signal }: CollectContext): Promise<CollectResult<SectionId>> {
    switch (id) {
      case 'processes-by-rss':
      case 'processes-by-cpu':
        return this.processes(signal);
      case 'swap':
        return this.swap(signal);
      case 'largest-folders':
        return this.largestFolders(mount, signal);
      case 'docker-df':
        return this.dockerDf(signal);
      case 'known-caches':
        return this.knownCaches(signal);
      case 'journal':
        return this.journal(signal);
    }
  }

  /** Runs a catalog entry; the failure is already a section's `unavailable` answer. */
  protected async exec(id: CatalogId, signal: AbortSignal, cwd?: string): Promise<{ stdout: string } | { unavailable: true; reason: string }> {
    const entry = CATALOG[id];
    const r = await this.deps.run(entry.command, entry.args, { timeoutMs: entry.timeoutMs, maxBytes: entry.maxBytes, signal, ...(cwd ? { cwd } : {}) });
    if (r.ok) return { stdout: r.stdout };
    const reasons = { missing: 'not found', timeout: 'timed out', aborted: 'aborted', 'too-large': 'output too large', failed: 'did not answer' } as const;
    return unavailable(`${entry.command} ${reasons[r.why]}`);
  }

  private async processes(signal: AbortSignal): Promise<CollectResult<'processes-by-rss'>> {
    const r = await this.exec('ps', signal);
    return 'stdout' in r ? parsePsProcesses(r.stdout) : r;
  }

  private async largestFolders(mount: string | null, signal: AbortSignal): Promise<CollectResult<'largest-folders'>> {
    if (!mount) return unavailable('no volume to scan');
    const df = await this.exec('df', signal);
    if (!('stdout' in df)) return df;
    const known = parseDfP(df.stdout).find((row) => isRealVolume(row) && row.mount === mount);
    if (!known) return unavailable('volume not known to this machine');
    const du = await this.exec('du-tree', signal, known.mount);
    return 'stdout' in du ? parseDuTree(du.stdout, known.mount) : du;
  }

  private async dockerDf(signal: AbortSignal): Promise<CollectResult<'docker-df'>> {
    const r = await this.exec('docker-df', signal);
    return 'stdout' in r ? parseDockerDf(r.stdout) : r;
  }

  protected async journal(signal: AbortSignal): Promise<CollectResult<'journal'>> {
    const r = await this.exec('journal', signal);
    if (!('stdout' in r)) return r;
    const bytes = parseJournalUsage(r.stdout);
    return bytes === null ? unavailable('journalctl output not understood') : [{ bytes }];
  }

  private async knownCaches(signal: AbortSignal): Promise<CollectResult<'known-caches'>> {
    const [caches, worktrees] = await Promise.all([this.caches(signal), this.worktrees(signal)]);
    return [...caches, ...worktrees];
  }

  private async caches(signal: AbortSignal): Promise<CacheItem[]> {
    const items = await Promise.all(
      this.cacheFolders().map(async ({ path, actionId }): Promise<CacheItem | null> => {
        if (!(await this.deps.fs.isDirectory(path))) return null;
        const size = await this.exec('du-size', signal, path);
        const bytes = 'stdout' in size ? parseDuSize(size.stdout) : null;
        return bytes === null ? null : { id: actionId, path, bytes, actionId };
      }),
    );
    return items.filter((i): i is CacheItem => i !== null);
  }

  private async worktrees(signal: AbortSignal): Promise<WorktreeItem[]> {
    const { fs, nowMs } = this.deps;
    const limit = nowMs() - OLD_WORKTREE_DAYS * 86_400_000;
    const found: { path: string; modifiedMs: number }[] = [];
    for (const root of await this.deps.worktreeRoots()) {
      for (const name of await fs.listDirs(root)) {
        const path = join(root, name);
        const modifiedMs = await fs.modifiedAtMs(path);
        if (modifiedMs !== null && modifiedMs < limit) found.push({ path, modifiedMs });
      }
    }
    const oldest = found.sort((a, b) => a.modifiedMs - b.modifiedMs).slice(0, MAX_WORKTREES);
    const items = await Promise.all(oldest.map(({ path, modifiedMs }) => this.worktree(path, modifiedMs, signal)));
    return items.filter((i): i is WorktreeItem => i !== null);
  }

  /** What git cannot tell counts as not safe to remove: dirty and unpushed. */
  private async worktree(path: string, modifiedMs: number, signal: AbortSignal): Promise<WorktreeItem | null> {
    const [size, status, unpushed] = await Promise.all([this.exec('du-size', signal, path), this.exec('git-status', signal, path), this.exec('git-unpushed', signal, path)]);
    const bytes = 'stdout' in size ? parseDuSize(size.stdout) : null;
    if (bytes === null) return null;
    return {
      id: 'worktree',
      path,
      bytes,
      lastUsedAt: new Date(modifiedMs).toISOString(),
      hasUncommitted: 'stdout' in status ? status.stdout.trim().length > 0 : true,
      hasUnpushed: 'stdout' in unpushed ? Number(unpushed.stdout.trim()) > 0 || Number.isNaN(Number(unpushed.stdout.trim())) : true,
      actionId: null,
    };
  }
}
