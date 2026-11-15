// The preview store (#567): last preview per machine and alert, bounded, expiring.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createPreviewStore } from '../src/delegation/preview-store.ts';

const entry = (n: number) => ({ prompt: `prompt ${n}`, takenAt: `t${n}` });

describe('preview store', () => {
  test('returns the last preview saved for a machine and alert', () => {
    const store = createPreviewStore();
    store.save('local', 'swap-high', entry(1), 0);
    store.save('local', 'swap-high', entry(2), 1);
    assert.deepEqual(store.find('local', 'swap-high', 2), entry(2));
  });

  test('keeps machines and alerts apart, even when ids share a separator', () => {
    const store = createPreviewStore();
    store.save('a:b', 'c', entry(1), 0);
    store.save('a', 'b:c', entry(2), 0);
    assert.deepEqual(store.find('a:b', 'c', 1), entry(1));
    assert.deepEqual(store.find('a', 'b:c', 1), entry(2));
    assert.equal(store.find('local', 'c', 1), null);
  });

  test('forgets a preview after the time to live', () => {
    const store = createPreviewStore({ ttlMs: 1000 });
    store.save('local', 'x', entry(1), 0);
    assert.deepEqual(store.find('local', 'x', 999), entry(1));
    assert.equal(store.find('local', 'x', 1000), null);
  });

  test('a new save restarts the time to live', () => {
    const store = createPreviewStore({ ttlMs: 1000 });
    store.save('local', 'x', entry(1), 0);
    store.save('local', 'x', entry(2), 900);
    assert.deepEqual(store.find('local', 'x', 1500), entry(2));
  });

  test('evicts the oldest entry past the bound', () => {
    const store = createPreviewStore({ maxEntries: 2 });
    store.save('local', 'a', entry(1), 0);
    store.save('local', 'b', entry(2), 0);
    store.save('local', 'c', entry(3), 0);
    assert.equal(store.find('local', 'a', 1), null);
    assert.deepEqual(store.find('local', 'b', 1), entry(2));
    assert.deepEqual(store.find('local', 'c', 1), entry(3));
  });

  test('re-saving a key makes it the newest, not the oldest', () => {
    const store = createPreviewStore({ maxEntries: 2 });
    store.save('local', 'a', entry(1), 0);
    store.save('local', 'b', entry(2), 0);
    store.save('local', 'a', entry(3), 0);
    store.save('local', 'c', entry(4), 0);
    assert.equal(store.find('local', 'b', 1), null);
    assert.deepEqual(store.find('local', 'a', 1), entry(3));
  });
});
