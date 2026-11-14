/*
 * The closed catalog of what a diagnosis collector may run (#565, epic #563): every entry is a read-only
 * command with fixed arguments, a timeout and a bound on its output.
 *
 * - Each entry is an argv list: the executable, then the arguments one by one. No shell, no `&&`, no `$VAR`.
 * - Nothing here reads a request, an alert, a process or a folder name. A command that must look at a
 *   folder runs with that folder as its working directory (a path the núcleo found itself) and `.` as
 *   the only path argument, so no path is ever an argument.
 * - Nothing writes, kills or deletes: `ps`, `sysctl` (read), `df`, `du`, `docker system df`,
 *   `journalctl --disk-usage`, and `git status` / `git rev-list` (the runner sets `GIT_OPTIONAL_LOCKS=0`).
 */

export interface CatalogEntry {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  /** The most bytes of stdout read; more than that is a failure, never a silent cut. */
  maxBytes: number;
}

const MB = 1024 * 1024;

export const CATALOG = {
  /** Every process once: pid, CPU%, RSS in KiB, start time, executable. The use case ranks them. */
  ps: { command: 'ps', args: ['-axo', 'pid=,pcpu=,rss=,lstart=,comm='], timeoutMs: 8_000, maxBytes: 4 * MB },
  'swap-usage': { command: 'sysctl', args: ['vm.swapusage'], timeoutMs: 3_000, maxBytes: 64 * 1024 },
  /** The core's own list of mounts: the only source of the mount a folder scan may use. */
  df: { command: 'df', args: ['-P', '-k'], timeoutMs: 5_000, maxBytes: MB },
  /** Two levels under the working directory, staying on its file system. */
  'du-tree': { command: 'du', args: ['-x', '-k', '-d', '2', '.'], timeoutMs: 12_000, maxBytes: 4 * MB },
  /** The total of the working directory. */
  'du-size': { command: 'du', args: ['-s', '-k', '.'], timeoutMs: 10_000, maxBytes: 64 * 1024 },
  'docker-df': { command: 'docker', args: ['system', 'df', '--format', '{{json .}}'], timeoutMs: 10_000, maxBytes: 256 * 1024 },
  journal: { command: 'journalctl', args: ['--disk-usage'], timeoutMs: 5_000, maxBytes: 64 * 1024 },
  'git-status': { command: 'git', args: ['status', '--porcelain'], timeoutMs: 8_000, maxBytes: 64 * 1024 },
  /** Commits that no remote branch has: what would be lost with the worktree. */
  'git-unpushed': { command: 'git', args: ['rev-list', '--count', 'HEAD', '--not', '--remotes'], timeoutMs: 8_000, maxBytes: 4 * 1024 },
} as const satisfies Record<string, CatalogEntry>;

export type CatalogId = keyof typeof CATALOG;
