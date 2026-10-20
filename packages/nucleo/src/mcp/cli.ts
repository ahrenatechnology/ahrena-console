#!/usr/bin/env node
// The core's MCP over stdio, for clients that only speak stdio (Claude Desktop's
// `claude_desktop_config.json`). It is a bridge to the `/mcp` of the core already running
// (`npm run api`): the same server and a single process reading the database. `npm run mcp -- --help`.
//
// The core comes from the single owner (src/owner, #86): the bridge adopts the machine's core
// through the lock or, if nobody started one, starts one with `--parent` on itself. When the bridge
// exits (Claude Desktop closes), the core exits too, unless another client (the app, another
// bridge) is registered.
//
// Old option names (`--porta`, `--sem-subir`) are still accepted until phase 6 of #173; the new
// one wins if both are given.

import { parseArgs } from 'node:util';
import { examine } from '../owner/owner.ts';
import { startOrAdopt } from '../owner/start.ts';
import { MCP_PATH } from './http.ts';
import { serverWithoutCore } from './index.ts';
import { serveStdio, httpBridge } from './stdio.ts';

const HELP = `Usage: npm run mcp -- [options]

  --port <n>    Talks only to the core on this port, without adopting or starting one (the old mode)
  --no-start    Adopts the core from the lock, but does not start one if there is none
  --help

Without --port, the bridge adopts this machine's core (~/.ahrena-console/nucleo.json) or starts one
on AHRENA_CONSOLE_PORT or 4720, with --parent on itself: the core exits when the bridge and every
registered client exit.

Reads JSON-RPC from stdin and answers on stdout, one message per line. Without the core up, the tool
list answers and every call says how to start it.
The old names (--porta, --sem-subir) are accepted until phase 6.
`;

const { values: o } = parseArgs({
  options: {
    port: { type: 'string' },
    'no-start': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
    // Old names, accepted until phase 6.
    porta: { type: 'string' },
    'sem-subir': { type: 'boolean', default: false },
  },
});
if (o.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
const portOption = o.port ?? o.porta;
const noStart = o['no-start'] || o['sem-subir'];
const fixedPort = portOption !== undefined;
const port = Number(portOption ?? process.env.AHRENA_CONSOLE_PORT ?? 4720);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  // Names what was actually used: the new option, the old one or the env var.
  const source = o.port !== undefined ? '--port' : o.porta !== undefined ? '--porta' : 'AHRENA_CONSOLE_PORT';
  process.stderr.write(`invalid ${source}: ${portOption ?? process.env.AHRENA_CONSOLE_PORT}\n`);
  process.exit(2);
}
const log = (m: string): void => {
  process.stderr.write(`[ahrena-console mcp] ${m}\n`);
};
const url = (p: number) => `http://127.0.0.1:${p}${MCP_PATH}`;

// The core's port: the live lock's, checked on every request (the core may have been replaced).
async function corePort(): Promise<number> {
  if (fixedPort) return port;
  const ex = await examine();
  return ex.state === 'alive' ? ex.lock.port : port;
}

// Adopts or starts, in the background: `initialize` answers right away, with the core or without it.
let starting: Promise<void> | null = null;
function ensureCore(): void {
  if (fixedPort || noStart || starting) return;
  starting = startOrAdopt({ port, parent: process.pid, log })
    .then((r) => log(r.estado === 'de-pe' ? `core at ${r.url} (${r.subiu ? 'started now' : 'adopted'})` : `the core did not start: ${r.motivo}`))
    .catch((e) => log(`the core did not start: ${(e as Error).message}`))
    .finally(() => {
      starting = null;
    });
}
ensureCore();

// Shown to the model in the tool error: pt-BR, with the commands as they still are on screen.
const howToStart = fixedPort
  ? `Suba com \`npm run api -- --porta ${port}\` em packages/nucleo e chame de novo.`
  : noStart
    ? 'Suba com `npm run nucleo -- subir` em packages/nucleo e chame de novo.'
    : 'A ponte está subindo o núcleo; chame de novo em alguns segundos.';
await serveStdio({
  handle: async (m) => {
    const p = await corePort();
    return httpBridge(url(p), {
      withoutCore: (msg) => {
        // The core went down or was stopped: next time, it is already up again.
        ensureCore();
        return serverWithoutCore(`O núcleo do Ahrena Console não respondeu em ${url(p)}. ${howToStart}`).handle(msg);
      },
    })(m);
  },
  log,
});
