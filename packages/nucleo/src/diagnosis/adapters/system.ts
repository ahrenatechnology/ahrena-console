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
import { type DiagnosisDeps, type DiagnosisFs, type DiagnosisRunner, type RunResult } from './common.ts';
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

export const systemFs: DiagnosisFs = {
  isDirectory: (path) => stat(path).then((s) => s.isDirectory(), () => false),
  listDirs: (path) =>
    readdir(path, { withFileTypes: true }).then(
      (entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name),
      () => [],
    ),
  modifiedAtMs: (path) => stat(path).then((s) => s.mtimeMs, () => null),
  exists: (path) => stat(path).then(() => true, () => false),
};

/** `<repo>/.claude/worktrees` for each repository folder the core already knows from the sessions that ran there (`knownFolders`). */
export const worktreeRootsOf = (repositoryFolders: readonly string[]): string[] => repositoryFolders.map((folder) => join(folder, '.claude', 'worktrees'));

export function systemDiagnosisDeps(worktreeRoots: () => Promise<string[]>, log: (message: string) => void, home: string = homedir()): DiagnosisDeps {
  return {
    run: systemRunner,
    readFile: (path) => readFile(path, 'utf8').catch(() => null),
    fs: systemFs,
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

