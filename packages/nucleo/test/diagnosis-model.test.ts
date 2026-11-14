// The diagnosis model (#565): fixed section ids, which sections each alert kind gets, the cap.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CACHE_ACTION_IDS, LIST_CAP, REASON_MAX, SECTION_IDS, capReason, isDiagnosable, sectionsFor } from '../src/diagnosis/model.ts';

describe('diagnosis model', () => {
  test('#565/AC-8 the section ids are fixed', () => {
    assert.deepEqual([...SECTION_IDS], ['processes-by-rss', 'processes-by-cpu', 'swap', 'largest-folders', 'docker-df', 'known-caches', 'journal']);
  });

  test('#565/AC-2 load-high gets only processes-by-cpu', () => {
    assert.deepEqual(sectionsFor('load-high', 'darwin'), ['processes-by-cpu']);
  });

  test('#565/AC-1 memory-high and swap-high get rss, cpu and swap', () => {
    const expected = ['processes-by-rss', 'processes-by-cpu', 'swap'];
    assert.deepEqual(sectionsFor('memory-high', 'darwin'), expected);
    assert.deepEqual(sectionsFor('swap-high', 'linux'), expected);
  });

  test('#565/AC-3 volume-full gets journal only on Linux', () => {
    const base = ['largest-folders', 'docker-df', 'known-caches'];
    assert.deepEqual(sectionsFor('volume-full', 'darwin'), base);
    assert.deepEqual(sectionsFor('volume-full', 'linux'), [...base, 'journal']);
  });

  test('#565/AC-4 the other alert kinds are not diagnosable', () => {
    for (const k of ['load-high', 'memory-high', 'swap-high', 'volume-full'] as const) assert.equal(isDiagnosable(k), true);
    for (const k of ['port-exposed', 'tunnel-busy', 'machine-unreachable', 'terminal-stuck'] as const) {
      assert.equal(isDiagnosable(k), false);
      assert.deepEqual(sectionsFor(k, 'linux'), []);
    }
  });

  test('#565/AC-11 the cache action ids are the cleanup catalog ids', () => {
    assert.deepEqual({ ...CACHE_ACTION_IDS }, { npm: 'npm-cache', pip: 'pip-cache', xcodeDerivedData: 'xcode-derived-data' });
  });

  test('#565/AC-9 the list cap is 10 and a reason is capped', () => {
    assert.equal(LIST_CAP, 10);
    assert.equal(capReason('x'.repeat(REASON_MAX + 50)).length, REASON_MAX);
    assert.equal(capReason('short'), 'short');
  });
});
