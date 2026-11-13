#!/usr/bin/env node
// Updates the core of a remote machine (the Workstation) from a checkout: guard, backup, switch, restart,
// confirm, roll back on failure. Issue 449, decision docs/decisoes/0021-remote-core-update.md (the contract:
// read it before changing the steps or the exit codes). Only node: built-ins, Node 24.
//
//   node update-remote-core.mjs --checkout <path> --ref <ref> [--port 4720] [--data-dir <dir>]
//        [--mac-telemetry-version <n>] [--mac-credential-command yes|no] [--allow-disconnect]
//        [--core-options "<options of src/api/cli.ts>"] [--check] [--no-fetch] [--progress json] (#462)
//   node --input-type=module - <args> < update-remote-core.mjs     (the script read from stdin, ADR-0022 section 2)
//   node update-remote-core.mjs install-unit --checkout <path> [--port 4720] [--data-dir <dir>] [--core-options "..."]
//
// Exit codes: 0 updated and confirmed (or --check passed); 2 usage; 20 guard: telemetry protocol differs;
// 21 guard: the target needs the owner's proof and the Mac has no credential command; 22 guard: the target
// has no manifest; 23 guard: the Mac's flags are missing; 30 dirty tree, unknown ref, or the target adds
// production dependencies; 31 backup failed; 32 the process does not check out (cmdline, port, uid) or its
// options cannot be read, or it did not stop; 33 another update holds <data-dir>/update.lock; 40 failed and (#462)
// rolled back; 41 failed and the rollback failed; 130 canceled by a signal during the check. (#462)
// Nothing is stopped, and no signal is sent, before the guard and the process check pass.
//
// --progress json (decision 0022 section 4): stdout carries only NDJSON, one phase event per phase (check, (#462)
// backup, swap, start, verify, rollback) and one final result event; the human messages go to stderr. (#462)
// Signals: until the backup phase SIGINT, SIGTERM and SIGHUP cancel (exit 130, lock released); from the backup (#462)
// phase on SIGHUP, SIGPIPE, SIGINT and SIGTERM are ignored, so the script finishes alone. (#462)
//
// Environment, for tests: AHRENA_CONSOLE_PROC_ROOT (default /proc), AHRENA_CONSOLE_UPDATE_START_TIMEOUT_MS
// (default 30000), AHRENA_CONSOLE_UPDATE_STOP_TIMEOUT_MS (default 15000), AHRENA_CONSOLE_UPDATE_PAUSE_MS
// (a pause between the backup and the stop, so a test can change the world in that window).

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync,
  linkSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { get } from 'node:http';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const EXIT = {
  OK: 0, USAGE: 2, TELEMETRY: 20, OWNER_PROOF: 21, NO_MANIFEST: 22, NO_MAC_FLAGS: 23,
  PREFLIGHT: 30, BACKUP: 31, PROCESS: 32, LOCKED: 33, ROLLED_BACK: 40, ROLLBACK_FAILED: 41, CANCELED: 130,
};
const UNIT = 'ahrena-console-core.service';
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];
const KEEP_BACKUPS = 5;
const MANIFEST_PATH = 'packages/nucleo/remote-contract.json';
const CLI_REL = 'packages/nucleo/src/api/cli.ts';
const OWNER_CLI_REL = 'packages/nucleo/src/owner/cli.ts';

class Stop extends Error {
  /** `reason` is the closed word of decision 0022 section 4 that tells apart the causes of one exit code. (#462) */
  constructor(code, message, reason = null) { super(message); this.code = code; this.reason = reason; }
}

// ---- progress: NDJSON on stdout under --progress json, human text on stderr --------------------------------- (#462)

let progress = false;
const report = { reason: null, backup: null, oldCommit: null, newCommit: null };
let resultSent = false;

const out = (line) => (progress ? console.error(line) : console.log(line));
const warn = (line) => console.error(line);
function emit(event) {
  if (!progress) return;
  try { writeSync(1, `${JSON.stringify({ v: 1, ...event })}\n`); } catch { /* the reader is gone: the script goes on alone (#462) */ }
}
const phase = (name) => emit({ event: 'phase', phase: name });
function emitResult(exit) {
  if (resultSent) return;
  resultSent = true;
  emit({ event: 'result', exit, reason: report.reason, backup: report.backup, oldCommit: report.oldCommit, newCommit: report.newCommit });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeoutMs = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ---- arguments -----------------------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['checkout', 'ref', 'port', 'data-dir', 'core-options', 'mac-telemetry-version', 'mac-credential-command', 'progress']);
const BOOL_FLAGS = new Set(['allow-disconnect', 'check', 'no-fetch', 'help']);

export function parseArguments(argv) {
  const opts = { command: 'update' };
  const rest = [...argv];
  if (rest[0] === 'install-unit') { opts.command = 'install-unit'; rest.shift(); }
  while (rest.length) {
    const arg = rest.shift();
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg);
    if (!m) throw new Stop(EXIT.USAGE, `unexpected argument: ${arg}`);
    const [, name, inline] = m;
    if (BOOL_FLAGS.has(name)) { opts[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) throw new Stop(EXIT.USAGE, `unknown option: --${name}`);
    // The value is the next argument as is, even when it starts with "--" (--core-options "--port 4720 ...").
    const value = inline ?? rest.shift();
    if (value === undefined) throw new Stop(EXIT.USAGE, `--${name} needs a value`);
    opts[name] = value;
  }
  if (opts.help) return opts;
  if (opts.progress !== undefined && opts.progress !== 'json') throw new Stop(EXIT.USAGE, '--progress must be json');
  if (!opts.checkout) throw new Stop(EXIT.USAGE, '--checkout is required');
  if (opts.command === 'update' && !opts.ref) throw new Stop(EXIT.USAGE, '--ref is required (an app-vX.Y.Z tag, origin/main or a sha): the script never picks "the newest" by itself');
  opts.port = opts.port === undefined ? 4720 : Number(opts.port);
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Stop(EXIT.USAGE, '--port must be a port number');
  if (opts['mac-telemetry-version'] !== undefined) {
    const n = Number(opts['mac-telemetry-version']);
    if (!Number.isInteger(n) || n < 0) throw new Stop(EXIT.USAGE, '--mac-telemetry-version must be an integer');
    opts['mac-telemetry-version'] = n;
  }
  const cred = opts['mac-credential-command'];
  if (cred !== undefined && cred !== 'yes' && cred !== 'no') throw new Stop(EXIT.USAGE, '--mac-credential-command must be yes or no');
  if (opts['core-options'] !== undefined) opts.coreOptions = splitOptions(opts['core-options']);
  return opts;
}

const USAGE = `Usage:
  update-remote-core.mjs --checkout <path> --ref <ref> [--port 4720] [--data-dir <dir>]
      --mac-telemetry-version <n> --mac-credential-command yes|no
      [--allow-disconnect] [--core-options "<options>"] [--check] [--no-fetch] [--progress json]
  update-remote-core.mjs install-unit --checkout <path> [--port 4720] [--data-dir <dir>] [--core-options "<options>"]
See scripts/remote-core/README.md and docs/decisoes/0021-remote-core-update.md, 0022-remote-core-update-button.md.`;

/** Whitespace-separated words; double quotes group a word with spaces. */
export function splitOptions(text) {
  const words = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) words.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return words;
}

// ---- git -----------------------------------------------------------------------------------------------

function git(checkout, ...args) {
  return execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitOrNull(checkout, ...args) {
  try { return git(checkout, ...args); } catch { return null; }
}

// ---- the core, by its port -----------------------------------------------------------------------------

/** The anonymous GET /api/overview on loopback, or null. The pid in it is a hint: anyone on the port can forge it. */
function readOverview(port, timeout = 2000) {
  return new Promise((done) => {
    const req = get({ host: '127.0.0.1', port, path: '/api/overview', timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || !body || typeof body !== 'object') return done(null);
          done({
            pid: Number.isInteger(body.pid) && body.pid > 0 ? body.pid : null,
            // What the anonymous overview says is data from whoever answers on the port: only the exact shapes of
            // decision 0021 section 1 are used, anything else is null.
            version: typeof body.version === 'string' && VERSION.test(body.version) ? body.version : null,
            commit: typeof body.commit === 'string' && COMMIT.test(body.commit) ? body.commit : null,
          });
        } catch { done(null); }
      });
      res.on('error', () => done(null));
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

const VERSION = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{4,40}$/;
const sameCommit = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));

async function waitFor(check, timeout, interval = 150) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= end) return null;
    await sleep(interval);
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---- verifying a process before any signal --------------------------------------------------------------

const procRoot = () => process.env.AHRENA_CONSOLE_PROC_ROOT || '/proc';
const procMounted = () => { try { return statSync(procRoot()).isDirectory(); } catch { return false; } };

function readCmdline(pid) {
  try {
    const raw = readFileSync(join(procRoot(), String(pid), 'cmdline'), 'utf8');
    return raw.split('\0').filter((s, i, a) => s !== '' || i < a.length - 1).filter((s) => s !== '');
  } catch { return null; }
}
function readUid(pid) {
  try {
    const m = /^Uid:\s+(\d+)/m.exec(readFileSync(join(procRoot(), String(pid), 'status'), 'utf8'));
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
const samePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); } catch { return resolve(a) === resolve(b); }
};
/** The value of --port in a list of core options, or null. */
function portOf(options) {
  for (let i = 0; i < options.length; i += 1) {
    if (options[i] === '--port') return options[i + 1] ?? null;
    if (options[i].startsWith('--port=')) return options[i].slice(7);
  }
  return null;
}
function dataDirOf(options) {
  for (let i = 0; i < options.length; i += 1) {
    if (options[i] === '--data-dir') return options[i + 1] ?? null;
    if (options[i].startsWith('--data-dir=')) return options[i].slice(11);
  }
  return null;
}

/** The working directory of a process, or null. */
function readCwd(pid) {
  try { return readlinkSync(join(procRoot(), String(pid), 'cwd')); } catch { return null; }
}
/** Rewrites a relative --data-dir to an absolute one, against the directory the core was started in. */
function absolutizeDataDir(options, cwd) {
  const out = [...options];
  for (let i = 0; i < out.length; i += 1) {
    const inline = out[i].startsWith('--data-dir=');
    const value = inline ? out[i].slice(11) : out[i] === '--data-dir' ? out[i + 1] : undefined;
    if (value === undefined || isAbsolute(value)) continue;
    if (!cwd) throw new Stop(EXIT.PROCESS, `the core was started with a relative --data-dir (${value}) and its working directory cannot be read; pass --core-options with an absolute path (nothing was stopped)`, 'no-options');
    if (inline) out[i] = `--data-dir=${resolve(cwd, value)}`; else out[i + 1] = resolve(cwd, value);
  }
  return out;
}

/**
 * Decides whether the process the overview points at is this checkout's core on this port, owned by this
 * user. Reads only; sends no signal. Returns the options the core was started with. Throws Stop(32). It is
 * called again right before every signal, because the pid can be reused between the check and the kill.
 */
function verifyProcess(info, ctx) {
  const refuse = (why) => new Stop(EXIT.PROCESS, `the process on port ${ctx.port} does not check out (${why}); nothing was stopped`, 'process-mismatch');
  if (!info.pid) throw refuse('its overview has no valid pid');
  const cliPath = join(ctx.checkout, CLI_REL);
  if (procMounted()) {
    const cmdline = readCmdline(info.pid);
    if (!cmdline) throw refuse(`cannot read the cmdline of pid ${info.pid}`);
    // Exactly: node, then only flags, then this checkout's src/api/cli.ts, then the core options.
    if (!/^node(js)?$/.test(basename(cmdline[0] ?? ''))) throw refuse(`pid ${info.pid} is not running node`);
    let at = 1;
    while (at < cmdline.length && cmdline[at].startsWith('-')) at += 1;
    const cwd = readCwd(info.pid);
    const script = cmdline[at];
    const absolute = script === undefined ? null : isAbsolute(script) ? script : cwd ? resolve(cwd, script) : null;
    if (!absolute || !samePath(absolute, cliPath)) throw refuse(`pid ${info.pid} is not running ${cliPath}`);
    const options = cmdline.slice(at + 1);
    if (String(portOf(options)) !== String(ctx.port)) throw refuse(`pid ${info.pid} was not started with --port ${ctx.port}`);
    const uid = readUid(info.pid);
    if (uid === null || uid !== process.getuid()) throw refuse(`pid ${info.pid} belongs to another user`);
    return ctx.coreOptions ?? absolutizeDataDir(options, cwd);
  }
  // No /proc: the options are not guessed. The owner of the port comes from ss, which lists only the
  // processes of the user running it.
  if (!ctx.coreOptions) throw new Stop(EXIT.PROCESS, 'there is no /proc to read the core options from; pass them with --core-options "--port ... --installation ... --data-dir ..." (nothing was stopped)', 'no-options');
  let listing = '';
  try { listing = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* handled below */ }
  const owns = listing.split('\n').some((l) => new RegExp(`[:.]${ctx.port}\\s`).test(l) && new RegExp(`pid=${info.pid}[,)]`).test(l));
  if (!owns) throw refuse(`ss does not show pid ${info.pid} listening on ${ctx.port} as this user`);
  return ctx.coreOptions;
}

/** `recheck` verifies the process again; it runs right before SIGTERM (a failure there changes nothing) and before SIGKILL. */
async function terminate(pid, port, recheck) {
  if (recheck) {
    try { recheck(); } catch (e) { e.untouched = true; throw e; }
  }
  process.kill(pid, 'SIGTERM');
  const gone = async () => !isAlive(pid) && !(await readOverview(port, 500));
  if (await waitFor(gone, timeoutMs('AHRENA_CONSOLE_UPDATE_STOP_TIMEOUT_MS', 15000))) return;
  out(`pid ${pid} ignored SIGTERM; sending SIGKILL`);
  if (isAlive(pid)) {
    recheck?.();
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone (#462) */ }
  }
  if (!(await waitFor(gone, 5000))) throw new Stop(EXIT.PROCESS, `pid ${pid} did not stop, or port ${port} stayed busy`);
}

// ---- systemd user unit ------------------------------------------------------------------------------------

const unitPath = () => join(homedir(), '.config', 'systemd', 'user', UNIT);
function systemctl(...args) {
  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  return spawnSync('systemctl', ['--user', ...args], { env, encoding: 'utf8' });
}
const unitActive = () => systemctl('is-active', '--quiet', UNIT).status === 0;

const CONTROL = /[\x00-\x1f\x7f]/;
/** One word of ExecStart: systemd expands % and $ there, so both are doubled; whitespace and quotes need quoting. */
const quoteUnit = (s) => {
  const t = s.replace(/%/g, '%%').replace(/\$/g, () => '$$');
  return /[\s"'\\]/.test(s) ? `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : t;
};

/** The text of the unit, with absolute paths (decision 0021 section 3). Control characters are refused. */
export function renderUnit({ node, checkout, options, dataDir }) {
  for (const v of [node, checkout, dataDir, ...options]) {
    if (CONTROL.test(v)) throw new Stop(EXIT.USAGE, 'a control character (a newline, for instance) in a path or in the core options cannot go into a systemd unit');
  }
  const exec = [node, ...NODE_FLAGS, join(checkout, CLI_REL), ...options].map(quoteUnit).join(' ');
  const raw = (path) => path.replace(/%/g, '%%');
  return `[Unit]
Description=Ahrena Console core
After=network.target

[Service]
Type=simple
WorkingDirectory=${raw(join(checkout, 'packages/nucleo'))}
ExecStart=${exec}
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
StandardOutput=append:${raw(join(dataDir, 'core-stdout.log'))}
StandardError=inherit

[Install]
WantedBy=default.target
`;
}

// ---- the lock: one update at a time on the machine ---------------------------------------------------------- (#462)

const LOCK_FILE = 'update.lock';
const LOCK_STALE_MS = 30 * 60 * 1000;
const heldLocks = [];

/** Why a lock file no longer holds anything ('missing', 'dead-pid', 'older-than-30-minutes'), or null when it is live. (#462) */
function staleReason(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return 'missing'; }
  let held = null;
  try { held = JSON.parse(text); } catch { /* unreadable content: judged by the file age below (#462) */ }
  const startedAt = Date.parse(held?.startedAt);
  if (Number.isInteger(held?.pid) && Number.isFinite(startedAt)) {
    if (Date.now() - startedAt > LOCK_STALE_MS) return 'older-than-30-minutes';
    return isAlive(held.pid) ? null : 'dead-pid';
  }
  // Half-written or foreign content fails closed: live until the file itself is old. (#462)
  try { return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS ? 'older-than-30-minutes' : null; } catch { return 'missing'; }
}

const lockBusy = () => new Stop(EXIT.LOCKED, 'another update is running on this machine (update.lock is held); nothing was touched');

/** --check never creates the lock; it only refuses to run beside a live one. (#462) */
function refuseLiveLock(dataDir) {
  const file = join(dataDir, LOCK_FILE);
  if (existsSync(file) && staleReason(file) === null) throw lockBusy();
}

function acquireLock(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, LOCK_FILE);
  const text = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      // Tracked before the write: a failed write must not leave an empty lock that nobody releases. (#462)
      heldLocks.push({ file, text });
      try { writeSync(fd, text); } catch (e) { heldLocks.pop(); rmSync(file, { force: true }); throw e; } finally { closeSync(fd); }
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const stale = staleReason(file);
    if (stale === null) throw lockBusy();
    if (stale !== 'missing') takeOverStale(dataDir, file, stale);
  }
  throw lockBusy();
}

/**
 * (#462) Moves the stale file aside under a unique name before judging it again, so two scripts that both read
 * "stale" cannot delete the fresh lock the other just created: whoever moved a live lock puts it back.
 */
function takeOverStale(dataDir, file, stale) {
  const aside = `${file}.stale-${process.pid}`;
  try { renameSync(file, aside); } catch { return; }
  if (staleReason(aside) === null) {
    try { linkSync(aside, file); } catch { /* another lock is already there (#462) */ }
    rmSync(aside, { force: true });
    throw lockBusy();
  }
  logLine(dataDir, `took over a stale update.lock (${stale})`);
  rmSync(aside, { force: true });
}

/** Removes only the locks this process wrote and that still hold its own content. (#462) */
function releaseLocks() {
  for (const { file, text } of heldLocks.splice(0)) {
    try { if (readFileSync(file, 'utf8') === text) rmSync(file, { force: true }); } catch { /* already gone (#462) */ }
  }
}

// ---- signals: cancel while nothing was touched, ignore once the backup starts ---------------------------------- (#462)

const noop = () => {};
function cancelOnSignals() {
  const cancel = () => {
    releaseLocks();
    emitResult(EXIT.CANCELED);
    process.exit(EXIT.CANCELED);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, cancel);
}
/** From the backup on the script finishes alone: a closed ssh must not leave the machine half-updated. (#462) */
function ignoreSignals() {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGPIPE']) {
    process.removeAllListeners(signal);
    process.on(signal, noop);
  }
  process.stdout.on('error', noop);
  process.stderr.on('error', noop);
}

// ---- the context -----------------------------------------------------------------------------------------

function context(opts) {
  let checkout;
  try { checkout = realpathSync(resolve(opts.checkout)); } catch { throw new Stop(EXIT.PREFLIGHT, `the checkout ${opts.checkout} is not accessible`, 'not-a-checkout'); }
  if (gitOrNull(checkout, 'rev-parse', '--git-dir') === null) throw new Stop(EXIT.PREFLIGHT, `${checkout} is not a git checkout`, 'not-a-checkout');
  return { checkout, port: opts.port, coreOptions: opts.coreOptions };
}
/** The data folder: the core's own (from its options) and --data-dir must agree when both are given. */
function resolveDataDir(opts, options) {
  const fromFlag = opts['data-dir'] ? resolve(opts['data-dir']) : null;
  const own = dataDirOf(options ?? opts.coreOptions ?? []);
  const fromCore = own ? resolve(own) : null;
  if (fromFlag && fromCore && fromFlag !== fromCore) {
    throw new Stop(EXIT.PROCESS, `--data-dir (${fromFlag}) is not the data folder the core was started with (${fromCore}); nothing was changed`, 'data-dir-mismatch');
  }
  return fromFlag ?? fromCore ?? join(homedir(), '.ahrena-console');
}
function logLine(dataDir, line) {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, 'update.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* the log is a convenience */ }
}

// ---- steps: preflight and guard ---------------------------------------------------------------------------

function preflight(opts, ctx) {
  const { checkout } = ctx;
  if (git(checkout, 'status', '--porcelain', '--untracked-files=no') !== '') {
    throw new Stop(EXIT.PREFLIGHT, 'the checkout has tracked changes; commit or discard them first (no --force: nothing is overwritten)', 'dirty-tree');
  }
  if (!opts['no-fetch']) {
    try { execFileSync('git', ['-C', checkout, 'fetch', 'origin', '--tags'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }); } catch (e) { warn(`fetch failed (continuing with what the checkout has): ${String(e.stderr ?? e.message).trim()}`); }
  }
  const sha = gitOrNull(checkout, 'rev-parse', '--verify', `${opts.ref}^{commit}`);
  if (!sha) throw new Stop(EXIT.PREFLIGHT, `the ref ${opts.ref} does not resolve to a commit in ${checkout}`, 'unknown-ref');
  const oldHead = git(checkout, 'rev-parse', 'HEAD');
  const branch = gitOrNull(checkout, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  if (branch) warn(`warning: the checkout is on the branch ${branch}; the update leaves it on a detached HEAD (to go back: git switch ${branch}). Local commits stay on the branch.`);
  return { sha, oldHead, branch };
}

function readManifest(checkout, sha) {
  const text = gitOrNull(checkout, 'show', `${sha}:${MANIFEST_PATH}`);
  if (text === null) return null;
  try {
    const m = JSON.parse(text);
    return m && typeof m === 'object' ? m : null;
  } catch { return null; }
}

/** The guard of section 4, in order. Returns { code, why } for the first refusal, or null. */
export function guard(manifest, mac) {
  if (mac.telemetryVersion === undefined || mac.credentialCommand === undefined) {
    return { code: EXIT.NO_MAC_FLAGS, why: 'the Mac did not declare itself: pass --mac-telemetry-version and --mac-credential-command (the script cannot guess what the Mac supports)' };
  }
  if (!manifest) return { code: EXIT.NO_MANIFEST, why: `the target has no ${MANIFEST_PATH}: its contract with the Mac is unknown, not approved by omission` };
  if (manifest.telemetryVersion !== mac.telemetryVersion) {
    return { code: EXIT.TELEMETRY, why: `the target answers telemetry version ${manifest.telemetryVersion} and the Mac reads ${mac.telemetryVersion}: the Mac would show incompatible-version` };
  }
  if (manifest.ownerProofRequired === true && mac.credentialCommand === false) {
    return { code: EXIT.OWNER_PROOF, why: 'the target requires the owner proof and this machine has no credential command on the Mac: the Mac would be left on owner-auth-required; configure connection.credential first (decision 0020 section 1)' };
  }
  return null;
}

/** Everything the guard would refuse, ignoring the order, for the --allow-disconnect warning. */
function runGuard(opts, ctx, target) {
  const manifest = readManifest(ctx.checkout, target.sha);
  const mac = {
    telemetryVersion: opts['mac-telemetry-version'],
    credentialCommand: opts['mac-credential-command'] === undefined ? undefined : opts['mac-credential-command'] === 'yes',
  };
  const refusal = guard(manifest, mac);
  if (refusal && !opts['allow-disconnect']) throw new Stop(refusal.code, `refused: ${refusal.why}`);
  if (refusal) {
    warn(`WARNING (--allow-disconnect): ${refusal.why}`);
    warn('WARNING: this machine may be left WITHOUT a connection to the Mac. The rollback (step 8) still applies if the new core does not answer.');
  }
  return manifest;
}

function checkDependencies(ctx, target) {
  const read = (rev) => {
    try { return JSON.parse(git(ctx.checkout, 'show', `${rev}:packages/nucleo/package.json`)); } catch { return {}; }
  };
  const before = read(target.oldHead).dependencies ?? {};
  const after = read(target.sha).dependencies ?? {};
  const added = Object.keys(after).filter((k) => before[k] !== after[k]);
  if (added.length) {
    throw new Stop(EXIT.PREFLIGHT, `the target adds or changes production dependencies (${added.join(', ')}) and this script does not run npm install; nothing was stopped`, 'new-dependencies');
  }
}

// ---- steps: backup, start, confirm -------------------------------------------------------------------------

/** Removes a directory only when it is a strict child of the backups folder (real paths), never anything else. */
function removeBackupDir(dir, root) {
  try {
    const realRoot = realpathSync(root);
    const real = join(realpathSync(dirname(dir)), basename(dir));
    if (real.startsWith(realRoot + sep) && real !== realRoot) rmSync(real, { recursive: true, force: true });
  } catch { /* nothing to remove */ }
}

async function makeBackup(dataDir, oldCommit, liveCore) {
  const db = join(dataDir, 'nucleo.sqlite');
  if (!existsSync(db)) {
    // A core is answering, so a missing database means the data folder is the wrong one: no backup, no rollback promise.
    if (liveCore) throw new Stop(EXIT.BACKUP, `a core is running but ${db} does not exist; check --data-dir. Nothing was stopped.`);
    out('no nucleo.sqlite yet: nothing to back up');
    return null;
  }
  const root = join(dataDir, 'backups');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
  const short = COMMIT.test(oldCommit ?? '') ? oldCommit.slice(0, 7) : 'unknown';
  const dir = join(root, `update-${stamp}-${short}`);
  const file = join(dir, 'nucleo.sqlite');
  let source;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    source = new DatabaseSync(db);
    await backup(source, file);
    chmodSync(file, 0o600);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const row = copy.prepare('PRAGMA quick_check').get();
      if (Object.values(row)[0] !== 'ok') throw new Error('the backup failed quick_check');
    } finally { copy.close(); }
  } catch (e) {
    removeBackupDir(dir, root);
    throw new Stop(EXIT.BACKUP, `the backup failed (${e.message}); the core was left running`);
  } finally { source?.close(); }
  const all = readdirSync(root).filter((n) => n.startsWith('update-')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) removeBackupDir(join(root, old), root);
  out(`backup: ${file}`);
  return file;
}

/** Starts the orphan core detached; returns the child and a flag that says whether it already exited. */
function startOrphan(ctx, options, dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const fd = openSync(join(dataDir, 'core-stdout.log'), 'a');
  const withPort = portOf(options) === null ? ['--port', String(ctx.port), ...options] : options;
  const child = spawn(process.execPath, [...NODE_FLAGS, join(ctx.checkout, CLI_REL), ...withPort], {
    cwd: join(ctx.checkout, 'packages/nucleo'), detached: true, stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  const handle = { pid: child.pid, exited: false };
  child.on('exit', () => { handle.exited = true; });
  child.unref();
  return handle;
}

async function startCore(ctx, run) {
  if (run.useUnit) {
    const r = systemctl('start', UNIT);
    if (r.status !== 0) throw new Error(`systemctl start failed: ${(r.stderr ?? '').trim()}`);
    return { pid: null, exited: false };
  }
  return startOrphan(ctx, run.options, run.dataDir);
}

async function stopCore(ctx, run, started) {
  if (run.useUnit) {
    systemctl('stop', UNIT);
    if (!(await waitFor(async () => !(await readOverview(ctx.port, 500)), timeoutMs('AHRENA_CONSOLE_UPDATE_STOP_TIMEOUT_MS', 15000)))) {
      throw new Stop(EXIT.PROCESS, `the unit stopped but port ${ctx.port} stayed busy`);
    }
    return;
  }
  if (started?.pid && isAlive(started.pid)) await terminate(started.pid, ctx.port);
}

async function confirm(ctx, expectation, manifest, started) {
  const ok = await waitFor(async () => {
    if (started?.exited) return 'exited';
    const o = await readOverview(ctx.port, 1000);
    if (o && sameCommit(o.commit, expectation.commit) && (expectation.version === null || o.version === expectation.version)) return o;
    return null;
  }, timeoutMs('AHRENA_CONSOLE_UPDATE_START_TIMEOUT_MS', 30000));
  if (!ok || ok === 'exited') throw new Error(ok === 'exited' ? 'the new core exited right after starting' : `the core did not answer ${expectation.commit.slice(0, 7)} on port ${ctx.port} in time`);
  if (manifest?.ownerProofRequired === true) {
    const command = typeof manifest.remoteCredentialCommand === 'string' && /^[a-z-]+$/.test(manifest.remoteCredentialCommand) ? manifest.remoteCredentialCommand : 'remote-credential';
    const r = spawnSync(process.execPath, [...NODE_FLAGS, join(ctx.checkout, OWNER_CLI_REL), command, '--port', String(ctx.port)], {
      cwd: join(ctx.checkout, 'packages/nucleo'),
      input: `${JSON.stringify({ version: 1, nonce: randomBytes(16).toString('hex') })}\n`,
      encoding: 'utf8',
    });
    // The credential on stdout is valid for 10 minutes and is discarded: only the exit code is read.
    if (r.status !== 0) throw new Error(`${command} exited ${r.status}: the Mac would not be able to sign in`);
  }
}

// ---- the update ---------------------------------------------------------------------------------------------

async function update(opts) {
  phase('check');
  cancelOnSignals();
  const lockDir = resolveDataDir(opts);
  refuseLiveLock(lockDir);
  try {
    return await runUpdate(opts, lockDir);
  } finally {
    releaseLocks();
  }
}

async function runUpdate(opts, lockDir) {
  const ctx = context(opts);
  const target = preflight(opts, ctx);
  report.oldCommit = target.oldHead;
  report.newCommit = target.sha;
  const manifest = runGuard(opts, ctx, target);
  checkDependencies(ctx, target);
  const targetVersion = (() => {
    try { return JSON.parse(git(ctx.checkout, 'show', `${target.sha}:packages/nucleo/package.json`)).version ?? null; } catch { return null; }
  })();
  if (opts.check) {
    out(`check ok: ${target.oldHead.slice(0, 7)} -> ${target.sha.slice(0, 7)} (${opts.ref}); nothing was touched`);
    return EXIT.OK;
  }
  // (#462) Taken only once the run is accepted: a refused checkout or guard creates no data folder and no lock.
  acquireLock(lockDir);

  const info = await readOverview(ctx.port);
  const unitExists = existsSync(unitPath());
  const active = unitExists && unitActive();
  if (target.oldHead === target.sha && info && sameCommit(info.commit, target.sha)) {
    out(`already at ${target.sha.slice(0, 7)} and the core answers it: nothing to do`);
    return EXIT.OK;
  }

  // Inspect before touching anything (reads only): which process, started how.
  const run = { useUnit: unitExists && (active || !info), options: null, dataDir: null };
  if (!run.useUnit) {
    if (info) run.options = verifyProcess(info, ctx);
    else if (ctx.coreOptions) run.options = ctx.coreOptions;
    else throw new Stop(EXIT.PROCESS, `nothing answers on port ${ctx.port} and there is no unit: pass --core-options to say how to start the core (nothing was changed)`, 'no-options');
  }
  run.dataDir = resolveDataDir(opts, run.options);
  if (run.dataDir !== lockDir) acquireLock(run.dataDir);

  const wasRunning = Boolean(info) || (run.useUnit && active);
  phase('backup');
  ignoreSignals();
  const backupFile = await makeBackup(run.dataDir, info?.commit ?? target.oldHead, wasRunning);
  report.backup = backupFile;
  logLine(run.dataDir, `update ${target.oldHead} -> ${target.sha} (${opts.ref}), backup ${backupFile ?? 'none'}`);
  const pause = Number(process.env.AHRENA_CONSOLE_UPDATE_PAUSE_MS);
  if (pause > 0) await sleep(pause);

  let started = null;
  let newStarted = false;
  let swapAnnounced = false;
  const announceSwap = () => {
    if (!swapAnnounced) { swapAnnounced = true; phase('swap'); }
  };
  try {
    // Step 4: stop. The only signal is to the verified pid (checked again right before it), or through the unit. (#462)
    if (run.useUnit) {
      if (active) { announceSwap(); out(`stopping through systemctl --user stop ${UNIT}`); await stopCore(ctx, run, null); }
    } else if (info) {
      out(`stopping the verified core (pid ${info.pid})`);
      await terminate(info.pid, ctx.port, () => { verifyProcess(info, ctx); announceSwap(); });
    }
    announceSwap();
    git(ctx.checkout, 'checkout', '--detach', target.sha);
    out(`code: ${target.oldHead.slice(0, 7)} -> ${target.sha.slice(0, 7)}`);
    phase('start');
    started = await startCore(ctx, run);
    newStarted = true;
    if (!run.useUnit) out(`started (orphan, pid ${started.pid}); run the script again with install-unit (see scripts/remote-core/README.md) to put it under systemd`);
    phase('verify');
    await confirm(ctx, { commit: target.sha, version: targetVersion }, manifest, started);
  } catch (e) {
    // The re-check before the first signal failed: nothing changed, so there is nothing to roll back.
    if (e.untouched) { logLine(run.dataDir, `refused before the stop: ${e.message}`); throw e; }
    warn(`the update failed: ${e.message}; rolling back`);
    logLine(run.dataDir, `update failed: ${e.message}`);
    return rollback(ctx, run, target, backupFile, started, wasRunning, newStarted);
  }
  logLine(run.dataDir, `updated to ${target.sha}`);
  out(`updated to ${target.sha.slice(0, 7)} (${targetVersion ?? 'version unknown'}); the core answered`);
  return EXIT.OK;
}

/** Puts the backup back through a temporary file and a rename: the live database is never removed before the copy exists. */
function restoreDatabase(dataDir, backupFile) {
  const live = join(dataDir, 'nucleo.sqlite');
  const temporary = join(dataDir, 'nucleo.sqlite.restoring');
  try {
    copyFileSync(backupFile, temporary);
    chmodSync(temporary, 0o600);
  } catch (e) {
    rmSync(temporary, { force: true });
    throw e;
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${live}${suffix}`, { force: true });
  renameSync(temporary, live);
}

// The database rule: it is restored from the backup only when the new core was started (it may have migrated
// or written). If the new core never started, the live database is kept as it is, so the writes made between
// the backup and the stop are not lost. (#462)
async function rollback(ctx, run, target, backupFile, started, wasRunning, newStarted) {
  phase('rollback');
  report.reason = 'started-failed';
  try {
    await stopCore(ctx, run, started);
    if (target.branch && gitOrNull(ctx.checkout, 'rev-parse', target.branch) === target.oldHead) git(ctx.checkout, 'checkout', target.branch);
    else git(ctx.checkout, 'checkout', '--detach', target.oldHead);
    if (backupFile && newStarted) restoreDatabase(run.dataDir, backupFile);
    if (wasRunning) {
      const answering = await readOverview(ctx.port, 1000);
      if (!(answering && sameCommit(answering.commit, target.oldHead))) {
        const again = await startCore(ctx, run);
        await confirm(ctx, { commit: target.oldHead, version: null }, null, again);
      }
    }
  } catch (e) {
    const msg = `rollback FAILED (${e.message}). Backup: ${backupFile ?? 'none'} (kept). Old commit: ${target.oldHead}. Restore by hand.`;
    warn(msg);
    logLine(run.dataDir, msg);
    return EXIT.ROLLBACK_FAILED;
  }
  const restored = backupFile && newStarted;
  const msg = `rolled back to ${target.oldHead.slice(0, 7)}${restored ? ' with the database restored from the backup' : ' (the new core never started: the database was left as it is)'}; the old core ${wasRunning ? 'answers again' : 'was not running before and stays stopped'}`;
  out(msg);
  logLine(run.dataDir, msg);
  return EXIT.ROLLED_BACK;
}

// ---- install-unit -------------------------------------------------------------------------------------------

async function installUnit(opts) {
  const ctx = context(opts);
  const info = await readOverview(ctx.port);
  const active = existsSync(unitPath()) && unitActive();
  let options = ctx.coreOptions ?? null;
  const orphan = info && !active;
  if (orphan) options = verifyProcess(info, ctx);
  if (!options) throw new Stop(EXIT.PROCESS, 'no running core to read the options from: pass --core-options "--port ... --installation ... --data-dir ..." (nothing was changed)', 'no-options');
  const withPort = portOf(options) === null ? ['--port', String(ctx.port), ...options] : options;
  const dataDir = resolveDataDir(opts, withPort);
  // Everything that can fail without touching the running core comes first: the text, the file, the reload, the enable.
  const text = renderUnit({ node: process.execPath, checkout: ctx.checkout, options: withPort, dataDir });
  mkdirSync(dataDir, { recursive: true });
  const file = unitPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  out(`wrote ${file}`);
  for (const args of [['daemon-reload'], ['enable', UNIT]]) {
    const r = systemctl(...args);
    if (r.status !== 0) throw new Stop(EXIT.PROCESS, `systemctl --user ${args.join(' ')} failed (${(r.stderr ?? '').trim()}); the running core was not touched`);
  }
  if (orphan) {
    out(`stopping the verified orphan core (pid ${info.pid})`);
    await terminate(info.pid, ctx.port, () => verifyProcess(info, ctx));
  }
  const started = systemctl('start', UNIT);
  const answered = started.status === 0 ? await waitFor(() => readOverview(ctx.port, 1000), timeoutMs('AHRENA_CONSOLE_UPDATE_START_TIMEOUT_MS', 30000)) : null;
  if (!answered) {
    if (orphan) {
      // The core must not stay down: start the orphan again with the options it had.
      const again = startOrphan(ctx, withPort, dataDir);
      const back = await waitFor(() => readOverview(ctx.port, 1000), timeoutMs('AHRENA_CONSOLE_UPDATE_START_TIMEOUT_MS', 30000));
      throw new Stop(EXIT.PROCESS, `the unit did not bring the core up (see journalctl --user -u ${UNIT}); ${back ? `the orphan core was started again (pid ${again.pid})` : 'the orphan core could NOT be started again, start it by hand'}`);
    }
    throw new Stop(EXIT.PROCESS, `the unit started but nothing answers on port ${ctx.port}; see journalctl --user -u ${UNIT}`);
  }
  out(`the core answers under ${UNIT} (version ${answered.version}, commit ${(answered.commit ?? 'unknown').slice(0, 7)})`);

  const linger = spawnSync('loginctl', ['show-user', userInfo().username, '-p', 'Linger'], { encoding: 'utf8' });
  if (!/^Linger=yes/m.test(linger.stdout ?? '')) {
    out('WARNING: linger is off, so the unit will not start at boot without a login. Run, once, yourself (this script never calls sudo):');
    out('  loginctl enable-linger "$(id -un)"');
  }
  return EXIT.OK;
}

// ---- main --------------------------------------------------------------------------------------------------- (#462)

async function execute(argv) {
  try {
    const opts = parseArguments(argv);
    if (opts.help) { out(USAGE); return EXIT.OK; }
    return opts.command === 'install-unit' ? await installUnit(opts) : await update(opts);
  } catch (e) {
    if (e instanceof Stop) {
      report.reason = e.reason;
      warn(e.code === EXIT.USAGE ? `${e.message}\n${USAGE}` : e.message);
      return e.code;
    }
    warn(`unexpected error: ${e.stack ?? e}`);
    return EXIT.PROCESS;
  }
}

/** Asked for before the arguments are parsed, so that even a usage error ends with a result line. (#462) */
const asksForJson = (argv) => argv.includes('--progress=json') || argv.some((a, i) => a === '--progress' && argv[i + 1] === 'json');

export async function main(argv) {
  progress = asksForJson(argv);
  const code = await execute(argv);
  emitResult(code);
  return code;
}

/** (#462) Run as a file, or read from stdin (`node --input-type=module -`, where argv[1] is "-"). */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  if (entry === '-') return true;
  try { return samePath(entry, fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
