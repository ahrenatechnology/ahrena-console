// Unit test beside its module (#660): `identity.ts` -> `identity.test.ts`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isLegacyIdentity,
  legacySessionIdentity,
  unknownCapabilities,
  validateCapabilities,
  type SessionCapabilities,
} from './identity.ts';

describe('legacy session identity', () => {
  test('a legacy identity is a claude session with no scope', () => {
    const identity = legacySessionIdentity('abc');
    assert.deepEqual(identity, { provider: 'claude', providerSessionId: 'abc', profileId: null, machineId: null, environmentId: null });
    assert.equal(isLegacyIdentity(identity), true);
  });

  test('a scoped or non-claude identity is not legacy', () => {
    assert.equal(isLegacyIdentity({ ...legacySessionIdentity('abc'), profileId: 'p1' }), false);
    assert.equal(isLegacyIdentity({ ...legacySessionIdentity('abc'), provider: 'codex' }), false);
  });
});

describe('session capabilities', () => {
  test('unknown capabilities are valid and advertise nothing', () => {
    const capabilities = unknownCapabilities();
    assert.equal(capabilities.mode, 'unknown');
    assert.doesNotThrow(() => validateCapabilities(capabilities));
  });

  test('an external session cannot advertise managed controls', () => {
    const capabilities: SessionCapabilities = { ...unknownCapabilities(), mode: 'external', sendInput: 'available' };
    assert.throws(() => validateCapabilities(capabilities), /cannot advertise managed controls/);
  });

  test('a managed session can advertise managed controls', () => {
    const capabilities: SessionCapabilities = { ...unknownCapabilities(), mode: 'managed', sendInput: 'available' };
    assert.doesNotThrow(() => validateCapabilities(capabilities));
  });
});
