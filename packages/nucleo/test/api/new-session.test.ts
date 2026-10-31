// "Nova sessão": `GET /api/new-session/folders` and `POST /api/new-session`, with stubbed launchers: no
// Claude Desktop or terminal is touched. Synthetic sessions only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, DesktopIndex, MontadorDoPainel, startLocalApi, type LocalApi } from '../../src/api/index.ts';
import { desktopNewSessionUrl, isThrowawayFolder, MAX_FOLDERS, newSessionCommand, projectFolder } from '../../src/api/new-session.ts';
import type { TerminalRequest } from '../../src/api/terminal-launch.ts';
import { session } from '../fixtures.ts';

describe('new session', () => {
  test('a worktree folds into its repository', () => {
    assert.equal(projectFolder('/w/app/.claude/worktrees/feat-x'), '/w/app');
    assert.equal(projectFolder('/w/app/.claude/worktrees/feat-x/packages/a'), '/w/app');
    assert.equal(projectFolder('/w/app/packages/a'), '/w/app/packages/a');
    assert.equal(projectFolder('/w/app/.claude/worktrees'), '/w/app/.claude/worktrees');
  });

  test('the throwaway folders are not offered', () => {
    assert.ok(isThrowawayFolder('/Users/x/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-1'));
    assert.ok(isThrowawayFolder('/private/tmp/claude-502/x'));
    assert.ok(isThrowawayFolder('/tmp'));
    assert.ok(isThrowawayFolder('/var/folders/ab/T/x'));
    assert.ok(!isThrowawayFolder('/Users/x/Workspace/app'));
  });

  test('the Desktop address and the command quote the folder', () => {
    assert.equal(desktopNewSessionUrl("/w/it's here"), `claude://code/new?folder=%2Fw%2Fit's%20here`);
    assert.equal(newSessionCommand("/w/it's $(x)"), `cd '/w/it'\\''s $(x)' && claude`);
    assert.equal(newSessionCommand('w/rel'), null);
  });

  describe('the routes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ahrena-new-session-'));
    const app = join(root, "it's $(x) app");
    const other = join(root, 'other');
    let storage: SqliteStorage;
    let api: LocalApi;
    let host: string;
    let desktop: string[];
    let terminal: TerminalRequest[];
    let terminalAnswer: 'opened' | 'unsupported' = 'opened';

    const startApi = (over: Partial<Parameters<typeof startLocalApi>[0]> = {}) => {
      const accounts = new Accounts({ storage, file: null });
      const panelBuilder = new MontadorDoPainel({ storage, contas: accounts, desktop: new DesktopIndex({ root: join(root, 'desktop') }), trabalho: null });
      return startLocalApi({
        panelBuilder,
        hooks: { storage },
        port: 0,
        log: () => {},
        openInDesktop: async (url) => void desktop.push(url),
        openTerminal: async (r) => (terminal.push(r), terminalAnswer),
        // The test folders live under the system's temporary folder, which the list leaves out.
        isThrowawayFolder: () => false,
        ...over,
      });
    };
    const fresh = () => ((desktop = []), (terminal = []));
    const post = (body: unknown, init: RequestInit = {}, base = api) =>
      fetch(`${base.url}/api/new-session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://${new URL(base.url).host}` }, body: JSON.stringify(body), ...init });

    before(async () => {
      mkdirSync(join(app, '.claude', 'worktrees', 'feat'), { recursive: true });
      mkdirSync(other);
      storage = openSqliteStorage({ path: ':memory:' });
      const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
      await storage.putSession(session({ id: '11111111-1111-4111-8111-111111111111', cwd: join(app, '.claude', 'worktrees', 'feat'), updatedAt: at(1) }));
      await storage.putSession(session({ id: '22222222-2222-4222-8222-222222222222', cwd: other, updatedAt: at(2) }));
      await storage.putSession(session({ id: '33333333-3333-4333-8333-333333333333', cwd: app, updatedAt: at(3) }));
      await storage.putSession(session({ id: '44444444-4444-4444-8444-444444444444', cwd: join(root, 'removed'), updatedAt: at(4) }));
      await storage.putSession(session({ id: '55555555-5555-4555-8555-555555555555', cwd: null, updatedAt: at(5) }));
      api = await startApi();
      host = new URL(api.url).host;
    });
    after(async () => {
      await api.close();
      await storage.close();
      rmSync(root, { recursive: true, force: true });
    });

    test('the folders: recent first, a worktree as its repository, once, only the ones that exist', async () => {
      const r = await fetch(`${api.url}/api/new-session/folders`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as { folders: { path: string; name: string }[]; targets: Record<string, boolean> };
      assert.deepEqual(body.folders, [
        { path: app, name: "it's $(x) app" },
        { path: other, name: 'other' },
      ]);
      assert.deepEqual(body.targets, { desktop: true, terminal: true });
      assert.ok(MAX_FOLDERS >= 2);
    });

    test('desktop: a new Code session in the folder', async () => {
      fresh();
      const r = await post({ folder: app, target: 'desktop' });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, opened: 'desktop' });
      assert.deepEqual(desktop, [desktopNewSessionUrl(app)]);
      assert.deepEqual(terminal, []);
    });

    test('terminal: claude in the folder, no session to resume', async () => {
      fresh();
      const r = await post({ folder: other, target: 'terminal' });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, opened: 'terminal' });
      assert.deepEqual(terminal, [{ sessionId: null, cwd: other }]);
    });

    test('no terminal it knows: 501 with the command to copy', async () => {
      fresh();
      terminalAnswer = 'unsupported';
      try {
        const r = await post({ folder: other, target: 'terminal' });
        assert.equal(r.status, 501);
        assert.equal(((await r.json()) as { command: string }).command, newSessionCommand(other));
      } finally {
        terminalAnswer = 'opened';
      }
    });

    test('only a folder of the list, and only desktop or terminal', async () => {
      fresh();
      for (const folder of [join(root, 'removed'), root, '/tmp', 'relative', 42]) assert.ok([400, 422].includes((await post({ folder, target: 'terminal' })).status), String(folder));
      for (const target of ['shell', '', null]) assert.equal((await post({ folder: app, target })).status, 400, String(target));
      assert.deepEqual(desktop, []);
      assert.deepEqual(terminal, []);
    });

    test('another Origin: 403; JSON only; a query: 403', async () => {
      fresh();
      assert.equal((await post({ folder: app, target: 'desktop' }, { headers: { 'content-type': 'application/json', origin: 'http://evil.example' } })).status, 403);
      assert.equal((await post({ folder: app, target: 'desktop' }, { headers: { 'content-type': 'application/json', origin: `http://${host}.example.com` } })).status, 403);
      assert.equal((await post({ folder: app, target: 'desktop' }, { headers: { 'content-type': 'text/plain', origin: `http://${host}` } })).status, 415);
      const q = await fetch(`${api.url}/api/new-session?x=1`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://${host}` }, body: '{}' });
      assert.equal(q.status, 403);
      assert.deepEqual(desktop, []);
    });

    test('without launchers: 501 with the command', async () => {
      const bare = await startApi({ openInDesktop: null, openTerminal: null });
      try {
        const targets = ((await (await fetch(`${bare.url}/api/new-session/folders`)).json()) as { targets: unknown }).targets;
        assert.deepEqual(targets, { desktop: false, terminal: false });
        for (const target of ['desktop', 'terminal']) {
          const r = await post({ folder: app, target }, {}, bare);
          assert.equal(r.status, 501, target);
          assert.equal(((await r.json()) as { command: string }).command, newSessionCommand(app));
        }
      } finally {
        await bare.close();
      }
    });
  });
});
