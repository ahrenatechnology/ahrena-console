/*
 * The closed catalog of what a diagnosis collector may run (#565, epic #563): every entry is a read-only
 * command with fixed arguments, a timeout and a bound on its output.
 *
 * - Each entry is an argv list: the executable, then the arguments one by one. No shell, no `&&`, no `$VAR`.
 * - Nothing here reads a request, an alert, a process or a folder name. A command that must look at a
 *   folder runs with that folder as its working directory (a path the núcleo found itself) and `.` as
 *   the only path argument, so no path is ever an argument.
 * - Nothing writes, kills or deletes: `ps`, `sysctl` (read), `df`, `du`, `docker system df`,
 *   `journalctl --disk-usage`, and five `git` reads. The runner sets `GIT_OPTIONAL_LOCKS=0`. Uncommitted work is asked with
 *   `ls-files --cached --debug`, `ls-files --cached --stage` against `ls-tree -r HEAD`, and `ls-files --others --exclude-standard`,
 *   never with `git status`, `diff-files` or `diff-index`: the first two can hash a file whose stat differs from the index and so run the repository's
 *   `filter.<driver>.clean` command, which can write. They read the index and the tree listings only, run no content
 *   filter, and run with `core.fsmonitor=false` so the repository's fsmonitor hook never runs. The collector itself compares
 *   each tracked file's `lstat` (size and mtime) with the index entry; a changed file, a racy entry (mtime at or after the
 *   index file's own) and any doubt count as uncommitted: the safe default. `rev-list` reads no index and runs no hook. Guaranteed by the argv and checked with a probe
 *   repository whose clean filter writes a marker file (#565).
 */

export interface CatalogEntry {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  /** The most bytes of stdout read; more than that is a failure, never a silent cut (#565). */
  maxBytes: number;
  /** `du` exits 1 on a folder it cannot read and still prints what it measured; that output is an answer in part, not a failure (#565). Every entry without this flag fails on a non-zero exit. */
  acceptOutputOnFailure?: true;
  /** Variables added to the runner's own environment (`LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0`); fixed here, never from a request (#722). */
  env?: Readonly<Record<string, string>>;
}

const MB = 1024 * 1024;

export const CATALOG = {
  /** Every process once: pid, CPU%, RSS in KiB, start time, executable; the use case ranks them (#565). */
  ps: { command: 'ps', args: ['-axo', 'pid=,pcpu=,rss=,lstart=,comm='], timeoutMs: 8_000, maxBytes: 4 * MB },
  /**
   * Every process with its parent, for the attribution to sessions (#722): pid, ppid, CPU%, start time and the full command line.
   * `TZ=UTC` so the start has one form on every machine; on macOS `lstartMatches` compares it as text with `procStart`, on Linux
   * `procStart` is clock ticks and the Linux adapter checks it against `/proc` instead. The command line stays inside the core,
   * only the few words of `rootCommandOf` leave it.
   */
  'ps-tree': { command: 'ps', args: ['-axo', 'pid=,ppid=,pcpu=,lstart=,args='], timeoutMs: 8_000, maxBytes: 8 * MB, env: { TZ: 'UTC' } },
  'swap-usage': { command: 'sysctl', args: ['vm.swapusage'], timeoutMs: 3_000, maxBytes: 64 * 1024 },
  /** The core's own list of mounts: the only source of the mount a folder scan may use (#565). */
  df: { command: 'df', args: ['-P', '-k'], timeoutMs: 5_000, maxBytes: MB },
  /** One top-level folder of a volume, staying on its file system: a whole-volume `du -d 2` never finished on a Mac (#565). */
  'du-folder': { command: 'du', args: ['-x', '-s', '-k', '.'], timeoutMs: 6_000, maxBytes: 64 * 1024, acceptOutputOnFailure: true },
  /** The total of the working directory (#565). */
  'du-size': { command: 'du', args: ['-s', '-k', '.'], timeoutMs: 10_000, maxBytes: 64 * 1024, acceptOutputOnFailure: true },
  'docker-df': { command: 'docker', args: ['system', 'df', '--format', '{{json .}}'], timeoutMs: 10_000, maxBytes: 256 * 1024 },
  journal: { command: 'journalctl', args: ['--disk-usage'], timeoutMs: 5_000, maxBytes: 64 * 1024 },
  /** Each tracked file's stat as the index recorded it; the collector compares it with the file's own `lstat`, so git never hashes a file and no filter driver runs (#565). */
  'git-index-stat': { command: 'git', args: ['-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--debug'], timeoutMs: 8_000, maxBytes: 32 * MB },
  /** Every index entry's mode, object id and stage; the collector compares it with `git-head-tree`, so staged work is read without `diff-index` (#565). */
  'git-index-entries': { command: 'git', args: ['-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--stage', '-z'], timeoutMs: 8_000, maxBytes: 32 * MB },
  /** Every entry of HEAD's tree; an unborn HEAD fails, which counts as uncommitted (#565). */
  'git-head-tree': { command: 'git', args: ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], timeoutMs: 8_000, maxBytes: 32 * MB },
  /** Files git does not track and does not ignore (#565). */
  'git-untracked': { command: 'git', args: ['-c', 'core.fsmonitor=false', 'ls-files', '--others', '--exclude-standard'], timeoutMs: 8_000, maxBytes: 64 * 1024 },
  /** Commits that no remote branch has: what would be lost with the worktree (#565). */
  'git-unpushed': { command: 'git', args: ['rev-list', '--count', 'HEAD', '--not', '--remotes'], timeoutMs: 8_000, maxBytes: 4 * 1024 },
} as const satisfies Record<string, CatalogEntry>;

export type CatalogId = keyof typeof CATALOG;
