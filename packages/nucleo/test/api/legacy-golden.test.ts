// Issue #173, phase 2b: the old Portuguese routes keep answering EXACTLY what they answered before
// the JSON keys went English. The goldens under `test/fixtures/legacy-golden/` were recorded once, in
// phase 2b layer 1, on the code before any key changed (`record-legacy-goldens.ts`): they are the
// bodies the published mod v0.0.30 and the installed app read.
//
// NEVER re-record them after phase 2b layer 1. A red here means an old route changed; the fix goes in
// the back-translator (`src/api/legacy-routes.ts`), never in the goldens.
//
// Every case replays on a fresh demo server, in the recorded order, and must give the same status,
// the same content-type, the same `Location` and the same body byte for byte (the compact JSON the
// server writes is compared with the golden body serialised the same way, so key order counts too).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { startLegacyDemo, type LegacyDemo } from './legacy-demo.ts';
import { GOLDEN_CASES, goldenFile, runGoldenCase, type GoldenRecord } from './legacy-golden-cases.ts';

const DIR = new URL('../fixtures/legacy-golden/', import.meta.url);
const goldens: GoldenRecord[] = GOLDEN_CASES.map((c, i) => JSON.parse(readFileSync(new URL(goldenFile(i, c.name), DIR), 'utf8')) as GoldenRecord);

describe('#173 phase 2b: the old routes answer their goldens byte for byte', () => {
  let demo: LegacyDemo;
  const vars: Record<string, string> = {};
  before(async () => {
    demo = await startLegacyDemo();
  });
  after(async () => {
    await demo.close();
  });

  test('one golden per case, and no golden without its case', () => {
    assert.equal(readdirSync(DIR).filter((f) => f.endsWith('.json')).length, GOLDEN_CASES.length);
  });

  // The cases share the server's state (the writes), so they run in order, one test each.
  GOLDEN_CASES.forEach((c, i) => {
    test(`${goldenFile(i, c.name)}: ${c.method ?? 'GET'} ${c.path}`, async () => {
      const golden = goldens[i]!;
      assert.deepEqual(golden.request, { method: c.method ?? 'GET', path: c.path, ...(c.body !== undefined ? { body: c.body } : {}) }, 'the case is the one recorded');
      const { record, text } = await runGoldenCase(demo, c, vars);

      assert.equal(record.status, golden.status, 'status');
      assert.equal(record.contentType, golden.contentType, 'content-type');
      assert.equal(record.location, golden.location, 'location');
      assert.deepStrictEqual(record.body, golden.body, c.keysOnly ? 'the key set' : 'body');
      if (!c.keysOnly) assert.equal(text, typeof golden.body === 'string' ? golden.body : JSON.stringify(golden.body), 'body, byte for byte');
    });
  });
});
