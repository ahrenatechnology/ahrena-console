import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteStorage } from '../src/adapters/sqlite/sqlite-storage.ts';
import { providerAccountKey, providerSessionKey, scopedEntityId, legacySessionIdentity, validateClaudeAccount, type ProviderAccount } from '../src/model.ts';
import { account, agent, event, session, T0 } from './fixtures.ts';

const identity = { ...legacySessionIdentity('same-id'), provider: 'codex' as const };
const id = providerSessionKey(identity);
const accountIdentity = { provider: 'codex' as const, providerAccountId: 'person', organizationId: null, profileId: null, machineId: null, environmentId: null };
const codexAccount = (): ProviderAccount => ({ ...account(), id: providerAccountKey(accountIdentity), identity: accountIdentity, accountUuid: 'person', organizationUuid: null });

test('both directions of session/account linkage enforce provider scope', async () => {
  const store = new SqliteStorage({ path: ':memory:' });
  try {
    const a = codexAccount();
    await store.putAccount(a);
    await store.putAccount(account());
    await assert.rejects(store.putSession(session({ accountId: a.id, accountSource: 'transcript' })), /scope/);
    await assert.rejects(store.putSession(session({ id, identity, accountId: account().id, accountSource: 'transcript' })), /scope/);
    await assert.rejects(store.putSession(session({ accountId: 'account:unmaterialized', accountSource: 'transcript' })), /identified/);
    await store.putSession(session({ accountId: 'legacy/unmaterialized', accountSource: 'transcript' }));
    await store.putSession(session({ id, identity, accountId: a.id, accountSource: 'transcript' }));
    assert.equal((await store.getSession(id))?.accountId, a.id);
  } finally { await store.close(); }
});

test('Codex account without organization roundtrips without an invented Claude organization', async () => {
  const store = new SqliteStorage({ path: ':memory:' });
  try {
    const a = codexAccount();
    await store.putAccount(a);
    const restored = (await store.getAccount(a.id))!;
    assert.equal(restored.organizationUuid, null);
    assert.equal(restored.identity?.organizationId, null);
    await store.putAccount(restored);
    assert.throws(() => validateClaudeAccount(a as never), /provider/);
    assert.throws(() => validateClaudeAccount({ ...account(), organizationUuid: null } as never));
    await assert.rejects(store.putAccount({ ...a, accountUuid: 'another-person' }), /differs/);
  } finally { await store.close(); }
});

test('foreign agent references cannot cross session boundaries in either direction', async () => {
  const store = new SqliteStorage({ path: ':memory:' });
  try {
    await store.putSession(session());
    await store.putAgent(agent());
    await store.putSession(session({ id, identity }));
    const ownAgent = scopedEntityId(id, 'agent', 'main');
    await store.putAgent(agent({ id: ownAgent, sessionId: id }));
    await assert.rejects(store.appendEvent(event({ id: scopedEntityId(id, 'event', 'e'), sessionId: id, agentId: 'a1' })), /another session/);
    await assert.rejects(store.appendEvent(event({ agentId: ownAgent })), /another session/);
    await assert.rejects(store.putAgent(agent({ id: scopedEntityId(id, 'agent', 'child'), sessionId: id, parentAgentId: 'a1' })), /another session/);
    await assert.rejects(store.putAgent(agent({ id: 'child', parentAgentId: ownAgent })), /another session/);
    const scopedEvent = event({ id: scopedEntityId(id, 'event', 'valid'), sessionId: id, agentId: ownAgent });
    assert.equal(await store.appendEvent(scopedEvent), true);
    assert.equal(await store.appendEvent(scopedEvent), false);
  } finally { await store.close(); }
});

test('scoped entities require a session and session creation cannot adopt prior raw entities', async () => {
  const store = new SqliteStorage({ path: ':memory:' });
  try {
    await assert.rejects(store.appendEvent(event({ sessionId: id })), /existing session/);
    await assert.rejects(store.putAgent(agent({ sessionId: id })), /existing session/);
    store.db.prepare('INSERT INTO events (id,session_id,type,created_at) VALUES (?,?,?,?)').run('raw', id, 'event', T0);
    await assert.rejects(store.putSession(session({ id, identity })), /orphan/);
    assert.equal(await store.getSession(id), null);
  } finally { await store.close(); }
});

test('new provider metadata rejects explicit nested credential fields without echoing values', async () => {
  const store = new SqliteStorage({ path: ':memory:' });
  try {
    for (const key of ['accessToken', 'refresh_token', 'apiKey', 'authorization', 'password', 'client_secret', 'credentials']) {
      await assert.rejects(store.putSession(session({ id, identity, metadata: { nested: [{ [key]: 'synthetic-sensitive-value' }] } })), e => {
        assert.match(String(e), /Credential fields/);
        assert.doesNotMatch(String(e), /synthetic-sensitive-value/);
        return true;
      });
      await assert.rejects(store.putAccount({ ...codexAccount(), metadata: { [key]: 'synthetic-sensitive-value' } }), /Credential fields/);
    }
    await store.putSession(session({ id, identity, metadata: { tokensUsed: 12, branch: 'main' } }));
    await assert.rejects(store.putAgent(agent({ id: scopedEntityId(id, 'agent', 'main'), sessionId: id, metadata: { nested: [{ api_key: 'synthetic-sensitive-value' }] } })), /Credential fields/);
  } finally { await store.close(); }
});


test('canonical keys with legacy identity still receive scoped metadata and orphan guards', async () => {
  const store = new SqliteStorage({ path: ':memory:' });
  try {
    const legacy = legacySessionIdentity('legacy-scoped');
    const scopedId = providerSessionKey(legacy);
    await assert.rejects(store.putSession(session({ id: scopedId, identity: legacy, metadata: { nested: { accessToken: 'synthetic' } } })), /Credential fields/);
    const a = account();
    const ai = { provider: 'claude' as const, providerAccountId: a.accountUuid, organizationId: a.organizationUuid, profileId: null, machineId: null, environmentId: null };
    await assert.rejects(store.putAccount({ ...a, id: providerAccountKey(ai), identity: ai, metadata: { nested: [{ refresh_token: 'synthetic' }] } }), /Credential fields/);
    store.db.prepare('INSERT INTO agents (id,session_id,type,status,started_at,updated_at) VALUES (?,?,?,?,?,?)').run('raw', scopedId, 'main', 'working', T0, T0);
    await assert.rejects(store.putSession(session({ id: scopedId, identity: legacy })), /orphan/);
    store.db.prepare('DELETE FROM agents WHERE session_id = ?').run(scopedId);
    await store.putSession(session({ id: scopedId, identity: legacy }));
    await assert.rejects(store.putAgent(agent({ id: scopedEntityId(scopedId, 'agent', 'main'), sessionId: scopedId, metadata: { nested: [{ apiKey: 'synthetic' }] } })), /Credential fields/);
  } finally { await store.close(); }
});


test('provider-prefixed and punctuated credentials and raw auth containers never persist', async () => {
  const store = new SqliteStorage({ path: ':memory:' });
  try {
    const a = codexAccount();
    const attempts = [
      { env: { OPENAI_API_KEY: 'synthetic-review-only' } },
      { env: { ANTHROPIC_API_KEY: 'synthetic-review-only' } },
      { nested: [{ OPENAI_API_KEY: 'synthetic-review-only' }] },
      { nested: [{ ANTHROPIC_API_KEY: 'synthetic-review-only' }] },
      { nested: { 'access-token': 'synthetic-review-only' } },
      { nested: { 'refresh.token': 'synthetic-review-only' } },
      { headers: { custom: 'synthetic-review-only' } },
      { authentication: { custom: 'synthetic-review-only' } },
    ];
    for (const metadata of attempts) {
      const noLeak = (error: unknown): boolean => {
        assert.match(String(error), /Credential fields/);
        assert.doesNotMatch(String(error), /synthetic-review-only/);
        return true;
      };
      await assert.rejects(store.putSession(session({ id, identity, metadata })), noLeak);
      await assert.rejects(store.putAccount({ ...a, metadata }), noLeak);
      assert.equal(await store.getSession(id), null);
      assert.equal(await store.getAccount(a.id), null);
    }
    await store.putSession(session({ id, identity }));
    for (const metadata of attempts) {
      const agentId = scopedEntityId(id, 'agent', 'main');
      await assert.rejects(store.putAgent(agent({ id: agentId, sessionId: id, metadata })), /Credential fields/);
      assert.equal(await store.getAgent(agentId), null);
    }
  } finally { await store.close(); }
});
