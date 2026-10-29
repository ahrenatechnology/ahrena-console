#!/usr/bin/env node
// The core's command for the app, the extension and the terminal: `npm run core -- status|start|stop`.
// `start` adopts the live core or starts one in the background, and only returns once it answers.
// One core per installation (decision 0010, #221): `--installation` and `--data-dir` say which one;
// the port is random (0) unless `--port` or `AHRENA_CONSOLE_CORE_PORT` forces one.
//
// The `--json` line is English (`state` `up`/`stopped`, `port`, `started`, `reason`…; start.ts). The
// old Portuguese names (`subir`, `parar`, `--porta`, `--pai`, `--substituir`) left in phase 6 of #173.

import { parseArgs } from 'node:util';
import { examine, stopCore } from './owner.ts';
import { isPidAlive } from './probe.ts';
import { runningOutput, startOrAdopt, type StartOutput } from './start.ts';
import { removeLock, type Lock } from './lock.ts';
import { INSTALLATIONS, consoleHome, parseInstallation, resolveDataDir, resolvePort } from './installation.ts';
import { listInstances, type Instance } from './registry.ts';

const HELP = `Usage: npm run core -- <command> [options] [-- API options]

  status              Says whether this installation's core is up (exit 0 if so, 1 if not) and lists
                      every live core in the instance registry (~/.ahrena-console/instances/)
  start               Adopts this installation's core or starts one in the background (log in
                      <data-dir>/nucleo.log) and waits for it to answer
  stop                Stops this installation's core (SIGTERM, then SIGKILL) and deletes the lock
  voice install       Installs the dictation engine for the compose box: builds whisper.cpp (CUDA with an
                      NVIDIA GPU and nvcc, else CPU) and downloads the ggml large-v3-turbo model into
                      ~/.ahrena-console/voice. Needs git and cmake. Runs once per machine

  --installation <i>  ${INSTALLATIONS.join(', ')} (default dev). Each installation runs its own core, with its
                      own data folder, and never adopts another installation's core
  --data-dir <dir>    Database, log, clients and lock. Default AHRENA_CONSOLE_DATA_DIR or the
                      installation's folder: dev ~/.ahrena-console, app ~/Library/Application
                      Support/dev.ahrena.console, mcpb ~/.ahrena-console/installations/mcpb
  --port <n>          For start. Default AHRENA_CONSOLE_CORE_PORT, AHRENA_CONSOLE_PORT or 0 (the
                      system picks a free port, announced in the output). If a core is up, its port wins
  --parent <pid>      For start: the core exits when this process is gone, unless another client
                      is registered. When adopting, registers the pid as a client
  --replace           For start: also replaces the core that is up if it runs an ancestor commit of
                      this version. A core of an older version is always replaced; other code only
                      warns
  --json              One JSON line on stdout, for the app and the extension
  --help

After --, options go to the API (npm run api -- --help), for example -- --no-github.
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    parent: { type: 'string' },
    replace: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
    installation: { type: 'string' },
    'data-dir': { type: 'string' },
  },
});
const [command, ...apiArgs] = positionals;
if (o.help || !command) {
  process.stdout.write(HELP);
  process.exit(o.help ? 0 : 2);
}
const portOption = o.port;
const parentOption = o.parent;
const replace = o.replace;

const log = (m: string) => console.error(`[ahrena-console] ${m}`);
const installation = parseInstallation(o.installation);
const dir = resolveDataDir({ installation, dataDir: o['data-dir'] });
const where = { installation, dataDir: dir };

function finish(s: StartOutput & { instances?: Instance[] }, text: string, exitCode = 0): never {
  process.stdout.write(o.json ? `${JSON.stringify(s)}\n` : `${text}\n`);
  process.exit(exitCode);
}

const line = (t: Lock, how: string) => `core up at http://127.0.0.1:${t.port} · version ${t.version} · pid ${t.pid} (${how})`;

const instanceLine = (i: Instance) => `  ${i.id} · ${i.installation} · port ${i.port} · pid ${i.pid} · version ${i.version}${i.commit ? ` (${i.commit})` : ''} · ${i.dataDir}`;

/** This installation's core, plus every live core in the registry (never a token: there is none there). */
async function status(): Promise<never> {
  const ex = await examine(dir);
  const instances = listInstances();
  const listing = instances.length ? `\ninstances:\n${instances.map(instanceLine).join('\n')}` : '\ninstances: none';
  const extra = { ...where, instances };
  if (ex.state === 'alive') finish({ ...runningOutput(ex.lock, { commit: ex.view.commit }), ...extra }, `${line(ex.lock, `since ${ex.lock.startedAt}`)}${listing}`);
  if (ex.state === 'orphan') finish({ state: 'stopped', reason: `trava órfã: ${ex.reason}`, ...extra }, `no ${installation} core up (orphan lock: ${ex.reason})${listing}`, 1);
  finish({ state: 'stopped', ...extra }, `no ${installation} core up${listing}`, 1);
}

async function stop(): Promise<never> {
  const ex = await examine(dir);
  if (ex.state === 'absent') finish({ state: 'stopped' }, 'no core up');
  if (ex.state === 'orphan') {
    removeLock(ex.lock?.token ?? null, dir);
    finish({ state: 'stopped', reason: `trava órfã apagada: ${ex.reason}` }, `no core up; orphan lock deleted (${ex.reason})`);
  }
  if (!(await stopCore(ex.lock, { dir }))) finish({ state: 'up', pid: ex.lock.pid, reason: 'não saiu' }, `the core (pid ${ex.lock.pid}) did not exit`, 1);
  finish({ state: 'stopped', pid: ex.lock.pid }, `core stopped (pid ${ex.lock.pid})`);
}

async function start(): Promise<never> {
  const parent = parentOption === undefined ? null : Number(parentOption);
  if (parent !== null && !(Number.isInteger(parent) && parent > 0 && isPidAlive(parent))) throw new Error('--parent: the pid of a live process');
  const port = resolvePort(portOption);
  const s = await startOrAdopt({ installation, dir, port, parent, replace, apiArgs, log });
  if (s.state !== 'up') finish({ ...s, ...where }, `the core did not start: ${s.reason}`, 1);
  const how = s.started ? 'just started' : 'adopted';
  finish(s, `core up at ${s.url} · version ${s.version}${s.commit ? ` (${s.commit})` : ''}${s.pid ? ` · pid ${s.pid}` : ''} (${how})`);
}

if (command === 'status') await status();
else if (command === 'start') await start();
else if (command === 'stop') await stop();
else if (command === 'voice' && apiArgs[0] === 'install') {
  const { installVoice } = await import('../transcription/install.ts');
  try {
    const r = await installVoice({ home: consoleHome(), log });
    finish({ state: 'installed', ...r } as never, `dictation installed: ${r.bin}`);
  } catch (e) {
    finish({ state: 'failed', reason: (e as Error).message } as never, `voice install failed: ${(e as Error).message}`, 1);
  }
}
else {
  process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
  process.exit(2);
}
