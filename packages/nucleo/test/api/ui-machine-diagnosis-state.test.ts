/* The state of the diagnosis next to a saturation alert (#566, layer 3 of 4): which alert opens by itself, the open and
close state that survives the 30 s re-reads, one read per open, "Tentar de novo" and "Ler de novo", the 20 s cap and the
abort on close and on leaving. Unit tests on the state logic (no DOM, the reader is a function the test gives) and
interaction tests on the mounted machine screen (fake DOM, the simulator's telemetry, GET /api/diagnosis answered here).
The normalizer and the per-status mapping of the route are layer 4; here the reader is the seam. */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { seedTelemetry, SimulatedCollector } from '../../src/simulator/telemetry.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { TELEMETRY_VERSION, type Alert } from '../../src/telemetry/model.ts';
import { TelemetrySampler } from '../../src/telemetry/sampler.ts';
import { localMachine, TelemetryService } from '../../src/telemetry/service.ts';
import { ElementoFalso, documentoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const here = { pathname: '/ui/machines/local', search: '', port: '4720' };
Object.assign(globalThis, { location: here, history: { state: null, replaceState: () => {} } });

// @ts-expect-error: browser module, plain JavaScript
import { ReadError } from '../../ui/api.js';
// @ts-expect-error: browser module, plain JavaScript
const state = await import('../../ui/screens/machine-diagnosis-state.js');
// @ts-expect-error: browser module, plain JavaScript
const format = await import('../../ui/screens/machine-format.js');
const screen = await import(
  // @ts-expect-error: idem
  '../../ui/screens/machine.js'
);

const NOW = Date.now();
const GB = 1024 ** 3;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const WS = { id: 'ws-example', label: 'Workstation', port: 14720 };
/** A configured remote that never answered: no reading stored, the core there does not respond. (#566) */
const DOWN = { id: 'ws-down', label: 'Workstation parada', port: 14721 };

const alert = (id: string, kind: Alert['kind'], level: Alert['level'], minutesAgo = 12): Alert => ({ id, kind, level, message: `message of ${id}`, detail: null, since: iso(minutesAgo * 60_000) });
const SWAP_HIGH = alert('swap-high', 'swap-high', 'error', 40);
const MEMORY_HIGH = alert('memory-high', 'memory-high', 'warning', 25);
const LOAD_HIGH = alert('load-high', 'load-high', 'error', 12);
const VOLUME_FULL = alert('volume-full:/', 'volume-full', 'warning', 60);
const PORT_EXPOSED = alert('port-exposed:5432', 'port-exposed', 'warning', 120);

const proc = (pid: number, name: string, rssGb: number, cpuPct: number) => ({ pid, name, rssBytes: rssGb * GB, cpuPct, startedAt: iso(3_600_000) });
const memoryDiagnosis = (alertId: string) => ({
  machine: 'local',
  alertId,
  kind: alertId,
  takenAt: iso(12_000),
  sections: [
    { id: 'processes-by-rss', status: 'ok', items: [proc(4182, 'qemu-system-aarch64', 9.8, 102), proc(7731, 'next-server', 3.2, 56)] },
    { id: 'processes-by-cpu', status: 'ok', items: [proc(4182, 'qemu-system-aarch64', 9.8, 102), proc(7731, 'next-server', 3.2, 56)] },
    { id: 'swap', status: 'ok', items: [{ usedBytes: 7.4 * GB, totalBytes: 8 * GB }] },
  ],
});

// ---------- the state logic, with no DOM ---------- (#566)

type Outcome = { state: string; diagnosis?: unknown; failure?: { status: number | null } };
interface Call {
  alert: Alert;
  signal: AbortSignal;
  resolve: (o: Outcome) => void;
  reject: (e: unknown) => void;
}
/** A reader the test settles by hand; every call is kept. (#566) */
function gatedReader() {
  const calls: Call[] = [];
  const read = (a: Alert, { signal }: { signal: AbortSignal }) =>
    new Promise<Outcome>((resolve, reject) => {
      calls.push({ alert: a, signal, resolve, reject });
    });
  return { calls, read };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const ready = (id = 'swap-high'): Outcome => ({ state: 'ready', diagnosis: memoryDiagnosis(id) });

function machineState(options: Record<string, unknown> = {}) {
  const gate = gatedReader();
  let changes = 0;
  const s = state.createDiagnosisState({ read: gate.read, onChange: () => changes++, ...options });
  return { s, gate, changes: () => changes };
}

describe('the route and the choice of alert', () => {
  test('the route names the machine and the alert, URL-encoded', () => {
    assert.equal(state.diagnosisRoute('local', 'swap-high'), '/api/diagnosis?machine=local&alert=swap-high');
    assert.equal(state.diagnosisRoute('ws-example', 'volume-full:/'), '/api/diagnosis?machine=ws-example&alert=volume-full%3A%2F');
  });

  test('only the four saturation kinds are kept', () => {
    assert.deepEqual(
      state.saturationAlerts([PORT_EXPOSED, SWAP_HIGH, alert('t', 'terminal-stuck' as Alert['kind'], 'warning'), VOLUME_FULL]).map((a: Alert) => a.id),
      ['swap-high', 'volume-full:/'],
    );
    assert.deepEqual(state.saturationAlerts(null), []);
  });

  test('the most severe is an error before a warning, then the oldest', () => {
    assert.equal(state.mostSevere([MEMORY_HIGH, SWAP_HIGH, LOAD_HIGH]).id, 'swap-high', 'error, and older than the other error');
    assert.equal(state.mostSevere([VOLUME_FULL, MEMORY_HIGH]).id, 'volume-full:/', 'both warnings: the oldest');
    assert.equal(state.mostSevere([LOAD_HIGH, { ...MEMORY_HIGH, level: 'error' }]).id, 'memory-high', 'both errors: the oldest (25 min against 12)');
    assert.equal(state.mostSevere([{ ...LOAD_HIGH, since: null }, { ...MEMORY_HIGH, level: 'error' }]).id, 'memory-high', 'an alert with no date is the newest');
    assert.equal(state.mostSevere([]), null);
  });
});

describe('what the probable cause needs from the reading', () => {
  const reading = (os: string) => ({
    host: { hostname: 'h', os },
    cpu: { cores: 12, model: null, usedPct: 50, load: { one: 24.6, five: null, fifteen: null } },
    memory: { totalBytes: 36 * GB, usedBytes: 30.5 * GB, swapTotalBytes: null, swapUsedBytes: null },
    volumes: [
      { mount: '/', totalBytes: 612 * GB, usedBytes: 556 * GB, freeBytes: 56 * GB, usedPct: 91 },
      { mount: '/Volumes/Data', totalBytes: 100 * GB, usedBytes: 90 * GB, freeBytes: 10 * GB, usedPct: 90 },
    ],
  });

  test('the memory in use, the load and the volume of the alert come from the reading', () => {
    const c = state.readingContext(reading('macOS 26.1'), VOLUME_FULL, { local: true });
    assert.equal(c.memoryUsedBytes, 30.5 * GB);
    assert.equal(c.load, 24.6);
    assert.deepEqual(c.volume, { mount: '/', usedBytes: 556 * GB, totalBytes: 612 * GB });
    assert.deepEqual(state.readingContext(reading('macOS 26.1'), alert('volume-full:/Volumes/Data', 'volume-full', 'warning'), { local: true }).volume, { mount: '/Volumes/Data', usedBytes: 90 * GB, totalBytes: 100 * GB });
  });

  test('no reading, no mount or no number leaves the field out: no cause is better than a made-up one', () => {
    assert.deepEqual(state.readingContext(null, SWAP_HIGH, { local: true }), {});
    assert.equal(state.readingContext(reading('macOS 26.1'), alert('volume-full:/nope', 'volume-full', 'warning'), { local: true }).volume, undefined);
  });

  test('this machine is named by its system: the Mac on macOS, "esta máquina" elsewhere; a remote is named by the panel', () => {
    assert.equal(state.readingContext(reading('macOS 26.1'), SWAP_HIGH, { local: true }).machine, 'o Mac');
    assert.equal(state.readingContext(reading('Ubuntu 24.04.1 LTS'), SWAP_HIGH, { local: true }).machine, 'esta máquina');
    assert.equal(state.readingContext(reading('Ubuntu 24.04.1 LTS'), SWAP_HIGH, { local: false }).machine, undefined);
  });
});

describe('the state of the panels', () => {
  test('the first sync opens the most severe saturation alert by itself and reads once; the others stay closed with no read', async () => {
    const { s, gate } = machineState();
    s.sync([PORT_EXPOSED, MEMORY_HIGH, SWAP_HIGH]);
    assert.equal(gate.calls.length, 1);
    assert.equal(gate.calls[0]!.alert.id, 'swap-high');
    assert.equal(s.view('swap-high').open, true);
    assert.equal(s.view('swap-high').state, 'loading');
    assert.equal(s.view('memory-high').open, false);
    assert.equal(s.view('port-exposed:5432'), null, 'a plain row has no panel');
    s.stop();
  });

  test('a plain alert and an empty list open nothing and read nothing', () => {
    const { s, gate } = machineState();
    s.sync([PORT_EXPOSED]);
    s.sync([]);
    s.sync(undefined);
    assert.equal(gate.calls.length, 0);
    s.stop();
  });

  test('the read arrives: ready with the diagnosis, and the screen is told', async () => {
    const { s, gate, changes } = machineState();
    s.sync([SWAP_HIGH]);
    gate.calls[0]!.resolve(ready());
    await tick();
    assert.equal(s.view('swap-high').state, 'ready');
    assert.equal((s.view('swap-high').diagnosis as { alertId: string }).alertId, 'swap-high');
    assert.equal(changes(), 1);
    s.stop();
  });

  test('a sync during the 30 s re-reads keeps the panel open and reads nothing again', async () => {
    const { s, gate } = machineState();
    s.sync([SWAP_HIGH, MEMORY_HIGH]);
    gate.calls[0]!.resolve(ready());
    await tick();
    s.sync([SWAP_HIGH, MEMORY_HIGH]);
    s.sync([{ ...SWAP_HIGH, message: 'new text' }, MEMORY_HIGH]);
    assert.equal(gate.calls.length, 1, 'no automatic refresh');
    assert.equal(s.view('swap-high').state, 'ready');
    assert.equal(s.view('swap-high').open, true);
    assert.equal(s.view('memory-high').open, false);
    s.stop();
  });

  test('opening another alert reads it once; closing aborts and drops what was read; opening again reads again (one read per open)', async () => {
    const { s, gate } = machineState();
    s.sync([SWAP_HIGH, MEMORY_HIGH]);
    gate.calls[0]!.resolve(ready());
    await tick();
    s.toggle('memory-high');
    assert.equal(gate.calls.length, 2);
    assert.equal(gate.calls[1]!.alert.id, 'memory-high');
    assert.equal(s.view('memory-high').state, 'loading');
    s.toggle('memory-high');
    assert.equal(gate.calls[1]!.signal.aborted, true, 'closing aborts the read in flight');
    assert.equal(s.view('memory-high').open, false);
    assert.equal(s.view('memory-high').state, 'idle');
    gate.calls[1]!.resolve(ready('memory-high'));
    await tick();
    assert.equal(s.view('memory-high').state, 'idle', 'a late answer after the close is dropped');
    s.toggle('memory-high');
    assert.equal(gate.calls.length, 3, 'a new open is a new read');
    s.stop();
  });

  test('what the person closed stays closed through later syncs, even when it was the one that opened by itself', async () => {
    const { s, gate } = machineState();
    s.sync([SWAP_HIGH]);
    gate.calls[0]!.resolve(ready());
    await tick();
    s.toggle('swap-high');
    s.sync([SWAP_HIGH]);
    s.sync([SWAP_HIGH, MEMORY_HIGH]);
    assert.equal(s.view('swap-high').open, false);
    assert.equal(s.view('memory-high').open, false, 'a newcomer does not open while another saturation alert is on screen');
    assert.equal(gate.calls.length, 1);
    s.stop();
  });

  test('"Tentar de novo" on a failure and "Ler de novo" on a diagnosis each read once more; while loading they do nothing', async () => {
    const { s, gate } = machineState();
    s.sync([SWAP_HIGH]);
    gate.calls[0]!.reject(new ReadError('O núcleo respondeu 500', { status: 500 }));
    await tick();
    assert.equal(s.view('swap-high').state, 'failed');
    assert.deepEqual(s.view('swap-high').failure, { status: 500 });
    s.retry('swap-high');
    s.retry('swap-high');
    assert.equal(gate.calls.length, 2, 'one retry, the second click lands on a read in flight');
    assert.equal(s.view('swap-high').state, 'loading');
    gate.calls[1]!.resolve(ready());
    await tick();
    s.reread('swap-high');
    assert.equal(gate.calls.length, 3);
    assert.equal(s.view('swap-high').state, 'loading');
    gate.calls[2]!.resolve(ready());
    await tick();
    assert.equal(s.view('swap-high').state, 'ready');
    s.stop();
  });

  test('a failure with no status (the core did not answer) keeps `status: null`', async () => {
    const { s, gate } = machineState();
    s.sync([SWAP_HIGH]);
    gate.calls[0]!.reject(new Error('network'));
    await tick();
    assert.deepEqual(s.view('swap-high').failure, { status: null });
    s.stop();
  });

  test('the reader may say closed or unsupported: they are states, not failures', async () => {
    const { s, gate } = machineState();
    s.sync([SWAP_HIGH, LOAD_HIGH]);
    gate.calls[0]!.resolve({ state: 'closed' });
    await tick();
    assert.equal(s.view('swap-high').state, 'closed');
    s.toggle('load-high');
    gate.calls[1]!.resolve({ state: 'unsupported' });
    await tick();
    assert.equal(s.view('load-high').state, 'unsupported');
    assert.equal(s.view('load-high').failure, null);
    s.stop();
  });

  test('past the 20 s cap the read is aborted and the panel fails with no status; a late answer is dropped', async () => {
    const { s, gate } = machineState({ ceilingMs: 25 });
    s.sync([SWAP_HIGH]);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(gate.calls[0]!.signal.aborted, true);
    assert.equal(s.view('swap-high').state, 'failed');
    assert.deepEqual(s.view('swap-high').failure, { status: null });
    gate.calls[0]!.resolve(ready());
    await tick();
    assert.equal(s.view('swap-high').state, 'failed');
    s.retry('swap-high');
    assert.equal(s.view('swap-high').state, 'loading', 'Tentar de novo starts a new wait');
    s.stop();
  });

  test('the cap is 20 s by default', async () => {
    const { READ_CEILING_MS } = await import(
      // @ts-expect-error: browser module, plain JavaScript
      '../../ui/screens/machine-diagnosis-format.js'
    );
    assert.equal(READ_CEILING_MS, 20_000);
    const timers: number[] = [];
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((f: () => void, ms?: number) => (timers.push(ms ?? 0), real(f, ms))) as typeof setTimeout;
    try {
      const { s } = machineState();
      s.sync([SWAP_HIGH]);
      s.stop();
    } finally {
      globalThis.setTimeout = real;
    }
    assert.ok(timers.includes(20_000), 'a 20 s timer was set for the read');
  });

  test('an alert that closes is dropped with its read in flight; a new one that opens when none is on screen opens by itself', async () => {
    const { s, gate } = machineState();
    s.sync([SWAP_HIGH]);
    s.sync([PORT_EXPOSED]);
    assert.equal(gate.calls[0]!.signal.aborted, true);
    assert.equal(s.view('swap-high'), null);
    s.sync([LOAD_HIGH]);
    assert.equal(gate.calls.length, 2);
    assert.equal(s.view('load-high').open, true);
    s.stop();
  });

  test('"Mostrar os 10" is kept per alert and section across syncs', async () => {
    const { s, gate } = machineState();
    s.sync([SWAP_HIGH]);
    gate.calls[0]!.resolve(ready());
    await tick();
    assert.equal(s.view('swap-high').expanded.has('processes-by-rss'), false);
    s.more('swap-high', 'processes-by-rss');
    s.sync([SWAP_HIGH]);
    assert.equal(s.view('swap-high').expanded.has('processes-by-rss'), true);
    s.more('swap-high', 'processes-by-rss');
    assert.equal(s.view('swap-high').expanded.has('processes-by-rss'), false);
    s.stop();
  });

  test('leaving the screen (the signal) aborts every read in flight and nothing changes the screen afterwards', async () => {
    const leave = new AbortController();
    const { s, gate, changes } = machineState({ signal: leave.signal });
    s.sync([SWAP_HIGH]);
    leave.abort();
    assert.equal(gate.calls[0]!.signal.aborted, true);
    gate.calls[0]!.resolve(ready());
    await tick();
    assert.equal(changes(), 0);
    s.toggle('swap-high');
    s.sync([LOAD_HIGH]);
    assert.equal(gate.calls.length, 1, 'a stopped state reads nothing');
  });
});

describe('the Memória card takes the tone of the alert (statCards)', () => {
  const reading = format.normalizeReading({ memory: { totalBytes: 36 * GB, usedBytes: 30 * GB, swapTotalBytes: 8 * GB, swapUsedBytes: 7 * GB }, cpu: { cores: 12, load: { one: 1 } }, disk: { volumes: [] } });
  const memoryCard = (alerts: unknown[]) => format.statCards(reading, { local: true, alerts }).find((c: { id: string }) => c.id === 'memory');
  const a = (kind: string, level: string) => ({ id: kind, kind, level, message: kind });

  test('warn for a warning, bad for an error, the most severe of both, ok without a memory alert', () => {
    assert.equal(memoryCard([]).tone, 'ok');
    assert.equal(memoryCard([a('port-exposed', 'error'), a('load-high', 'error'), a('volume-full', 'error')]).tone, 'ok');
    assert.equal(memoryCard([a('memory-high', 'warning')]).tone, 'warn');
    assert.equal(memoryCard([a('swap-high', 'error')]).tone, 'bad');
    assert.equal(memoryCard([a('memory-high', 'warning'), a('swap-high', 'error')]).tone, 'bad');
  });
});

// ---------- the mounted screen ---------- (#566)

let storage: SqliteStorage;
let service: TelemetryService;

before(async () => {
  storage = openSqliteStorage({ path: ':memory:' });
  const store = new SqliteTelemetryStore(storage.db);
  const tracker = new AlertTracker();
  await seedTelemetry(store, 'local', 'local', NOW, 1);
  await seedTelemetry(store, WS.id, 'workstation', NOW, 1);
  await new TelemetrySampler({ machineId: WS.id, collector: new SimulatedCollector('workstation', () => NOW), store, tracker }).sampleOnce();
  const status = { state: 'connected' as const, reason: null, version: TELEMETRY_VERSION };
  const remoteEntry = { id: WS.id, label: WS.label, port: WS.port, state: () => status.state, status: () => status };
  const downStatus = { state: 'unreachable' as const, reason: 'no-response', version: null };
  const downEntry = { id: DOWN.id, label: DOWN.label, port: DOWN.port, state: () => downStatus.state, status: () => downStatus };
  service = new TelemetryService({ store, tracker, machines: [localMachine(), remoteEntry, downEntry], now: () => NOW });
});
after(() => storage.close());

type Answer = (route: URL) => Promise<unknown>;
interface Mounted {
  area: ElementoFalso;
  diagnosisReads: () => URL[];
  signals: AbortSignal[];
  ready: Promise<unknown>;
  /** A telemetry re-read (the 30 s one, or a change): `onRestart` runs `draw()`. (#566) */
  reread: () => Promise<void>;
  setAlerts: (alerts: Alert[]) => void;
  leave: () => void;
}
const open: Mounted[] = [];
afterEach(() => open.splice(0).forEach((m) => m.leave()));

function mount({ machine = 'local', alerts, diagnosis = [] }: { machine?: string; alerts: Alert[]; diagnosis?: Answer[] }): Mounted {
  here.pathname = `/ui/machines/${machine}`;
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const signals: AbortSignal[] = [];
  const leaving = new AbortController();
  const restarts: Array<() => void> = [];
  let current = alerts;
  let cleanup: (() => void) | null = null;
  let answered = 0;
  const coreRead = async (route: string): Promise<unknown> => {
    const url = new URL(route, 'http://127.0.0.1');
    let body: unknown;
    if (url.pathname === '/api/machines') body = await service.machines();
    else if (url.pathname === '/api/attention') body = { total: 0, items: [] };
    else if (url.pathname === '/api/telemetry') {
      const t = await service.telemetry(url.searchParams.get('machine') ?? 'local', Number(url.searchParams.get('hours') ?? 1) as 1 | 12);
      body = t && { ...t, alerts: url.searchParams.get('machine') === machine ? current : [] };
    } else if (url.pathname === '/api/diagnosis') {
      const answer = diagnosis[Math.min(answered++, diagnosis.length - 1)];
      if (!answer) throw new Error(`no diagnosis answer for ${route}`);
      body = await answer(url);
    } else throw new Error(`unexpected route ${route}`);
    return JSON.parse(JSON.stringify(body));
  };
  const ctx = {
    params: { id: machine },
    signal: leaving.signal,
    read: (route: string, options?: { signal?: AbortSignal }) => {
      reads.push(route);
      if (route.startsWith('/api/diagnosis') && options?.signal) signals.push(options.signal);
      return coreRead(route);
    },
    write: async () => {
      throw new Error('issue 566 writes nothing');
    },
    onChange: () => {},
    onRestart: (f: () => void) => void restarts.push(f),
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: () => {},
  };
  const readyP = screen.mount(area, ctx).then((f: () => void) => (cleanup = f));
  const m: Mounted = {
    area,
    diagnosisReads: () => reads.map((r) => new URL(r, 'http://127.0.0.1')).filter((u) => u.pathname === '/api/diagnosis'),
    signals,
    ready: readyP,
    reread: async () => {
      const telemetry = () => reads.filter((r) => r.startsWith('/api/telemetry')).length;
      const before = telemetry();
      restarts.forEach((f) => f());
      await until(() => telemetry() > before);
      await new Promise((r) => setTimeout(r, 40));
    },
    setAlerts: (next) => void (current = next),
    leave: () => (leaving.abort(), cleanup?.()),
  };
  open.push(m);
  return m;
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('did not happen in time');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const deferred = () => {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((res) => (resolve = res));
  return { promise, resolve };
};
const ok = (body: (u: URL) => unknown): Answer => async (u) => body(u);
const fails = (status: number): Answer => async (u) => {
  throw new ReadError(`O núcleo respondeu ${status}`, { status, route: `${u.pathname}${u.search}`, body: {} });
};
const answerMemory = ok((u) => memoryDiagnosis(u.searchParams.get('alert')!));
const panels = (area: ElementoFalso) => area.querySelectorAll('[data-part="diagnosis"]');
const rowOf = (area: ElementoFalso, id: string) => area.querySelector(`[data-alert="${id}"]`)!;
const buttonNamed = (node: ElementoFalso | null, name: string) => (node ? (node.querySelectorAll('button').find((b) => texto(b).includes(name)) ?? null) : null);

describe('the machine screen drives the panels (issue 566)', () => {
  test('#566/AC-2 two saturation alerts: the most severe opens by itself, the other waits behind "Ver diagnóstico" and reads nothing', async () => {
    const m = mount({ alerts: [MEMORY_HIGH, SWAP_HIGH], diagnosis: [answerMemory] });
    await m.ready;
    await until(() => /qemu-system-aarch64/.test(texto(rowOf(m.area, 'swap-high'))));
    assert.deepEqual(m.diagnosisReads().map((u) => u.searchParams.get('alert')), ['swap-high']);
    assert.equal(panels(m.area).length, 1);
    assert.equal(rowOf(m.area, 'swap-high').querySelector('[data-dg-action="toggle"]')!.getAttribute('aria-expanded'), 'true');
    const waiting = rowOf(m.area, 'memory-high');
    assert.equal(panels(waiting).length, 0);
    assert.equal(waiting.querySelector('[data-dg-action="toggle"]')!.getAttribute('aria-expanded'), 'false');
    assert.match(texto(waiting), /Ver diagnóstico/);
  });

  test('#566/AC-2 "Ver diagnóstico" on the other alert reads it once and shows it under its own row', async () => {
    const m = mount({ alerts: [MEMORY_HIGH, SWAP_HIGH], diagnosis: [answerMemory] });
    await m.ready;
    await until(() => m.diagnosisReads().length === 1);
    buttonNamed(rowOf(m.area, 'memory-high'), 'Ver diagnóstico')!.click();
    await until(() => m.diagnosisReads().length === 2);
    assert.equal(m.diagnosisReads()[1]!.searchParams.get('alert'), 'memory-high');
    await until(() => panels(rowOf(m.area, 'memory-high')).length === 1 && /qemu-system-aarch64/.test(texto(rowOf(m.area, 'memory-high'))));
    assert.equal(panels(m.area).length, 2, 'both stay open: one does not close the other');
  });

  test('#566/AC-2 the open panel survives the telemetry re-reads and does not read the diagnosis again', async () => {
    const m = mount({ alerts: [SWAP_HIGH], diagnosis: [answerMemory] });
    await m.ready;
    await until(() => /qemu-system-aarch64/.test(texto(m.area)));
    await m.reread();
    await m.reread();
    assert.equal(panels(m.area).length, 1);
    assert.match(texto(m.area), /qemu-system-aarch64/);
    assert.equal(m.diagnosisReads().length, 1, 'no automatic refresh');
  });

  test('#566/AC-2 a closed panel stays closed through a re-read, and opening it again reads again', async () => {
    const m = mount({ alerts: [SWAP_HIGH], diagnosis: [answerMemory] });
    await m.ready;
    await until(() => /qemu-system-aarch64/.test(texto(m.area)));
    rowOf(m.area, 'swap-high').querySelector('[data-dg-action="toggle"]')!.click();
    assert.equal(panels(m.area).length, 0);
    assert.equal(rowOf(m.area, 'swap-high').querySelector('[data-dg-action="toggle"]')!.getAttribute('aria-expanded'), 'false');
    await m.reread();
    assert.equal(panels(m.area).length, 0, 'the re-read does not open what the person closed');
    assert.equal(m.diagnosisReads().length, 1);
    buttonNamed(rowOf(m.area, 'swap-high'), 'Ver diagnóstico')!.click();
    await until(() => m.diagnosisReads().length === 2);
    await until(() => /qemu-system-aarch64/.test(texto(m.area)));
  });

  test('#566/AC-3 "Ler de novo" reads once more, and the panel goes through "Carregando diagnóstico" again', async () => {
    const gate = deferred();
    const m = mount({ alerts: [SWAP_HIGH], diagnosis: [answerMemory, () => gate.promise] });
    await m.ready;
    await until(() => /qemu-system-aarch64/.test(texto(m.area)));
    buttonNamed(panels(m.area)[0]!, 'Ler de novo')!.click();
    await until(() => /Carregando diagnóstico/.test(texto(m.area)));
    assert.equal(m.diagnosisReads().length, 2);
    gate.resolve(memoryDiagnosis('swap-high'));
    await until(() => /qemu-system-aarch64/.test(texto(m.area)));
    assert.equal(m.diagnosisReads().length, 2);
  });

  test('#566/AC-3 "Tentar de novo" after a failure reads once and a second failure shows the failure again', async () => {
    const m = mount({ alerts: [SWAP_HIGH], diagnosis: [fails(500), fails(500)] });
    await m.ready;
    await until(() => /Não deu para diagnosticar/.test(texto(m.area)));
    assert.match(texto(panels(m.area)[0]), /GET \/api\/diagnosis · erro 500/);
    buttonNamed(panels(m.area)[0]!, 'Tentar de novo')!.click();
    await until(() => m.diagnosisReads().length === 2);
    await until(() => /Não deu para diagnosticar/.test(texto(m.area)));
    assert.equal(m.diagnosisReads().length, 2);
  });

  test('#566/AC-3 the diagnosis read is passed an abort signal, and leaving the screen aborts a read still in flight', async () => {
    const gate = deferred();
    const m = mount({ alerts: [SWAP_HIGH], diagnosis: [() => gate.promise] });
    await m.ready;
    await until(() => m.signals.length === 1);
    assert.equal(m.signals[0]!.aborted, false);
    m.leave();
    assert.equal(m.signals[0]!.aborted, true);
    gate.resolve(memoryDiagnosis('swap-high'));
  });

  test('#566/AC-3 closing the panel aborts the read in flight', async () => {
    const gate = deferred();
    const m = mount({ alerts: [SWAP_HIGH], diagnosis: [() => gate.promise] });
    await m.ready;
    await until(() => /Carregando diagnóstico/.test(texto(m.area)));
    rowOf(m.area, 'swap-high').querySelector('[data-dg-action="toggle"]')!.click();
    assert.equal(m.signals[0]!.aborted, true);
    assert.equal(panels(m.area).length, 0);
    gate.resolve(memoryDiagnosis('swap-high'));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(panels(m.area).length, 0, 'a late answer does not reopen it');
  });

  test('#566/AC-2 the cause names the Workstation by its label, and this machine by its system', async () => {
    const ws = mount({ machine: WS.id, alerts: [alert('swap-high', 'swap-high', 'error')], diagnosis: [answerMemory] });
    await ws.ready;
    await until(() => /Resolver/.test(texto(ws.area)));
    assert.doesNotMatch(texto(panels(ws.area)[0]), /o Mac/);
    const local = mount({ alerts: [SWAP_HIGH], diagnosis: [answerMemory] });
    await local.ready;
    await until(() => /Resolver/.test(texto(local.area)));
    assert.match(texto(panels(local.area)[0]), /o Mac|esta máquina/);
  });

  test('#566/AC-4 the Memória card is yellow for a warning and red for an error, before the diagnosis arrives', async () => {
    const gate = deferred();
    const warning = mount({ alerts: [MEMORY_HIGH], diagnosis: [() => gate.promise] });
    await warning.ready;
    const card = warning.area.querySelector('[data-card="memory"]')!;
    assert.ok(card.classList.contains('tm-warn') && !card.classList.contains('tm-bad'));
    assert.ok(!warning.area.querySelector('[data-card="disk"]')!.classList.contains('tm-warn'), 'only Memória takes the new tone');
    const red = mount({ alerts: [SWAP_HIGH, MEMORY_HIGH], diagnosis: [() => gate.promise] });
    await red.ready;
    const redCard = red.area.querySelector('[data-card="memory"]')!;
    assert.ok(redCard.classList.contains('tm-bad') && !redCard.classList.contains('tm-warn'));
    gate.resolve(memoryDiagnosis('x'));
  });

  test('#566/AC-5 the card O que pede atenção takes the whole line only while a saturation alert is open', async () => {
    const calm = mount({ alerts: [PORT_EXPOSED] });
    await calm.ready;
    const plain = calm.area.querySelector('[data-band="attention"]')!;
    assert.ok(plain.classList.contains('tm-band-half'), 'as today: half a line, beside Processos do Claude');
    const gate = deferred();
    const busy = mount({ alerts: [VOLUME_FULL, PORT_EXPOSED], diagnosis: [() => gate.promise] });
    await busy.ready;
    const wide = busy.area.querySelector('[data-band="attention"]')!;
    assert.ok(wide.classList.contains('tm-band-stack'), 'the attention band is two lines');
    assert.ok(wide.querySelector('.tm-band-single [data-part="alerts"]'), 'the alerts card is alone on the first, whole line');
    assert.ok(wide.querySelector('.tm-band-half [data-part="claude"]'), 'Processos do Claude is on the line below');
    gate.resolve(memoryDiagnosis('x'));
  });

  test('a repaint keeps the focus on the same button of the same alert', async () => {
    const m = mount({ alerts: [SWAP_HIGH, MEMORY_HIGH], diagnosis: [answerMemory] });
    await m.ready;
    await until(() => /qemu-system-aarch64/.test(texto(m.area)));
    const toggle = rowOf(m.area, 'memory-high').querySelector('[data-dg-action="toggle"]')!;
    toggle.focus();
    await m.reread();
    const after = documentoFalso.activeElement;
    assert.ok(after && after !== toggle, 'the button was rebuilt');
    assert.equal(after.getAttribute('data-dg-action'), 'toggle');
    assert.equal(after.closest('[data-alert]')!.getAttribute('data-alert'), 'memory-high');
  });

  test('a repaint keeps the focus when the alert id carries a quote and a backslash (a mount named so)', async () => {
    const odd = alert('volume-full:/Volumes/Da"ta\\x', 'volume-full', 'error', 60);
    const m = mount({ alerts: [odd], diagnosis: [answerMemory] });
    await m.ready;
    const rowFor = () => m.area.querySelectorAll('li').find((li) => li.getAttribute('data-alert') === odd.id)!;
    const toggle = rowFor().querySelector('[data-dg-action="toggle"]')!;
    toggle.focus();
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => void rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      await m.reread();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    assert.deepEqual(rejections, [], 'the repaint throws nothing');
    const after = documentoFalso.activeElement;
    assert.ok(after && after !== toggle, 'the button was rebuilt');
    assert.equal(after.getAttribute('data-dg-action'), 'toggle');
    assert.equal(after.closest('[data-alert]')!.getAttribute('data-alert'), odd.id);
  });

  test('a repaint keeps the focus when the mount has a dot in its name (the selector must not read it as a class)', async () => {
    const dotted = alert('volume-full:/Volumes/My.Drive', 'volume-full', 'error', 60);
    const m = mount({ alerts: [dotted], diagnosis: [answerMemory] });
    await m.ready;
    const toggle = m.area.querySelectorAll('li').find((li) => li.getAttribute('data-alert') === dotted.id)!.querySelector('[data-dg-action="toggle"]')!;
    toggle.focus();
    await m.reread();
    const after = documentoFalso.activeElement;
    assert.ok(after && after !== toggle, 'the button was rebuilt');
    assert.equal(after.getAttribute('data-dg-action'), 'toggle');
    assert.equal(after.closest('[data-alert]')!.getAttribute('data-alert'), dotted.id);
  });

  test('#566/AC-5 a remote with no reading and no alerts card on screen reads no diagnosis, whatever its alerts', async () => {
    const m = mount({ machine: DOWN.id, alerts: [SWAP_HIGH, VOLUME_FULL], diagnosis: [answerMemory] });
    await m.ready;
    await m.reread();
    assert.equal(m.area.querySelector('[data-part="alerts"]'), null, 'no alerts card is drawn: there is no body');
    assert.deepEqual(m.diagnosisReads(), []);
    assert.equal(panels(m.area).length, 0);
  });

  test('#566/AC-5 a screen with no saturation alert reads no diagnosis and draws no panel', async () => {
    const m = mount({ alerts: [PORT_EXPOSED] });
    await m.ready;
    await m.reread();
    assert.deepEqual(m.diagnosisReads(), []);
    assert.equal(panels(m.area).length, 0);
    assert.equal(buttonNamed(m.area, 'Ver diagnóstico'), null);
  });

  test('#566/AC-2 an alert that closes between two re-reads takes its panel with it', async () => {
    const m = mount({ alerts: [SWAP_HIGH, PORT_EXPOSED], diagnosis: [answerMemory] });
    await m.ready;
    await until(() => /qemu-system-aarch64/.test(texto(m.area)));
    m.setAlerts([PORT_EXPOSED]);
    await m.reread();
    assert.equal(panels(m.area).length, 0);
    assert.equal(m.diagnosisReads().length, 1);
  });
});
