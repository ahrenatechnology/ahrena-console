// Unit tests for scripts/coverage-report.mjs (issue 659).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layerOf, mergeCoverage, parseDiff, parseLcov, summarize, toLcov, toMarkdown } from '../scripts/coverage-report.mjs'

const lcov = (file, ...da) => `TN:\nSF:/repo/${file}\n${da.map(([n, h]) => `DA:${n},${h}`).join('\n')}\nend_of_record\n`
const map = {
  layers: ['domain', 'edge'],
  packages: { nucleo: { cost: { layer: 'domain' }, api: { layer: 'edge' } } },
}

test('parseLcov makes paths relative to the root', () => {
  const m = parseLcov(lcov('packages/nucleo/src/cost/a.ts', [1, 1], [2, 0]), '/repo')
  assert.deepEqual([...m.get('packages/nucleo/src/cost/a.ts')], [[1, 1], [2, 0]])
})

test('parseLcov puts paths written relative to packages/nucleo under it', () => {
  const m = parseLcov('SF:src/cost/a.ts\nDA:1,1\nend_of_record\n', '/repo')
  assert.ok(m.has('packages/nucleo/src/cost/a.ts'))
})

test('mergeCoverage counts a line covered when any shard hit it', () => {
  const a = parseLcov(lcov('x.ts', [1, 0], [2, 0]), '/repo')
  const b = parseLcov(lcov('x.ts', [1, 3]), '/repo')
  const merged = mergeCoverage([a, b])
  assert.deepEqual([...merged.get('x.ts')], [[1, 3], [2, 0]])
  assert.match(toLcov(merged), /LF:2\nLH:1/)
})

test('parseDiff reads added line ranges and skips deleted files', () => {
  const d = parseDiff('+++ b/a.ts\n@@ -1,0 +3,2 @@\n+x\n+y\n@@ -9 +12 @@\n+z\n+++ /dev/null\n')
  assert.deepEqual([...d.get('a.ts')], [3, 4, 12])
  assert.equal(d.size, 1)
})

test('layerOf maps by the first folder under src and flags the rest unmapped', () => {
  assert.equal(layerOf('packages/nucleo/src/cost/a.ts', map), 'domain')
  assert.equal(layerOf('packages/nucleo/src/api/x/y.ts', map), 'edge')
  assert.equal(layerOf('packages/nucleo/src/new/z.ts', map), 'unmapped')
  assert.equal(layerOf('scripts/a.mjs', map), 'unmapped')
})

test('summarize reports total, per layer and diff', () => {
  const merged = mergeCoverage([
    parseLcov(lcov('packages/nucleo/src/cost/a.ts', [1, 1], [2, 0]) + lcov('packages/nucleo/src/api/b.ts', [1, 1]), '/repo'),
  ])
  const diff = new Map([['packages/nucleo/src/cost/a.ts', new Set([2])]])
  const s = summarize(merged, map, diff)
  assert.deepEqual(s.total, { covered: 2, total: 3 })
  assert.deepEqual(s.layers.domain, { covered: 1, total: 2 })
  assert.deepEqual(s.layers.edge, { covered: 1, total: 1 })
  assert.deepEqual(s.diff, { covered: 0, total: 1 })
  const md = toMarkdown(s)
  assert.match(md, /Diff \(changed lines\) \| 0\.0%/)
  assert.match(md, /Layer: domain \| 50\.0%/)
})

test('without a base the diff row says n/a', () => {
  assert.match(toMarkdown(summarize(new Map(), map)), /no base to diff against/)
})
