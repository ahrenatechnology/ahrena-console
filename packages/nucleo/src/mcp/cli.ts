#!/usr/bin/env node
// The core's MCP over stdio: how Claude Code (`claude mcp add ahrena-console -- node …/cli.ts`),
// Claude Desktop and the `.mcpb` extension register it. It is a bridge to the `/mcp` of a core that is
// already running: the same server and a single process reading each database. `npm run mcp -- --help`.
//
// Since #221 (decision 0010) each core listens on a random port and writes itself into the instance
// registry. The bridge reads the registry on every request and picks a core by the rule in target.ts:
// its own installation's core, else the oldest live one; with none of its installation live, it may
// start its own with `--parent` on itself, and that core exits when the bridge and every registered
// client exit.

import { parseArgs } from 'node:util';
import { parseInstallation, resolveDataDir, resolvePort, type Installation } from '../owner/installation.ts';
import { startOrAdopt } from '../owner/start.ts';
import { MCP_PATH } from './http.ts';
import { serverWithoutCore } from './index.ts';
import { serveStdio, httpBridge, type MessageHandler } from './stdio.ts';
import { CoreResolver, lockKey, type CoreTarget } from './target.ts';

const HELP = `Usage: npm run mcp -- [options]

  --installation <i>  app, dev or mcpb (default dev): whose core the bridge prefers and starts.
                      The .mcpb extension passes mcpb
  --data-dir <dir>    The data folder of the core it starts (default: the installation's)
  --port <n>          Talks only to the core on this port: no registry, no start (the old mode)
  --no-start          Uses a live core from the registry, but never starts one
  --help

Without --port, the bridge reads the instance registry (~/.ahrena-console/instances) on every
request: the oldest live core of its installation, else the oldest live core of any installation.
With none of its installation live, mcpb starts its own; dev and app start their own only when no
core is live at all. The core it starts gets port 0 (or AHRENA_CONSOLE_CORE_PORT /
AHRENA_CONSOLE_PORT, if set) and --parent on the bridge: it exits when the bridge and every
registered client exit.

Reads JSON-RPC from stdin and answers on stdout, one message per line. Without a core up, the tool
list answers and every call says how to start one.
`;

const { values: o } = parseArgs({
  options: {
    installation: { type: 'string' },
    'data-dir': { type: 'string' },
    port: { type: 'string' },
    'no-start': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (o.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
const fail = (m: string): never => {
  process.stderr.write(`${m}\n`);
  process.exit(2);
};
const log = (m: string): void => {
  process.stderr.write(`[ahrena-console mcp] ${m}\n`);
};
const url = (p: number) => `http://127.0.0.1:${p}${MCP_PATH}`;

const portOption = o.port;
const noStart = o['no-start'];
let installation: Installation = 'dev';
let startPort = 0;
try {
  installation = parseInstallation(o.installation);
  startPort = resolvePort(undefined);
} catch (e) {
  fail((e as Error).message);
}
const fixedPort = portOption === undefined ? null : Number(portOption);
if (fixedPort !== null && (!Number.isInteger(fixedPort) || fixedPort < 1 || fixedPort > 65535)) fail(`invalid --port: ${portOption}`);

const resolver =
  fixedPort === null
    ? new CoreResolver({
        installation,
        dataDir: resolveDataDir({ installation, dataDir: o['data-dir'] }),
        startPort,
        noStart,
        parent: process.pid,
        start: startOrAdopt,
        log,
      })
    : null;

// Starts (or finds) the core in the background: `initialize` answers right away, with a core or without.
void resolver?.target().catch((e) => log(`registry: ${(e as Error).message}`));

// Shown to the model in the tool error: pt-BR, with the commands as they are on screen.
const howToStart = (): string =>
  fixedPort !== null
    ? `O núcleo não respondeu em ${url(fixedPort)}. Suba com \`npm run api -- --port ${fixedPort}\` em packages/nucleo e chame de novo.`
    : resolver?.isStarting()
      ? 'Nenhum núcleo do Ahrena Console respondeu ainda; a ponte está subindo um. Chame de novo em alguns segundos.'
      : 'Nenhum núcleo do Ahrena Console respondeu. Suba com `npm run core -- start` em packages/nucleo e chame de novo.';

/** Thrown by the bridge's `withoutCore`: the core did not answer, try the next one. */
class Unreachable extends Error {}
const unreachable: MessageHandler = async () => {
  throw new Unreachable();
};
const send = (port: number, m: unknown) => httpBridge(url(port), { withoutCore: unreachable })(m);

/** At most this many cores tried for one message (a stale entry, then the next one). */
const MAX_TRIES = 3;

await serveStdio({
  handle: async (m) => {
    if (fixedPort !== null) {
      try {
        return await send(fixedPort, m);
      } catch (e) {
        if (!(e instanceof Unreachable)) throw e;
        return serverWithoutCore(howToStart()).handle(m);
      }
    }
    const tried = new Set<string>();
    for (let n = 0; n < MAX_TRIES; n++) {
      const t: CoreTarget | null = await resolver!.target(tried);
      if (!t) break;
      try {
        return await send(t.port, m);
      } catch (e) {
        if (!(e instanceof Unreachable)) throw e;
        // The core went down or moved: skip it now, look in the registry again next time. Its port
        // is not tried again as rule 2 in this request either.
        resolver!.failed(t);
        tried.add(t.key).add(lockKey(t.port));
      }
    }
    // Nobody answered: the next request tries again, and a core may be starting meanwhile (target()
    // decides that, by the rule; a live core that does not answer does not start another one).
    return serverWithoutCore(howToStart()).handle(m);
  },
  log,
});
