/* The no-op observer (#661): it runs the work, records nothing and swallows nothing. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { noopObserver } from './port.ts';

describe('noopObserver', () => {
  test('entry runs the work with a fresh correlation id each time', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) await noopObserver.entry({ name: 'GET /x', method: 'GET', route: '/x' }, async (scope) => { ids.push(scope.correlationId); });
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });

  test('adapter returns what the work returns and rethrows what it throws', async () => {
    assert.equal(await noopObserver.adapter({ name: 'x.read' }, async () => 7), 7);
    await assert.rejects(noopObserver.adapter({ name: 'x.read' }, async () => { throw new Error('boom'); }), /boom/);
  });
});
