// The table behind the remote credentials (decision 0020 section 2, #388): AC4 (eviction, nonce memory, wrong core)
// and the identity a machine proves (AC2: a restart keeps the identity and changes the generation).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { CREDENTIAL_TTL_MS, MAX_LIVE_CREDENTIALS, NONCE_RETENTION_MS, RemoteCredentialStore, machineIdentity } from '../../src/api/remote-credentials.ts';
import { hex } from './remote-credential-fixture.ts';

const mk = (o: ConstructorParameters<typeof RemoteCredentialStore>[0] = {}) => {
  const clock = { now: 1_000_000 };
  return { clock, store: new RemoteCredentialStore({ now: () => clock.now, machineIdentity: 'd'.repeat(64), ...o }) };
};

describe('AC4 · the credential table', () => {
  test('AC4 a credential carries the documented fields: 16-byte id and generation, 32-byte key, 10 minutes', () => {
    const { store, clock } = mk({ uid: 501, corePid: 77 });
    const c = store.issue({ port: 4720 });
    assert.match(c.credentialId, /^[0-9a-f]{32}$/);
    assert.match(store.generation, /^[0-9a-f]{32}$/);
    assert.equal(Buffer.from(c.key, 'base64url').length, 32);
    assert.deepEqual({ uid: c.uid, corePid: c.corePid, corePort: c.corePort, issuedAt: c.issuedAt, expiresAt: c.expiresAt }, { uid: 501, corePid: 77, corePort: 4720, issuedAt: clock.now, expiresAt: clock.now + 600_000 });
    assert.equal(CREDENTIAL_TTL_MS, 600_000);
  });

  test('AC4 at most three live: the fourth issue evicts the oldest, in order', () => {
    const { store } = mk();
    const ids = Array.from({ length: 5 }, () => store.issue({ port: 1 }).credentialId);
    assert.equal(MAX_LIVE_CREDENTIALS, 3);
    assert.equal(store.liveCount(), 3);
    assert.deepEqual(ids.map((id) => store.lookup(id).kind), ['unknown', 'unknown', 'live', 'live', 'live']);
  });

  test('AC4 revoke drops the listed ids before minting, so a revoke frees a slot instead of evicting', () => {
    const { store } = mk();
    const [a, b, c] = [store.issue({ port: 1 }), store.issue({ port: 1 }), store.issue({ port: 1 })];
    const d = store.issue({ port: 1, revoke: [b.credentialId, hex(16)] });
    assert.deepEqual([a, b, c, d].map((x) => store.lookup(x.credentialId).kind), ['live', 'unknown', 'live', 'live']);
  });

  test('AC4 expired is told apart from unknown for one more TTL, then forgotten', () => {
    const { store, clock } = mk();
    const c = store.issue({ port: 1 });
    clock.now += CREDENTIAL_TTL_MS;
    assert.equal(store.lookup(c.credentialId).kind, 'expired');
    assert.equal(store.liveCount(), 0);
    clock.now += CREDENTIAL_TTL_MS;
    store.issue({ port: 1 });
    assert.equal(store.lookup(c.credentialId).kind, 'unknown');
  });

  test('AC4 an expired credential does not count against the three live', () => {
    const { store, clock } = mk();
    const old = store.issue({ port: 1 });
    clock.now += CREDENTIAL_TTL_MS + 1;
    const fresh = [store.issue({ port: 1 }), store.issue({ port: 1 }), store.issue({ port: 1 })];
    assert.equal(store.lookup(old.credentialId).kind, 'expired');
    assert.deepEqual(fresh.map((x) => store.lookup(x.credentialId).kind), ['live', 'live', 'live']);
  });

  test('AC4 a nonce is recorded once, forgotten after its retention, and capped per credential', () => {
    const { store, clock } = mk({ maxNonces: 2 });
    const c = store.issue({ port: 1 });
    const other = store.issue({ port: 1 });
    assert.equal(store.recordNonce(c.credentialId, 'n1'), 'recorded');
    assert.equal(store.recordNonce(c.credentialId, 'n1'), 'replayed');
    assert.equal(store.recordNonce(other.credentialId, 'n1'), 'recorded', 'per credential');
    assert.equal(store.recordNonce(c.credentialId, 'n2'), 'recorded');
    assert.equal(store.recordNonce(c.credentialId, 'n3'), 'full');
    clock.now += NONCE_RETENTION_MS;
    assert.equal(store.recordNonce(c.credentialId, 'n3'), 'recorded');
    assert.equal(store.recordNonce(c.credentialId, 'n1'), 'recorded');
  });

  test('AC4 a table never answers for a credential another table issued', () => {
    const a = mk().store;
    const b = mk().store;
    const c = a.issue({ port: 1 });
    assert.equal(b.lookup(c.credentialId).kind, 'unknown');
    assert.notEqual(a.generation, b.generation);
  });
});

describe('AC2 · generation and identity', () => {
  test('AC2 restart empties the table and changes the generation; the machine identity stays', () => {
    const { store } = mk();
    const c = store.issue({ port: 1 });
    const before = store.generation;
    store.restart();
    assert.equal(store.lookup(c.credentialId).kind, 'unknown');
    assert.notEqual(store.generation, before);
    assert.equal(store.issue({ port: 1 }).machineIdentity, 'd'.repeat(64));
  });

  test('AC2 the machine identity is the SHA-256 of the versioned prefix and the machine id, and is injectable', () => {
    assert.equal(machineIdentity(() => 'abc'), createHash('sha256').update('ahrena-console-machine-v1\nabc').digest('hex'));
    assert.notEqual(machineIdentity(() => 'abc'), machineIdentity(() => 'abd'));
    assert.match(machineIdentity(), /^[0-9a-f]{64}$/);
    assert.equal(machineIdentity(), machineIdentity(), 'stable');
  });
});
