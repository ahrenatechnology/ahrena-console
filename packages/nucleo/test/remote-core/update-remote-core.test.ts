// The remote core update command (issue 449, decision 0021 sections 3 and 4): AC2 backup, switch, restart,
// confirm and roll back; AC3 the systemd user unit; AC4 the guard that refuses before stopping anything.
//
// No SSH and nothing on the real Workstation: temporary git repositories hold a fake core (a tiny
// src/api/cli.ts that answers /api/overview and opens the database), systemctl, loginctl and ss are fakes on
// the PATH, /proc is a temporary tree (AHRENA_CONSOLE_PROC_ROOT) and the data folder is temporary. The fake
// core is a real process, so every refusal can check that its pid did not change and that no SIGTERM arrived.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, get, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/remote-core/update-remote-core.mjs', import.meta.url));
const README = fileURLToPath(new URL('../../../../scripts/remote-core/README.md', import.meta.url));
const NODE_FLAG = '--disable-warning=ExperimentalWarning';

// ---- the fake core, as the text of a src/api/cli.ts inside the temporary repository -----------------------

type CoreVariant = 'old' | 'good' | 'fails' | 'fails-and-breaks';
function fakeCoreSource(variant: CoreVariant): string {
  const before: Record<CoreVariant, string> = {
    old: "if (fs.existsSync(path.join(dataDir, 'broken'))) process.exit(1);",
    good: 'migrate();',
    fails: 'migrate(); process.exit(1);',
    'fails-and-breaks': "migrate(); fs.writeFileSync(path.join(dataDir, 'broken'), '1'); process.exit(1);",
  };
  return [
    "import http from 'node:http';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { execFileSync } from 'node:child_process';",
    "import { fileURLToPath } from 'node:url';",
    "import { DatabaseSync } from 'node:sqlite';",
    'const args = process.argv.slice(2);',
    'const at = (name) => args[args.indexOf(name) + 1];',
    "const port = Number(at('--port'));",
    "const dataDir = at('--data-dir');",
    'const here = path.dirname(fileURLToPath(import.meta.url));',
    "const version = JSON.parse(fs.readFileSync(path.join(here, '../../package.json'), 'utf8')).version;",
    "const commit = execFileSync('git', ['-C', here, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();",
    "fs.appendFileSync(path.join(dataDir, 'argv.log'), JSON.stringify(args) + '\\n');",
    "function migrate() { const db = new DatabaseSync(path.join(dataDir, 'nucleo.sqlite')); db.exec(\"INSERT INTO t VALUES ('migrated')\"); db.close(); }",
    before[variant],
    'const server = http.createServer((req, res) => {',
    "  if (req.url === '/api/overview') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, name: 'ahrena-console', version, pid: process.pid, commit })); return; }",
    '  res.statusCode = 404; res.end();',
    '});',
    "server.listen(port, '127.0.0.1');",
    "process.on('SIGTERM', () => { fs.appendFileSync(path.join(dataDir, 'sigterm.log'), process.pid + '\\n'); server.close(); process.exit(0); });",
    '',
  ].join('\n');
}

const OWNER_STUB = [
  "import fs from 'node:fs';",
  "const input = fs.readFileSync(0, 'utf8');",
  "if (process.env.FAKE_CREDENTIAL_LOG) fs.appendFileSync(process.env.FAKE_CREDENTIAL_LOG, process.argv.slice(2).join(' ') + ' ' + JSON.stringify(JSON.parse(input).version) + '\\n');",
  'process.exit(Number(process.env.FAKE_CREDENTIAL_EXIT ?? 0));',
  '',
].join('\n');

const MANIFEST = { manifest: 1, telemetryVersion: 1, ownerProofRequired: true, remoteCredentialCommand: 'remote-credential' };

// ---- fake systemctl, loginctl, ss and sudo ----------------------------------------------------------------

const FAKE_SYSTEMCTL = `
const fs = require('fs'), path = require('path'), cp = require('child_process');
const dir = process.env.FAKE_SYSTEMD_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), args.join(' ') + '\\n');
const pidFile = path.join(dir, 'pid');
const alive = () => { try { const p = Number(fs.readFileSync(pidFile, 'utf8')); process.kill(p, 0); return p; } catch { return 0; } };
const verb = args.filter((a) => a !== '--user')[0];
if (process.env.FAKE_SYSTEMCTL_FAIL === verb) process.exit(1);
if (process.env.FAKE_SYSTEMCTL_FAIL_ONCE === verb) { const m = path.join(dir, 'failed-once'); if (!fs.existsSync(m)) { fs.writeFileSync(m, '1'); process.exit(1); } }
if (verb === 'is-active') process.exit(process.env.FAKE_ACTIVE || alive() ? 0 : 3);
if (verb === 'stop') {
  const p = alive();
  if (p) { process.kill(p, 'SIGTERM'); for (let i = 0; i < 100 && alive(); i += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  process.exit(0);
}
if (verb === 'start' || (verb === 'enable' && args.includes('--now'))) {
  if (alive()) process.exit(0);
  const unit = fs.readFileSync(path.join(process.env.HOME, '.config/systemd/user/ahrena-console-core.service'), 'utf8');
  const exec = /^ExecStart=(.*)$/m.exec(unit)[1];
  const cwd = /^WorkingDirectory=(.*)$/m.exec(unit)[1];
  const words = []; const re = /"((?:[^"\\\\]|\\\\.)*)"|(\\S+)/g;
  for (let m = re.exec(exec); m; m = re.exec(exec)) words.push((m[1] !== undefined ? m[1].replace(/\\\\(.)/g, '$1') : m[2]).replace(/%%/g, '%'));
  const child = cp.spawn(words[0], words.slice(1), { cwd, detached: true, stdio: 'ignore' });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  process.exit(0);
}
process.exit(0);
`;
const FAKE_LOGINCTL = `
process.stdout.write('Linger=' + (process.env.FAKE_LINGER || 'no') + '\\n');
`;
const FAKE_SS = `
process.stdout.write('State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\\n');
if (process.env.FAKE_SS_PID) process.stdout.write('LISTEN 0 511 127.0.0.1:' + process.env.FAKE_SS_PORT + ' 0.0.0.0:* users:(("node",pid=' + process.env.FAKE_SS_PID + ',fd=20))\\n');
`;
const FAKE_SUDO = `
require('fs').writeFileSync(require('path').join(process.env.FAKE_SYSTEMD_DIR, 'sudo-called'), process.argv.slice(2).join(' '));
process.exit(1);
`;

// ---- helpers -----------------------------------------------------------------------------------------------

interface Result { code: number; stdout: string; stderr: string }
interface Env {
  root: string; repo: string; home: string; data: string; bin: string; proc: string; systemd: string;
  port: number; shaA: string; shaB: string; env: NodeJS.ProcessEnv;
}
interface Options { variantB?: CoreVariant; manifest?: boolean; deps?: boolean }

const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...gitEnv } }).trim();
const write = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
const executable = (path: string, body: string) => { writeFileSync(path, `#!${process.execPath}\n${body}`); chmodSync(path, 0o755); };

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createNetServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => done(port)); });
  });
}
function overview(port: number): Promise<{ pid: number; version: string; commit: string } | null> {
  return new Promise((done) => {
    const req = get({ host: '127.0.0.1', port, path: '/api/overview', timeout: 1000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { done(null); } });
    });
    req.on('error', () => done(null));
    req.on('timeout', () => { req.destroy(); done(null); });
  });
}
async function until<T>(f: () => Promise<T | null | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

let e: Env;
const pids = new Set<number>();
const servers: Server[] = [];

async function makeEnv(o: Options = {}): Promise<Env> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'update-remote-core-')));
  const repo = join(root, 'checkout');
  const home = join(root, 'home');
  const data = join(root, 'data');
  const bin = join(root, 'bin');
  const proc = join(root, 'proc');
  const systemd = join(root, 'systemd');
  for (const d of [repo, home, data, bin, proc, systemd]) mkdirSync(d, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  const pkg = (version: string, deps: Record<string, string> = {}) => `${JSON.stringify({ name: 'nucleo', version, type: 'module', dependencies: deps })}\n`;
  write(join(repo, 'packages/nucleo/package.json'), pkg('0.0.7'));
  write(join(repo, 'packages/nucleo/src/api/cli.ts'), fakeCoreSource('old'));
  write(join(repo, 'packages/nucleo/src/owner/cli.ts'), OWNER_STUB);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'old');
  const shaA = git(repo, 'rev-parse', 'HEAD');
  write(join(repo, 'packages/nucleo/package.json'), pkg('0.0.17', o.deps ? { left: '1.0.0' } : {}));
  write(join(repo, 'packages/nucleo/src/api/cli.ts'), fakeCoreSource(o.variantB ?? 'good'));
  if (o.manifest !== false) write(join(repo, 'packages/nucleo/remote-contract.json'), `${JSON.stringify(MANIFEST)}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'new');
  git(repo, 'tag', 'app-v0.0.17');
  const shaB = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-B', 'main', shaA);
  executable(join(bin, 'systemctl'), FAKE_SYSTEMCTL);
  executable(join(bin, 'loginctl'), FAKE_LOGINCTL);
  executable(join(bin, 'ss'), FAKE_SS);
  executable(join(bin, 'sudo'), FAKE_SUDO);
  const db = new DatabaseSync(join(data, 'nucleo.sqlite'));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('original');");
  db.close();
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_SYSTEMD_DIR: systemd,
    AHRENA_CONSOLE_PROC_ROOT: join(root, 'no-proc'), AHRENA_CONSOLE_UPDATE_START_TIMEOUT_MS: '4000', AHRENA_CONSOLE_UPDATE_STOP_TIMEOUT_MS: '4000',
    FAKE_CREDENTIAL_LOG: join(root, 'credential.log'), FAKE_SS_PORT: String(port),
  };
  delete env.FAKE_SS_PID;
  return { root, repo, home, data, bin, proc, systemd, port, shaA, shaB, env };
}

const coreArgs = () => ['--port', String(e.port), '--installation', 'dev', '--data-dir', e.data, '--no-github'];
const cliPath = () => join(e.repo, 'packages/nucleo/src/api/cli.ts');

/** The fake core, started the way the Workstation starts the orphan. Waits until it answers. */
async function startOrphan(): Promise<number> {
  const child = spawn(process.execPath, [NODE_FLAG, cliPath(), ...coreArgs()], { cwd: join(e.repo, 'packages/nucleo'), detached: true, stdio: 'ignore' });
  child.unref();
  pids.add(child.pid!);
  const o = await until(() => overview(e.port));
  assert.equal(o.pid, child.pid);
  return child.pid!;
}
/** A /proc tree entry that says what the real /proc says about a process. */
function writeProc(pid: number, cmdline: string[], uid = process.getuid!()) {
  mkdirSync(join(e.proc, String(pid)), { recursive: true });
  writeFileSync(join(e.proc, String(pid), 'cmdline'), `${cmdline.join('\0')}\0`);
  writeFileSync(join(e.proc, String(pid), 'status'), `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
  e.env.AHRENA_CONSOLE_PROC_ROOT = e.proc;
}
const honestProc = (pid: number) => writeProc(pid, [process.execPath, NODE_FLAG, cliPath(), ...coreArgs()]);

function baseArgs(extra: string[] = [], ref = 'app-v0.0.17') {
  return ['--checkout', e.repo, '--ref', ref, '--no-fetch', '--port', String(e.port), '--data-dir', e.data,
    '--mac-telemetry-version', '1', '--mac-credential-command', 'yes', ...extra];
}
function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { ...e.env, ...env }, encoding: 'utf8' }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}
/** Like run, but calls `watch` with the stdout so far, to change the world at a known point of the script. */
function runWatch(args: string[], env: NodeJS.ProcessEnv, watch: (stdout: string) => void): Promise<Result> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...e.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; watch(stdout); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}
const rows = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return (db.prepare('SELECT v FROM t ORDER BY rowid').all() as { v: string }[]).map((r) => r.v); } finally { db.close(); }
};
const backups = () => (existsSync(join(e.data, 'backups')) ? readdirSync(join(e.data, 'backups')).filter((n) => n.startsWith('update-')) : []);
const head = () => git(e.repo, 'rev-parse', 'HEAD');

/** After a refusal nothing was touched: the same process answers the old commit, no signal reached it, HEAD stays. */
async function assertUntouched(pid: number) {
  assert.ok(alive(pid), 'the working core is still alive');
  const o = await overview(e.port);
  assert.equal(o?.pid, pid, 'the pid did not change');
  assert.equal(o?.commit, e.shaA);
  assert.deepEqual(lines(join(e.data, 'sigterm.log')), [], 'no SIGTERM reached the core');
  assert.equal(head(), e.shaA);
  assert.deepEqual(backups(), [], 'no backup was made before a refusal');
  assert.deepEqual(rows(join(e.data, 'nucleo.sqlite')), ['original']);
}

/** Rebuilds the environment with another repository (the variants differ in the commit being installed). */
async function makeEnvReplace(o: Options) {
  rmSync(e.root, { recursive: true, force: true });
  e = await makeEnv(o);
}

beforeEach(async () => { e = await makeEnv(); });

afterEach(async () => {
  const known = [...pids];
  const o = await overview(e.port);
  if (o) known.push(o.pid);
  if (existsSync(join(e.systemd, 'pid'))) known.push(Number(readFileSync(join(e.systemd, 'pid'), 'utf8')));
  for (const pid of known) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  pids.clear();
  for (const s of servers.splice(0)) s.close();
  rmSync(e.root, { recursive: true, force: true });
});

// ---- AC2 ---------------------------------------------------------------------------------------------------

describe('AC2 · backup, switch, restart, confirm and roll back', () => {
  test('AC2 updates the old checkout: online backup, switch to --ref, same options, confirmed through /api/overview', async () => {
    const oldPid = await startOrphan();
    honestProc(oldPid);
    // A row that lives only in the WAL: a plain copy of nucleo.sqlite would miss it, the online backup must not.
    const live = new DatabaseSync(join(e.data, 'nucleo.sqlite'));
    live.exec("PRAGMA wal_autocheckpoint = 0; INSERT INTO t VALUES ('in-wal')");
    const r = await run(baseArgs());
    live.close();
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(head(), e.shaB);
    const o = await overview(e.port);
    assert.equal(o?.commit, e.shaB);
    assert.equal(o?.version, '0.0.17');
    assert.notEqual(o?.pid, oldPid);
    assert.ok(!alive(oldPid), 'the old process was stopped');
    assert.deepEqual(lines(join(e.data, 'sigterm.log')), [String(oldPid)]);
    const [dir] = backups();
    assert.match(dir!, new RegExp(`^update-\\d{8}T\\d+Z-${e.shaA.slice(0, 7)}$`));
    assert.deepEqual(rows(join(e.data, 'backups', dir!, 'nucleo.sqlite')), ['original', 'in-wal']);
    const argv = lines(join(e.data, 'argv.log')).map((l) => JSON.parse(l));
    assert.deepEqual(argv.at(-1), argv.at(-2), 'restarted with the same options');
    assert.match(readFileSync(join(e.data, 'update.log'), 'utf8'), new RegExp(`${e.shaA} -> ${e.shaB}`));
    // The target requires the owner proof: the script ran the credential emission there and read only the exit code.
    assert.deepEqual(lines(e.env.FAKE_CREDENTIAL_LOG!), [`remote-credential --port ${e.port} 1`]);
    assert.ok(!/nonce/i.test(r.stdout + r.stderr));
  });

  test('AC2 repeating the same --ref is a no-op: exit 0, nothing stopped, no new backup', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    assert.equal((await run(baseArgs())).code, 0);
    const after = (await overview(e.port))!;
    const count = backups().length;
    const again = await run(baseArgs());
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /nothing to do/);
    assert.equal((await overview(e.port))?.pid, after.pid);
    assert.equal(backups().length, count);
  });

  test('AC2 keeps the last 5 backups', async () => {
    mkdirSync(join(e.data, 'backups'), { recursive: true });
    for (let i = 1; i <= 6; i += 1) mkdirSync(join(e.data, 'backups', `update-2026010${i}T000000000Z-aaaaaaa`));
    const pid = await startOrphan();
    honestProc(pid);
    assert.equal((await run(baseArgs())).code, 0);
    const names = backups();
    assert.equal(names.length, 5);
    assert.ok(!names.includes('update-20260101T000000000Z-aaaaaaa') && !names.includes('update-20260102T000000000Z-aaaaaaa'));
  });

  test('AC2 a core that does not come up: exit 40, code and database back, the old core answers with the same options', async () => {
    await makeEnvReplace({ variantB: 'fails' });
    const oldPid = await startOrphan();
    honestProc(oldPid);
    const r = await run(baseArgs());
    assert.equal(r.code, 40, r.stderr + r.stdout);
    assert.equal(head(), e.shaA);
    assert.equal(git(e.repo, 'symbolic-ref', '--short', 'HEAD'), 'main', 'the branch is restored');
    assert.deepEqual(rows(join(e.data, 'nucleo.sqlite')), ['original'], 'the migrated database was replaced by the backup');
    const o = await overview(e.port);
    assert.equal(o?.commit, e.shaA);
    assert.notEqual(o?.pid, oldPid);
    const argv = lines(join(e.data, 'argv.log')).map((l) => JSON.parse(l));
    assert.deepEqual(argv.at(-1), argv[0], 'the old core was started again with its options');
    assert.equal(backups().length, 1, 'the backup stays');
    assert.ok(!existsSync(join(e.data, 'nucleo.sqlite.restoring')), 'no temporary file is left');
  });

  test('AC2 a target that answers but cannot issue the owner credential is rolled back (exit 40)', async () => {
    const oldPid = await startOrphan();
    honestProc(oldPid);
    const r = await run(baseArgs(), { FAKE_CREDENTIAL_EXIT: '10' });
    assert.equal(r.code, 40, r.stderr + r.stdout);
    assert.equal(head(), e.shaA);
    assert.equal((await overview(e.port))?.commit, e.shaA);
  });

  test('AC2 a rollback that also fails: exit 41, the message names the backup and the old commit, nothing is deleted', async () => {
    await makeEnvReplace({ variantB: 'fails-and-breaks' });
    const oldPid = await startOrphan();
    honestProc(oldPid);
    const r = await run(baseArgs());
    assert.equal(r.code, 41, r.stderr + r.stdout);
    assert.match(r.stderr, new RegExp(e.shaA));
    const [dir] = backups();
    assert.ok(r.stderr.includes(join(e.data, 'backups', dir!, 'nucleo.sqlite')));
    assert.ok(existsSync(join(e.data, 'backups', dir!, 'nucleo.sqlite')));
  });

  test('AC2 tracked changes in the checkout: exit 30 and the core is not touched', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    write(join(e.repo, 'packages/nucleo/package.json'), '{"dirty":true}\n');
    const r = await run(baseArgs());
    assert.equal(r.code, 30, r.stderr);
    git(e.repo, 'checkout', '--', '.');
    await assertUntouched(pid);
  });

  test('AC2 a ref that does not exist: exit 30 and the core is not touched', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const r = await run(baseArgs([], 'app-v9.9.9'));
    assert.equal(r.code, 30, r.stderr);
    await assertUntouched(pid);
  });

  test('AC2 a target with new production dependencies is refused before stopping (exit 30)', async () => {
    await makeEnvReplace({ deps: true });
    const pid = await startOrphan();
    honestProc(pid);
    const r = await run(baseArgs());
    assert.equal(r.code, 30, r.stderr);
    assert.match(r.stderr, /npm install/);
    await assertUntouched(pid);
  });

  test('AC2 a backup that cannot be made: exit 31 and the core keeps running', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    // Not a database: the online backup fails, and the script must leave the core alone.
    for (const s of ['', '-wal', '-shm']) rmSync(join(e.data, `nucleo.sqlite${s}`), { force: true });
    writeFileSync(join(e.data, 'nucleo.sqlite'), 'this is not a sqlite file, '.repeat(200));
    const r = await run(baseArgs());
    assert.equal(r.code, 31, r.stderr);
    assert.ok(alive(pid));
    assert.equal((await overview(e.port))?.pid, pid);
    assert.deepEqual(lines(join(e.data, 'sigterm.log')), []);
    assert.equal(head(), e.shaA);
    assert.deepEqual(backups(), [], 'a failed backup leaves nothing behind');
  });
});

describe('AC2 · review round 1: what the overview says is not trusted, and the data survives a failure', () => {
  const writeUnitFile = () => write(join(e.home, '.config/systemd/user/ahrena-console-core.service'), '[Service]\n');
  const impostor = async (body: object) => {
    const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); });
    servers.push(server);
    await new Promise<void>((r) => server.listen(e.port, '127.0.0.1', r));
  };

  test('AC2 a forged commit in the overview never reaches a path: the failed backup removes nothing outside backups/', async () => {
    writeUnitFile();
    await impostor({ ok: true, version: '0.0.7', pid: 1, commit: '/../../x' });
    // The unit is "active", so the pid is not even checked; the backup fails (not a database).
    for (const s of ['', '-wal', '-shm']) rmSync(join(e.data, `nucleo.sqlite${s}`), { force: true });
    writeFileSync(join(e.data, 'nucleo.sqlite'), 'this is not a sqlite file, '.repeat(200));
    writeFileSync(join(e.data, 'nucleo.json'), '{"lock":true}');
    const r = await run(baseArgs(), { FAKE_ACTIVE: '1' });
    assert.equal(r.code, 31, r.stderr + r.stdout);
    assert.ok(existsSync(join(e.data, 'nucleo.sqlite')), 'the data folder survives');
    assert.ok(existsSync(join(e.data, 'nucleo.json')), 'the lock survives');
    assert.deepEqual(backups(), []);
  });

  test('AC2 a forged commit and a forged version are read as unknown: the backup is named from the checkout, not from the overview', async () => {
    writeUnitFile();
    await impostor({ ok: true, version: '<b>9</b>', pid: 1, commit: '/../../x' });
    const r = await run(baseArgs(), { FAKE_ACTIVE: '1' });
    assert.notEqual(r.code, 0);
    assert.ok(existsSync(join(e.data, 'nucleo.sqlite')));
    for (const n of backups()) assert.match(n, new RegExp(`-${e.shaA.slice(0, 7)}$`));
    assert.ok(!existsSync(join(e.data, '..', 'x')));
  });

  test('AC2 a running core and no nucleo.sqlite where --data-dir says: exit 31, nothing stopped', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    rmSync(join(e.data, 'nucleo.sqlite'), { force: true });
    const r = await run(baseArgs());
    assert.equal(r.code, 31, r.stderr);
    assert.ok(alive(pid));
    assert.deepEqual(lines(join(e.data, 'sigterm.log')), []);
    assert.equal(head(), e.shaA);
  });

  test('AC2 --data-dir that disagrees with the data folder of the core is refused (exit 32)', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const r = await run(baseArgs().map((a, i, all) => (all[i - 1] === '--data-dir' ? join(e.root, 'elsewhere') : a)));
    assert.equal(r.code, 32, r.stderr);
    await assertUntouched(pid);
  });

  test('AC2 a new core that never started keeps the live database, writes made after the backup included (exit 40)', async () => {
    // Under the unit, the first `systemctl start` fails: the new code never ran, so nothing may be restored.
    const install = await run(['install-unit', '--checkout', e.repo, '--port', String(e.port), '--data-dir', e.data, '--core-options', coreArgs().join(' ')]);
    assert.equal(install.code, 0, install.stderr);
    let wrote = false;
    const r = await runWatch(baseArgs(), { AHRENA_CONSOLE_UPDATE_PAUSE_MS: '1500', FAKE_SYSTEMCTL_FAIL_ONCE: 'start' }, (stdout) => {
      if (!wrote && stdout.includes('backup:')) {
        wrote = true;
        const db = new DatabaseSync(join(e.data, 'nucleo.sqlite'));
        db.exec("INSERT INTO t VALUES ('late')");
        db.close();
      }
    });
    assert.equal(r.code, 40, r.stderr + r.stdout);
    assert.match(r.stdout, /never started/);
    assert.deepEqual(rows(join(e.data, 'nucleo.sqlite')), ['original', 'late']);
    assert.equal(head(), e.shaA);
    assert.equal((await overview(e.port))?.commit, e.shaA);
  });
});

// ---- AC3 ---------------------------------------------------------------------------------------------------

describe('AC3 · the systemd user unit', () => {
  const unitFile = () => join(e.home, '.config/systemd/user/ahrena-console-core.service');
  const calls = () => lines(join(e.systemd, 'calls.log'));
  const installArgs = (...extra: string[]) => ['install-unit', '--checkout', e.repo, '--port', String(e.port), '--data-dir', e.data, ...extra];

  test('AC3 install-unit stops the verified orphan, writes the unit of the decision, enables it and confirms the core', async () => {
    const oldPid = await startOrphan();
    honestProc(oldPid);
    const r = await run(installArgs());
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(!alive(oldPid), 'the orphan was stopped');
    assert.equal(readFileSync(unitFile(), 'utf8'), [
      '[Unit]', 'Description=Ahrena Console core', 'After=network.target', '',
      '[Service]', 'Type=simple', `WorkingDirectory=${join(e.repo, 'packages/nucleo')}`,
      `ExecStart=${process.execPath} ${NODE_FLAG} ${cliPath()} ${coreArgs().join(' ')}`,
      'Restart=on-failure', 'RestartSec=5', 'TimeoutStopSec=20',
      `StandardOutput=append:${join(e.data, 'core-stdout.log')}`, 'StandardError=inherit', '',
      '[Install]', 'WantedBy=default.target', '',
    ].join('\n'));
    assert.deepEqual(calls(), ['--user daemon-reload', '--user enable ahrena-console-core.service', '--user start ahrena-console-core.service']);
    const o = await overview(e.port);
    assert.equal(o?.pid, Number(readFileSync(join(e.systemd, 'pid'), 'utf8')), "the core answering is the unit's");
    assert.notEqual(o?.pid, oldPid);
  });

  test('AC3 linger off: prints the loginctl command, exits 0 and never calls sudo', async () => {
    const r = await run(installArgs('--core-options', coreArgs().join(' ')), { FAKE_LINGER: 'no' });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(r.stdout.includes('loginctl enable-linger "$(id -un)"'));
    assert.ok(!existsSync(join(e.systemd, 'sudo-called')));
  });

  test('AC3 linger on: no warning', async () => {
    const r = await run(installArgs('--core-options', coreArgs().join(' ')), { FAKE_LINGER: 'yes' });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(!r.stdout.includes('enable-linger'));
  });

  test('AC3 install-unit with nothing running and no --core-options refuses instead of guessing (exit 32)', async () => {
    const r = await run(installArgs());
    assert.equal(r.code, 32, r.stderr);
    assert.ok(!existsSync(unitFile()));
    assert.deepEqual(calls(), []);
  });

  test('AC3 install-unit refuses a process that does not check out, before stopping it', async () => {
    const oldPid = await startOrphan();
    writeProc(oldPid, ['/usr/bin/some-other-program', '--port', String(e.port)]);
    const r = await run(installArgs());
    assert.equal(r.code, 32, r.stderr);
    assert.ok(alive(oldPid));
    assert.deepEqual(lines(join(e.data, 'sigterm.log')), []);
    assert.ok(!existsSync(unitFile()));
  });

  test('AC3 with the unit installed, the update goes through systemctl stop/start and not through a signal from the script', async () => {
    const install = await run(installArgs('--core-options', coreArgs().join(' ')));
    assert.equal(install.code, 0, install.stderr);
    const unitPid = (await overview(e.port))!.pid;
    writeFileSync(join(e.systemd, 'calls.log'), '');
    // No /proc at all (the default of these tests): the unit path does not need it.
    const r = await run(baseArgs());
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.deepEqual(calls(), [
      '--user is-active --quiet ahrena-console-core.service',
      '--user stop ahrena-console-core.service',
      '--user start ahrena-console-core.service',
    ]);
    const o = await overview(e.port);
    assert.equal(o?.commit, e.shaB);
    assert.notEqual(o?.pid, unitPid);
    assert.equal(o?.pid, Number(readFileSync(join(e.systemd, 'pid'), 'utf8')));
    assert.ok(!/SIGTERM|SIGKILL/.test(r.stdout + r.stderr));
  });

  test('AC3 systemctl failing before the stop leaves the running core alone (exit 32, no signal)', async () => {
    const oldPid = await startOrphan();
    honestProc(oldPid);
    const r = await run(installArgs(), { FAKE_SYSTEMCTL_FAIL: 'daemon-reload' });
    assert.equal(r.code, 32, r.stderr);
    assert.ok(alive(oldPid));
    assert.equal((await overview(e.port))?.pid, oldPid);
    assert.deepEqual(lines(join(e.data, 'sigterm.log')), []);
  });

  test('AC3 a unit that fails to start does not leave the core down: the orphan is started again (exit 32)', async () => {
    const oldPid = await startOrphan();
    honestProc(oldPid);
    const r = await run(installArgs(), { FAKE_SYSTEMCTL_FAIL: 'start' });
    assert.equal(r.code, 32, r.stderr);
    assert.match(r.stderr, /started again/);
    const o = await overview(e.port);
    assert.ok(o, 'the core answers');
    assert.notEqual(o.pid, oldPid);
  });

  test('AC3 $ and % in the options are doubled in ExecStart', async () => {
    const r = await run(installArgs('--core-options', `${coreArgs().join(' ')} --installation a$HOME%h`));
    assert.equal(r.code, 0, r.stderr);
    const exec = /^ExecStart=(.*)$/m.exec(readFileSync(unitFile(), 'utf8'))![1];
    assert.ok(exec.includes('a$$HOME%%h'), exec);
  });

  test('AC3 a newline in the options is refused before anything is written (exit 2)', async () => {
    const r = await run(installArgs('--core-options', `${coreArgs().join(' ')} --installation "a\nExecStartPost=/bin/evil"`));
    assert.equal(r.code, 2, r.stderr);
    assert.ok(!existsSync(unitFile()));
    assert.deepEqual(calls(), []);
  });

  test('AC3 the unit text is in the README, with the linger command and the manual Workstation step', () => {
    const readme = readFileSync(README, 'utf8');
    for (const needle of ['ExecStart=', 'Restart=on-failure', 'TimeoutStopSec=20', 'WantedBy=default.target', 'loginctl enable-linger "$(id -un)"', 'install-unit', '--allow-disconnect', '--check']) {
      assert.ok(readme.includes(needle), `README mentions ${needle}`);
    }
  });
});

// ---- AC4 ---------------------------------------------------------------------------------------------------

describe('AC4 · refuse before stopping the working process', () => {
  test('AC4 a forged pid in the overview (a program that is not the core): exit 32, no signal to anyone', async () => {
    const flag = join(e.root, 'bystander.sigterm');
    const bystander = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>require('fs').writeFileSync(${JSON.stringify(flag)},'1'));setInterval(()=>{},1000)`], { stdio: 'ignore' });
    pids.add(bystander.pid!);
    // An impostor on the port answers the overview with the bystander's pid.
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, version: '0.0.7', pid: bystander.pid, commit: e.shaA }));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(e.port, '127.0.0.1', r));
    for (const cmdline of [
      ['/usr/bin/sleep', '1000'],
      [process.execPath, NODE_FLAG, cliPath().replace('/api/cli.ts', '/api/other.ts'), '--port', String(e.port)],
      [process.execPath, NODE_FLAG, cliPath(), '--port', String(e.port + 1)],
      [process.execPath, NODE_FLAG, '/somewhere/else/packages/nucleo/src/api/cli.ts', '--port', String(e.port)],
    ]) {
      writeProc(bystander.pid!, cmdline);
      const r = await run(baseArgs());
      assert.equal(r.code, 32, `${cmdline.join(' ')}: ${r.stderr}`);
      assert.ok(alive(bystander.pid!), 'the bystander is alive');
      assert.ok(!existsSync(flag), 'the bystander got no SIGTERM');
      assert.equal(head(), e.shaA);
      assert.deepEqual(backups(), []);
    }
  });

  test('AC4 a process of another uid: exit 32 and it is not signalled', async () => {
    const pid = await startOrphan();
    writeProc(pid, [process.execPath, NODE_FLAG, cliPath(), ...coreArgs()], process.getuid!() + 1);
    const r = await run(baseArgs());
    assert.equal(r.code, 32, r.stderr);
    await assertUntouched(pid);
  });

  test('AC4 a pid that /proc does not know: exit 32', async () => {
    const pid = await startOrphan();
    honestProc(pid + 1); // /proc is mounted, but has no entry for the pid the overview gave
    const r = await run(baseArgs());
    assert.equal(r.code, 32, r.stderr);
    await assertUntouched(pid);
  });

  test('AC4 no /proc and no --core-options: exit 32 before stopping (the options are never guessed)', async () => {
    const pid = await startOrphan();
    const r = await run(baseArgs()); // AHRENA_CONSOLE_PROC_ROOT points at a folder that does not exist
    assert.equal(r.code, 32, r.stderr);
    assert.match(r.stderr, /--core-options/);
    await assertUntouched(pid);
  });

  test("AC4 no /proc, --core-options given, but ss does not show the pid as this user's listener: exit 32", async () => {
    const pid = await startOrphan();
    const r = await run(baseArgs(['--core-options', coreArgs().join(' ')]), { FAKE_SS_PID: String(pid + 1) });
    assert.equal(r.code, 32, r.stderr);
    await assertUntouched(pid);
  });

  test('AC4 no /proc, --core-options given and ss confirms the owner: the update goes on with those options', async () => {
    const pid = await startOrphan();
    const r = await run(baseArgs(['--core-options', coreArgs().join(' ')]), { FAKE_SS_PID: String(pid) });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal((await overview(e.port))?.commit, e.shaB);
    const argv = lines(join(e.data, 'argv.log')).map((l) => JSON.parse(l));
    assert.deepEqual(argv.at(-1), coreArgs());
  });

  test('AC4 the pid is checked again right before the signal: a process swapped in during the backup is not killed', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    let swapped = false;
    const r = await runWatch(baseArgs(), { AHRENA_CONSOLE_UPDATE_PAUSE_MS: '1500' }, (stdout) => {
      if (!swapped && stdout.includes('backup:')) {
        swapped = true;
        // The pid now belongs to something else, as if the core had exited and the pid were reused.
        writeProc(pid, ['/usr/bin/sleep', '1000']);
      }
    });
    assert.equal(r.code, 32, r.stderr + r.stdout);
    assert.ok(alive(pid), 'it was not signalled');
    assert.deepEqual(lines(join(e.data, 'sigterm.log')), []);
    assert.equal(head(), e.shaA);
  });

  test('AC4 argv0 must be node: the right script run by another program is refused', async () => {
    const pid = await startOrphan();
    writeProc(pid, ['/usr/bin/python3', NODE_FLAG, cliPath(), ...coreArgs()]);
    const r = await run(baseArgs());
    assert.equal(r.code, 32, r.stderr);
    await assertUntouched(pid);
  });

  test('AC4 a core started with relative paths is resolved against its own working directory, and restarted with an absolute --data-dir', async () => {
    const pid = await startOrphan();
    writeProc(pid, [process.execPath, NODE_FLAG, 'checkout/packages/nucleo/src/api/cli.ts', '--port', String(e.port), '--installation', 'dev', '--data-dir', 'data', '--no-github']);
    symlinkSync(e.root, join(e.proc, String(pid), 'cwd'));
    const r = await run(baseArgs());
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const argv = lines(join(e.data, 'argv.log')).map((l) => JSON.parse(l));
    assert.deepEqual(argv.at(-1), coreArgs());
  });

  const refusals: { name: string; code: number; options?: Options; args: (base: string[]) => string[] }[] = [
    { name: 'the telemetry protocol differs', code: 20, args: (b) => b.map((a, i) => (b[i - 1] === '--mac-telemetry-version' ? '2' : a)) },
    { name: 'the target needs the owner proof and the Mac has no credential command', code: 21, args: (b) => b.map((a, i) => (b[i - 1] === '--mac-credential-command' ? 'no' : a)) },
    { name: 'the target has no manifest', code: 22, options: { manifest: false }, args: (b) => b },
    { name: 'the Mac flags are missing', code: 23, args: (b) => b.filter((a, i) => !a.startsWith('--mac-') && !b[i - 1]?.startsWith('--mac-')) },
  ];

  for (const refusal of refusals) {
    test(`AC4 ${refusal.code} · ${refusal.name}: refused with the working core untouched`, async () => {
      if (refusal.options) await makeEnvReplace(refusal.options);
      const pid = await startOrphan();
      honestProc(pid);
      const r = await run(refusal.args(baseArgs()));
      assert.equal(r.code, refusal.code, r.stderr + r.stdout);
      await assertUntouched(pid);
    });

    test(`AC4 ${refusal.code} · --allow-disconnect goes past it, says so loudly, and still updates`, async () => {
      if (refusal.options) await makeEnvReplace(refusal.options);
      const pid = await startOrphan();
      honestProc(pid);
      const r = await run([...refusal.args(baseArgs()), '--allow-disconnect']);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.match(r.stderr, /WITHOUT a connection/);
      assert.equal((await overview(e.port))?.commit, e.shaB);
      assert.equal(head(), e.shaB);
    });

    test(`AC4 ${refusal.code} · --check reports it and touches nothing`, async () => {
      if (refusal.options) await makeEnvReplace(refusal.options);
      const pid = await startOrphan();
      honestProc(pid);
      const r = await run([...refusal.args(baseArgs()), '--check']);
      assert.equal(r.code, refusal.code, r.stderr + r.stdout);
      await assertUntouched(pid);
    });
  }

  test('AC4 --allow-disconnect does not skip the rollback: a target that does not come up is still rolled back', async () => {
    await makeEnvReplace({ variantB: 'fails', manifest: false });
    const pid = await startOrphan();
    honestProc(pid);
    const r = await run(baseArgs(['--allow-disconnect']));
    assert.equal(r.code, 40, r.stderr + r.stdout);
    assert.equal(head(), e.shaA);
    assert.equal((await overview(e.port))?.commit, e.shaA);
    assert.deepEqual(rows(join(e.data, 'nucleo.sqlite')), ['original']);
  });

  test('AC4 --check on a good target passes and touches nothing: no stop, no backup, no unit call, HEAD stays', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const r = await run(baseArgs(['--check']));
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /nothing was touched/);
    await assertUntouched(pid);
    assert.ok(!existsSync(join(e.systemd, 'calls.log')));
    assert.ok(!existsSync(join(e.data, 'update.log')));
  });

  test('AC4 --ref is required: the script never picks "the newest" by itself (exit 2)', async () => {
    const r = await run(['--checkout', e.repo]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--ref is required/);
  });
});

// ---- issue 462 layer 2: the lock, the NDJSON progress, the stdin run, the signals (decision 0022) ----------------

type Event = { v: number; event: string; phase?: string; exit?: number; reason?: string | null; backup?: string | null; oldCommit?: string | null; newCommit?: string | null };
/** Every line of stdout must be a JSON object: a line that is not one fails the parse and so the test. */
const events = (stdout: string): Event[] => stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Event);
const phases = (stdout: string) => events(stdout).filter((v) => v.event === 'phase').map((v) => v.phase);
const resultOf = (stdout: string) => {
  const all = events(stdout);
  const results = all.filter((v) => v.event === 'result');
  assert.equal(results.length, 1, 'exactly one result event');
  assert.equal(all.at(-1), results[0], 'the result is the last line');
  return results[0]!;
};
const RESULT_KEYS = ['v', 'event', 'exit', 'reason', 'backup', 'oldCommit', 'newCommit'];
const JSON_FLAGS = ['--progress', 'json'];
const lockFile = () => join(e.data, 'update.lock');
const writeLock = (pid: number, startedAt = new Date().toISOString()) => writeFileSync(lockFile(), JSON.stringify({ pid, startedAt }));

/** Runs the script as a child that can be watched and signalled; `viaStdin` feeds it to `node --input-type=module -`. */
function spawnScript(args: string[], env: NodeJS.ProcessEnv = {}, viaStdin = false) {
  const argv = viaStdin ? [NODE_FLAG, '--input-type=module', '-', ...args] : [SCRIPT, ...args];
  const child = spawn(process.execPath, argv, { env: { ...e.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const seen = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { seen.stdout += d; });
  child.stderr.on('data', (d) => { seen.stderr += d; });
  if (viaStdin) child.stdin.end(readFileSync(SCRIPT)); else child.stdin.end();
  const done = new Promise<Result>((resolve) => { child.on('close', (code) => resolve({ code: code ?? 1, stdout: seen.stdout, stderr: seen.stderr })); });
  return { child, done, seen };
}
const PAUSE = { AHRENA_CONSOLE_UPDATE_PAUSE_MS: '1500' };

describe('AC5 · one update at a time on the machine: update.lock', () => {
  test('AC5 the lock exists while the update runs: {pid, startedAt}, mode 0600, removed after success', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const run1 = spawnScript(baseArgs(), PAUSE);
    await until(async () => existsSync(lockFile()));
    const held = JSON.parse(readFileSync(lockFile(), 'utf8'));
    assert.deepEqual(Object.keys(held), ['pid', 'startedAt']);
    assert.equal(held.pid, run1.child.pid);
    assert.ok(Math.abs(Date.now() - Date.parse(held.startedAt)) < 30_000);
    assert.equal(statSync(lockFile()).mode & 0o777, 0o600);
    const r = await run1.done;
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(lockFile()));
  });

  test('AC5 a live lock: exit 33 and nothing is touched, before any git or backup work', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    writeLock(process.pid);
    const r = await run(baseArgs());
    assert.equal(r.code, 33, r.stderr);
    await assertUntouched(pid);
    assert.ok(existsSync(lockFile()), "someone else's lock is not removed");
    assert.ok(!existsSync(join(e.data, 'update.log')));
  });

  test('AC5 two scripts at once on the same data folder: one updates, the other exits 33', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const first = spawnScript(baseArgs(), PAUSE);
    await until(async () => existsSync(lockFile()));
    const second = await run(baseArgs());
    assert.equal(second.code, 33, second.stderr);
    const r = await first.done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(head(), e.shaB);
    assert.ok(!existsSync(lockFile()));
  });

  test('AC5 a lock of a dead pid is taken over, with a line in update.log', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((done) => dead.on('close', done));
    writeLock(dead.pid!);
    const r = await run(baseArgs());
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(join(e.data, 'update.log'), 'utf8'), /took over a stale update\.lock \(dead-pid\)/);
    assert.ok(!existsSync(lockFile()));
  });

  test('AC5 a lock started more than 30 minutes ago is taken over even if the pid is alive', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    writeLock(process.pid, new Date(Date.now() - 31 * 60_000).toISOString());
    const r = await run(baseArgs());
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(join(e.data, 'update.log'), 'utf8'), /older-than-30-minutes/);
    assert.equal(head(), e.shaB);
  });

  test('AC5 a lock with unreadable content is live while recent (fail closed)', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    writeFileSync(lockFile(), 'half written');
    const r = await run(baseArgs());
    assert.equal(r.code, 33, r.stderr);
    await assertUntouched(pid);
  });

  test('AC5 the lock is removed after a failure that rolled back (40) and after a refusal (30)', async () => {
    await makeEnvReplace({ variantB: 'fails' });
    const pid = await startOrphan();
    honestProc(pid);
    assert.equal((await run(baseArgs())).code, 40);
    assert.ok(!existsSync(lockFile()));
    writeFileSync(join(e.repo, 'packages/nucleo/package.json'), '{"dirty":true}\n');
    assert.equal((await run(baseArgs())).code, 30);
    assert.ok(!existsSync(lockFile()));
  });

  test('AC5 --check with a live lock exits 33 and touches nothing', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    writeLock(process.pid);
    const r = await run(baseArgs(['--check']));
    assert.equal(r.code, 33, r.stderr);
    await assertUntouched(pid);
    assert.ok(!existsSync(join(e.data, 'update.log')));
  });

  test('AC5 --check never creates the lock, and leaves a stale one alone', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const clean = await run(baseArgs(['--check']));
    assert.equal(clean.code, 0, clean.stderr);
    assert.ok(!existsSync(lockFile()));
    writeLock(process.pid, new Date(Date.now() - 31 * 60_000).toISOString());
    const stale = await run(baseArgs(['--check']));
    assert.equal(stale.code, 0, stale.stderr);
    assert.ok(existsSync(lockFile()), 'a --check removes nothing');
    assert.ok(!existsSync(join(e.data, 'update.log')));
  });
});

describe('AC1 · --progress json: NDJSON on stdout, human text on stderr', () => {
  test('AC1 a successful update announces check, backup, swap, start, verify and then the result', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const r = await run(baseArgs(JSON_FLAGS));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(phases(r.stdout), ['check', 'backup', 'swap', 'start', 'verify']);
    for (const line of events(r.stdout)) assert.equal(line.v, 1);
    const result = resultOf(r.stdout);
    assert.deepEqual(Object.keys(result), RESULT_KEYS);
    assert.equal(result.exit, 0);
    assert.equal(result.reason, null);
    assert.equal(result.oldCommit, e.shaA);
    assert.equal(result.newCommit, e.shaB);
    const [dir] = backups();
    assert.equal(result.backup, join(e.data, 'backups', dir!, 'nucleo.sqlite'));
    assert.match(r.stderr, /updated to/, 'the human message went to stderr');
    assert.ok(!r.stdout.includes('updated to'));
  });

  test('AC1 a phase event has exactly the keys v, event and phase', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const r = await run(baseArgs([...JSON_FLAGS, '--check']));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(events(r.stdout).map((v) => Object.keys(v)), [['v', 'event', 'phase'], RESULT_KEYS]);
    assert.deepEqual(phases(r.stdout), ['check']);
    assert.equal(resultOf(r.stdout).newCommit, e.shaB);
    assert.equal(resultOf(r.stdout).backup, null);
  });

  test('AC1 a rollback adds the rollback phase and exits 40 with reason started-failed and the backup', async () => {
    await makeEnvReplace({ variantB: 'fails' });
    const pid = await startOrphan();
    honestProc(pid);
    const r = await run(baseArgs(JSON_FLAGS));
    assert.equal(r.code, 40, r.stderr);
    assert.deepEqual(phases(r.stdout), ['check', 'backup', 'swap', 'start', 'verify', 'rollback']);
    const result = resultOf(r.stdout);
    assert.deepEqual([result.exit, result.reason, result.oldCommit, result.newCommit], [40, 'started-failed', e.shaA, e.shaB]);
    assert.ok(result.backup && existsSync(result.backup));
  });

  test('AC1 a rollback that fails exits 41 and still carries the backup and the old commit', async () => {
    await makeEnvReplace({ variantB: 'fails-and-breaks' });
    const pid = await startOrphan();
    honestProc(pid);
    const r = await run(baseArgs(JSON_FLAGS));
    assert.equal(r.code, 41, r.stderr);
    const result = resultOf(r.stdout);
    assert.deepEqual([result.exit, result.reason, result.oldCommit], [41, 'started-failed', e.shaA]);
    assert.ok(result.backup && existsSync(result.backup));
  });

  const refusals: { name: string; code: number; reason: string | null; args: () => string[]; setup?: () => Promise<void> | void }[] = [
    { name: 'not-a-checkout', code: 30, reason: 'not-a-checkout', args: () => baseArgs().map((a, i, all) => (all[i - 1] === '--checkout' ? join(e.root, 'nowhere') : a)).concat(JSON_FLAGS) },
    { name: 'dirty-tree', code: 30, reason: 'dirty-tree', args: () => baseArgs(JSON_FLAGS), setup: () => write(join(e.repo, 'packages/nucleo/src/owner/cli.ts'), '// local change\n') },
    { name: 'unknown-ref', code: 30, reason: 'unknown-ref', args: () => baseArgs(JSON_FLAGS, 'app-v9.9.9') },
    { name: 'new-dependencies', code: 30, reason: 'new-dependencies', args: () => baseArgs(JSON_FLAGS), setup: () => makeEnvReplace({ deps: true }) },
    { name: 'telemetry', code: 20, reason: null, args: () => baseArgs([...JSON_FLAGS, '--mac-telemetry-version', '2']) },
    { name: 'owner-proof', code: 21, reason: null, args: () => baseArgs([...JSON_FLAGS, '--mac-credential-command', 'no']) },
    { name: 'no-manifest', code: 22, reason: null, args: () => baseArgs(JSON_FLAGS), setup: () => makeEnvReplace({ manifest: false }) },
    { name: 'no-mac-flags', code: 23, reason: null, args: () => ['--checkout', e.repo, '--ref', 'app-v0.0.17', '--no-fetch', '--port', String(e.port), '--data-dir', e.data, ...JSON_FLAGS] },
    { name: 'live-lock', code: 33, reason: null, args: () => baseArgs(JSON_FLAGS), setup: () => writeLock(process.pid) },
  ];
  for (const c of refusals) {
    test(`AC1 refusal ${c.name}: exit ${c.code}, reason ${c.reason}, a closed result and no signal`, async () => {
      await c.setup?.();
      const pid = await startOrphan();
      honestProc(pid);
      const r = await run(c.args());
      assert.equal(r.code, c.code, r.stderr);
      const result = resultOf(r.stdout);
      assert.deepEqual(Object.keys(result), RESULT_KEYS);
      assert.deepEqual([result.exit, result.reason], [c.code, c.reason]);
      assert.deepEqual(lines(join(e.data, 'sigterm.log')), [], 'no SIGTERM reached the core');
      assert.ok(!phases(r.stdout).includes('swap'));
    });
  }

  test('AC1 31: a backup that cannot be made ends after the backup phase with no backup path', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    for (const s of ['', '-wal', '-shm']) rmSync(join(e.data, `nucleo.sqlite${s}`), { force: true });
    writeFileSync(join(e.data, 'nucleo.sqlite'), 'this is not a sqlite file, '.repeat(200));
    const r = await run(baseArgs(JSON_FLAGS));
    assert.equal(r.code, 31, r.stderr);
    assert.deepEqual(phases(r.stdout), ['check', 'backup']);
    assert.deepEqual([resultOf(r.stdout).reason, resultOf(r.stdout).backup], [null, null]);
  });

  test('AC1 32 reasons: process-mismatch, no-options and data-dir-mismatch', async () => {
    const pid = await startOrphan();
    writeProc(pid, ['/usr/bin/python3', 'server.py']);
    const mismatch = await run(baseArgs(JSON_FLAGS));
    assert.equal(mismatch.code, 32, mismatch.stderr);
    assert.equal(resultOf(mismatch.stdout).reason, 'process-mismatch');
    e.env.AHRENA_CONSOLE_PROC_ROOT = join(e.root, 'no-proc');
    const noOptions = await run(baseArgs(JSON_FLAGS));
    assert.equal(noOptions.code, 32, noOptions.stderr);
    assert.equal(resultOf(noOptions.stdout).reason, 'no-options');
    honestProc(pid);
    const wrongDir = await run(baseArgs(JSON_FLAGS).map((a, i, all) => (all[i - 1] === '--data-dir' ? join(e.root, 'elsewhere') : a)));
    assert.equal(wrongDir.code, 32, wrongDir.stderr);
    assert.equal(resultOf(wrongDir.stdout).reason, 'data-dir-mismatch');
    await assertUntouched(pid);
  });

  test('AC1 a usage error and a bad --progress value still end with a result (or exit 2)', async () => {
    const usage = await run(['--checkout', e.repo, ...JSON_FLAGS]);
    assert.equal(usage.code, 2);
    assert.equal(resultOf(usage.stdout).exit, 2);
    const bad = await run(baseArgs(['--progress', 'text']));
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--progress must be json/);
  });

  test('AC1 without --progress the output stays free text on stdout', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const r = await run(baseArgs(['--check']));
    assert.match(r.stdout, /nothing was touched/);
    assert.throws(() => events(r.stdout));
  });
});

describe('AC7 · the script read from stdin: node --input-type=module -', () => {
  test('AC7 --check from stdin works and reports through NDJSON', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const r = await spawnScript(baseArgs([...JSON_FLAGS, '--check']), {}, true).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(resultOf(r.stdout).newCommit, e.shaB);
    await assertUntouched(pid);
  });

  test('AC7 a full update from stdin works; the hint does not name a script path', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const r = await spawnScript(baseArgs(JSON_FLAGS), {}, true).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(head(), e.shaB);
    assert.equal(resultOf(r.stdout).exit, 0);
    assert.match(r.stderr, /run the script again with install-unit/);
    assert.ok(!/node \S+ install-unit/.test(r.stderr + r.stdout));
    assert.ok(!/\$\{process\.argv\[1\]\}/.test(readFileSync(SCRIPT, 'utf8')), 'no message is built from argv[1]');
  });

  test('AC7 install-unit works from stdin too', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const r = await spawnScript(['install-unit', '--checkout', e.repo, '--port', String(e.port), '--data-dir', e.data, '--core-options', coreArgs().join(' ')], {}, true).done;
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(existsSync(join(e.home, '.config/systemd/user/ahrena-console-core.service')));
  });
});

describe('AC8 · signals', () => {
  const FAKE_GIT = (real: string) => `
const a = process.argv.slice(2);
if (a.includes('fetch')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
const r = require('child_process').spawnSync(${JSON.stringify(real)}, a, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`;

  test('AC8 SIGTERM during the check cancels: exit 130, result 130, lock released, nothing touched', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    executable(join(e.bin, 'git'), FAKE_GIT(execFileSync('which', ['git'], { encoding: 'utf8' }).trim()));
    const args = baseArgs(JSON_FLAGS).filter((a) => a !== '--no-fetch');
    const slow = spawnScript(args);
    await until(async () => existsSync(lockFile()));
    await new Promise((r) => setTimeout(r, 300));
    slow.child.kill('SIGTERM');
    const r = await slow.done;
    assert.equal(r.code, 130, r.stderr);
    assert.equal(resultOf(r.stdout).exit, 130);
    assert.deepEqual(phases(r.stdout), ['check']);
    assert.ok(!existsSync(lockFile()));
    await assertUntouched(pid);
  });

  test('AC8 after the backup phase SIGTERM, SIGINT and SIGHUP are ignored: the update finishes alone', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const running = spawnScript(baseArgs(JSON_FLAGS), PAUSE);
    await until(async () => running.seen.stdout.includes('"phase":"backup"'));
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) running.child.kill(signal);
    const r = await running.done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(head(), e.shaB);
    assert.ok(!existsSync(lockFile()));
  });

  test('AC8 a stdout closed after the backup phase (EPIPE) does not stop the update', async () => {
    const pid = await startOrphan();
    honestProc(pid);
    const running = spawnScript(baseArgs(JSON_FLAGS), PAUSE);
    await until(async () => running.seen.stdout.includes('"phase":"backup"'));
    running.child.stdout.destroy();
    const r = await running.done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(head(), e.shaB);
    assert.equal((await overview(e.port))?.commit, e.shaB);
    assert.ok(!existsSync(lockFile()));
  });
});
