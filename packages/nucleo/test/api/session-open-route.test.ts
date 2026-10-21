// #285: "Abrir no Claude Desktop / no terminal / Ir para o terminal". The `open` descriptor on the Detail
// head, the wall cards, the Sessions rows and the attention items, and `POST /api/sessions/<id>/open`,
// with stubbed launchers: no Claude Desktop, terminal or osascript is touched. Synthetic sessions only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  Accounts,
  DesktopIndex,
  LeiturasDoDetalhe,
  ListaDeSessoes,
  MontadorDoPainel,
  startLocalApi,
  type CabecaDoDetalhe,
  type ListaDeSessoesHttp,
  type LocalApi,
  type RespostaDaAtencao,
  type Wall,
} from '../../src/api/index.ts';
import { SessionOpenDescriber, type LiveProcess, type SessionOpen } from '../../src/api/session-open.ts';
import type { FocusResult, TerminalRequest } from '../../src/api/terminal-launch.ts';
import { FleetReader } from '../../src/mcp/index.ts';
import { session } from '../fixtures.ts';

const DESK = '11111111-1111-4111-8111-111111111111';
const TERM = '22222222-2222-4222-8222-222222222222';
const LIVE = '33333333-3333-4333-8333-333333333333';
const NOCWD = '44444444-4444-4444-8444-444444444444';
const GONE = '55555555-5555-4555-8555-555555555555';
const REMOTE = '66666666-6666-4666-8666-666666666666';
const UNKNOWN = '77777777-7777-4777-8777-777777777777';
const LOCAL = 'local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface Launches {
  desktop: string[];
  terminal: TerminalRequest[];
  focus: LiveProcess[];
}

describe('#285 open the session where it runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahrena-open-route-'));
  const work = join(root, "it's $(x) `y` here");
  const liveDir = join(root, 'live');
  let storage: SqliteStorage;
  let api: LocalApi;
  let host: string;
  let launches: Launches;
  let focusAnswer: FocusResult = 'focused';
  let terminalAnswer: 'opened' | 'unsupported' = 'opened';
  const now = Date.now();
  const recent = new Date(now - 3 * 60_000).toISOString();

  const startApi = async (over: Partial<Parameters<typeof startLocalApi>[0]> = {}) => {
    const accounts = new Accounts({ storage, file: null });
    const desktopRoot = join(root, 'desktop');
    const desktop = new DesktopIndex({ root: desktopRoot });
    const live = { refresh: async () => {}, find: (id: string): LiveProcess | null => (id === LIVE ? { pid: 777, sessionId: LIVE, cwd: liveDir, procStart: 'Tue Oct 20 04:00:34 2026' } : null) };
    const describer = new SessionOpenDescriber({ live });
    const panelBuilder = new MontadorDoPainel({ storage, contas: accounts, desktop, trabalho: null });
    return startLocalApi({
      panelBuilder,
      hooks: { storage },
      port: 0,
      log: () => {},
      detail: new LeiturasDoDetalhe({ storage, montador: panelBuilder, open: describer }),
      sessions: new ListaDeSessoes({ storage, contas: accounts, desktop, open: describer }),
      fleet: new FleetReader({ storage, accounts, desktop, timeZone: 'UTC' }),
      remoteAttention: [
        {
          id: 'ws',
          label: 'Workstation',
          attention: () => ({
            items: [{ session: REMOTE, title: 'remota', project: null, account: null, level: 'your-turn', reason: 'your-turn', since: recent, minutes: 3, local: null, machine: null, open: { target: 'terminal', command: 'rm -rf ~' } }],
          }),
        },
      ],
      openDescriber: describer,
      openInDesktop: async (url) => void launches.desktop.push(url),
      openTerminal: async (r) => (launches.terminal.push(r), terminalAnswer),
      focusTerminal: async (p) => (launches.focus.push(p), focusAnswer),
      ...over,
    });
  };

  before(async () => {
    mkdirSync(work);
    mkdirSync(liveDir);
    const org = join(root, 'desktop', 'acct', 'org');
    mkdirSync(org, { recursive: true });
    writeFileSync(join(org, `${LOCAL}.json`), JSON.stringify({ sessionId: LOCAL, cliSessionId: DESK, cwd: work, title: 'No Desktop' }));
    storage = openSqliteStorage({ path: ':memory:' });
    const waiting = { status: 'active' as const, awaitingInputSince: recent, awaitingReason: 'stop' as const, updatedAt: recent, startedAt: recent };
    await storage.putSession(session({ id: DESK, cwd: work, ...waiting }));
    await storage.putSession(session({ id: TERM, cwd: work, ...waiting }));
    await storage.putSession(session({ id: LIVE, cwd: null, ...waiting }));
    await storage.putSession(session({ id: NOCWD, cwd: null, ...waiting }));
    await storage.putSession(session({ id: GONE, cwd: join(root, 'removed'), ...waiting }));
    api = await startApi();
    host = new URL(api.url).host;
  });
  after(async () => {
    await api.close();
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  const resume = (cwd: string, id: string) => `cd '${cwd.replaceAll("'", `'\\''`)}' && claude --resume ${id}`;
  const expected: Record<string, SessionOpen> = {
    [DESK]: { target: 'desktop', command: null },
    [TERM]: { target: 'terminal', command: resume(work, TERM) },
    [LIVE]: { target: 'terminal-live', command: resume(liveDir, LIVE) },
    [NOCWD]: { target: 'none', command: null },
    [GONE]: { target: 'terminal', command: resume(join(root, 'removed'), GONE) },
  };
  const fresh = () => (launches = { desktop: [], terminal: [], focus: [] });
  const post = (id: string, init: RequestInit = {}, suffix = '') =>
    fetch(`${api.url}/api/sessions/${id}/open${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://${host}` }, body: '{}', ...init });

  describe('the open descriptor on every surface', () => {
    test('the Detail head', async () => {
      for (const [id, open] of Object.entries(expected)) {
        const head = (await (await fetch(`${api.url}/api/sessions/${id}`)).json()) as CabecaDoDetalhe;
        assert.deepEqual(head.open, open, id);
      }
    });

    test('the wall cards', async () => {
      const wall = (await (await fetch(`${api.url}/api/wall`)).json()) as Wall;
      for (const [id, open] of Object.entries(expected)) assert.deepEqual(wall.cards.find((c) => c.id === id)?.open, open, id);
    });

    test('the Sessions rows', async () => {
      const list = (await (await fetch(`${api.url}/api/sessions`)).json()) as ListaDeSessoesHttp;
      for (const [id, open] of Object.entries(expected)) assert.deepEqual(list.items.find((r) => r.id === id)?.open, open, id);
    });

    test('the attention items; a remote item is remote, whatever command it brings', async () => {
      const r = (await (await fetch(`${api.url}/api/attention`)).json()) as RespostaDaAtencao;
      for (const [id, open] of Object.entries(expected)) assert.deepEqual(r.items.find((i) => i.session === id && !i.machine)?.open, open, id);
      assert.deepEqual(r.items.find((i) => i.session === REMOTE)?.open, { target: 'remote', command: null });
    });
  });

  describe('POST /api/sessions/<id>/open', () => {
    test('desktop: the claude:// address of its local id', async () => {
      fresh();
      const r = await post(DESK);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, opened: 'desktop' });
      assert.deepEqual(launches.desktop, [`claude://claude.ai/epitaxy/${LOCAL}`]);
    });

    test('terminal: the session id and its own folder, nothing from the request', async () => {
      fresh();
      const r = await post(TERM, { body: JSON.stringify({ cwd: '/etc', sessionId: DESK, command: 'touch x' }) });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, opened: 'terminal' });
      assert.deepEqual(launches.terminal, [{ sessionId: TERM, cwd: work }]);
      assert.deepEqual(launches.desktop, []);
    });

    test('terminal-live: its process brought forward', async () => {
      fresh();
      const r = await post(LIVE);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, opened: 'focused' });
      assert.deepEqual(launches.focus.map((p) => p.pid), [777]);
      assert.deepEqual(launches.terminal, [], 'a live session is never resumed a second time');
    });

    test('terminal-live not found: 409 with the command', async () => {
      fresh();
      focusAnswer = 'not-found';
      try {
        const r = await post(LIVE);
        assert.equal(r.status, 409);
        const body = (await r.json()) as { error: string; command: string };
        assert.match(body.error, /terminal/);
        assert.equal(body.command, expected[LIVE]!.command);
        assert.deepEqual(launches.terminal, [], 'a session that really runs is not resumed a second time');
      } finally {
        focusAnswer = 'focused';
      }
    });

    test('terminal-live whose process is gone (stale pid file): resumes in a new terminal', async () => {
      fresh();
      focusAnswer = 'stale';
      try {
        const r = await post(LIVE);
        assert.equal(r.status, 200);
        assert.deepEqual(await r.json(), { ok: true, opened: 'terminal' });
        assert.deepEqual(launches.terminal, [{ sessionId: LIVE, cwd: liveDir }]);
      } finally {
        focusAnswer = 'focused';
      }
    });

    test('a terminal program missing: 501 with the command', async () => {
      fresh();
      terminalAnswer = 'unsupported';
      try {
        const r = await post(TERM);
        assert.equal(r.status, 501);
        assert.deepEqual(await r.json(), { error: 'Não há um terminal que o console saiba abrir aqui; copie o comando', command: expected[TERM]!.command });
      } finally {
        terminalAnswer = 'opened';
      }
    });

    test('a folder that no longer exists: 422, nothing runs', async () => {
      fresh();
      const r = await post(GONE);
      assert.equal(r.status, 422);
      assert.equal(((await r.json()) as { command: string }).command, expected[GONE]!.command);
      assert.deepEqual(launches.terminal, []);
    });

    test('none: 422; remote: 422 with the reason; unknown: 404', async () => {
      fresh();
      const none = await post(NOCWD);
      assert.equal(none.status, 422);
      const remote = await post(REMOTE);
      assert.equal(remote.status, 422);
      assert.deepEqual(await remote.json(), { error: 'A sessão roda em outra máquina' });
      assert.equal((await post(UNKNOWN)).status, 404);
      assert.deepEqual(launches, { desktop: [], terminal: [], focus: [] });
    });

    test('another Origin: 403; no Origin from this machine is a local request like the other writes', async () => {
      fresh();
      assert.equal((await post(TERM, { headers: { 'content-type': 'application/json', origin: 'https://example.com' } })).status, 403);
      assert.equal((await post(TERM, { headers: { 'content-type': 'application/json', origin: `http://${host}.example.com` } })).status, 403);
      assert.deepEqual(launches.terminal, []);
      assert.equal((await post(TERM, { headers: { 'content-type': 'application/json' } })).status, 200);
    });

    test('not JSON: 415', async () => {
      fresh();
      for (const ct of ['text/plain', 'application/x-www-form-urlencoded', '']) {
        const r = await post(TERM, { headers: { 'content-type': ct, origin: `http://${host}` } });
        assert.equal(r.status, 415, ct);
      }
      assert.deepEqual(launches.terminal, []);
    });

    test('a query: 403, with or without Origin', async () => {
      fresh();
      assert.equal((await post(TERM, {}, '?cwd=/etc')).status, 403);
      assert.equal((await post(TERM, { headers: { 'content-type': 'application/json' } }, '?x=1')).status, 403);
      assert.deepEqual(launches.terminal, []);
    });

    test('a bad id: 403 from the /ui, 400 locally, never a launch', async () => {
      fresh();
      for (const bad of ['sim-panel-current', `${TERM.toUpperCase()}x`, encodeURIComponent(`${TERM};touch x`), '%E0%A4%A', '..']) {
        assert.equal((await post(bad)).status, 403, bad);
        const local = await post(bad, { headers: { 'content-type': 'application/json' } });
        // `..` is normalized away by the client (`/api/open`): not this route at all.
        assert.ok([400, 404, 405].includes(local.status), `${bad}: ${local.status}`);
      }
      assert.deepEqual(launches, { desktop: [], terminal: [], focus: [] });
    });

    test('GET: 405', async () => {
      assert.equal((await fetch(`${api.url}/api/sessions/${TERM}/open`)).status, 405);
    });

    test('without launchers (another platform, the demo): 501 / 409 with the command', async () => {
      const bare = await startApi({ openInDesktop: null, openTerminal: null, focusTerminal: null });
      try {
        const p = (id: string) => fetch(`${bare.url}/api/sessions/${id}/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const desk = await p(DESK);
        assert.equal(desk.status, 501);
        assert.equal(((await desk.json()) as { command: string }).command, resume(work, DESK));
        const term = await p(TERM);
        assert.equal(term.status, 501);
        assert.equal(((await term.json()) as { command: string }).command, expected[TERM]!.command);
        assert.equal((await p(LIVE)).status, 409);
      } finally {
        await bare.close();
      }
    });

    test('a launcher that throws: 502, without the cause on screen', async () => {
      const logs: string[] = [];
      const failing = await startApi({
        log: (m) => void logs.push(m),
        openTerminal: async () => {
          throw Object.assign(new Error(`EACCES ${work}`), { code: 'EACCES' });
        },
      });
      try {
        const r = await fetch(`${failing.url}/api/sessions/${TERM}/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(r.status, 502);
        const body = (await r.json()) as { error: string };
        assert.equal(body.error, 'Não deu para abrir a sessão');
        assert.ok(!JSON.stringify(body).includes(work));
        assert.deepEqual(logs, [`session ${TERM}: opening failed (EACCES)`], 'one English line, without the folder');
      } finally {
        await failing.close();
      }
    });

    test('the old POST /open/<local_…> still opens in the Claude Desktop', async () => {
      fresh();
      const r = await fetch(`${api.url}/open/${LOCAL}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 200);
      assert.deepEqual(launches.desktop, [`claude://claude.ai/epitaxy/${LOCAL}`]);
    });
  });
});
