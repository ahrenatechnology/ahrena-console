import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnavailablePeerVerifier } from './unavailable-peer-verifier.ts';

test('the layer 1 verifier never matches a peer', async () => {
  assert.equal(await new UnavailablePeerVerifier().verify(3), 'unavailable');
});
