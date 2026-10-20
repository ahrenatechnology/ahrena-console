// Live process probe: which directories have a `claude` process running right now.
// macOS with `ps` + `lsof`; Linux through `/proc`. Off (returns `null`) on Windows, in a container
// and in the cloud, where the process is not on the same machine. `null` means "don't know": the watcher ends nothing.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { normalizeDir } from './watcher.ts';

/** Tells which directories have a live `claude` process; `null` when it cannot tell. */
export interface ProcessProbe {
  liveDirs(): Promise<ReadonlySet<string> | null>;
}

/** For tests and for whoever already knows the answer. */
export function fixedProbe(dirs: Iterable<string> | null): ProcessProbe {
  const live = dirs === null ? null : new Set([...dirs].map(normalizeDir));
  return { liveDirs: async () => live };
}

/** Runs a command and returns its stdout. */
export type RunCommand = (command: string, args: string[]) => Promise<string>;

/** Options of `systemProcessProbe()`. */
export interface ProbeOptions {
  platform?: NodeJS.Platform;
  run?: RunCommand;
  /** Root of `/proc` on Linux. */
  proc?: string;
  /** `true` inside a container; the default looks at `/.dockerenv`. */
  inContainer?: boolean;
}

const defaultRun: RunCommand = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // `lsof` exits with 1 when some pid vanished midway; what it found still holds.
      if (err && !stdout) reject(err);
      else resolve(stdout);
    });
  });

/**
 * Is the command line Claude Code? The `claude` binary or the npm package running on node. The binary
 * path may have a space: Claude Desktop's lives in `~/Library/Application Support/Claude/
 * claude-code/<version>/…/MacOS/claude`, and cutting at the first space lost all its sessions.
 */
export function isClaude(commandLine: string): boolean {
  return /^(?:\S*\/|\/.*?\/)?claude(?:\s|$)/.test(commandLine.trim()) || commandLine.includes('@anthropic-ai/claude-code');
}

/** Output of `ps -axo pid=,args=` → Claude Code pids. */
export function pidsFromPs(output: string): number[] {
  const pids: number[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && isClaude(m[2])) pids.push(Number(m[1]));
  }
  return pids;
}

/** Output of `lsof -Fn -a -d cwd -p ...` → directories (`n<path>` lines). */
export function dirsFromLsof(output: string): string[] {
  return output
    .split('\n')
    .filter((l) => l.startsWith('n') && l.length > 1)
    .map((l) => normalizeDir(l.slice(1)));
}

/** The probe for this machine's platform. */
export function systemProcessProbe(options: ProbeOptions = {}): ProcessProbe {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const proc = options.proc ?? '/proc';
  const inContainer = options.inContainer ?? existsSync('/.dockerenv');
  if (inContainer) return fixedProbe(null);

  if (platform === 'darwin') {
    return {
      async liveDirs() {
        try {
          const pids = pidsFromPs(await run('ps', ['-axo', 'pid=,args=']));
          if (pids.length === 0) return new Set();
          const output = await run('lsof', ['-Fn', '-a', '-d', 'cwd', '-p', pids.join(',')]);
          return new Set(dirsFromLsof(output));
        } catch {
          return null;
        }
      },
    };
  }

  if (platform === 'linux') {
    return {
      async liveDirs() {
        try {
          const live = new Set<string>();
          for (const name of await readdir(proc)) {
            if (!/^\d+$/.test(name)) continue;
            try {
              const line = (await readFile(`${proc}/${name}/cmdline`, 'utf8')).split('\0').join(' ');
              if (!isClaude(line)) continue;
              live.add(normalizeDir(await readlink(`${proc}/${name}/cwd`)));
            } catch {
              // The process ended between the listing and the read.
            }
          }
          return live;
        } catch {
          return null;
        }
      },
    };
  }

  return fixedProbe(null);
}
