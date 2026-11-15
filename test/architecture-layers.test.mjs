// Guard for issue 657 (STR-4): the layer map covers everything directly under packages/*/src.
// Fails when a folder or top-level file is missing from docs/architecture/layers.json, when the map
// names an entry that no longer exists, and when a layer is not one of the four.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.ROOT ?? join(fileURLToPath(new URL('.', import.meta.url)), '..')
const MAP_FILE = join(ROOT, 'docs', 'architecture', 'layers.json')
const LAYERS = ['domain', 'application', 'edge', 'composition-root']

/** What sits directly under each packages/<name>/src: folders and files, minus dotfiles and tests. */
export function sourceEntries(root = ROOT) {
  const out = {}
  for (const pkg of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    const src = join(root, 'packages', pkg.name, 'src')
    if (!pkg.isDirectory() || !existsSync(src)) continue
    out[pkg.name] = readdirSync(src)
      .filter((name) => !name.startsWith('.') && !/\.test\.[a-z]+$/.test(name))
      .sort()
  }
  return out
}

/** Names the problems between the entries on disk and the map; empty when they agree. */
export function mapProblems(entries, map) {
  const problems = []
  const mapped = map?.packages ?? {}
  for (const [pkg, names] of Object.entries(entries)) {
    const rows = mapped[pkg]
    if (!rows) {
      problems.push(`package ${pkg} has a src/ and no entry in the layer map`)
      continue
    }
    for (const name of names) {
      if (!(name in rows)) problems.push(`packages/${pkg}/src/${name} is missing from the layer map`)
    }
    for (const name of Object.keys(rows)) {
      if (!names.includes(name)) problems.push(`the layer map names packages/${pkg}/src/${name}, which does not exist`)
    }
    for (const [name, row] of Object.entries(rows)) {
      if (!LAYERS.includes(row?.layer)) problems.push(`packages/${pkg}/src/${name} has layer ${JSON.stringify(row?.layer)}, not one of ${LAYERS.join(', ')}`)
      else if (typeof row.evidence !== 'string' || row.evidence.trim() === '') problems.push(`packages/${pkg}/src/${name} has no evidence for its layer`)
    }
  }
  for (const pkg of Object.keys(mapped)) {
    if (!(pkg in entries)) problems.push(`the layer map names package ${pkg}, which has no src/`)
  }
  return problems
}

const readMap = () => (existsSync(MAP_FILE) ? JSON.parse(readFileSync(MAP_FILE, 'utf8')) : null)

test('issue 657/AC-2: the layer map file exists and declares the four layers', () => {
  const map = readMap()
  assert.ok(map, 'docs/architecture/layers.json does not exist')
  assert.deepEqual(map.layers, LAYERS)
})

test('issue 657/AC-2: every folder and top-level file under packages/*/src is in the layer map, and nothing stale is', () => {
  const problems = mapProblems(sourceEntries(), readMap())
  assert.deepEqual(problems, [])
})

test('issue 657/AC-2: the check names a new folder left out of the map', () => {
  const map = structuredClone(readMap() ?? { packages: {} })
  const entries = sourceEntries()
  entries.nucleo = [...(entries.nucleo ?? []), 'brand-new-folder']
  assert.ok(mapProblems(entries, map).some((p) => p.includes('packages/nucleo/src/brand-new-folder is missing')))
})

test('issue 657/AC-2: the check names a stale map entry', () => {
  const map = structuredClone(readMap() ?? { packages: { nucleo: {} } })
  map.packages.nucleo ??= {}
  map.packages.nucleo['folder-that-was-removed'] = { layer: 'edge', evidence: 'x' }
  assert.ok(mapProblems(sourceEntries(), map).some((p) => p.includes('folder-that-was-removed, which does not exist')))
})

test('issue 657/AC-2: the check refuses a layer outside the four', () => {
  const map = structuredClone(readMap() ?? { packages: { nucleo: {} } })
  const first = Object.keys(map.packages.nucleo ?? {})[0] ?? 'model.ts'
  map.packages.nucleo ??= {}
  map.packages.nucleo[first] = { layer: 'infrastructure', evidence: 'x' }
  assert.ok(mapProblems({ nucleo: [first] }, { packages: { nucleo: map.packages.nucleo } }).some((p) => p.includes('not one of')))
})
