// LOG-1 (#661): the observer masks sensitive keys before export.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { maskAttributes, REDACTED } from '../../src/observability/masking.ts';

describe('maskAttributes', () => {
  test('a key that names a secret or a personal datum leaves redacted, the others untouched', () => {
    const masked = maskAttributes({ 'http.request.method': 'GET', authorization: 'Bearer abc', 'user.email': 'a@b.c', api_key: 'k', 'http.response.status_code': 200 });
    assert.deepEqual(masked, { 'http.request.method': 'GET', authorization: REDACTED, 'user.email': REDACTED, api_key: REDACTED, 'http.response.status_code': 200 });
  });
});
