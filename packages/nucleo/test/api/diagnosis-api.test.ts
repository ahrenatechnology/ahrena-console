/*
 * GET /api/diagnosis (#565), through the assembled route on 127.0.0.1: the collectors and the remote
 * núcleo are doubles, the AlertTracker and the use case are the real ones. One scenario per acceptance
 * criterion, named by its token; the contract test at the end checks every status the authored contract
 * (docs/contracts/diagnosis.md) declares is answered by the route, and no other.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { createDiagnosisRoute } from '../../src/api/diagnosis.ts';
import type { CollectContext, SectionCollector } from '../../src/diagnosis/diagnose.ts';
import { SECTION_IDS, SECTION_STATUSES, type SectionId } from '../../src/diagnosis/model.ts';
import { AlertTracker } from '../../src/telemetry/alerts.ts';
import type { Alert, AlertKind } from '../../src/telemetry/model.ts';
import type { RemoteGet, RemoteGetResult } from '../../src/telemetry/ports.ts';
import { OWNER_TOKEN, ownerFetch as fetch } from '../owner-http.ts';

const NOW = '2026-11-14T12:00:00.000Z';
const WORKSTATION_PORT = 14720;
const alert = (id: string, kind: AlertKind): Alert => ({ id, kind, level: 'warning', message: 'm', detail: null, since: NOW });
const proc = (pid: number, rssBytes: number, cpuPct: number) => ({ pid, name: `p${pid}`, rssBytes, cpuPct, startedAt: NOW });
const processes = (n: number) => Array.from({ length: n }, (_, i) => proc(i + 1, (i + 1) * 100, (i + 1) % 9));

/** What each section answers when the test does not say otherwise: one row of each documented shape (AC-9). */
const SECTION_DATA: Record<SectionId, unknown[]> = {
  'processes-by-rss': processes(15),
  'processes-by-cpu': processes(15),
  swap: [{ usedBytes: 5, totalBytes: 10 }],
  'largest-folders': [{ path: '/var/lib', bytes: 900 }],
  'docker-df': [{ type: 'Images', usedBytes: 800, reclaimableBytes: 300 }],
  'known-caches': [
    { id: 'npm', path: '/home/u/.npm', bytes: 50, actionId: 'npm-cache' },
    { id: 'pip', path: '/home/u/.cache/pip', bytes: 40, actionId: 'pip-cache' },
    { id: 'worktree', path: '/home/u/r/.claude/worktrees/old', bytes: 30, lastUsedAt: NOW, hasUncommitted: false, hasUnpushed: true, actionId: null },
  ],
  journal: [{ bytes: 700 }],
};

type Collector = (id: SectionId, context: CollectContext) => Promise<unknown>;
/* The tests answer loosely; the port is typed per section, so the cast to `SectionCollector` lives in `boot`, once (#565). */
const answerAll: Collector = async (id) => SECTION_DATA[id];

/** The statuses the route answered over the whole file; the contract test compares them with the authored contract. */
const answered = new Set<number>();

interface BootOptions {
  collect?: Collector;
  platform?: 'darwin' | 'linux';
  /** `false`: a platform with no collector. */
  withCollector?: boolean;
  /** `false`: the route is not wired at all. */
  wired?: boolean;
  remote?: RemoteGet | null;
  sectionTimeoutMs?: number;
}

async function boot(options: BootOptions = {}) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const tracker = new AlertTracker();
  const logged: string[] = [];
  const diagnosis =
    options.wired === false
      ? null
      : createDiagnosisRoute({
          alerts: tracker,
          local:
            options.withCollector === false
              ? null
              : { collect: (options.collect ?? answerAll) as SectionCollector, platform: options.platform ?? 'darwin', log: (m: string) => logged.push(m), now: () => NOW, sectionTimeoutMs: options.sectionTimeoutMs ?? 100 },
          remote: options.remote ? { port: (id: string) => (id === 'workstation' ? WORKSTATION_PORT : undefined), get: options.remote } : null,
        });
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ ownerToken: () => OWNER_TOKEN, panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, diagnosis });
  return {
    tracker,
    logged,
    get: async (query: string, init: { method?: string } = {}) => {
      const r = await fetch(`${api.url}/api/diagnosis${query}`, init);
      answered.add(r.status);
      return r;
    },
    close: async () => {
      await api.close();
      await storage.close();
    },
  };
}

type Body = { machine: string; alertId: string; kind: string; takenAt: string; sections: Array<{ id: string; status: string; items: Array<Record<string, unknown>>; reason?: string; partial?: unknown }> };
const ok = (r: Response) => r.json() as Promise<Body>;

/** A fake Workstation núcleo: records the paths it was asked and answers as scripted. */
function fakeRemote(answer: RemoteGetResult | ((path: string) => RemoteGetResult)) {
  const asked: Array<{ port: number; path: string }> = [];
  const get: RemoteGet = async (port, path) => {
    asked.push({ port, path });
    return typeof answer === 'function' ? answer(path) : answer;
  };
  return { asked, get };
}
const diagnosisBody = (over: Record<string, unknown> = {}) => ({
  machine: 'local',
  alertId: 'volume-full:/',
  kind: 'volume-full',
  takenAt: NOW,
  sections: [
    { id: 'largest-folders', status: 'ok', items: [{ path: '/var/lib', bytes: 900 }] },
    { id: 'docker-df', status: 'ok', items: [{ type: 'Images', usedBytes: 800, reclaimableBytes: 300 }] },
    { id: 'known-caches', status: 'ok', items: [{ id: 'npm', path: '/home/u/.npm', bytes: 50, actionId: 'npm-cache' }] },
    { id: 'journal', status: 'ok', items: [{ bytes: 700 }] },
  ],
  ...over,
});

describe('#565 GET /api/diagnosis: this machine', () => {
  test('#565/AC-1 Given swap-high is open on this machine, When asked, Then up to 10 processes by RSS and by CPU, the swap and takenAt come back', async () => {
    const { tracker, get, close } = await boot();
    try {
      tracker.update('local', [alert('swap-high', 'swap-high')]);
      const r = await get('?machine=local&alert=swap-high');
      assert.equal(r.status, 200);
      const d = await ok(r);
      assert.equal(d.machine, 'local');
      assert.equal(d.alertId, 'swap-high');
      assert.equal(d.kind, 'swap-high');
      assert.equal(d.takenAt, NOW);
      assert.deepEqual(d.sections.map((s) => s.id), ['processes-by-rss', 'processes-by-cpu', 'swap']);
      assert.equal(d.sections[0]!.items.length, 10);
      assert.equal(d.sections[1]!.items.length, 10);
      assert.deepEqual(d.sections[0]!.items.map((p) => p.rssBytes), [1500, 1400, 1300, 1200, 1100, 1000, 900, 800, 700, 600]);
      assert.deepEqual(d.sections[2]!.items, [{ usedBytes: 5, totalBytes: 10 }]);
    } finally {
      await close();
    }
  });

  test('#565/AC-1 Given memory-high is open, When asked, Then it answers the same three sections', async () => {
    const { tracker, get, close } = await boot();
    try {
      tracker.update('local', [alert('memory-high', 'memory-high')]);
      const d = await ok(await get('?machine=local&alert=memory-high'));
      assert.deepEqual(d.sections.map((s) => s.id), ['processes-by-rss', 'processes-by-cpu', 'swap']);
    } finally {
      await close();
    }
  });

  test('#565/AC-2 Given load-high is open, When asked, Then only up to 10 processes by CPU come back', async () => {
    const { tracker, get, close } = await boot();
    try {
      tracker.update('local', [alert('load-high', 'load-high')]);
      const d = await ok(await get('?machine=local&alert=load-high'));
      assert.deepEqual(d.sections.map((s) => s.id), ['processes-by-cpu']);
      assert.equal(d.sections[0]!.items.length, 10);
    } finally {
      await close();
    }
  });

  test('#565/AC-3 Given volume-full:/ is open on Linux, When asked, Then folders, docker df, known caches and the journal come back, for the mount of the open alert', async () => {
    const mounts: Array<string | null> = [];
    const { tracker, get, close } = await boot({ platform: 'linux', collect: async (id, ctx) => (mounts.push(ctx.mount), SECTION_DATA[id]) });
    try {
      tracker.update('local', [alert('volume-full:/', 'volume-full')]);
      const d = await ok(await get('?machine=local&alert=volume-full%3A%2F'));
      assert.deepEqual(d.sections.map((s) => s.id), ['largest-folders', 'docker-df', 'known-caches', 'journal']);
      assert.ok(mounts.length === 4 && mounts.every((m) => m === '/'));
    } finally {
      await close();
    }
  });

  test('#565/AC-3 Given volume-full:/ is open on macOS, When asked, Then there is no journal section', async () => {
    const { tracker, get, close } = await boot({ platform: 'darwin' });
    try {
      tracker.update('local', [alert('volume-full:/', 'volume-full')]);
      const d = await ok(await get('?machine=local&alert=volume-full%3A%2F'));
      assert.deepEqual(d.sections.map((s) => s.id), ['largest-folders', 'docker-df', 'known-caches']);
    } finally {
      await close();
    }
  });

  test('#565/AC-4 Given the alert is not open, When asked, Then 404 with the reason', async () => {
    const { tracker, get, close } = await boot();
    try {
      tracker.update('local', [alert('load-high', 'load-high')]);
      const r = await get('?machine=local&alert=swap-high');
      assert.equal(r.status, 404);
      const b = (await r.json()) as { error: string; reason: string };
      assert.equal(b.reason, 'alert-not-open');
      assert.ok(b.error.length > 0);
    } finally {
      await close();
    }
  });

  test('#565/AC-4 Given an alert open on another machine, When asked for this one, Then 404: an alert is open on one machine only', async () => {
    const { tracker, get, close } = await boot({ remote: fakeRemote({ kind: 'unreachable', reason: 'port-closed' }).get });
    try {
      tracker.update('workstation', [alert('swap-high', 'swap-high')]);
      const r = await get('?machine=local&alert=swap-high');
      assert.equal(r.status, 404);
      assert.equal(((await r.json()) as { reason: string }).reason, 'alert-not-open');
    } finally {
      await close();
    }
  });

  test('#565/AC-4 Given an unknown machine, When asked, Then 404 with the reason, and nothing is collected', async () => {
    const asked: string[] = [];
    const { tracker, get, close } = await boot({ collect: async (id) => (asked.push(id), SECTION_DATA[id]) });
    try {
      tracker.update('local', [alert('swap-high', 'swap-high')]);
      const r = await get('?machine=nowhere&alert=swap-high');
      assert.equal(r.status, 404);
      assert.equal(((await r.json()) as { reason: string }).reason, 'unknown-machine');
      assert.deepEqual(asked, []);
    } finally {
      await close();
    }
  });

  test('#565/AC-4 Given an open alert of a kind that has no diagnosis, When asked, Then 422 not-diagnosable', async () => {
    const { tracker, get, close } = await boot();
    try {
      tracker.update('local', [alert('port-exposed:5432', 'port-exposed')]);
      const r = await get('?machine=local&alert=port-exposed%3A5432');
      assert.equal(r.status, 422);
      assert.equal(((await r.json()) as { reason: string }).reason, 'not-diagnosable');
    } finally {
      await close();
    }
  });

  test('#565/AC-6 Given a tool is missing, When asked, Then that section is unavailable with a reason and the others still answer', async () => {
    const { tracker, get, close } = await boot({
      platform: 'linux',
      collect: async (id) => (id === 'docker-df' || id === 'journal' ? { unavailable: true, reason: 'docker not installed' } : SECTION_DATA[id]),
    });
    try {
      tracker.update('local', [alert('volume-full:/', 'volume-full')]);
      const r = await get('?machine=local&alert=volume-full%3A%2F');
      assert.equal(r.status, 200);
      const byId = Object.fromEntries((await ok(r)).sections.map((s) => [s.id, s]));
      assert.equal(byId['docker-df']!.status, 'unavailable');
      assert.equal(byId['docker-df']!.reason, 'docker not installed');
      assert.equal(byId['journal']!.status, 'unavailable');
      assert.equal(byId['largest-folders']!.status, 'ok');
      assert.equal(byId['known-caches']!.status, 'ok');
    } finally {
      await close();
    }
  });

  test('#565/AC-6 Given a collection is slower than the limit, When asked, Then that section is timeout and the response is still sent', async () => {
    const { tracker, get, close } = await boot({
      sectionTimeoutMs: 30,
      collect: async (id, ctx) => (id === 'swap' ? new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))) : SECTION_DATA[id]),
    });
    try {
      tracker.update('local', [alert('swap-high', 'swap-high')]);
      const r = await get('?machine=local&alert=swap-high');
      assert.equal(r.status, 200);
      const byId = Object.fromEntries((await ok(r)).sections.map((s) => [s.id, s]));
      assert.equal(byId['swap']!.status, 'timeout');
      assert.deepEqual(byId['swap']!.items, []);
      assert.equal(byId['processes-by-rss']!.status, 'ok');
    } finally {
      await close();
    }
  });

  test('#565/AC-6 Given a section was read only in part, When asked, Then it stays ok and carries the partial marker', async () => {
    const { tracker, get, close } = await boot({
      collect: async (id) => (id === 'largest-folders' ? { items: [{ path: '/a', bytes: 1 }], partial: { reason: 'a folder could not be read' } } : SECTION_DATA[id]),
    });
    try {
      tracker.update('local', [alert('volume-full:/', 'volume-full')]);
      const d = await ok(await get('?machine=local&alert=volume-full%3A%2F'));
      assert.deepEqual(d.sections[0]!.partial, { reason: 'a folder could not be read' });
      assert.equal(d.sections[0]!.status, 'ok');
    } finally {
      await close();
    }
  });

  test('#565/AC-8 Given each diagnosable kind, When asked, Then the section ids are the fixed ones and each status is one of the three', async () => {
    const { tracker, get, close } = await boot({ platform: 'linux' });
    try {
      const seen = new Set<string>();
      for (const [id, kind] of [['load-high', 'load-high'], ['memory-high', 'memory-high'], ['swap-high', 'swap-high'], ['volume-full:/', 'volume-full']] as const) {
        tracker.update('local', [alert(id, kind)]);
        const d = await ok(await get(`?machine=local&alert=${encodeURIComponent(id)}`));
        for (const s of d.sections) {
          seen.add(s.id);
          assert.ok((SECTION_STATUSES as readonly string[]).includes(s.status));
        }
      }
      assert.deepEqual([...seen].sort(), [...SECTION_IDS].sort());
    } finally {
      await close();
    }
  });

  test('#565/AC-9 Given every section answers, When asked, Then each item has the documented keys', async () => {
    const { tracker, get, close } = await boot({ platform: 'linux' });
    try {
      tracker.update('local', [alert('swap-high', 'swap-high')]);
      const swap = await ok(await get('?machine=local&alert=swap-high'));
      assert.deepEqual(Object.keys(swap.sections[0]!.items[0]!).sort(), ['cpuPct', 'name', 'pid', 'rssBytes', 'startedAt']);
      tracker.update('local', [alert('volume-full:/', 'volume-full')]);
      const volume = await ok(await get('?machine=local&alert=volume-full%3A%2F'));
      const byId = Object.fromEntries(volume.sections.map((s) => [s.id, s]));
      assert.deepEqual(Object.keys(byId['largest-folders']!.items[0]!).sort(), ['bytes', 'path']);
      assert.deepEqual(Object.keys(byId['journal']!.items[0]!), ['bytes']);
      const caches = byId['known-caches']!.items;
      assert.deepEqual(Object.keys(caches[0]!).sort(), ['actionId', 'bytes', 'id', 'path']);
      const worktree = caches.find((c) => c.id === 'worktree')!;
      assert.deepEqual(Object.keys(worktree).sort(), ['actionId', 'bytes', 'hasUncommitted', 'hasUnpushed', 'id', 'lastUsedAt', 'path']);
    } finally {
      await close();
    }
  });

  test('#565/AC-9 Given a section did not come back, When asked, Then it may carry a short reason and no items', async () => {
    const { tracker, get, close } = await boot({ collect: async (id) => (id === 'swap' ? { unavailable: true, reason: 'x'.repeat(500) } : SECTION_DATA[id]) });
    try {
      tracker.update('local', [alert('swap-high', 'swap-high')]);
      const swap = (await ok(await get('?machine=local&alert=swap-high'))).sections[2]!;
      assert.equal(swap.status, 'unavailable');
      assert.deepEqual(swap.items, []);
      assert.ok(swap.reason !== undefined && swap.reason.length <= 120);
    } finally {
      await close();
    }
  });

  test('#565/AC-10 Given volume-full:/ is open, When the alert comes encoded once (volume-full%3A%2F), Then the server decodes it once and finds it', async () => {
    const { tracker, get, close } = await boot();
    try {
      tracker.update('local', [alert('volume-full:/', 'volume-full')]);
      const d = await ok(await get('?machine=local&alert=volume-full%3A%2F'));
      assert.equal(d.alertId, 'volume-full:/');
    } finally {
      await close();
    }
  });

  test('#565/AC-10 Given the alert arrives encoded twice, When asked, Then it is decoded once only, so it is not open: 404', async () => {
    const { tracker, get, close } = await boot();
    try {
      tracker.update('local', [alert('volume-full:/', 'volume-full')]);
      assert.equal((await get('?machine=local&alert=volume-full%253A%252F')).status, 404);
      assert.equal((await get('?machine=local&alert=volume-full:/')).status, 200);
    } finally {
      await close();
    }
  });

  test('#565/AC-11 Given known caches, When asked, Then every cache item carries the cleanup actionId of #569', async () => {
    const { tracker, get, close } = await boot({
      collect: async (id) =>
        id === 'known-caches'
          ? [
              { id: 'npm', path: '/a', bytes: 3, actionId: 'npm-cache' },
              { id: 'pip', path: '/b', bytes: 2, actionId: 'pip-cache' },
              { id: 'xcode-derived-data', path: '/c', bytes: 1, actionId: 'xcode-derived-data' },
            ]
          : SECTION_DATA[id],
    });
    try {
      tracker.update('local', [alert('volume-full:/', 'volume-full')]);
      const d = await ok(await get('?machine=local&alert=volume-full%3A%2F'));
      const caches = d.sections.find((s) => s.id === 'known-caches')!.items;
      assert.deepEqual(caches.map((c) => c.actionId), ['npm-cache', 'pip-cache', 'xcode-derived-data']);
    } finally {
      await close();
    }
  });
});

describe('#565 GET /api/diagnosis: the Workstation, through the tunnel', () => {
  test('#565/AC-3 Given volume-full:/ is open on the Workstation, When the Mac core is asked, Then it asks the Workstation core and returns its sections as the Workstation', async () => {
    const remote = fakeRemote({ kind: 'response', status: 200, body: diagnosisBody() });
    const { tracker, get, close } = await boot({ remote: remote.get });
    try {
      tracker.update('workstation', [alert('volume-full:/', 'volume-full')]);
      const r = await get('?machine=workstation&alert=volume-full%3A%2F');
      assert.equal(r.status, 200);
      const d = await ok(r);
      assert.equal(d.machine, 'workstation');
      assert.deepEqual(d.sections.map((s) => s.id), ['largest-folders', 'docker-df', 'known-caches', 'journal']);
      assert.deepEqual(remote.asked, [{ port: WORKSTATION_PORT, path: '/api/diagnosis?machine=local&alert=volume-full%3A%2F' }]);
    } finally {
      await close();
    }
  });

  test('#565/AC-4 Given the alert is not open on the Workstation, When asked, Then 404 and the Workstation is not asked', async () => {
    const remote = fakeRemote({ kind: 'response', status: 200, body: diagnosisBody() });
    const { get, close } = await boot({ remote: remote.get });
    try {
      const r = await get('?machine=workstation&alert=volume-full%3A%2F');
      assert.equal(r.status, 404);
      assert.equal(((await r.json()) as { reason: string }).reason, 'alert-not-open');
      assert.deepEqual(remote.asked, []);
    } finally {
      await close();
    }
  });

  test('#565/AC-5 Given the tunnel is down, When asked, Then 502 saying the machine did not answer', async () => {
    const { tracker, get, close } = await boot({ remote: fakeRemote({ kind: 'unreachable', reason: 'port-closed' }).get });
    try {
      tracker.update('workstation', [alert('swap-high', 'swap-high')]);
      const r = await get('?machine=workstation&alert=swap-high');
      assert.equal(r.status, 502);
      const b = (await r.json()) as { error: string; reason: string };
      assert.equal(b.error, 'a máquina não respondeu');
      assert.equal(b.reason, 'unreachable');
    } finally {
      await close();
    }
  });

  test('#565/AC-5 Given the Workstation core answers something that is not a diagnosis, When asked, Then 502, never the raw body', async () => {
    const { tracker, get, close } = await boot({ remote: fakeRemote({ kind: 'response', status: 200, body: { sections: 'nope', secret: 'x' } }).get });
    try {
      tracker.update('workstation', [alert('swap-high', 'swap-high')]);
      const r = await get('?machine=workstation&alert=swap-high');
      assert.equal(r.status, 502);
      assert.ok(!JSON.stringify(await r.json()).includes('secret'));
    } finally {
      await close();
    }
  });

  test('#565/AC-5 Given the Workstation core closed the alert meanwhile, When asked, Then its 404 comes through as alert-not-open', async () => {
    const { tracker, get, close } = await boot({ remote: fakeRemote({ kind: 'response', status: 404, body: { error: 'o alerta não está aberto', reason: 'alert-not-open' } }).get });
    try {
      tracker.update('workstation', [alert('swap-high', 'swap-high')]);
      const r = await get('?machine=workstation&alert=swap-high');
      assert.equal(r.status, 404);
      assert.equal(((await r.json()) as { reason: string }).reason, 'alert-not-open');
    } finally {
      await close();
    }
  });

  test('#565/AC-12 Given an old Workstation core without the route, When asked, Then 501 diagnosis-unsupported, which is not a failure', async () => {
    const { tracker, get, close } = await boot({ remote: fakeRemote({ kind: 'response', status: 404, body: { error: 'não encontrado' } }).get });
    try {
      tracker.update('workstation', [alert('swap-high', 'swap-high')]);
      const r = await get('?machine=workstation&alert=swap-high');
      assert.equal(r.status, 501);
      assert.deepEqual(await r.json(), { error: 'diagnosis-unsupported' });
    } finally {
      await close();
    }
  });

  test('#565/AC-12 Given the Workstation core itself answers 501 diagnosis-unsupported, When asked, Then the Mac answers the same', async () => {
    const { tracker, get, close } = await boot({ remote: fakeRemote({ kind: 'response', status: 501, body: { error: 'diagnosis-unsupported' } }).get });
    try {
      tracker.update('workstation', [alert('swap-high', 'swap-high')]);
      const r = await get('?machine=workstation&alert=swap-high');
      assert.equal(r.status, 501);
      assert.deepEqual(await r.json(), { error: 'diagnosis-unsupported' });
    } finally {
      await close();
    }
  });

  test('#565/AC-5 Given the Workstation core answers a server error, When asked, Then 502 and not the unsupported answer', async () => {
    const { tracker, get, close } = await boot({ remote: fakeRemote({ kind: 'response', status: 500, body: { error: 'boom' } }).get });
    try {
      tracker.update('workstation', [alert('swap-high', 'swap-high')]);
      assert.equal((await get('?machine=workstation&alert=swap-high')).status, 502);
    } finally {
      await close();
    }
  });
});

describe('#565 GET /api/diagnosis: a core without diagnosis', () => {
  test('#565/AC-12 Given the route is not wired, When asked, Then 501 diagnosis-unsupported', async () => {
    const { get, close } = await boot({ wired: false });
    try {
      const r = await get('?machine=local&alert=swap-high');
      assert.equal(r.status, 501);
      assert.deepEqual(await r.json(), { error: 'diagnosis-unsupported' });
    } finally {
      await close();
    }
  });

  test('#565/AC-12 Given a platform with no collector, When this machine is asked, Then 501 diagnosis-unsupported', async () => {
    const { tracker, get, close } = await boot({ withCollector: false });
    try {
      tracker.update('local', [alert('swap-high', 'swap-high')]);
      const r = await get('?machine=local&alert=swap-high');
      assert.equal(r.status, 501);
      assert.deepEqual(await r.json(), { error: 'diagnosis-unsupported' });
    } finally {
      await close();
    }
  });
});

describe('#565 GET /api/diagnosis: the request', () => {
  test('#565/AC-7 Given a hostile machine or alert, When asked, Then it is refused before any collector runs', async () => {
    const asked: string[] = [];
    const { tracker, get, close } = await boot({ collect: async (id) => (asked.push(id), SECTION_DATA[id]) });
    try {
      tracker.update('local', [alert('volume-full:/', 'volume-full')]);
      for (const q of [
        '?machine=local&alert=volume-full%3A%2F%3B%20rm%20-rf%20%2F',
        '?machine=local&alert=volume-full%3A%2F..%2F..%2Fetc',
        '?machine=local&alert=%24(touch%20x)',
        '?machine=local%3Brm&alert=swap-high',
        '?machine=..%2Fetc&alert=swap-high',
        '?machine=local&alert=%00',
      ]) {
        const r = await get(q);
        assert.ok(r.status === 400 || r.status === 404, `${q} gave ${r.status}`);
      }
      assert.deepEqual(asked, []);
    } finally {
      await close();
    }
  });

  test('#565/AC-7 Given an open volume-full alert, When asked, Then the mount the collector gets is the one of the open alert, never text from the query', async () => {
    const mounts: Array<string | null> = [];
    const { tracker, get, close } = await boot({ collect: async (id, ctx) => (mounts.push(ctx.mount), SECTION_DATA[id]) });
    try {
      tracker.update('local', [alert('volume-full:/data', 'volume-full')]);
      assert.equal((await get('?machine=local&alert=volume-full%3A%2Fdata&mount=%2Fetc')).status, 200);
      assert.ok(mounts.length > 0 && mounts.every((m) => m === '/data'));
    } finally {
      await close();
    }
  });

  test('#565/AC-4 Given a missing, repeated, empty or invalid parameter, When asked, Then 400', async () => {
    const { tracker, get, close } = await boot();
    try {
      tracker.update('local', [alert('swap-high', 'swap-high')]);
      for (const q of ['', '?machine=local', '?alert=swap-high', '?machine=&alert=swap-high', '?machine=local&alert=', '?machine=Local&alert=swap-high', '?machine=local&alert=swap-high&alert=load-high', '?machine=local&machine=local&alert=swap-high', `?machine=local&alert=${'a'.repeat(300)}`]) {
        const r = await get(q);
        assert.equal(r.status, 400, q);
        assert.ok(((await r.json()) as { error: string }).error.length > 0);
      }
    } finally {
      await close();
    }
  });

  test('#565/AC-4 Given a method other than GET, When asked, Then 405', async () => {
    const { get, close } = await boot();
    try {
      assert.equal((await get('?machine=local&alert=swap-high', { method: 'POST' })).status, 405);
    } finally {
      await close();
    }
  });
});

describe('#565 the authored contract', () => {
  test('#565/AC-12 every status docs/contracts/diagnosis.md declares is answered by the route, and the route answers no other', () => {
    const doc = readFileSync(new URL('../../../../docs/contracts/diagnosis.md', import.meta.url), 'utf8');
    const declared = [...doc.matchAll(/^\| `(\d{3})` \|/gm)].map((m) => Number(m[1])).sort();
    assert.ok(declared.length > 0, 'the contract declares no status');
    assert.deepEqual([...answered].sort(), declared);
  });

  test('#565/AC-8 the contract names the same section ids and statuses as the model', () => {
    const doc = readFileSync(new URL('../../../../docs/contracts/diagnosis.md', import.meta.url), 'utf8');
    for (const id of SECTION_IDS) assert.ok(doc.includes(`\`${id}\``), id);
    for (const status of SECTION_STATUSES) assert.ok(doc.includes(`\`${status}\``), status);
  });
});
