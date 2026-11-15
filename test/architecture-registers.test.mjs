// Guard for issue 657 (CON-1, PER-1): the strategy register has one row per problem with a reference
// that exists, and the table-modes register covers every SQLite table the sources create.
//
// Run with: node --test --test-concurrency=1 test/architecture-registers.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.ROOT ?? join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DIR = join(ROOT, 'docs', 'architecture')
export const PROBLEMS = ['result', 'error-format', 'http-client', 'validation', 'test', 'date-time', 'persistence', 'events']
export const MODES = ['append-only', 'upsert-with-history', 'upsert']

const readJson = (name) => {
  const file = join(DIR, name)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(path, out)
    else if (/\.(ts|mjs|js)$/.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) out.push(path)
  }
  return out
}

/**
 * The tables the sources leave behind: every CREATE TABLE, minus a table dropped, and a rebuilt table
 * (`x_new` renamed to `x`) counted under its final name. Maps a table to the files that create it.
 */
export function createdTables(root = ROOT) {
  const created = new Map()
  const dropped = new Set()
  const renames = []
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const src = join(root, 'packages', pkg, 'src')
    if (!existsSync(src) || !statSync(src).isDirectory()) continue
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8')
      const rel = relative(root, file)
      for (const m of text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)) created.set(m[1], [...(created.get(m[1]) ?? []), rel])
      for (const m of text.matchAll(/DROP TABLE (?:IF EXISTS )?([a-z_]+)/g)) dropped.add(m[1])
      for (const m of text.matchAll(/ALTER TABLE ([a-z_]+) RENAME TO ([a-z_]+)/g)) renames.push([m[1], m[2]])
    }
  }
  const final = new Map(created)
  for (const name of dropped) final.delete(name)
  for (const [from, to] of renames) {
    final.set(to, [...new Set([...(final.get(to) ?? []), ...(created.get(from) ?? [])])])
    final.delete(from)
  }
  return final
}

export function strategyProblems(register, root = ROOT) {
  const problems = []
  const rows = register?.problems ?? {}
  for (const name of PROBLEMS) {
    const row = rows[name]
    if (!row) { problems.push(`the strategy register has no row for ${name}`); continue }
    if (typeof row.decision !== 'string' || row.decision.trim() === '') problems.push(`${name} has no decision`)
    if (typeof row.reference !== 'string' || !existsSync(join(root, row.reference))) problems.push(`${name} has a reference that does not exist: ${row.reference}`)
  }
  for (const name of Object.keys(rows)) if (!PROBLEMS.includes(name)) problems.push(`the strategy register has a row for ${name}, which is not one of the eight problems`)
  return problems
}

export function tableProblems(register, tables) {
  const problems = []
  const rows = register?.tables ?? {}
  for (const [table, files] of tables) {
    const row = rows[table]
    if (!row) { problems.push(`table ${table} (created in ${files[0]}) is missing from the table-modes register`); continue }
    if (!MODES.includes(row.mode)) problems.push(`table ${table} has mode ${JSON.stringify(row.mode)}, not one of ${MODES.join(', ')}`)
    if (row.mode === 'upsert' && row.legacy !== true) problems.push(`table ${table} is upsert with no history: it must be flagged legacy: true`)
    if (row.mode === 'upsert-with-history' && !(typeof row.history === 'string' && row.history.trim())) problems.push(`table ${table} is upsert-with-history and names no history`)
    if (!files.includes(row.createdIn)) problems.push(`table ${table} says it is created in ${row.createdIn}, which does not create it`)
  }
  for (const table of Object.keys(rows)) if (!tables.has(table)) problems.push(`the table-modes register names ${table}, which no CREATE TABLE creates`)
  return problems
}

test('issue 657/AC-3: the strategy register has one row per problem, each with a reference that exists', () => {
  const register = readJson('strategies.json')
  assert.ok(register, 'docs/architecture/strategies.json does not exist')
  assert.deepEqual(strategyProblems(register), [])
})

test('issue 657/AC-3: every table the sources create is in the table-modes register, with an allowed mode', () => {
  const register = readJson('table-modes.json')
  assert.ok(register, 'docs/architecture/table-modes.json does not exist')
  assert.deepEqual(register.modes, MODES)
  assert.deepEqual(tableProblems(register, createdTables()), [])
})

test('issue 657/AC-3: the checks name a missing problem, a missing reference, an unknown table and a bad mode', () => {
  const strategies = strategyProblems({ problems: { result: { decision: 'x', reference: 'no/such/file.ts' } } })
  assert.ok(strategies.some((p) => p.includes('no row for events')))
  assert.ok(strategies.some((p) => p.includes('reference that does not exist')))
  const tables = new Map([['new_table', ['packages/nucleo/src/x.ts']]])
  assert.ok(tableProblems({ tables: {} }, tables).some((p) => p.includes('new_table') && p.includes('missing')))
  assert.ok(tableProblems({ tables: { gone: { mode: 'append-only' }, new_table: { mode: 'overwrite', createdIn: 'packages/nucleo/src/x.ts' } } }, tables).some((p) => p.includes('gone, which no CREATE TABLE creates')))
  assert.ok(tableProblems({ tables: { new_table: { mode: 'overwrite', createdIn: 'packages/nucleo/src/x.ts' } } }, tables).some((p) => p.includes('not one of')))
})

test('issue 657/AC-3: the table scan sees a rebuilt table under its final name and not the temporary one', () => {
  const names = [...createdTables().keys()]
  assert.ok(names.includes('context_meters') && names.includes('decisions'))
  assert.ok(!names.some((n) => n.endsWith('_new')) && !names.includes('reprocessamentos'))
})
