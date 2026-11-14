/*
 * What the diagnosis collectors use from the real system (#565): the command runner (`execFile`, no
 * shell), the file reader and the directory reads. Only the running núcleo uses this; tests pass doubles.
 *
 * - `LC_ALL=C` so numbers and dates do not change with the machine's language, and `GIT_OPTIONAL_LOCKS=0`
 *   so `git status` never writes to the repository (it would refresh the index otherwise).
 * - The timeout kills the child; so does the abort signal. Output past `maxBytes` is a failure.
 * - A command that exits with an error still counts when it printed something (`du` exits 1 on a
 *   folder it cannot read, and its output is still the answer).
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SectionCollector } from '../diagnose.ts';
import type { HostInfo } from '../../telemetry/model.ts';
import type { FileReader } from '../../telemetry/ports.ts';
import { stripControlCharacters, type DiagnosisDeps, type DiagnosisFs, type DiagnosisRunner, type RunResult } from './common.ts';
import { DarwinDiagnosisCollector } from './darwin.ts';
import { LinuxDiagnosisCollector } from './linux.ts';

export const systemRunner: DiagnosisRunner = (command, args, options) =>
  new Promise<RunResult>((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBytes,
        signal: options.signal,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
        windowsHide: true,
      },
      (err, stdout) => {
        if (!err) return resolve({ ok: true, stdout });
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (options.signal.aborted || e.name === 'AbortError') return resolve({ ok: false, why: 'aborted' });
        if (e.code === 'ENOENT') return resolve({ ok: false, why: 'missing' });
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ ok: false, why: 'too-large' });
        if (e.killed) return resolve({ ok: false, why: 'timeout' });
        resolve(stdout ? { ok: true, stdout } : { ok: false, why: 'failed' });
      },
    );
  });

/* What the reads below do with an error (#565): ENOENT and ENOTDIR mean "not there" and answer no, empty or null quietly; any other code (EACCES, EMFILE...) is logged with the path and the code, and the path is treated as absent, so the section still answers with what could be read. */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

/** The file operations `systemFs` and `systemReadFile` use; tests pass a fake that throws. */
export interface FsOperations {
  stat: typeof stat;
  readdir: typeof readdir;
  readFile: typeof readFile;
}
const realOperations: FsOperations = { stat, readdir, readFile };

function onReadError(log: (message: string) => void, path: string, err: unknown): void {
  const code = (err as NodeJS.ErrnoException | null)?.code ?? 'unknown';
  if (ABSENT_CODES.has(code)) return;
  log(stripControlCharacters(`diagnosis read failed ${path}: ${code}`));
}

export const systemFs = (log: (message: string) => void, ops: Pick<FsOperations, 'stat' | 'readdir'> = realOperations): DiagnosisFs => ({
  isDirectory: (path) => ops.stat(path).then((s) => s.isDirectory(), (err) => (onReadError(log, path, err), false)),
  listDirs: (path) =>
    ops.readdir(path, { withFileTypes: true }).then(
      (entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name),
      (err) => (onReadError(log, path, err), []),
    ),
  modifiedAtMs: (path) => ops.stat(path).then((s) => s.mtimeMs, (err) => (onReadError(log, path, err), null)),
  exists: (path) => ops.stat(path).then(() => true, (err) => (onReadError(log, path, err), false)),
});

export const systemReadFile = (log: (message: string) => void, ops: Pick<FsOperations, 'readFile'> = realOperations): FileReader => (path) =>
  ops.readFile(path, 'utf8').then(
    (text) => text,
    (err) => (onReadError(log, path, err), null),
  );

/** `<repo>/.claude/worktrees` for each repository folder the core already knows from the sessions that ran there (`knownFolders`). */
export const worktreeRootsOf = (repositoryFolders: readonly string[]): string[] => repositoryFolders.map((folder) => join(folder, '.claude', 'worktrees'));

export function systemDiagnosisDeps(worktreeRoots: () => Promise<string[]>, log: (message: string) => void, home: string = homedir()): DiagnosisDeps {
  return {
    run: systemRunner,
    readFile: systemReadFile(log),
    fs: systemFs(log),
    home,
    worktreeRoots,
    nowMs: () => Date.now(),
    log,
  };
}

/** The platform's collector as the use case's port; `null` where there is none (Windows). */
export function diagnosisCollectorFor(platform: HostInfo['platform'] | NodeJS.Platform = process.platform, deps: DiagnosisDeps): SectionCollector | null {
  if (platform === 'darwin') return new DarwinDiagnosisCollector(deps).collect;
  if (platform === 'linux') return new LinuxDiagnosisCollector(deps).collect;
  return null;
}

