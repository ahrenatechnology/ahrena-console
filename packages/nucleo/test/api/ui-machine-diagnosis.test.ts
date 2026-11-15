/* End-to-end skeleton of the diagnosis next to a saturation alert (#566, epic #563); wireframe 566-1 to 566-9 in
docs/wireframes/index.html, chapter "Saturou, entendi, resolvi", approved by the design owner on 2026-11-14. It mounts
the machine screen on the fake DOM with the simulator's telemetry, swaps in the open alerts per test, and answers
GET /api/diagnosis here, shaped like docs/contracts/diagnosis.md (issue 565). No network, no process runs.
Every scenario is a `todo` until the layers of issue 566 turn it green; the assertions are the finished behaviour. */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { seedTelemetry, SimulatedCollector } from '../../src/simulator/telemetry.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import { SqliteTelemetryStore } from '../../src/telemetry/adapters/sqlite.ts';
import { TELEMETRY_VERSION, type Alert } from '../../src/telemetry/model.ts';
import { TelemetrySampler } from '../../src/telemetry/sampler.ts';
import { localMachine, TelemetryService } from '../../src/telemetry/service.ts';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const here = { pathname: '/ui/machines/local', search: '', port: '4720' };
Object.assign(globalThis, { location: here, history: { state: null, replaceState: () => {} } });

// @ts-expect-error: browser module, plain JavaScript
import { ReadError } from '../../ui/api.js';
const screen = await import(
  // @ts-expect-error: idem
  '../../ui/screens/machine.js'
);

const TODO = { todo: 'issue 566: the diagnosis panel next to a saturation alert is not built yet' };

const NOW = Date.now();
const WS = { id: 'ws-example', label: 'Workstation', port: 14720 };
const GB = 1024 ** 3;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

// ---------- the open alerts and the diagnoses, as the core serves them ---------- (#566)

const alert = (id: string, kind: Alert['kind'], level: Alert['level'], message: string): Alert => ({ id, kind, level, message, detail: null, since: iso(12 * 60_000) });
const SWAP_HIGH = alert('swap-high', 'swap-high', 'error', 'O swap passou de 90%');
const MEMORY_HIGH = alert('memory-high', 'memory-high', 'warning', 'A memória está alta');
const LOAD_HIGH = alert('load-high', 'load-high', 'error', 'CPU saturada há 12 min');
const VOLUME_FULL = alert('volume-full:/', 'volume-full', 'warning', 'O volume / passou de 85%');
const PORT_EXPOSED = alert('port-exposed:5432', 'port-exposed', 'warning', 'A porta 5432 está aberta para a rede');

const proc = (pid: number, name: string, rssGb: number, cpuPct: number) => ({ pid, name, rssBytes: rssGb * GB, cpuPct, startedAt: iso(3_600_000) });
const memoryDiagnosis = (machine: string, alertId: string) => ({
  machine,
  alertId,
  kind: alertId,
  takenAt: iso(12_000),
  sections: [
    { id: 'processes-by-rss', status: 'ok', items: [proc(4182, 'qemu-system-aarch64', 9.8, 102), proc(7731, 'next-server', 3.2, 56)] },
    { id: 'processes-by-cpu', status: 'ok', items: [proc(4182, 'qemu-system-aarch64', 9.8, 102), proc(7731, 'next-server', 3.2, 56)] },
    { id: 'swap', status: 'ok', items: [{ usedBytes: 7.4 * GB, totalBytes: 8 * GB }] },
  ],
});

// ---------- the simulator's telemetry behind the core's service ---------- (#566)

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
  service = new TelemetryService({ store, tracker, machines: [localMachine(), remoteEntry], now: () => NOW });
});
after(() => storage.close());

/** One answer per GET /api/diagnosis, in order; the last one repeats. (#566) */
type DiagnosisAnswer = (route: URL) => Promise<unknown>;

interface Mounted {
  area: ElementoFalso;
  reads: string[];
  diagnosisReads: () => URL[];
  ready: Promise<unknown>;
  leave: () => void;
}
const open: Mounted[] = [];
afterEach(() => open.splice(0).forEach((m) => m.leave()));

function mount({ machine = 'local', alerts, diagnosis = [] }: { machine?: string; alerts: Alert[]; diagnosis?: DiagnosisAnswer[] }): Mounted {
  here.pathname = `/ui/machines/${machine}`;
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const signal = new AbortController();
  let cleanup: (() => void) | null = null;
  let answered = 0;
  const coreRead = async (route: string): Promise<unknown> => {
    const url = new URL(route, 'http://127.0.0.1');
    let body: unknown;
    if (url.pathname === '/api/machines') body = await service.machines();
    else if (url.pathname === '/api/attention') body = { total: 0, items: [] };
    else if (url.pathname === '/api/telemetry') {
      const t = await service.telemetry(url.searchParams.get('machine') ?? 'local', Number(url.searchParams.get('hours') ?? 1) as 1 | 12);
      body = t && { ...t, alerts: url.searchParams.get('machine') === machine ? alerts : [] };
    } else if (url.pathname === '/api/diagnosis') {
      const answer = diagnosis[Math.min(answered++, diagnosis.length - 1)];
      if (!answer) throw new Error(`no diagnosis answer for ${route}`);
      body = await answer(url);
    } else throw new Error(`unexpected route ${route}`);
    return JSON.parse(JSON.stringify(body));
  };
  const ctx = {
    params: { id: machine },
    signal: signal.signal,
    read: (route: string) => (reads.push(route), coreRead(route)),
    write: async () => {
      throw new Error('issue 566 writes nothing');
    },
    onChange: () => {},
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: () => {},
  };
  const ready = screen.mount(area, ctx).then((f: () => void) => (cleanup = f));
  const diagnosisReads = () => reads.map((r) => new URL(r, 'http://127.0.0.1')).filter((u) => u.pathname === '/api/diagnosis');
  const m: Mounted = { area, reads, diagnosisReads, ready, leave: () => (signal.abort(), cleanup?.()) };
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
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const ok = (body: (u: URL) => unknown): DiagnosisAnswer => async (u) => body(u);
const fails = (status: number, body: Record<string, unknown>): DiagnosisAnswer => async (u) => {
  throw new ReadError(String(body.error ?? `O núcleo respondeu ${status}`), { status, route: `${u.pathname}${u.search}`, body });
};
const panel = (area: ElementoFalso) => area.querySelector('[data-part="diagnosis"]');
const memoryCard = (area: ElementoFalso) => area.querySelector('[data-card="memory"]')!;
const buttonNamed = (node: ElementoFalso | null, name: string) => (node ? node.querySelectorAll('button').find((b) => texto(b).includes(name)) ?? null : null);

describe('the diagnosis next to a saturation alert (issue 566)', () => {
  test('#566/AC-2 an open swap-high reads GET /api/diagnosis and shows the processes by memory and by CPU and the swap', TODO, async () => {
    const m = mount({ alerts: [SWAP_HIGH], diagnosis: [ok((u) => memoryDiagnosis('local', u.searchParams.get('alert')!))] });
    await m.ready;
    await until(() => /Processos por memória/.test(texto(panel(m.area))));
    const [read] = m.diagnosisReads();
    assert.equal(read?.searchParams.get('machine'), 'local');
    assert.equal(read?.searchParams.get('alert'), 'swap-high');
    const text = texto(panel(m.area));
    assert.match(text, /Processos por memória/);
    assert.match(text, /Processos por CPU/);
    assert.match(text, /qemu-system-aarch64/);
    assert.match(text, /Swap/);
    assert.ok(panel(m.area)!.closest('[data-part="alerts"]'), 'the panel lives in the card O que pede atenção');
  });

  test('#566/AC-2 a volume-full on the Workstation asks the route for that machine and alert, URL-encoded', TODO, async () => {
    const m = mount({ machine: WS.id, alerts: [VOLUME_FULL], diagnosis: [ok((u) => ({ machine: WS.id, alertId: u.searchParams.get('alert'), kind: 'volume-full', takenAt: iso(5000), sections: [{ id: 'largest-folders', status: 'ok', items: [{ path: '/home/ubuntu/.cache', bytes: 31.4 * GB }] }] }))] });
    await m.ready;
    await until(() => m.diagnosisReads().length > 0);
    assert.match(m.reads.find((r) => r.startsWith('/api/diagnosis'))!, /alert=volume-full%3A%2F/);
    assert.equal(m.diagnosisReads()[0]!.searchParams.get('machine'), WS.id);
    await until(() => /Maiores pastas de \//.test(texto(panel(m.area))));
  });

  test('#566/AC-3 while the diagnosis loads the alert shows "Carregando diagnóstico", then the diagnosis', TODO, async () => {
    const gate = deferred();
    const m = mount({ alerts: [SWAP_HIGH], diagnosis: [() => gate.promise] });
    await m.ready;
    await until(() => /Carregando diagnóstico/.test(texto(panel(m.area))));
    assert.equal(panel(m.area)!.getAttribute('aria-busy'), 'true');
    assert.doesNotMatch(texto(panel(m.area)), /qemu-system-aarch64/);
    gate.resolve(memoryDiagnosis('local', 'swap-high'));
    await until(() => /qemu-system-aarch64/.test(texto(panel(m.area))));
    assert.doesNotMatch(texto(panel(m.area)), /Carregando diagnóstico/);
    assert.notEqual(panel(m.area)!.getAttribute('aria-busy'), 'true');
  });

  test('#566/AC-3 a failed route shows "Não deu para diagnosticar" and "Tentar de novo", which asks again', TODO, async () => {
    const m = mount({ alerts: [SWAP_HIGH], diagnosis: [fails(500, { error: 'O núcleo respondeu 500' }), ok(() => memoryDiagnosis('local', 'swap-high'))] });
    await m.ready;
    await until(() => /Não deu para diagnosticar/.test(texto(panel(m.area))));
    const retry = buttonNamed(panel(m.area), 'Tentar de novo');
    assert.ok(retry, 'the failure offers Tentar de novo');
    assert.equal(m.diagnosisReads().length, 1);
    retry.click();
    await until(() => /qemu-system-aarch64/.test(texto(panel(m.area))));
    assert.equal(m.diagnosisReads().length, 2, 'Tentar de novo asks the route again');
    assert.doesNotMatch(texto(panel(m.area)), /Não deu para diagnosticar/);
  });

  test('#566/AC-3 the Workstation with an old core (501 diagnosis-unsupported) says it does not diagnose yet, with no retry', TODO, async () => {
    const m = mount({ machine: WS.id, alerts: [LOAD_HIGH], diagnosis: [fails(501, { error: 'diagnosis-unsupported' })] });
    await m.ready;
    await until(() => /ainda não faz diagnóstico/.test(texto(panel(m.area))));
    const p = panel(m.area);
    assert.match(texto(p), /O núcleo da Workstation ainda não faz diagnóstico/);
    assert.doesNotMatch(texto(p), /Não deu para diagnosticar/, 'unsupported is not a failure');
    assert.equal(buttonNamed(p, 'Tentar de novo'), null, 'no retry: asking again gives the same answer');
    assert.match(texto(m.area), /CPU saturada há 12 min/, 'the alert itself stays');
  });

  test('#566/AC-4 the Memória card takes the tone of the memory or swap alert level, the most severe one winning', TODO, async () => {
    const answers = [ok((u) => memoryDiagnosis('local', u.searchParams.get('alert')!))];
    const warning = mount({ alerts: [MEMORY_HIGH], diagnosis: answers });
    await warning.ready;
    assert.ok(memoryCard(warning.area).classList.contains('tm-warn'), 'memory-high in warning: yellow');
    assert.ok(!memoryCard(warning.area).classList.contains('tm-bad'));
    warning.leave();

    const error = mount({ alerts: [SWAP_HIGH], diagnosis: answers });
    await error.ready;
    assert.ok(memoryCard(error.area).classList.contains('tm-bad'), 'swap-high in error: red');
    error.leave();

    const both = mount({ alerts: [MEMORY_HIGH, SWAP_HIGH], diagnosis: answers });
    await both.ready;
    assert.ok(memoryCard(both.area).classList.contains('tm-bad'), 'two open: the most severe wins');
    assert.ok(!memoryCard(both.area).classList.contains('tm-warn'));
  });

  test('#566/AC-5 without a saturation alert there is no diagnosis panel and no diagnosis read', TODO, async () => {
    const m = mount({ alerts: [PORT_EXPOSED] });
    await m.ready;
    assert.match(texto(m.area.querySelector('[data-part="alerts"]')), /A porta 5432 está aberta/, 'the screen is mounted, so this is not vacuous');
    assert.equal(panel(m.area), null);
    assert.equal(buttonNamed(m.area, 'Ver diagnóstico'), null);
    assert.deepEqual(m.diagnosisReads(), []);
    const memory = memoryCard(m.area);
    assert.ok(!memory.classList.contains('tm-bad') && !memory.classList.contains('tm-warn'), 'the Memória card stays as today');
    // Proves the panel would exist: the same screen with a saturation alert does read the route. (#566)
    const withAlert = mount({ alerts: [PORT_EXPOSED, SWAP_HIGH], diagnosis: [ok(() => memoryDiagnosis('local', 'swap-high'))] });
    await withAlert.ready;
    await until(() => withAlert.diagnosisReads().length === 1);
    assert.ok(panel(withAlert.area));
  });
});
