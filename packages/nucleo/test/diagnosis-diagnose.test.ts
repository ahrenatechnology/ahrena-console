// The diagnosis use case (#565): ports are doubles (tracker, collector, clock); no IO.
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { diagnose, type CollectContext, type DiagnoseDeps, type SectionCollector } from '../src/diagnosis/diagnose.ts';
import type { ProcessItem, SectionId } from '../src/diagnosis/model.ts';
import type { Alert, AlertKind } from '../src/telemetry/model.ts';

const NOW = '2026-11-14T12:00:00.000Z';
const alert = (id: string, kind: AlertKind): Alert => ({ id, kind, level: 'warning', message: 'm', detail: null, since: NOW });
const proc = (pid: number, rssBytes: number, cpuPct: number): ProcessItem => ({ pid, name: `p${pid}`, rssBytes, cpuPct, startedAt: NOW });

// Tests answer loosely; the port itself is typed per section, so the cast lives here, once.
type LooseCollector = (id: SectionId, context: CollectContext) => Promise<unknown>;
const logged: string[] = [];

function deps(open: Alert[], collector: LooseCollector, over: Partial<DiagnoseDeps> = {}): DiagnoseDeps {
  return {
    alerts: { active: (m) => (m === 'local' ? open : []) },
    isKnownMachine: (m) => m === 'local',
    collect: collector as SectionCollector,
    log: (message) => logged.push(message),
    platform: 'darwin',
    now: () => NOW,
    sectionTimeoutMs: 50,
    ...over,
  };
}
const many = (n: number) => Array.from({ length: n }, (_, i) => proc(i + 1, (i + 1) * 100, (i + 1) % 7));

describe('diagnose', () => {
  beforeEach(() => {
    logged.length = 0;
  });

  test('#565/AC-1 swap-high returns rss and cpu top 10 sorted, swap, and takenAt', async () => {
    const collector: LooseCollector = async (id) => {
      if (id === 'swap') return [{ usedBytes: 5, totalBytes: 10 }];
      return many(15);
    };
    const r = await diagnose({ machine: 'local', alertId: 'swap-high' }, deps([alert('swap-high', 'swap-high')], collector));
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    const d = r.diagnosis;
    assert.deepEqual(d.sections.map((s) => s.id), ['processes-by-rss', 'processes-by-cpu', 'swap']);
    assert.equal(d.takenAt, NOW);
    assert.equal(d.machine, 'local');
    assert.equal(d.alertId, 'swap-high');
    assert.equal(d.kind, 'swap-high');
    const rss = d.sections[0].items as ProcessItem[];
    assert.equal(rss.length, 10);
    assert.deepEqual(rss.map((p) => p.rssBytes), [...rss.map((p) => p.rssBytes)].sort((a, b) => b - a));
    const cpu = d.sections[1].items as ProcessItem[];
    assert.equal(cpu.length, 10);
    assert.deepEqual(cpu.map((p) => p.cpuPct), [...cpu.map((p) => p.cpuPct)].sort((a, b) => b - a));
    assert.deepEqual(d.sections[2].items, [{ usedBytes: 5, totalBytes: 10 }]);
  });

  test('#565/AC-2 load-high collects only processes-by-cpu', async () => {
    const asked: string[] = [];
    const r = await diagnose({ machine: 'local', alertId: 'load-high' }, deps([alert('load-high', 'load-high')], async (id) => (asked.push(id), many(3))));
    assert.deepEqual(asked, ['processes-by-cpu']);
    assert.equal(r.kind, 'ok');
  });

  test('#565/AC-3 volume-full passes the mount of the open alert and adds journal on Linux', async () => {
    const ctxs: CollectContext[] = [];
    const open = [alert('volume-full:/data', 'volume-full')];
    const r = await diagnose({ machine: 'local', alertId: 'volume-full:/data' }, deps(open, async (_id, ctx) => (ctxs.push(ctx), []), { platform: 'linux' }));
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.deepEqual(r.diagnosis.sections.map((s) => s.id), ['largest-folders', 'docker-df', 'known-caches', 'journal']);
    assert.ok(ctxs.every((c) => c.mount === '/data'));
  });

  test('#565/AC-3 known-caches keeps every item, worktrees included', async () => {
    const items = [
      { id: 'npm', path: '/a', bytes: 1, actionId: 'npm-cache' },
      { id: 'worktree', path: '/w', bytes: 2, lastUsedAt: NOW, hasUncommitted: false, hasUnpushed: true, actionId: null },
    ];
    const r = await diagnose({ machine: 'local', alertId: 'volume-full:/' }, deps([alert('volume-full:/', 'volume-full')], async (id) => (id === 'known-caches' ? items : [])));
    assert.equal(r.kind === 'ok' && r.diagnosis.sections[2].items.length, 2);
  });

  test('#565/AC-4 an alert that is not open is reported as such', async () => {
    const r = await diagnose({ machine: 'local', alertId: 'swap-high' }, deps([], async () => []));
    assert.deepEqual(r, { kind: 'alert-not-open' });
  });

  test('#565/AC-4 an unknown machine is reported as such', async () => {
    const r = await diagnose({ machine: 'nope', alertId: 'swap-high' }, deps([alert('swap-high', 'swap-high')], async () => []));
    assert.deepEqual(r, { kind: 'unknown-machine' });
  });

  test('#565/AC-4 an open alert of a kind with no diagnosis is reported as not diagnosable', async () => {
    const r = await diagnose({ machine: 'local', alertId: 'port-exposed:5432' }, deps([alert('port-exposed:5432', 'port-exposed')], async () => []));
    assert.deepEqual(r, { kind: 'not-diagnosable' });
  });

  test('#565/AC-6 an unavailable or throwing collector fails only its section', async () => {
    const collector: LooseCollector = async (id) => {
      if (id === 'processes-by-rss') return { unavailable: true, reason: 'ps missing' };
      if (id === 'processes-by-cpu') throw new Error('boom'.repeat(100));
      return [{ usedBytes: 1, totalBytes: 2 }];
    };
    const r = await diagnose({ machine: 'local', alertId: 'memory-high' }, deps([alert('memory-high', 'memory-high')], collector));
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    const [rss, cpu, swap] = r.diagnosis.sections;
    assert.deepEqual([rss.status, rss.reason, rss.items], ['unavailable', 'ps missing', []]);
    assert.equal(cpu.status, 'unavailable');
    assert.ok((cpu.reason ?? '').length <= 120);
    assert.equal(swap.status, 'ok');
    assert.equal(swap.reason, undefined);
  });

  test('#565/AC-6 a slow collector becomes timeout, the others come, and the timer is cleared', async () => {
    const collector: LooseCollector = (id) => (id === 'processes-by-cpu' ? new Promise(() => {}) : Promise.resolve(many(2)));
    const started = Date.now();
    const r = await diagnose({ machine: 'local', alertId: 'load-high' }, deps([alert('load-high', 'load-high')], collector, { sectionTimeoutMs: 20 }));
    assert.ok(Date.now() - started < 1000);
    assert.equal(r.kind === 'ok' && r.diagnosis.sections[0].status, 'timeout');
    const r2 = await diagnose({ machine: 'local', alertId: 'memory-high' }, deps([alert('memory-high', 'memory-high')], (id) => (id === 'swap' ? new Promise(() => {}) : Promise.resolve(many(2))), { sectionTimeoutMs: 20 }));
    assert.deepEqual(r2.kind === 'ok' && r2.diagnosis.sections.map((s) => s.status), ['ok', 'ok', 'timeout']);
  });

  test('#565/AC-6 sections run in parallel', async () => {
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const started = Date.now();
    await diagnose({ machine: 'local', alertId: 'memory-high' }, deps([alert('memory-high', 'memory-high')], async () => (await delay(40), []), { sectionTimeoutMs: 500 }));
    assert.ok(Date.now() - started < 110);
  });

  test('#565/AC-6 a throwing collector is logged with section, machine and error; unavailable and timeout are not', async () => {
    const collector: LooseCollector = async (id) => {
      if (id === 'processes-by-rss') throw new Error('ps exploded');
      if (id === 'processes-by-cpu') return { unavailable: true, reason: 'no ps' };
      return new Promise(() => {});
    };
    await diagnose({ machine: 'local', alertId: 'memory-high' }, deps([alert('memory-high', 'memory-high')], collector, { sectionTimeoutMs: 20 }));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /processes-by-rss/);
    assert.match(logged[0], /local/);
    assert.match(logged[0], /ps exploded/);
  });

  test('#565/AC-6 the signal of a timed-out section is aborted, and the signal of a finished one too', async () => {
    const signals = new Map<string, AbortSignal>();
    const collector: LooseCollector = (id, ctx) => {
      signals.set(id, ctx.signal);
      assert.equal(ctx.signal.aborted, false);
      return id === 'processes-by-cpu' ? new Promise(() => {}) : Promise.resolve(many(2));
    };
    await diagnose({ machine: 'local', alertId: 'memory-high' }, deps([alert('memory-high', 'memory-high')], collector, { sectionTimeoutMs: 20 }));
    assert.equal(signals.get('processes-by-cpu')?.aborted, true);
    assert.equal(signals.get('processes-by-rss')?.aborted, true);
  });
});
