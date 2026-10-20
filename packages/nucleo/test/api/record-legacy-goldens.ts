// Records the goldens of the old Portuguese routes (issue #173, phase 2b, layer 1):
//
//   node --disable-warning=ExperimentalWarning test/api/record-legacy-goldens.ts [dir]
//
// It ran ONCE, on the code before any JSON key changed; the files under
// `test/fixtures/legacy-golden/` are the bodies the published mod v0.0.30 and the installed app read.
// Never run it again into that folder: `legacy-golden.test.ts` proves every later layer still answers
// them byte for byte. With a `dir`, it writes there instead (to compare two runs, for instance).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLegacyDemo } from './legacy-demo.ts';
import { goldenFile, runGoldenCases } from './legacy-golden-cases.ts';

const dir = process.argv[2] ?? fileURLToPath(new URL('../fixtures/legacy-golden/', import.meta.url));
mkdirSync(dir, { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(join(dir, f));

const demo = await startLegacyDemo();
try {
  const records = await runGoldenCases(demo);
  records.forEach((r, i) => writeFileSync(join(dir, goldenFile(i, r.name)), `${JSON.stringify(r, null, 2)}\n`));
  console.log(`${records.length} goldens in ${dir}`);
} finally {
  await demo.close();
}
