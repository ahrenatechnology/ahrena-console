// Liberar uma porta on /ui (issue 286, wireframes C88 to C91): which action each row of "Portas em
// escuta" offers, the line that goes when the port closes, and the confirmation flow against a fake
// núcleo: the preview, SIGTERM, the wait, the second confirmation for SIGKILL, and the refusals.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openRelease } from '../../ui/screens/port-release.js';
import { releaseAction, releaseProblem, releaseRoute, releasePreviewRoute, withoutReleased } from '../../ui/screens/machine-format.js';
import { ElementoFalso, instalarDomFalso, texto } from './fake-dom.ts';

instalarDomFalso();

const row = (o: Record<string, unknown> = {}) => ({ ports: [5432], interface: 'all', address: null, process: 'postgres', pid: 2210, owner: null, ...o });
const wsOk = { status: 'ok', remoteActions: true };

describe('#286 releaseAction: what a row offers', () => {
  test('#286 a user process is released; the tunnel warns; the núcleo, no pid and a container proxy are not', () => {
    assert.deepEqual(releaseAction(row()), { kind: 'release', warn: null });
    assert.deepEqual(releaseAction(row({ process: 'ssh', owner: 'túnel para ws-exemplo' })), { kind: 'release', warn: 'derruba o túnel' });
    assert.deepEqual(releaseAction(row({ owner: 'Núcleo do console' })), { kind: 'off', why: 'é o núcleo do console' });
    assert.deepEqual(releaseAction(row({ ports: [4720], process: 'node' }), { ownPort: 4720 }), { kind: 'off', why: 'é o núcleo do console' });
    assert.deepEqual(releaseAction(row({ pid: null })), { kind: 'off', why: 'o sistema não disse quem escuta' });
    assert.equal(releaseAction(row({ process: 'docker-proxy', pid: null })).kind, 'stack');
  });

  test('#286 on the remote: Liberar only when the núcleo over there takes it; else the command, or off with the reason', () => {
    assert.equal(releaseAction(row(), { remote: wsOk }).kind, 'release');
    assert.deepEqual(releaseAction(row(), { remote: { status: 'ok', remoteActions: false } }), { kind: 'copy', command: 'kill -TERM 2210' });
    assert.deepEqual(releaseAction(row(), { remote: { status: 'unsupported', remoteActions: false } }), { kind: 'off', why: 'o núcleo de lá é de antes desta ação' });
    assert.deepEqual(releaseAction(row(), { remote: { status: 'unreachable', remoteActions: false } }), { kind: 'off', why: 'sem conexão com o núcleo de lá' });
  });

  test('#286 the routes: this machine, and a remote through its id', () => {
    assert.equal(releaseRoute('local'), '/api/ports/release');
    assert.equal(releaseRoute('ws-exemplo'), '/api/machines/ws-exemplo/ports/release');
    assert.equal(releasePreviewRoute('local', 5432, 2210), '/api/ports/release/preview?port=5432&pid=2210');
  });

  test('#286 the line goes when the port closes, and comes back only if a later sample still has it', () => {
    const reading = { takenAt: '2026-10-29T12:00:00Z', ports: [{ port: 5432, pid: 2210 }, { port: 3000, pid: 7741 }] };
    const at = Date.parse('2026-10-29T12:00:10Z');
    const released = new Map([['5432:2210', at]]);
    assert.deepEqual(withoutReleased(reading, released).ports.map((p: { port: number }) => p.port), [3000]);
    assert.equal(withoutReleased({ ...reading, takenAt: '2026-10-29T12:00:30Z' }, released).ports.length, 2);
    assert.equal(withoutReleased(reading, new Map()), reading);
  });

  test('#286 a known reason from the núcleo is worded; anything else is the error message', () => {
    assert.match(releaseProblem({ body: { reason: 'remote-actions-off' } }), /não aceita ações pelo túnel/);
    assert.equal(releaseProblem({ message: 'sem rede' }), 'sem rede');
  });
});

// ---------- the dialog ----------

const flush = () => new Promise((r) => setTimeout(r, 0));
const PREVIEW = { process: 'postgres', pid: 2210, command: 'postgres -D data', ports: [5432], interface: 'all' };
let body: ElementoFalso;

beforeEach(() => {
  body = new ElementoFalso('body');
  Object.assign(document, { body });
});
afterEach(() => Object.assign(document, { body: undefined }));

function boot(opts: { preview?: unknown; previewError?: unknown; writes?: (unknown | Error)[]; machineId?: string; warn?: boolean } = {}) {
  const writes: { route: string; body: unknown }[] = [];
  const reads: string[] = [];
  const navigated: string[] = [];
  const done: unknown[] = [];
  let refreshed = 0;
  const answers = [...(opts.writes ?? [])];
  const ctx = {
    signal: new AbortController().signal,
    read: async (route: string) => {
      reads.push(route);
      if (opts.previewError) throw opts.previewError;
      return opts.preview ?? PREVIEW;
    },
    write: async (route: string, b: unknown) => {
      writes.push({ route, body: b });
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a;
    },
    navigate: (to: string) => navigated.push(to),
  };
  const close = openRelease(ctx, { machineId: opts.machineId ?? 'local', machineLabel: 'Workstation', row: row(), warn: opts.warn ?? false, tunnelMachineId: 'ws-exemplo', onDone: (d: unknown) => done.push(d), onRefresh: () => refreshed++ });
  return { writes, reads, navigated, done, refreshed: () => refreshed, close };
}
const click = (action: string) => body.querySelector(`[data-rp-action="${action}"]`)!.click();
const refusal = (reason: string, extra: object = {}) => Object.assign(new Error(reason), { status: 409, body: { reason, ...extra } });

describe('#286 the release dialog', () => {
  test('#286 preview, confirm, SIGTERM: the port closes, onDone runs and the dialog goes', async () => {
    const t = boot({ writes: [{ result: 'released' }] });
    await flush();
    assert.deepEqual(t.reads, ['/api/ports/release/preview?port=5432&pid=2210']);
    const text = texto(body);
    assert.match(text, /Liberar a porta 5432/);
    assert.match(text, /postgres · pid 2210/);
    assert.match(text, /postgres -D data/);
    click('release');
    await flush();
    assert.deepEqual(t.writes, [{ route: '/api/ports/release', body: { port: 5432, pid: 2210, signal: 'TERM' } }]);
    assert.deepEqual(t.done, [{ port: 5432, pid: 2210, process: 'postgres', signal: 'TERM' }]);
    assert.equal(body.children.length, 0);
  });

  test('#286 a process that stays asks for a second confirmation before SIGKILL', async () => {
    const t = boot({ writes: [{ result: 'still-listening' }, { result: 'released' }] });
    await flush();
    click('release');
    await flush();
    assert.match(texto(body), /não saiu/);
    assert.equal(t.writes.length, 1, 'no SIGKILL without the second click');
    click('kill');
    await flush();
    assert.deepEqual(t.writes.map((w) => (w.body as { signal: string }).signal), ['TERM', 'KILL']);
    assert.equal(t.done.length, 1);
  });

  test('#286 the owner changed: nothing is sent, the new owner is shown and the list can refresh', async () => {
    const t = boot({ previewError: refusal('owner-changed', { now: { process: 'redis-server', pid: 5120 } }) });
    await flush();
    assert.match(texto(body), /A 5432 mudou de dono/);
    assert.match(texto(body), /redis-server · pid 5120/);
    assert.deepEqual(t.writes, []);
    click('refresh');
    assert.equal(t.refreshed(), 1);
  });

  test('#286 a refusal on the release itself shows its reason', async () => {
    const t = boot({ writes: [refusal('other-user')] });
    await flush();
    click('release');
    await flush();
    assert.match(texto(body), /outro usuário e o console não pede senha/);
    assert.equal(t.done.length, 0);
  });

  test('#286 a system process and a KILL with no TERM before it have their own text', async () => {
    for (const [reason, re] of [['system', /processo do sistema/], ['term-first', /só vale depois do pedido normal/]] as const) {
      const t = boot({ writes: [refusal(reason)] });
      await flush();
      click('release');
      await flush();
      assert.match(texto(body), re);
      assert.equal(t.done.length, 0);
    }
  });

  test('#286 the tunnel asks first, and can go to the connection of the machine instead', async () => {
    const t = boot({ warn: true, writes: [{ result: 'released' }] });
    await flush();
    assert.match(texto(body), /Liberar derruba o túnel/);
    assert.equal(t.writes.length, 0);
    click('see-connection');
    assert.deepEqual(t.navigated, ['/ui/machines/ws-exemplo']);
    const again = boot({ warn: true, writes: [{ result: 'released' }] });
    await flush();
    click('continue');
    await flush();
    assert.match(texto(body), /Liberar a porta 5432/);
    click('release');
    await flush();
    assert.equal(again.writes.length, 1);
  });

  test('#286 on a remote machine the confirm says where it runs and the write goes to that machine', async () => {
    const t = boot({ machineId: 'ws-exemplo', writes: [{ result: 'released' }] });
    await flush();
    assert.deepEqual(t.reads, ['/api/machines/ws-exemplo/ports/release/preview?port=5432&pid=2210']);
    assert.match(texto(body), /Na Workstation · pelo núcleo de lá/);
    click('release');
    await flush();
    assert.equal(t.writes[0]!.route, '/api/machines/ws-exemplo/ports/release');
  });

  test('#286 a remote that refuses the tunnel is said plainly', async () => {
    boot({ machineId: 'ws-exemplo', writes: [refusal('remote-actions-off')] });
    await flush();
    click('release');
    await flush();
    assert.match(texto(body), /A Workstation não aceita ações pelo túnel/);
  });
});
