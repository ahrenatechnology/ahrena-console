// The connection of a remote machine (#278, decision 0013 section 4): the state derived for every
// case, every reason of the closed list (with log files whose EARLIER bytes hold a pattern that must
// not be matched), the jobs (start, stop, reconnect, and login-and-start with login fails → no start
// and Cancel in each step), and "stopped by you" suppressing the unreachable alert.
//
// The commands are a FAKE script in a temporary folder (prints a text and exits with a code, sleeps, or
// writes a marker); the AWS login is a stub; the time unit is shortened (1 "second" = 20 ms). No real
// tunnel, host, account or region: placeholders only.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { deriveConnection, LOG_PATTERNS, MachineConnection, reasonFromLog, tunnelFor, type CloudLogins, type CloudLoginStatus, type DeriveInput } from '../../src/telemetry/connection.ts';
import type { ConnectionConfig, ReconnectConfig } from '../../src/telemetry/machines-config.ts';
import type { ConnectionReason, TelemetryReading } from '../../src/telemetry/model.ts';
import { ReconnectRunner } from '../../src/telemetry/reconnect.ts';
import { RemoteMachine } from '../../src/telemetry/remote.ts';
import type { MachineStatus } from '../../src/telemetry/service.ts';
import { reading, T0 } from './reading.ts';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-connection-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const SCRIPT = join(dir, 'fake-connect.mjs');
writeFileSync(
  SCRIPT,
  `const [mode, a, b] = process.argv.slice(2);
const fs = await import('node:fs');
if (mode === 'print') { console.error(a); process.exitCode = Number(b); }
if (mode === 'print-file') { console.error(fs.readFileSync(a, 'utf8')); process.exitCode = Number(b); }
if (mode === 'marker') fs.writeFileSync(a, 'ran');
if (mode === 'sleep') setTimeout(() => {}, 60_000);
`,
);
const cmd = (...args: string[]): ReconnectConfig => ({ command: [process.execPath, SCRIPT, ...args], timeoutSeconds: 900 });

const DOWN: MachineStatus = { state: 'unreachable', reason: 'port-closed', version: null };
const NO_RESPONSE: MachineStatus = { state: 'unreachable', reason: 'no-response', version: null };
const UP: MachineStatus = { state: 'connected', reason: null, version: 1 };

// ---------------------------------------------------------------------------------------------
// Pure derivation

const base = (over: Partial<DeriveInput> = {}): DeriveInput => ({
  config: { start: cmd('marker', 'x'), stop: cmd('marker', 'y') },
  port: 14720,
  machine: DOWN,
  job: null,
  jobAlive: false,
  stoppedAt: null,
  failure: null,
  reading: null,
  cloud: null,
  logFile: '/example/reconnect.log',
  now: T0,
  memo: null,
  ...over,
});
const runningJob = (kind: 'start' | 'stop' | 'reconnect' | 'login-and-start', step: 'login' | 'stop' | 'start' | 'read') => ({
  kind,
  steps: [step],
  step,
  state: 'running' as const,
  startedAt: '2026-11-02T11:59:00.000Z',
  endedAt: null,
  stepStartedAt: '2026-11-02T11:59:00.000Z',
  stepTimeoutSeconds: 180,
  startedBy: 'ui' as const,
});
const tunnelReading = (state: 'up' | 'idle' | 'busy' | 'down', heldBy: string | null = null): TelemetryReading =>
  reading({
    tunnels: [
      {
        pid: 4242,
        destination: 'ws-exemplo',
        since: '2026-11-02T09:00:00.000Z',
        ports: [
          { localPort: 14720, remoteHost: 'localhost', remotePort: 4720, state, heldBy },
          { localPort: 13000, remoteHost: 'localhost', remotePort: 3000, state: 'up', heldBy: null },
        ],
      },
      { pid: 4343, destination: 'outra-maquina', since: null, ports: [{ localPort: 15000, remoteHost: 'localhost', remotePort: 5000, state: 'up', heldBy: null }] },
    ],
  });

describe('#278 the connection state, derived', () => {
  test('#278 up: the remote núcleo answers; since = the ssh process start; ports of the tunnel that forwards the machine port', () => {
    const { status } = deriveConnection(base({ machine: UP, reading: tunnelReading('up') }));
    assert.equal(status.state, 'up');
    assert.equal(status.since, '2026-11-02T09:00:00.000Z');
    assert.deepEqual(status.ports.map((p) => p.localPort), [14720, 13000]);
    assert.equal(status.lastError, null);
    assert.deepEqual(status.actions, { start: false, stop: true, reconnect: true, loginAndStart: false });
    assert.deepEqual(status.command, { start: cmd('marker', 'x').command, stop: cmd('marker', 'y').command, startTimeoutSeconds: 900, stopTimeoutSeconds: 900 });
  });

  test('#278 down: nothing answers and no start failed; no reason when only the port is closed', () => {
    const { status } = deriveConnection(base());
    assert.equal(status.state, 'down');
    assert.equal(status.lastError, null);
    assert.deepEqual(status.ports, []);
    assert.deepEqual(status.actions, { start: true, stop: false, reconnect: true, loginAndStart: false });
  });

  test('#278 starting and stopping while a job runs; no action is offered then', () => {
    for (const [kind, step, want] of [
      ['start', 'start', 'starting'],
      ['login-and-start', 'login', 'starting'],
      ['reconnect', 'stop', 'starting'],
      ['stop', 'stop', 'stopping'],
      ['stop', 'read', 'stopping'],
    ] as const) {
      const { status } = deriveConnection(base({ job: runningJob(kind, step), jobAlive: true }));
      assert.equal(status.state, want, `${kind}/${step}`);
      assert.equal(status.since, '2026-11-02T11:59:00.000Z');
      assert.deepEqual(status.actions, { start: false, stop: false, reconnect: false, loginAndStart: false });
      assert.equal(status.job?.step, step);
    }
  });

  test('#278 failing: the last start failed and the machine still does not answer; the reason of that run', () => {
    const failure = { reason: 'ssm-agent-offline' as ConnectionReason, at: '2026-11-02T11:58:00.000Z', exitCode: 255 };
    const { status } = deriveConnection(base({ failure }));
    assert.equal(status.state, 'failing');
    assert.equal(status.since, failure.at);
    assert.deepEqual(status.lastError, { reason: 'ssm-agent-offline', at: failure.at, exitCode: 255, holder: null });
    // Up again: no longer failing.
    assert.equal(deriveConnection(base({ failure, machine: UP })).status.state, 'up');
  });

  test('#278 stopped: after a stop the user asked for, even with the machine down; only Subir is offered', () => {
    const { status } = deriveConnection(base({ stoppedAt: '2026-11-02T11:00:00.000Z', machine: NO_RESPONSE, failure: { reason: 'exit-code', at: 'x', exitCode: 1 } }));
    assert.equal(status.state, 'stopped');
    assert.equal(status.since, '2026-11-02T11:00:00.000Z');
    assert.equal(status.lastError, null, 'a stop is not a drop: no reason');
    assert.deepEqual(status.actions, { start: true, stop: false, reconnect: false, loginAndStart: false });
  });

  test('#278 since is kept while the state holds, and moves when it changes', () => {
    const first = deriveConnection(base({ now: T0 }));
    const second = deriveConnection(base({ now: T0 + 60_000, memo: first.memo }));
    assert.equal(second.status.since, first.status.since);
    const third = deriveConnection(base({ now: T0 + 120_000, memo: second.memo, failure: { reason: 'exit-code', at: '2026-11-02T12:01:30.000Z', exitCode: 2 } }));
    assert.equal(third.status.since, '2026-11-02T12:01:30.000Z');
  });

  test('#278 without a connection: configured false, no command, no action', () => {
    const { status } = deriveConnection(base({ config: null }));
    assert.equal(status.configured, false);
    assert.equal(status.command, null);
    assert.equal(status.logFile, null);
    assert.deepEqual(status.actions, { start: false, stop: false, reconnect: false, loginAndStart: false });
  });
});

describe('#278 the reason, in the order of the closed list', () => {
  const expired = { cloud: { connector: 'aws' as const, profile: 'perfil-dev', session: 'sessao-exemplo', state: 'expired' as const, expiresAt: '2026-11-02T03:10:00.000Z' }, loginPossible: true };
  const failure = { reason: 'host-unknown' as ConnectionReason, at: '2026-11-02T11:58:00.000Z', exitCode: 255 };

  test('#278 (1) the linked session expired wins over everything, and offers login-and-start', () => {
    const { status } = deriveConnection(base({ cloud: expired, reading: tunnelReading('busy', 'node'), machine: NO_RESPONSE, failure }));
    assert.equal(status.lastError?.reason, 'sso-expired');
    assert.deepEqual(status.cloud, expired.cloud);
    assert.equal(status.actions.loginAndStart, true);
    assert.equal(deriveConnection(base({ cloud: { ...expired, loginPossible: false } })).status.actions.loginAndStart, false);
    assert.equal(deriveConnection(base({ cloud: { ...expired, cloud: { ...expired.cloud, state: 'valid' } } })).status.actions.loginAndStart, false);
  });

  test('#278 (2) the port held by another process, with its name, from the tunnel probe or the listening ports', () => {
    const viaTunnel = deriveConnection(base({ reading: tunnelReading('busy', 'node'), machine: NO_RESPONSE, failure })).status;
    assert.deepEqual(viaTunnel.lastError, { reason: 'port-busy', at: viaTunnel.since, exitCode: null, holder: 'node' });
    const listener = reading({ tunnels: [], ports: [{ port: 14720, interface: 'loopback', address: null, process: 'python3', pid: 812 }] });
    assert.equal(deriveConnection(base({ reading: listener, machine: NO_RESPONSE })).status.lastError?.holder, 'python3');
    const sshListener = reading({ tunnels: [], ports: [{ port: 14720, interface: 'loopback', address: null, process: 'ssh', pid: 813 }] });
    assert.equal(tunnelFor(sshListener, 14720).busy, false);
  });

  test('#278 (3) the port open and no núcleo answering', () => {
    assert.equal(deriveConnection(base({ machine: NO_RESPONSE, failure })).status.lastError?.reason, 'core-not-answering');
  });

  test('#278 (4) after a failed start, the reason found in that run’s log bytes; port-busy from the log takes the probe’s holder', () => {
    assert.deepEqual(deriveConnection(base({ failure })).status.lastError, { reason: 'host-unknown', at: failure.at, exitCode: 255, holder: null });
    const fromLog = deriveConnection(base({ failure: { ...failure, reason: 'port-busy' } })).status.lastError;
    assert.equal(fromLog?.reason, 'port-busy');
  });
});

// ---------------------------------------------------------------------------------------------
// The log reasons

let n = 0;
const logPath = () => join(dir, `reconnect-${++n}.log`);

describe('#278 the patterns, only in the bytes the run wrote', () => {
  const samples: [string, ConnectionReason][] = [
    ['An error occurred (TargetNotConnected) when calling the StartSession operation', 'ssm-agent-offline'],
    ['ssh: Could not resolve hostname ws-exemplo: nodename nor servname provided', 'host-unknown'],
    ['usuario@ws-exemplo: Permission denied (publickey).', 'key-refused'],
    ['bind [127.0.0.1]:14720: Address already in use', 'port-busy'],
    ['Error when retrieving token from sso: Token has expired and refresh failed', 'sso-expired'],
    ['Error loading SSO Token: Token for sessao-exemplo does not exist', 'sso-expired'],
    ['something else entirely', 'exit-code'],
  ];

  test('#278 each pattern of the list maps to its reason; nothing matched is exit-code', async () => {
    assert.equal(LOG_PATTERNS.length, 5);
    for (const [line, want] of samples) {
      const f = logPath();
      writeFileSync(f, 'earlier run: nothing here\n');
      const offset = 'earlier run: nothing here\n'.length;
      appendFileSync(f, `${line}\n`);
      assert.equal(await reasonFromLog(f, offset), want, line);
    }
  });

  test('#278 a pattern in the EARLIER bytes of the file is never matched', async () => {
    const f = logPath();
    const earlier = 'An error occurred (TargetNotConnected)\nPermission denied (publickey).\n';
    writeFileSync(f, earlier);
    appendFileSync(f, 'ssh: Could not resolve hostname ws-exemplo\n');
    assert.equal(await reasonFromLog(f, earlier.length), 'host-unknown');
    assert.equal(await reasonFromLog(f, Buffer.byteLength(earlier) + 'ssh: Could not resolve hostname ws-exemplo\n'.length), 'exit-code', 'a run that wrote nothing');
  });

  test('#278 a file rotated when the run opened it (shorter than the offset) is read from 0; no offset is exit-code', async () => {
    const f = logPath();
    writeFileSync(f, 'Permission denied (publickey).\n');
    assert.equal(await reasonFromLog(f, 10_000), 'key-refused');
    assert.equal(await reasonFromLog(f, null), 'exit-code');
    assert.equal(await reasonFromLog(join(dir, 'missing.log'), 0), 'exit-code');
  });
});

// ---------------------------------------------------------------------------------------------
// The jobs

class StubCloud implements CloudLogins {
  calls: string[] = [];
  sessionState: 'valid' | 'expiring' | 'expired' | 'never' | 'unknown' = 'expired';
  loginSupported = true;
  refuse: string | null = null;
  private state: CloudLoginStatus['state'] = 'idle';
  private release: () => void = () => {};
  private exit: Promise<void> = Promise.resolve();
  async view() {
    return {
      cli: { found: true, version: 2 },
      configFile: { status: 'ok' as const },
      sessions: [{ name: 'sessao-exemplo', loginSupported: this.loginSupported, state: this.sessionState, expiresAt: '2026-11-02T03:10:00.000Z', profiles: [{ name: 'perfil-dev' }] }],
    };
  }
  async login(name: string) {
    this.calls.push(`login ${name}`);
    if (this.refuse) return { kind: 'refused' as const, reason: this.refuse };
    this.state = 'running';
    this.exit = new Promise<void>((r) => (this.release = r));
    return { kind: 'started' as const };
  }
  async cancel(name: string) {
    this.calls.push(`cancel ${name}`);
    if (this.state === 'running') this.finish('canceled');
    return { kind: 'canceled' };
  }
  finish(state: CloudLoginStatus['state']) {
    this.state = state;
    this.release();
  }
  logins = {
    exited: () => this.exit,
    status: (): CloudLoginStatus => ({ state: this.state, timeoutSeconds: 300 }),
  };
}

function setup(config: ConnectionConfig | null, o: { machine?: MachineStatus; cloud?: StubCloud | null; reading?: TelemetryReading | null } = {}) {
  const logFile = logPath();
  const configs: Record<string, ConnectionConfig | null> = { 'ws-exemplo': config };
  const state = { machine: o.machine ?? DOWN, reads: 0, readGate: null as Promise<void> | null };
  const machine = {
    port: 14720,
    status: () => state.machine,
    readNow: async () => {
      state.reads++;
      if (state.readGate) await state.readGate;
    },
  };
  const registry = {
    refresh: async () => {},
    fileInvalid: () => false,
    connectionOf: (id: string) => (id in configs ? configs[id]! : undefined),
    get: (id: string) => (id === 'ws-exemplo' ? machine : undefined),
  };
  const spawns: string[] = [];
  const startRunner = new ReconnectRunner({
    logFile,
    lookup: async (id) => (id in configs ? (configs[id]?.start ?? null) : undefined),
    msPerSecond: 20,
    killGraceMs: 150,
    onSpawn: () => spawns.push('start'),
  });
  const changes: string[] = [];
  const conn = new MachineConnection({
    registry,
    startRunner,
    logFile,
    cloud: o.cloud === undefined ? null : o.cloud,
    localReading: async () => o.reading ?? null,
    onChange: (id) => changes.push(id),
    runner: { msPerSecond: 20, killGraceMs: 150, onSpawn: () => spawns.push('stop') },
  });
  return { conn, state, logFile, spawns, changes, configs, startRunner };
}

const marker = () => join(dir, `marker-${++n}`);
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('#278 the start, stop and reconnect jobs', () => {
  test('#278 start: the start command runs, the machine is read, the job succeeds; changes are published', async () => {
    const m = marker();
    const s = setup({ start: cmd('marker', m) });
    const r = await s.conn.start('ws-exemplo', 'ui');
    assert.equal(r.kind, 'started');
    if (r.kind !== 'started') return;
    assert.equal(r.status.state, 'starting');
    assert.equal(r.status.job?.kind, 'start');
    assert.deepEqual(r.status.job?.steps, ['start', 'read']);
    await s.conn.settled('ws-exemplo');
    assert.equal(existsSync(m), true);
    assert.equal(s.state.reads, 1);
    const st = await s.conn.status('ws-exemplo');
    assert.equal(st?.job?.state, 'succeeded');
    assert.ok(s.changes.length >= 3 && s.changes.every((c) => c === 'ws-exemplo'));
  });

  test('#278 a failed start: failing, with the reason of THIS run (an earlier pattern in the log is ignored) and the exit code', async () => {
    const said = join(dir, `said-${++n}.txt`);
    writeFileSync(said, 'An error occurred (TargetNotConnected) when calling StartSession LOG-SENTINEL');
    const s = setup({ start: cmd('print-file', said, '254') });
    writeFileSync(s.logFile, 'old run: ssh: Could not resolve hostname ws-exemplo\nold run: Permission denied (publickey).\n');
    await s.conn.start('ws-exemplo', 'local');
    await s.conn.settled('ws-exemplo');
    const st = (await s.conn.status('ws-exemplo'))!;
    assert.equal(st.state, 'failing');
    assert.equal(st.job?.state, 'failed');
    assert.equal(st.job?.step, 'start');
    assert.deepEqual({ reason: st.lastError?.reason, exitCode: st.lastError?.exitCode }, { reason: 'ssm-agent-offline', exitCode: 254 });
    assert.equal(s.state.reads, 0, 'a failed start reads nothing');
    assert.equal(JSON.stringify(st).includes('LOG-SENTINEL') || JSON.stringify(st).includes('TargetNotConnected'), false, 'the log text never reaches the status');
  });

  test('#278 a failed start with nothing known in its bytes is exit-code, even with patterns before it', async () => {
    const s = setup({ start: cmd('print', 'nada conhecido', '3') });
    writeFileSync(s.logFile, 'An error occurred (TargetNotConnected)\nAddress already in use\nToken has expired\n');
    await s.conn.start('ws-exemplo', 'ui');
    await s.conn.settled('ws-exemplo');
    assert.deepEqual((await s.conn.status('ws-exemplo'))!.lastError, { reason: 'exit-code', at: (await s.conn.status('ws-exemplo'))!.lastError!.at, exitCode: 3, holder: null });
  });

  test('#278 stop: stopped by you, the unreachable alert is suppressed until a start, and Subir clears it', async () => {
    const m = marker();
    const s = setup({ start: cmd('marker', m), stop: cmd('print', 'stopping', '0') }, { machine: UP });
    const r = await s.conn.stop('ws-exemplo', 'ui');
    assert.equal(r.kind, 'started');
    assert.equal(s.conn.suppressUnreachable('ws-exemplo'), true, 'while the stop runs');
    await s.conn.settled('ws-exemplo');
    s.state.machine = DOWN;
    const st = (await s.conn.status('ws-exemplo'))!;
    assert.equal(st.state, 'stopped');
    assert.ok(st.since);
    assert.equal(s.conn.suppressUnreachable('ws-exemplo'), true);
    await s.conn.start('ws-exemplo', 'ui');
    assert.equal(s.conn.suppressUnreachable('ws-exemplo'), false);
    await s.conn.settled('ws-exemplo');
    assert.equal(existsSync(m), true);
  });

  test('#278 stop, then the machine answers again outside the console: up, the actions come back, and the next drop alerts', async () => {
    const s = setup({ start: cmd('print', 'starting', '0'), stop: cmd('print', 'stopping', '0') }, { machine: UP });
    await s.conn.stop('ws-exemplo', 'ui');
    await s.conn.settled('ws-exemplo');
    s.state.machine = DOWN;
    assert.equal((await s.conn.status('ws-exemplo'))!.state, 'stopped');
    assert.equal(s.conn.suppressUnreachable('ws-exemplo'), true);
    // The tunnel comes back some other way (a terminal, a reboot): the machine answers, no job runs.
    s.state.machine = UP;
    const st = (await s.conn.status('ws-exemplo'))!;
    assert.equal(st.state, 'up');
    assert.deepEqual({ stop: st.actions.stop, reconnect: st.actions.reconnect }, { stop: true, reconnect: true });
    assert.equal(s.conn.suppressUnreachable('ws-exemplo'), false);
    // The next drop opens machine-unreachable.
    s.state.machine = DOWN;
    const tracker = new AlertTracker();
    const entered: string[] = [];
    const m = new RemoteMachine({
      config: { id: 'ws-exemplo', label: 'Workstation', port: 14720 },
      get: async () => ({ kind: 'unreachable', reason: 'port-closed' }),
      store: { putSample: async () => {}, listPoints: async () => [], latest: async () => null },
      tracker,
      onAlertChange: (c) => c.change === 'entered' && entered.push(c.alert.id),
      suppressUnreachable: (id) => s.conn.suppressUnreachable(id),
    });
    await m.pollOnce();
    assert.deepEqual(entered, ['machine-unreachable']);
  });

  test('#278 the stopped mark is not cleared while the machine still answers during the stop job', async () => {
    const s = setup({ start: cmd('print', 'starting', '0'), stop: cmd('print', 'stopping', '0') }, { machine: UP });
    let release = () => {};
    s.state.readGate = new Promise<void>((r) => (release = r));
    await s.conn.stop('ws-exemplo', 'ui');
    await waitFor(async () => (await s.conn.status('ws-exemplo'))!.job?.step === 'read');
    assert.equal((await s.conn.status('ws-exemplo'))!.state, 'stopping');
    assert.equal(s.conn.suppressUnreachable('ws-exemplo'), true);
    s.state.machine = DOWN;
    release();
    await s.conn.settled('ws-exemplo');
    assert.equal((await s.conn.status('ws-exemplo'))!.state, 'stopped');
  });

  test('#278 stop without a stop command is refused, nothing runs', async () => {
    const s = setup({ start: cmd('marker', marker()) }, { machine: UP });
    assert.deepEqual(await s.conn.stop('ws-exemplo', 'ui'), { kind: 'refused', reason: 'no-stop-command' });
    assert.deepEqual(s.spawns, []);
  });

  test('#278 reconnect: stop, then start, even when the stop fails', async () => {
    const m = marker();
    const s = setup({ start: cmd('marker', m), stop: cmd('print', 'nothing to stop', '1') }, { machine: UP });
    await s.conn.reconnect('ws-exemplo', 'ui');
    await s.conn.settled('ws-exemplo');
    assert.deepEqual(s.spawns, ['stop', 'start']);
    assert.equal(existsSync(m), true);
    const st = (await s.conn.status('ws-exemplo'))!;
    assert.equal(st.job?.state, 'succeeded');
    assert.notEqual(st.state, 'stopped', 'a reconnect is not a stop by you');
  });

  test('#278 one job at a time: another kind is busy, the same kind joins the one running', async () => {
    const s = setup({ start: cmd('sleep'), stop: cmd('sleep') });
    await s.conn.start('ws-exemplo', 'ui');
    assert.equal((await s.conn.start('ws-exemplo', 'local')).kind, 'already-running');
    assert.deepEqual(await s.conn.stop('ws-exemplo', 'ui'), { kind: 'refused', reason: 'busy' });
    assert.equal((await s.conn.legacy.start('ws-exemplo', 'local')).kind, 'already-running');
    await s.conn.cancel('ws-exemplo');
    await s.conn.settled('ws-exemplo');
    assert.deepEqual(s.spawns, ['start']);
  });

  test('#278 unknown id and no connection are refused', async () => {
    const s = setup(null);
    assert.deepEqual(await s.conn.start('ws-nenhuma', 'ui'), { kind: 'refused', reason: 'unknown' });
    assert.deepEqual(await s.conn.start('ws-exemplo', 'ui'), { kind: 'refused', reason: 'not-configured' });
    assert.deepEqual(await s.conn.cancel('ws-exemplo'), { kind: 'refused', reason: 'not-running' });
    assert.deepEqual(await s.conn.cancel('ws-nenhuma'), { kind: 'refused', reason: 'unknown' });
  });

  test('#278 the old Reconnect route is a start job of the connection, with the reconnect status', async () => {
    const m = marker();
    const s = setup({ start: cmd('marker', m) });
    const r = await s.conn.legacy.start('ws-exemplo', 'local');
    assert.equal(r.kind, 'started');
    if (r.kind === 'started') assert.equal(r.status.state, 'running');
    await s.conn.settled('ws-exemplo');
    assert.equal(existsSync(m), true);
  });
});

describe('#278 login-and-start: one job, login → start → read', () => {
  const linked = (start: ReconnectConfig): ConnectionConfig => ({ start, cloudProfile: { connector: 'aws', profile: 'perfil-dev' } });

  test('#278 login exits 0 → the start runs → the machine is read', async () => {
    const m = marker();
    const cloud = new StubCloud();
    const s = setup(linked(cmd('marker', m)), { cloud });
    const r = await s.conn.loginAndStart('ws-exemplo', 'ui');
    assert.equal(r.kind, 'started');
    if (r.kind !== 'started') return;
    assert.deepEqual(r.status.job?.steps, ['login', 'start', 'read']);
    assert.equal(r.status.job?.step, 'login');
    assert.equal(r.status.job?.stepTimeoutSeconds, 300);
    assert.deepEqual(cloud.calls, ['login sessao-exemplo']);
    cloud.finish('succeeded');
    await s.conn.settled('ws-exemplo');
    assert.equal(existsSync(m), true);
    assert.equal(s.state.reads, 1);
    assert.equal((await s.conn.status('ws-exemplo'))!.job?.state, 'succeeded');
  });

  test('#278 login fails → no start', async () => {
    const m = marker();
    const cloud = new StubCloud();
    const s = setup(linked(cmd('marker', m)), { cloud });
    await s.conn.loginAndStart('ws-exemplo', 'ui');
    cloud.finish('failed');
    await s.conn.settled('ws-exemplo');
    assert.equal(existsSync(m), false);
    assert.deepEqual(s.spawns, []);
    const st = (await s.conn.status('ws-exemplo'))!;
    assert.deepEqual([st.job?.state, st.job?.step], ['failed', 'login']);
    assert.equal(st.lastError?.reason, 'sso-expired', 'the session is still expired');
  });

  test('#278 Cancel in the login step: the login is canceled, no start', async () => {
    const m = marker();
    const cloud = new StubCloud();
    const s = setup(linked(cmd('marker', m)), { cloud });
    await s.conn.loginAndStart('ws-exemplo', 'ui');
    const c = await s.conn.cancel('ws-exemplo');
    assert.equal(c.kind, 'canceled');
    if (c.kind === 'canceled') assert.equal(c.status.job?.state, 'canceled');
    await s.conn.settled('ws-exemplo');
    assert.deepEqual(cloud.calls, ['login sessao-exemplo', 'cancel sessao-exemplo']);
    assert.equal(existsSync(m), false);
  });

  test('#278 Cancel in the start step: the start process group is ended, no read', async () => {
    const cloud = new StubCloud();
    const s = setup(linked(cmd('sleep')), { cloud });
    await s.conn.loginAndStart('ws-exemplo', 'ui');
    cloud.finish('succeeded');
    await waitFor(async () => (await s.conn.status('ws-exemplo'))!.job?.step === 'start' && s.spawns.length === 1);
    await s.conn.cancel('ws-exemplo');
    await s.conn.settled('ws-exemplo');
    assert.equal(s.startRunner.lastRun('ws-exemplo')?.state, 'canceled');
    assert.equal(s.state.reads, 0);
    assert.equal((await s.conn.status('ws-exemplo'))!.job?.state, 'canceled');
  });

  test('#278 Cancel in the read step: the job is canceled', async () => {
    const cloud = new StubCloud();
    const s = setup(linked(cmd('marker', marker())), { cloud });
    let open: () => void = () => {};
    s.state.readGate = new Promise<void>((r) => (open = r));
    await s.conn.loginAndStart('ws-exemplo', 'ui');
    cloud.finish('succeeded');
    await waitFor(() => s.state.reads === 1);
    const c = await s.conn.cancel('ws-exemplo');
    assert.equal(c.kind, 'canceled');
    open();
    await s.conn.settled('ws-exemplo');
    const st = (await s.conn.status('ws-exemplo'))!;
    assert.deepEqual([st.job?.state, st.job?.step], ['canceled', 'read']);
  });

  test('#278 refusals: no profile, profile not in ~/.aws/config, name not supported, the connector refusing; nothing runs', async () => {
    const cloud = new StubCloud();
    assert.deepEqual(await setup({ start: cmd('sleep') }, { cloud }).conn.loginAndStart('ws-exemplo', 'ui'), { kind: 'refused', reason: 'no-cloud-profile' });
    assert.deepEqual(await setup(linked(cmd('sleep')), { cloud: null }).conn.loginAndStart('ws-exemplo', 'ui'), { kind: 'refused', reason: 'cloud-unavailable' });
    const other: ConnectionConfig = { start: cmd('sleep'), cloudProfile: { connector: 'aws', profile: 'perfil-outro' } };
    assert.deepEqual(await setup(other, { cloud }).conn.loginAndStart('ws-exemplo', 'ui'), { kind: 'refused', reason: 'profile-not-found' });
    cloud.loginSupported = false;
    assert.deepEqual(await setup(linked(cmd('sleep')), { cloud }).conn.loginAndStart('ws-exemplo', 'ui'), { kind: 'refused', reason: 'login-not-possible' });
    cloud.loginSupported = true;
    cloud.refuse = 'cli-missing';
    const s = setup(linked(cmd('sleep')), { cloud });
    assert.deepEqual(await s.conn.loginAndStart('ws-exemplo', 'ui'), { kind: 'refused', reason: 'cli-missing' });
    assert.deepEqual(s.spawns, []);
  });

  test('#278 the cloud link in the status: session, state and expiry from the connector', async () => {
    const cloud = new StubCloud();
    const st = (await setup(linked(cmd('sleep')), { cloud }).conn.status('ws-exemplo'))!;
    assert.deepEqual(st.cloud, { connector: 'aws', profile: 'perfil-dev', session: 'sessao-exemplo', state: 'expired', expiresAt: '2026-11-02T03:10:00.000Z' });
    assert.equal(st.actions.loginAndStart, true);
    assert.equal(st.lastError?.reason, 'sso-expired');
  });
});

describe('#278 stopped by you suppresses the machine-unreachable alert', () => {
  test('#278 a drop while suppressed opens no alert; after a start it does', async () => {
    let suppress = true;
    const tracker = new AlertTracker();
    const entered: string[] = [];
    const m = new RemoteMachine({
      config: { id: 'ws-exemplo', label: 'Workstation', port: 14720 },
      get: async () => ({ kind: 'unreachable', reason: 'port-closed' }),
      store: { putSample: async () => {}, listPoints: async () => [], latest: async () => null },
      tracker,
      onAlertChange: (c) => c.change === 'entered' && entered.push(c.alert.id),
      suppressUnreachable: () => suppress,
    });
    await m.pollOnce();
    assert.equal(m.state(), 'unreachable');
    assert.deepEqual(tracker.active('ws-exemplo'), []);
    assert.deepEqual(entered, []);
    suppress = false;
    await m.pollOnce();
    assert.deepEqual(entered, ['machine-unreachable']);
  });
});
