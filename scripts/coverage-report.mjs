#!/usr/bin/env node
// Sums the lcov files of the core shards and reports line coverage three ways: of the lines the PR
// changed (diff), of everything (total) and of each layer in docs/architecture/layers.json (#659).
// It only publishes: nothing here fails on a threshold (the scorecard check does, #666).
//
//   node scripts/coverage-report.mjs --lcov <dir-or-file>... [--base <sha>] [--out <dir>]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Parses one lcov text into Map<path, Map<line, hits>>. Paths become repo-relative: absolute ones against `root`, relative ones under `prefix`. */
export function parseLcov(text, root = ROOT, prefix = 'packages/nucleo/') {
  const files = new Map()
  let current = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('SF:')) {
      const path = line.slice(3)
      let rel = (path.startsWith('/') ? relative(root, path) : path).split(sep).join('/')
      // Shards ran on other runners: keep what follows the repo root, found by the packages/ folder.
      if (rel.startsWith('..')) rel = rel.slice(rel.indexOf('packages/'))
      // node --test writes paths relative to the folder it ran in (packages/nucleo).
      else if (!path.startsWith('/') && !rel.startsWith('packages/')) rel = prefix + rel
      current = files.get(rel) ?? new Map()
      files.set(rel, current)
    } else if (line.startsWith('DA:') && current) {
      const [no, hits] = line.slice(3).split(',').map(Number)
      current.set(no, (current.get(no) ?? 0) + hits)
    } else if (line === 'end_of_record') current = null
  }
  return files
}

/** Sums several parsed lcov maps: a line is covered when any shard hit it. */
export function mergeCoverage(maps) {
  const merged = new Map()
  for (const map of maps) {
    for (const [file, lines] of map) {
      const into = merged.get(file) ?? new Map()
      merged.set(file, into)
      for (const [no, hits] of lines) into.set(no, (into.get(no) ?? 0) + hits)
    }
  }
  return merged
}

/** Serialises merged coverage back to lcov. */
export function toLcov(merged) {
  const out = []
  for (const [file, lines] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
    out.push('TN:', `SF:${file}`)
    const sorted = [...lines].sort(([a], [b]) => a - b)
    for (const [no, hits] of sorted) out.push(`DA:${no},${hits}`)
    out.push(`LF:${sorted.length}`, `LH:${sorted.filter(([, h]) => h > 0).length}`, 'end_of_record')
  }
  return out.join('\n') + '\n'
}

/** Parses `git diff -U0` into Map<path, Set<added line number>>. */
export function parseDiff(text) {
  const added = new Map()
  let file = null
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(6)
      if (file) added.set(file, new Set())
    } else if (line.startsWith('@@') && file) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line)
      const start = Number(m[1])
      const count = m[2] === undefined ? 1 : Number(m[2])
      for (let i = 0; i < count; i++) added.get(file).add(start + i)
    }
  }
  return added
}

/** Which layer a repo-relative file belongs to, from layers.json; 'unmapped' when it has no entry. */
export function layerOf(file, map) {
  const m = /^packages\/([^/]+)\/src\/([^/]+)/.exec(file)
  return m ? (map.packages?.[m[1]]?.[m[2]]?.layer ?? 'unmapped') : 'unmapped'
}

const tally = () => ({ covered: 0, total: 0 })
const add = (t, hits) => {
  t.total++
  if (hits > 0) t.covered++
}

/** Computes total, per-layer and diff coverage. `diff` is null when no base was given. */
export function summarize(merged, layerMap, diff = null) {
  const total = tally()
  const layers = Object.fromEntries([...(layerMap.layers ?? []), 'unmapped'].map((l) => [l, tally()]))
  const changed = diff ? tally() : null
  for (const [file, lines] of merged) {
    const layer = layerOf(file, layerMap)
    const touched = diff?.get(file)
    for (const [no, hits] of lines) {
      add(total, hits)
      add(layers[layer], hits)
      if (touched?.has(no)) add(changed, hits)
    }
  }
  return { total, layers, diff: changed }
}

const pct = (t) => (t.total === 0 ? 'n/a' : `${((100 * t.covered) / t.total).toFixed(1)}%`)
const row = (name, t) => `| ${name} | ${pct(t)} | ${t.covered}/${t.total} |`

/** The markdown published to the job summary. */
export function toMarkdown(summary) {
  const rows = [
    '## Core line coverage',
    '',
    'Published, not enforced here: the scorecard check applies the limits (#666).',
    '',
    '| Scope | Lines | Covered/total |',
    '| --- | --- | --- |',
    summary.diff ? row('Diff (changed lines)', summary.diff) : '| Diff (changed lines) | n/a | no base to diff against |',
    row('Total', summary.total),
    ...Object.entries(summary.layers)
      .filter(([name, t]) => t.total > 0 || name !== 'unmapped')
      .map(([name, t]) => row(`Layer: ${name}`, t)),
  ]
  return rows.join('\n') + '\n'
}

function collect(paths) {
  const files = []
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p, { recursive: true })) if (String(e).endsWith('.lcov')) files.push(join(p, String(e)))
    } else files.push(p)
  }
  return files
}

function main(argv) {
  const lcov = []
  let base = null
  let out = 'coverage-report'
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lcov') while (argv[i + 1] && !argv[i + 1].startsWith('--')) lcov.push(argv[++i])
    else if (argv[i] === '--base') base = argv[++i]
    else if (argv[i] === '--out') out = argv[++i]
  }
  const files = collect(lcov)
  if (files.length === 0) throw new Error('no lcov files found: pass --lcov <dir-or-file>')
  const merged = mergeCoverage(files.map((f) => parseLcov(readFileSync(f, 'utf8'))))
  const layerMap = JSON.parse(readFileSync(join(ROOT, 'docs/architecture/layers.json'), 'utf8'))
  const diff = base
    ? parseDiff(execFileSync('git', ['diff', '-U0', '--no-color', `${base}...HEAD`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }))
    : null
  const summary = summarize(merged, layerMap, diff)
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'lcov.info'), toLcov(merged))
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  const md = toMarkdown(summary)
  writeFileSync(join(out, 'summary.md'), md)
  process.stdout.write(md)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
