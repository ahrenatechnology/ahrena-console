import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { migrate, MIGRATIONS } from '../src/adapters/sqlite/migrations.ts';
import { providerSessionKey, providerAccountKey, scopedEntityId, legacySessionIdentity, unknownCapabilities, type SessionIdentity } from '../src/model.ts';
import { describeOpen } from '../src/api/session-open.ts';
import { FeedDeEventos } from '../src/api/events.ts';
import { Accounts } from '../src/api/accounts.ts';
import { pedidoDeSessoes, ListaDeSessoes } from '../src/api/sessions.ts';
import { account, session, event, agent, T0 } from './fixtures.ts';

const uuid = '00000000-0000-4000-8000-000000000001';
const identity = (provider: 'claude' | 'codex', profileId: string | null = null): SessionIdentity => ({ ...legacySessionIdentity(uuid), provider, profileId });

test('identical provider UUIDs are isolated by provider, profile, machine and environment', async () => {
  const store = new SqliteStorage({ path: ':memory:' });
  try {
    const identities = [identity('claude'), identity('codex'), identity('codex', 'work'), { ...identity('codex'), machineId: 'other' }, { ...identity('codex'), environmentId: 'sandbox' }];
    const ids = identities.map((i, n) => n ? providerSessionKey(i) : uuid);
    for (const [n, i] of identities.entries()) {
      const id = ids[n];
      await store.putSession(session({ id, identity: i }));
      await store.appendEvent(event({ id: scopedEntityId(id, 'event', 'same-event'), sessionId: id, agentId: null }));
      await store.putAgent(agent({ id: scopedEntityId(id, 'agent', 'same-agent'), sessionId: id }));
    }
    assert.equal(new Set(ids).size, identities.length);
    for (const [n, i] of identities.entries()) {
      assert.equal((await store.getSessionByIdentity(i))?.id, ids[n]);
      assert.equal((await store.listEvents(ids[n])).items.length, 1);
      assert.equal((await store.listAgents(ids[n])).length, 1);
    }
    assert.equal((await store.listSessions({ provider: 'codex', profileId: null, machineId: null, environmentId: null })).items.length, 1);
    await assert.rejects(store.putSession(session({ id: uuid, identity: identity('codex') })));
    await assert.rejects(store.putSession(session({ id: ids[1] })));
    await assert.rejects(store.appendEvent(event({ sessionId: ids[1] })), /scoped/);
    await assert.rejects(store.putAgent(agent({ sessionId: ids[1] })), /scoped/);
    const updated = (await store.getSession(ids[1]))!;
    await store.putSession({ ...updated, name: 'Updated' });
    assert.equal((await store.listSessions()).items.length, 5);
  } finally { await store.close(); }
});

test('account identities do not collide and unknown account never falls back to Claude environment or Desktop', async () => {
  const store = new SqliteStorage({ path: ':memory:' });
  try {
    const accounts = new Accounts({ storage: store, file: null });
    const claude = account();
    await store.putAccount(claude);
    const i = identity('codex', 'personal');
    const ai = { provider: i.provider, profileId: i.profileId, machineId: null, environmentId: null, providerAccountId: claude.accountUuid, organizationId: claude.organizationUuid };
    const a = account({ id: providerAccountKey(ai), identity: ai, confidence: 'confirmed' });
    await store.putAccount(a);
    assert.equal((await store.listAccounts()).length, 2);
    const s = session({ id: providerSessionKey(i), identity: i });
    await store.putSession(s);
    accounts.reportEnv(s.id, claude.accountUuid, claude.organizationUuid);
    assert.equal(accounts.ofSession(s, { accounts: [claude.id] } as never), null);
    await assert.rejects(store.putSession({ ...s, accountId: claude.id, accountSource: 'transcript' }), /scope/);
    await store.putSession({ ...s, accountId: a.id, accountSource: 'transcript', accountConfidence: 'confirmed' });
    assert.equal((await store.getSession(s.id))?.accountId, a.id);
  } finally { await store.close(); }
});

test('migration 14 preserves IDs, events, links, counts and is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'identity-migration-'));
  const path = join(dir, 'db.sqlite');
  try {
    const db = new DatabaseSync(path);
    migrate(db, MIGRATIONS.filter(m => m.version < 14));
    db.prepare(`INSERT INTO sessions (id,status,started_at,updated_at,account_id,account_source) VALUES (?,?,?,?,?,?)`).run(uuid, 'active', T0, T0, 'a/o', 'transcript');
    db.prepare(`INSERT INTO accounts (id,account_uuid,organization_uuid,first_seen_at,last_seen_at) VALUES ('a/o','a','o',?,?)`).run(T0,T0);
    db.prepare(`INSERT INTO events (id,session_id,type,created_at) VALUES ('event',?,'SessionStart',?)`).run(uuid,T0);
    db.prepare(`INSERT INTO agents (id,session_id,type,status,started_at,updated_at) VALUES ('agent',?,'main','working',?,?)`).run(uuid,T0,T0);
    const before = db.prepare('SELECT * FROM events').all();
    assert.deepEqual(migrate(db), MIGRATIONS.filter(m => m.version >= 14).map(m => m.version));
    assert.deepEqual(migrate(db), []);
    assert.deepEqual(db.prepare('SELECT * FROM events').all(), before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM agents').get()!.n, 1);
    db.close();
    const store = new SqliteStorage({ path });
    try {
      const s = (await store.getSession(uuid))!;
      assert.equal(s.accountId, 'a/o');
      assert.equal(s.accountSource, 'transcript');
      assert.deepEqual(s.identity, legacySessionIdentity(uuid));
      assert.deepEqual(s.capabilities, unknownCapabilities());
      assert.equal(s.accountConfidence, 'unknown');
      assert.equal((await store.getSessionByIdentity(legacySessionIdentity(uuid)))?.id, uuid);
      assert.equal((await store.getAccount('a/o'))?.id, 'a/o');
      await store.putSession({ ...s, name: 'Preserved' });
    } finally { await store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('opening never interprets a foreign provider or profile as a Claude Desktop session', () => {
  const facts = { sessionId: uuid, cwd: '/repo', local: `local_${uuid}`, machine: null, live: true };
  assert.equal(describeOpen(facts).target, 'desktop');
  for (const i of [identity('codex'), identity('claude', 'work')]) {
    assert.deepEqual(describeOpen({ ...facts, identity: i }), { target: 'none', command: null });
    assert.deepEqual(describeOpen({ ...facts, sessionId: providerSessionKey(i) }), { target: 'none', command: null });
  }
});

test('unknown capabilities do not imply managed controls; identity rejects credential fields', async () => {
  const store = new SqliteStorage({ path: ':memory:' });
  try {
    await assert.rejects(store.putSession(session({ capabilities: { ...unknownCapabilities(), mode: 'external', sendInput: 'available' } })));
    await assert.rejects(store.putSession(session({ identity: { ...identity('claude'), accessToken: 'synthetic' } as never })), /Unexpected identity/);
    assert.throws(() => pedidoDeSessoes(new URL('http://localhost/api/sessions?provider=invalid')));
    assert.equal(pedidoDeSessoes(new URL('http://localhost/api/sessions?provider=codex&profileId=personal')).provider, 'codex');
  } finally { await store.close(); }
});


test('session list and feed expose scoped identity; old consumers retain id and existing fields', async () => {
  const store = new SqliteStorage({ path: ':memory:' });
  try {
    const i = identity('codex', 'personal');
    const id = providerSessionKey(i);
    await store.putSession(session({ id, identity: i }));
    await store.putSession(session({ id: uuid }));
    await store.appendEvent(event({ id: scopedEntityId(id, 'event', 'same'), sessionId: id, agentId: null }));
    const list = new ListaDeSessoes({ storage: store, contas: new Accounts({ storage: store, file: null }) });
    const result = await list.listar(pedidoDeSessoes(new URL('http://localhost/api/sessions?provider=codex&profileId=personal')));
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, id);
    assert.deepEqual(result.items[0].identity, i);
    assert.deepEqual(result.items[0].capabilities, unknownCapabilities());
    assert.equal(result.items[0].open.target, 'none');
    const feed = await new FeedDeEventos({ storage: store }).responder(new URLSearchParams({ session: id }));
    assert.equal(feed.status, 200);
    assert.ok('events' in feed.corpo);
    assert.equal(feed.corpo.events[0].session.id, id);
    assert.deepEqual(feed.corpo.events[0].session.identity, i);
  } finally { await store.close(); }
});
