// The read-only ai-memory entry (#726, decision 0014): embedded in the console, no install or update.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ACTION_IDS, CATALOG, catalogEntry } from './catalog.ts';

describe('#719/AC-1 ai-memory catalog entry', () => {
  test('#719/AC-1 #726/AC-1 the entry has no install, update, start or stop action in any source', () => {
    const entry = catalogEntry('ai-memory')!;
    assert.ok(entry, 'ai-memory is in the catalog');
    for (const source of entry.sources) {
      for (const action of ACTION_IDS) assert.equal(source.actions[action], undefined, `${source.id} must not offer ${action}`);
      assert.equal(source.latest, null, 'no latest reader: nothing to update to');
    }
  });

  test('#719/AC-1 #726/AC-1 the only source is the embedded one, and the entry names no package manager or installer', () => {
    const entry = catalogEntry('ai-memory')!;
    assert.deepEqual(entry.sources.map((s) => s.id), ['embedded']);
    assert.ok(entry.sources.every((s) => !s.manager));
    assert.equal(entry.embedded, true);
    assert.deepEqual(entry.probe?.argv, ['ai-memory', '--version']);
    assert.equal(entry.probe?.version.exec('ai-memory 3.5.1')?.[1], '3.5.1');
  });

  test('#719/AC-1 #726/AC-1 ai-memory is the only entry that runs an embedded binary', () => {
    assert.deepEqual(CATALOG.filter((e) => e.embedded).map((e) => e.id), ['ai-memory']);
  });
});
