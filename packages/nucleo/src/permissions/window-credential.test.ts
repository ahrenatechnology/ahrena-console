import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWindowCredentialHolder } from './window-credential.ts';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

test('a new holder has no credential', () => {
  assert.equal(createWindowCredentialHolder().current(), null);
});

test('an accepted credential is current', () => {
  const h = createWindowCredentialHolder();
  h.accept(A);
  assert.equal(h.current(), A);
});

test('a second accepted credential replaces the first at once', () => {
  const h = createWindowCredentialHolder();
  h.accept(A);
  h.accept(B);
  assert.equal(h.current(), B);
});

test('revoking clears the credential', () => {
  const h = createWindowCredentialHolder();
  h.accept(A);
  h.revoke();
  assert.equal(h.current(), null);
});

test('the holder never shows the value when printed or serialised', () => {
  const h = createWindowCredentialHolder();
  h.accept(A);
  assert.ok(!JSON.stringify(h).includes(A));
  assert.ok(!String(Object.values(h)).includes(A));
});
