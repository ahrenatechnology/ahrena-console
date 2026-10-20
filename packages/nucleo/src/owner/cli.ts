#!/usr/bin/env node
// The core's command for the app, the extension and the terminal: `npm run core -- status|start|stop`.
// `start` adopts the live core or starts one in the background, and only returns once it answers.
//
// Old names (`subir`, `parar`, `--porta`, `--pai`, `--substituir`) are still accepted until
// phase 6 of #173; the new one wins if both are given. The `--json` line keeps its Portuguese keys
// and values: the desktop app parses it.

import { parseArgs } from 'node:util';
import { examine, stopCore } from './owner.ts';
import { isPidAlive } from './probe.ts';
import { runningOutput, startOrAdopt, type StartOutput } from './start.ts';
import { defaultDir, removeLock, type Lock } from './lock.ts';

const HELP = `Usage: npm run core -- <command> [options] [-- API options]

  status              Says whether a core is up on this machine. Exits 0 if so, 1 if not
  start               Adopts the core that is up or starts one in the background (log in
                      ~/.ahrena-console/nucleo.log) and waits for it to answer
  stop                Stops the core that is up (SIGTERM, then SIGKILL) and deletes the lock

  --port <n>          For start. Default AHRENA_CONSOLE_PORT or 4720. If a core is up, its port wins
  --parent <pid>      For start: the core exits when this process is gone, unless another client
                      is registered. When adopting, registers the pid as a client
  --replace           For start: replaces the core that is up if it is older than this one (version
                      or ancestor commit). For other code, only warns
  --json              One JSON line on stdout, for the app and the extension
  --help

After --, options go to the API (npm run api -- --help), for example -- --sem-github.
The old names (subir, parar, --porta, --pai, --substituir) are accepted until phase 6.
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    parent: { type: 'string' },
    replace: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
    // Old names, accepted until phase 6 (the desktop app still passes `--pai`).
    porta: { type: 'string' },
    pai: { type: 'string' },
    substituir: { type: 'boolean', default: false },
  },
});
const [command, ...apiArgs] = positionals;
if (o.help || !command) {
  process.stdout.write(HELP);
  process.exit(o.help ? 0 : 2);
}
const portOption = o.port ?? o.porta;
const parentOption = o.parent ?? o.pai;
const replace = o.replace || o.substituir;

const log = (m: string) => console.error(`[ahrena-console] ${m}`);
const dir = defaultDir();

function finish(s: StartOutput, text: string, exitCode = 0): never {
  process.stdout.write(o.json ? `${JSON.stringify(s)}\n` : `${text}\n`);
  process.exit(exitCode);
}

const line = (t: Lock, how: string) => `core up at http://127.0.0.1:${t.port} · version ${t.version} · pid ${t.pid} (${how})`;

async function status(): Promise<never> {
  const ex = await examine(dir);
  if (ex.state === 'alive') finish(runningOutput(ex.lock, { commit: ex.view.commit }), line(ex.lock, `since ${ex.lock.startedAt}`));
  if (ex.state === 'orphan') finish({ estado: 'parado', motivo: `trava órfã: ${ex.reason}` }, `no core up (orphan lock: ${ex.reason})`, 1);
  finish({ estado: 'parado' }, 'no core up', 1);
}

async function stop(): Promise<never> {
  const ex = await examine(dir);
  if (ex.state === 'absent') finish({ estado: 'parado' }, 'no core up');
  if (ex.state === 'orphan') {
    removeLock(ex.lock?.token ?? null, dir);
    finish({ estado: 'parado', motivo: `trava órfã apagada: ${ex.reason}` }, `no core up; orphan lock deleted (${ex.reason})`);
  }
  if (!(await stopCore(ex.lock, { dir }))) finish({ estado: 'de-pe', pid: ex.lock.pid, motivo: 'não saiu' }, `the core (pid ${ex.lock.pid}) did not exit`, 1);
  finish({ estado: 'parado', pid: ex.lock.pid }, `core stopped (pid ${ex.lock.pid})`);
}

async function start(): Promise<never> {
  const parent = parentOption === undefined ? null : Number(parentOption);
  if (parent !== null && !(Number.isInteger(parent) && parent > 0 && isPidAlive(parent))) throw new Error('--parent: the pid of a live process');
  const port = Number(portOption ?? process.env.AHRENA_CONSOLE_PORT ?? 4720);
  const s = await startOrAdopt({ dir, port, parent, replace, apiArgs, log });
  if (s.estado !== 'de-pe') finish(s, `the core did not start: ${s.motivo}`, 1);
  const how = s.subiu ? 'just started' : 'adopted';
  finish(s, `core up at ${s.url} · version ${s.versao}${s.commit ? ` (${s.commit})` : ''}${s.pid ? ` · pid ${s.pid}` : ''} (${how})`);
}

if (command === 'status') await status();
else if (command === 'start' || command === 'subir') await start();
else if (command === 'stop' || command === 'parar') await stop();
else {
  process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
  process.exit(2);
}
