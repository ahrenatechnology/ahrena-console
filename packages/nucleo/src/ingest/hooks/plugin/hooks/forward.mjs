#!/usr/bin/env node
// Forwards Claude Code's hook events to the Ahrena Console cores.
//
// Reads the payload from stdin and POSTs it to `/api/hooks` of every core it finds. It never gets in
// the session's way:
// - writes nothing to stdout (on SessionStart and UserPromptSubmit, stdout becomes model context);
// - always exits 0, even with every core down;
// - gives up after AHRENA_CONSOLE_HOOK_TIMEOUT_MS (default 800 ms), counting the read and every send;
// - logs each failure as one line, which `doctor` (item 1.8) reads.
//
// Where it sends (decision 0010, item 4; issue #221):
// - `AHRENA_CONSOLE_URL` or `AHRENA_CONSOLE_PORT` set: that core only.
// - Otherwise, every live core in the instance registry, `<home>/instances/<installation>-<pid>.json`,
//   where `<home>` is `AHRENA_CONSOLE_HOME` or `~/.ahrena-console`. All at once, within the same
//   deadline, with the same body and the same `x-ahrena-delivery-id`: one delivery, many cores.
// - Transition (decision 0010, item 7): also 127.0.0.1:4720, unless a registered core already has it.
//   Cores published before #221 (the app 0.0.1, an old checkout) answer there and write no registry
//   entry. Nobody listening there is the normal case once they are gone, so a refused connection to
//   4720 is not logged. Goes away when every published core writes the registry.
// - No live core at all: the 4720 attempt is refused and nothing is logged (with nothing running,
//   every hook of every session would add a line).
// The hook only reads the registry. Entries of dead cores are skipped here and deleted by the cores,
// which clean the folder when they list it; a hook stays free of side effects.
// An entry is trusted on "pid alive" alone: the file of a core killed with SIGKILL whose pid was reused
// makes the hook POST to whatever listens on that 127.0.0.1 port (or log ECONNREFUSED) until a core
// lists the folder and cleans it. Same exposure as the old fixed 4720; checking that the port answers
// with that pid (verifyInstance) would cost a round trip per hook, so it is left out.
//
// The payload carries an `ahrena_console.env` field with the environment's config folder, account and
// org (decision 0006): only `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_ACCOUNT_UUID` and
// `CLAUDE_CODE_ORGANIZATION_UUID`, plus `ssh: true` when the hook runs in an SSH session (only the
// presence of `SSH_CONNECTION`, never its value). No other variable, and never a token or key. That is
// why it only sends to a local core: an `AHRENA_CONSOLE_URL` outside 127.0.0.1, localhost and ::1 is
// refused, and registry entries are always reached on 127.0.0.1.
//
// Plain JavaScript with no dependencies, so it runs on any Node >= 18 without the core installed.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const env = process.env;
const explicitBase = env.AHRENA_CONSOLE_URL || (env.AHRENA_CONSOLE_PORT ? `http://127.0.0.1:${env.AHRENA_CONSOLE_PORT}` : '');
const home = env.AHRENA_CONSOLE_HOME ? resolve(env.AHRENA_CONSOLE_HOME) : join(homedir(), '.ahrena-console');
const timeoutMs = Number(env.AHRENA_CONSOLE_HOOK_TIMEOUT_MS) || 800;
const logPath = env.AHRENA_CONSOLE_HOOK_LOG || join(home, 'hooks.log');
const MAX_BODY = 1024 * 1024;
/**
 * The fixed port of the cores published before the registry (decision 0010, item 7).
 * `AHRENA_CONSOLE_LEGACY_PORT` moves it (the tests) and `0` turns the fallback off.
 */
const LEGACY_PORT = env.AHRENA_CONSOLE_LEGACY_PORT === undefined ? 4720 : Number(env.AHRENA_CONSOLE_LEGACY_PORT);
const LEGACY_BASE = Number.isInteger(LEGACY_PORT) && LEGACY_PORT > 0 && LEGACY_PORT <= 65535 ? `http://127.0.0.1:${LEGACY_PORT}` : null;
const MAX_LOG = 256 * 1024;
/** A registry entry is a few hundred bytes; anything bigger is not one. */
const MAX_ENTRY = 64 * 1024;
const firedAt = new Date().toISOString();
const deadline = Date.now() + timeoutMs;

function record(message) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    try {
      if (statSync(logPath).size > MAX_LOG) truncateSync(logPath, 0);
    } catch {
      // no file yet
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // nowhere to log: stay silent
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish('stdin não fechou a tempo'), Math.max(deadline - Date.now(), 0));
    function finish(problem) {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve({ body: Buffer.concat(chunks).toString('utf8'), problem });
    }
    process.stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) return finish('payload maior que 1 MiB, descartado');
      chunks.push(chunk);
    });
    process.stdin.on('end', () => finish(null));
    process.stdin.on('error', (err) => finish(`erro no stdin: ${err.message}`));
  });
}

/** The environment variables that go to the core; no other leaves from here. */
const CONTEXT_VARS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ACCOUNT_UUID', 'CLAUDE_CODE_ORGANIZATION_UUID'];

/** Adds `ahrena_console.env` to the payload; if it is not a JSON object, it goes as it came. */
function withContext(body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return body;
  const context = {};
  for (const name of CONTEXT_VARS) if (env[name]) context[name] = env[name];
  if (env.SSH_CONNECTION) context.ssh = true;
  return JSON.stringify({ ...payload, ahrena_console: { env: context } });
}

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

/** The core's address, if it is local; else `null`. */
function localBase(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.includes(u.hostname) ? url : null;
  } catch {
    return null;
  }
}

/** The registry's file names: `<installation>-<pid>.json`, as the core writes them. */
const INSTANCE_ID = /^(app|dev|mcpb)-[1-9]\d*$/;

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

/** `true` if the pid exists; EPERM means it exists under another user. */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * The address of every live core in the registry, one per port. An entry that cannot be read, is
 * malformed, does not match its file name or has a dead pid is skipped, never deleted.
 */
function registeredBases() {
  const dir = join(home, 'instances');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const ports = new Set();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!INSTANCE_ID.test(id)) continue;
    let entry;
    try {
      const file = join(dir, name);
      const st = statSync(file);
      if (!st.isFile() || st.size > MAX_ENTRY) continue;
      entry = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || entry.id !== id) continue;
    if (!isPositiveInt(entry.pid) || id !== `${entry.installation}-${entry.pid}`) continue;
    if (!isPositiveInt(entry.port) || entry.port > 65535) continue;
    if (isPidAlive(entry.pid)) ports.add(entry.port);
  }
  return [...ports].map((port) => `http://127.0.0.1:${port}`);
}

/** The registry's cores plus the legacy 4720, unless one of them is already there. */
function targetBases() {
  const bases = registeredBases();
  return !LEGACY_BASE || bases.includes(LEGACY_BASE) ? bases : [...bases, LEGACY_BASE];
}

function eventName(body) {
  const m = /"hook_event_name"\s*:\s*"([A-Za-z0-9]+)"/.exec(body);
  return m ? m[1] : 'desconhecido';
}

/** Sends one delivery to one core; a failure becomes a log line naming the core. */
async function send(base, event, payload, deliveryId) {
  try {
    const res = await fetch(`${base}/api/hooks`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ahrena-delivery-id': deliveryId,
        'x-ahrena-hook-at': firedAt,
      },
      body: payload,
      signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 50)),
    });
    if (!res.ok) record(`${event} recusado pelo núcleo ${base}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    const cause = err?.cause?.code || err?.name || 'erro';
    // Nobody on the legacy port is the normal case after the transition: not a failure.
    if (base === LEGACY_BASE && !explicitBase && cause === 'ECONNREFUSED') return;
    record(`${event} não enviado a ${base}: ${cause}`);
  }
}

async function main() {
  // stdin is always read to the end (or the deadline), so Claude Code never writes to a closed pipe.
  const { body, problem } = await readStdin();
  const targets = explicitBase ? [explicitBase.replace(/\/+$/, '')] : targetBases();
  if (!targets.length) return; // no core and no legacy port: nothing to send, nothing to log
  const event = eventName(body);
  if (problem) return record(`${event} não enviado: ${problem}`);
  if (!body.trim()) return record('hook sem payload, nada a enviar');
  if (explicitBase && !localBase(targets[0])) return record(`${event} não enviado: AHRENA_CONSOLE_URL precisa ser 127.0.0.1, localhost ou ::1`);
  const payload = withContext(body);
  const deliveryId = randomUUID();
  await Promise.allSettled(targets.map((base) => send(base, event, payload, deliveryId)));
}

main()
  .catch((err) => record(`falha inesperada: ${err?.message ?? err}`))
  .finally(() => process.exit(0));
