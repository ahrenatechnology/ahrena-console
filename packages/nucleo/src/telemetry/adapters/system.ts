// O que os coletores usam do sistema de verdade (#175): o executor de comandos, a leitura de
// arquivo, o `fs.statfs`, a sonda de porta e o `node:os`. Só o núcleo no ar usa isto; os testes
// passam os dublês com as saídas gravadas.
//
// - Comando sem shell (`execFile`), com tempo curto e `LC_ALL=C` (o ponto decimal do `ps` e do
//   `df` não muda com a língua da máquina). Falhou, não existe ou estourou o tempo: `null`. O que
//   sai com erro mas escreveu algo vale (o `lsof` sai com 1 quando um processo some no meio).
// - A sonda só conecta em 127.0.0.1 e fecha; não escreve nada na conexão.

import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { connect } from 'node:net';
import * as nodeOs from 'node:os';
import type { CollectorDeps, CommandRunner, FileReader, OsFacts, PortProbe, StatFs } from '../ports.ts';
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
        const morto = (err as { killed?: boolean }).killed === true;
        resolve(!morto && stdout ? stdout : null);
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

/** Quanto a conexão precisa ficar aberta para contar como `open`: o `ssh` fecha a de um encaminhamento sem ninguém lá em menos que isso. */
export const PROBE_HOLD_MS = 1_000;

export const systemProbe: PortProbe = (port) =>
  new Promise((resolve) => {
    let feito = false;
    const fim = (r: 'open' | 'closed' | 'refused') => {
      if (feito) return;
      feito = true;
      clearTimeout(limite);
      socket.destroy();
      resolve(r);
    };
    const socket = connect({ host: '127.0.0.1', port });
    const limite = setTimeout(() => fim('refused'), 2 * PROBE_HOLD_MS);
    socket.once('connect', () => {
      clearTimeout(limite);
      const segurar = setTimeout(() => fim('open'), PROBE_HOLD_MS);
      socket.once('close', () => (clearTimeout(segurar), fim('closed')));
    });
    socket.once('error', () => fim('refused'));
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
};

export function systemDeps(): CollectorDeps {
  return { run: systemRunner, readFile: systemReadFile, statfs: systemStatfs, probe: systemProbe, os: systemOs };
}

/** O coletor da plataforma; `null` onde não há um (Windows): o núcleo sobe sem telemetria. */
export function collectorFor(platform: NodeJS.Platform = process.platform, deps: CollectorDeps = systemDeps()): TelemetryCollector | null {
  if (platform === 'darwin') return new DarwinCollector(deps);
  if (platform === 'linux') return new LinuxCollector(deps);
  return null;
}
