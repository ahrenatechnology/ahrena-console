// What the collectors use from the real system (#175): the command runner, the file reader,
// `fs.statfs`, a file's owner (`fs.stat`), the port probe and `node:os`. Only the running núcleo
// uses this; tests pass doubles with the recorded outputs.
//
// - Commands without a shell (`execFile`), with a short timeout and `LC_ALL=C` (the decimal point
//   of `ps` and `df` does not change with the machine's language). Failed, missing or timed out:
//   `null`. Output from a command that exits with an error still counts (`lsof` exits with 1 when
//   a process disappears midway).
// - The probe only connects to 127.0.0.1 and closes; it writes nothing on the connection.

import { execFile } from 'node:child_process';
import { readFile, stat, statfs } from 'node:fs/promises';
import { connect } from 'node:net';
import * as nodeOs from 'node:os';
import type { CollectorDeps, CommandRunner, FileOwner, FileReader, OsFacts, PortProbe, StatFs } from '../ports.ts';
import type { TelemetryCollector } from '../ports.ts';
import { COMMAND_TIMEOUT_MS } from './common.ts';
import { DarwinCollector } from './darwin.ts';
import { LinuxCollector } from './linux.ts';

export const systemRunner: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }, windowsHide: true },
      (err, stdout) => {
        if (!err) return resolve(stdout);
        const killed = (err as { killed?: boolean }).killed === true;
        resolve(!killed && stdout ? stdout : null);
      },
    );
  });

export const systemReadFile: FileReader = (path) => readFile(path, 'utf8').catch(() => null);

export const systemStatfs: StatFs = async (mount) => {
  try {
    const s = await statfs(mount);
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bfree * s.bsize, availableBytes: s.bavail * s.bsize };
  } catch {
    return null;
  }
};

export const systemFileOwner: FileOwner = async (path) => {
  try {
    const s = await stat(path);
    return { uid: s.uid, mode: s.mode };
  } catch {
    return null;
  }
};

/** How long the connection must stay open to count as `open`: `ssh` closes a forward with nobody on the other side faster than this. */
export const PROBE_HOLD_MS = 1_000;

export const systemProbe: PortProbe = (port) =>
  new Promise((resolve) => {
    let done = false;
    const end = (r: 'open' | 'closed' | 'refused') => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(r);
    };
    const socket = connect({ host: '127.0.0.1', port });
    const deadline = setTimeout(() => end('refused'), 2 * PROBE_HOLD_MS);
    socket.once('connect', () => {
      clearTimeout(deadline);
      const hold = setTimeout(() => end('open'), PROBE_HOLD_MS);
      socket.once('close', () => (clearTimeout(hold), end('closed')));
    });
    socket.once('error', () => end('refused'));
    socket.on('data', () => {});
  });

export const systemOs: OsFacts = {
  hostname: () => nodeOs.hostname(),
  arch: () => nodeOs.arch(),
  uptime: () => nodeOs.uptime(),
  totalmem: () => nodeOs.totalmem(),
  freemem: () => nodeOs.freemem(),
  loadavg: () => nodeOs.loadavg(),
  cpus: () => nodeOs.cpus(),
  uid: () => process.getuid?.() ?? null,
};

export function systemDeps(): CollectorDeps {
  return { run: systemRunner, readFile: systemReadFile, statfs: systemStatfs, fileOwner: systemFileOwner, probe: systemProbe, os: systemOs };
}

/** The platform's collector; `null` where there is none (Windows): the núcleo starts without telemetry. */
export function collectorFor(platform: NodeJS.Platform = process.platform, deps: CollectorDeps = systemDeps()): TelemetryCollector | null {
  if (platform === 'darwin') return new DarwinCollector(deps);
  if (platform === 'linux') return new LinuxCollector(deps);
  return null;
}
