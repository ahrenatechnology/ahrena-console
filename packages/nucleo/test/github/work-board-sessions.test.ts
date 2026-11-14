/*
 * #465 the live Console sessions linked to work board issues: by the branch, else by the first reference in
 * the first prompt; the repo from the folder's git remote (a fake locator here, no git), lower case.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts } from '../../src/api/index.ts';
import type { DesktopSession } from '../../src/api/desktop-index.ts';
import type { SessionLocation } from '../../src/dev-console/sessions.ts';
import { FleetWorkSessions } from '../../src/github/work-board-sessions.ts';
import { FleetReader } from '../../src/mcp/index.ts';
import type { Session, SessionEvent } from '../../src/model.ts';
import { agent, at, event, session, T0 } from '../fixtures.ts';

let storage: SqliteStorage;
let desktop: Map<string, string>;
let folders: Record<string, SessionLocation>;
let located: string[];

const fleet = () => {
  const index = {
    refresh: async () => {},
    sessionByCli: (id: string): DesktopSession | null =>
      desktop.has(id) ? { localId: `local_${id}`, cliSessionId: id, title: null, branch: desktop.get(id)!, cwd: null, parentLocalId: null, archived: false, accounts: [] } : null,
  };
  return new FleetReader({ storage, accounts: new Accounts({ storage, file: null }), desktop: index as never, now: () => Date.parse(T0), timeZone: 'UTC', cacheMs: 0 });
};
const sessions = () =>
  new FleetWorkSessions({
    fleet: fleet(),
    locate: async (cwd) => {
      located.push(cwd);
      return folders[cwd] ?? { repo: null, branch: null };
    },
  });

async function live(over: Partial<Session>, events: Partial<SessionEvent>[] = []) {
  const s = session({ startedAt: at(-60), updatedAt: at(-1), ...over });
  await storage.putSession(s);
  await storage.putAgent(agent({ id: `${s.id}:main`, sessionId: s.id, status: s.awaitingInputSince ? 'waiting' : 'working' }));
  let i = 0;
  for (const e of events) await storage.appendEvent(event({ sessionId: s.id, id: `${s.id}-e${++i}`, agentId: `${s.id}:main`, createdAt: at(-50 + i), ...e }));
}
const prompt = (text: string): Partial<SessionEvent> => ({ type: 'UserPromptSubmit', toolName: null, summary: 'prompt', data: { prompt: text } });
const PERMISSION: Partial<SessionEvent> = { type: 'Notification', toolName: null, summary: 'Claude needs your permission', data: { notification_type: 'permission_prompt' } };

beforeEach(() => {
  storage = openSqliteStorage({ path: ':memory:' });
  desktop = new Map();
  located = [];
  folders = {
    '/w/board': { repo: 'owner/repo', branch: 'feat/500-board' },
    '/w/main': { repo: 'owner/repo', branch: 'main' },
    '/w/mixed': { repo: 'Owner/Repo', branch: 'main' },
    '/w/claude': { repo: 'owner/repo', branch: 'claude/foo-bar-123456' },
    '/w/release': { repo: 'owner/repo', branch: 'release/2026-11' },
    '/w/norepo': { repo: null, branch: 'feat/500-board' },
  };
});
afterEach(() => storage.close());

const byId = async () => new Map((await sessions().links()).map((l) => [l.sessionId, l]));

describe('#465 sessions linked to work board issues', () => {
  test('the branch links the session to owner/repo#n', async () => {
    await live({ id: 'b', cwd: '/w/board' });
    assert.deepEqual(await sessions().links(), [{ sessionId: 'b', key: 'owner/repo#500', state: 'working', since: at(-60) }]);
  });

  test("the Desktop branch wins over git's", async () => {
    await live({ id: 'b', cwd: '/w/board' });
    desktop.set('b', 'fix/612-desktop');
    assert.equal((await byId()).get('b')?.key, 'owner/repo#612');
  });

  test("without an issue in the branch, the first prompt's reference: #n in the session repo, owner/name#n, or an issues URL", async () => {
    await live({ id: 'bare', cwd: '/w/main' }, [prompt('work on #12 please')]);
    await live({ id: 'other', cwd: '/w/main' }, [prompt('see other/repo#7 first')]);
    await live({ id: 'url', cwd: '/w/main' }, [{ type: 'UserPrompt', toolName: null, summary: null, data: { text: 'from https://github.com/acme/app/issues/31' } }]);
    const links = await byId();
    assert.deepEqual([links.get('bare')?.key, links.get('other')?.key, links.get('url')?.key], ['owner/repo#12', 'other/repo#7', 'acme/app#31']);
  });

  test('only the first reference of the first prompt counts', async () => {
    await live({ id: 'p', cwd: '/w/main' }, [{ type: 'PreToolUse' }, prompt('do #3, then #4'), prompt('now #9')]);
    assert.equal((await byId()).get('p')?.key, 'owner/repo#3');
  });

  test('the first prompt is read once per session; a session with no prompt yet is read again', async () => {
    await live({ id: 'p', cwd: '/w/main' }, [prompt('do #3')]);
    await live({ id: 'later', cwd: '/w/main' });
    const s = sessions();
    const reads: string[] = [];
    const listEvents = storage.listEvents.bind(storage);
    storage.listEvents = async (id, q) => (reads.push(id), listEvents(id, q));
    await s.links();
    await storage.appendEvent(event({ sessionId: 'later', id: 'later-e1', agentId: 'later:main', createdAt: at(-5), ...prompt('fix #8') }));
    const second = new Map((await s.links()).map((l) => [l.sessionId, l.key]));
    assert.deepEqual(reads.sort(), ['later', 'later', 'p']);
    assert.equal(second.get('later'), 'owner/repo#8');
  });

  test('#465 only a `<type>/<n>-…` branch links by number; any other branch falls through to the prompt', async () => {
    await live({ id: 'claude', cwd: '/w/claude' }, [prompt('#7')]);
    await live({ id: 'release', cwd: '/w/release' });
    const links = await byId();
    assert.equal(links.get('claude')?.key, 'owner/repo#7');
    assert.equal(links.has('release'), false);
  });

  test("#465 a Desktop branch without the shape falls through to git's branch", async () => {
    await live({ id: 'b', cwd: '/w/board' });
    desktop.set('b', 'claude/foo-bar-123456');
    assert.equal((await byId()).get('b')?.key, 'owner/repo#500');
  });

  test('#465 a branch number without a repo still reads the prompt, which may name owner/name#n', async () => {
    await live({ id: 'explicit', cwd: '/w/norepo' }, [prompt('see other/repo#7')]);
    await live({ id: 'bare', cwd: '/w/norepo' }, [prompt('see #7')]);
    const links = await byId();
    assert.equal(links.get('explicit')?.key, 'other/repo#7');
    assert.equal(links.has('bare'), false);
  });

  test('#465 a session that left the live list loses its memo: back with the same id, its new first prompt counts', async () => {
    await live({ id: 'p', cwd: '/w/main' }, [prompt('do #3')]);
    const s = sessions();
    assert.equal((await s.links())[0]?.key, 'owner/repo#3');
    await storage.putSession(session({ id: 'p', cwd: '/w/main', status: 'completed', startedAt: at(-60), updatedAt: at(-1), endedAt: at(-1) }));
    assert.deepEqual(await s.links(), []);
    storage.db.prepare('DELETE FROM events WHERE session_id = ?').run('p');
    await live({ id: 'p', cwd: '/w/main' }, [prompt('now #9')]);
    assert.equal((await s.links())[0]?.key, 'owner/repo#9');
  });

  test('#465 the first prompt is looked for in 3 pages at most', async () => {
    await live({ id: 'long', cwd: '/w/main' });
    for (let i = 0; i < 600; i++) await storage.appendEvent(event({ sessionId: 'long', id: `long-${String(i).padStart(4, '0')}`, agentId: 'long:main', createdAt: at(-50) }));
    await storage.appendEvent(event({ sessionId: 'long', id: 'long-9999', agentId: 'long:main', createdAt: at(-40), ...prompt('fix #5') }));
    let calls = 0;
    const listEvents = storage.listEvents.bind(storage);
    storage.listEvents = async (id, q) => (calls++, listEvents(id, q));
    assert.deepEqual(await sessions().links(), []);
    assert.equal(calls, 3);
  });

  test('a session with no issue in the branch or the prompt is not linked', async () => {
    await live({ id: 'none', cwd: '/w/main' }, [prompt('tidy the README')]);
    await live({ id: 'nowhere', cwd: '/w/unknown' }, [prompt('fix #5')]);
    await live({ id: 'nocwd', cwd: null }, [prompt('fix #5')]);
    assert.deepEqual(await sessions().links(), []);
  });

  test('the three states: needs-you when blocked on the person, working while an agent acts, else idle', async () => {
    await live({ id: 'working', cwd: '/w/board' });
    await live({ id: 'blocked', cwd: '/w/board', awaitingInputSince: at(-9), awaitingReason: 'notification' }, [PERMISSION]);
    await live({ id: 'turn', cwd: '/w/board', awaitingInputSince: at(-4), awaitingReason: 'stop' });
    const links = await byId();
    assert.deepEqual(
      ['working', 'blocked', 'turn'].map((id) => [links.get(id)?.state, links.get(id)?.since]),
      [
        ['working', at(-60)],
        ['needs-you', at(-9)],
        ['idle', at(-60)],
      ],
    );
  });

  test('the repo is lower case, so a mixed-case remote links like the board key compares it', async () => {
    await live({ id: 'm', cwd: '/w/mixed' }, [prompt('#21')]);
    assert.equal((await byId()).get('m')?.key, 'owner/repo#21');
  });

  test('a session that is not live is ignored', async () => {
    await live({ id: 'done', cwd: '/w/board', status: 'completed', endedAt: at(-2) });
    assert.deepEqual(await sessions().links(), []);
  });
});

describe('#507/AC-3 the planning session is told apart', () => {
  const PLAN_PROMPT = 'Ahrena Console planning run: Owner/Repo#500\nRun Athena in planning-only mode.';

  test('#507/AC-3 Given a session whose first prompt is the planning run marker, Then it links to that issue and is marked planning', async () => {
    await live({ id: 'p', cwd: '/w/main' }, [prompt(PLAN_PROMPT)]);
    assert.deepEqual(await sessions().links(), [{ sessionId: 'p', key: 'Owner/Repo#500', state: 'working', since: at(-60), planning: true }]);
  });

  test('#507/AC-3 the marker wins over the branch of the folder it started in', async () => {
    await live({ id: 'p', cwd: '/w/board' }, [prompt(PLAN_PROMPT)]);
    const [l] = await sessions().links();
    assert.equal(l!.key, 'Owner/Repo#500');
    assert.equal(l!.planning, true);
  });

  test('#507/AC-3 a session that merely mentions the issue, or a branch session, is not planning', async () => {
    await live({ id: 'm', cwd: '/w/main' }, [prompt('look at owner/repo#500 please')]);
    await live({ id: 'b', cwd: '/w/board' }, [prompt('do the thing')]);
    const links = await sessions().links();
    assert.ok(links.length === 2 && links.every((l) => l.planning === undefined));
  });
});
