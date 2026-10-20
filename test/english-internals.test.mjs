// Guard for decision 0009 (issue #173): internals in English, pt-BR only on screen.
// Fails when a NEW API route, /ui URL, file or folder name, CSS class or environment variable is
// in Portuguese.
// What already existed when the rule was written is frozen in english-internals.legacy.json
// and leaves that list as the migration phases rename it.
//
// Run with: node --test 'test/*.test.mjs'
// Freeze the names of a tree (adds to the legacy list, never removes):
//   FREEZE_LEGACY_NAMES=1 ROOT=<checkout> node --test test/english-internals.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { portugueseWords, routes, words } from './english-internals.lib.mjs'

export { portugueseWords, routes, words }

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = process.env.ROOT ?? join(HERE, '..')
const LEGACY_FILE = join(HERE, 'english-internals.legacy.json')

// Not checked here: docs/ waits for the confirmation of what the rule says about documentation
// (decision 0009). The mod (plugins/) migrated in 0.0.31 (#187); mod-english.test.mjs also checks
// its JSON keys, query parameters and state keys.
const SKIPPED_TREES = ['docs/']
// Where routes and /ui URLs are written.
const ROUTE_SOURCES = ['packages/nucleo/src/', 'packages/nucleo/ui/', 'apps/desktop/src-tauri/src/', 'apps/desktop/pagina/', 'plugins/ahrena-console/hooks/']
const CSS_SOURCES = /\.(css|html)$/
const CODE = /\.(ts|js|mjs|cjs|rs|json|ya?ml|sh|toml)$/

function files() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').filter(Boolean).filter((f) => existsSync(join(ROOT, f)))
}

/** Every file and folder name, as its path from the root. */
export function paths(list) {
  const all = new Set()
  for (const f of list) {
    if (SKIPPED_TREES.some((t) => f.startsWith(t))) continue
    const parts = f.split('/')
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join('/'))
  }
  return all
}

/** The name a path adds: its last part, without the extension. */
function ownName(path) {
  const last = path.split('/').pop()
  return last.slice(0, last.length - extname(last).length) || last
}

/**
 * Environment variables a source reads or sets: `process.env.X`, `env::var("X")`, `.env("X", …)`,
 * `env: { X: … }` and any `AHRENA_*` name.
 */
export function envVars(source) {
  const found = new Set()
  const patterns = [
    /process\.env(?:\.|\[\s*['"`])([A-Z_][A-Z0-9_]*)/g,
    /env::var(?:_os)?\(\s*"([A-Z_][A-Z0-9_]*)"/g,
    /\.(?:env|env_remove)\(\s*"([A-Z_][A-Z0-9_]*)"/g,
    /\b(AHRENA_[A-Z0-9_]*[A-Z0-9])\b/g,
  ]
  for (const re of patterns) for (const m of source.matchAll(re)) found.add(m[1])
  return found
}

/** Class selectors of a stylesheet (or of the <style> in an HTML page). */
export function cssClasses(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\([^)]*\)/g, '')
  const found = new Set()
  for (const m of css.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)(?=[^{};]*\{)/g)) found.add(m[1])
  return found
}

function current() {
  const list = files()
  const read = (f) => readFileSync(join(ROOT, f), 'utf8')
  const routeSet = new Set()
  const classSet = new Set()
  const envSet = new Set()
  for (const f of list) {
    if (!SKIPPED_TREES.some((t) => f.startsWith(t)) && CODE.test(f) && !f.endsWith('.legacy.json') && !f.endsWith('-lock.json') && !f.endsWith('.lock')) for (const v of envVars(read(f))) envSet.add(v)
    if (ROUTE_SOURCES.some((s) => f.startsWith(s)) && /\.(ts|js|rs|html)$/.test(f)) for (const r of routes(read(f))) routeSet.add(r)
    if (!SKIPPED_TREES.some((t) => f.startsWith(t)) && !f.startsWith('spikes/') && CSS_SOURCES.test(f)) for (const c of cssClasses(read(f))) classSet.add(c)
  }
  return { routes: routeSet, paths: paths(list), cssClasses: classSet, envVars: envSet }
}

const sorted = (set) => [...set].sort()
const legacy = { routes: [], paths: [], cssClasses: [], envVars: [], ...(existsSync(LEGACY_FILE) ? JSON.parse(readFileSync(LEGACY_FILE, 'utf8')) : {}) }
const now = current()

if (process.env.FREEZE_LEGACY_NAMES === '1') {
  const freeze = (kind, own) => sorted(new Set([...legacy[kind], ...sorted(now[kind]).filter((n) => portugueseWords(own(n)).length)]))
  const next = {
    $comment: legacy.$comment,
    routes: freeze('routes', (r) => r),
    paths: freeze('paths', ownName),
    cssClasses: freeze('cssClasses', (c) => c),
    envVars: freeze('envVars', (v) => v),
  }
  writeFileSync(LEGACY_FILE, JSON.stringify(next, null, 2) + '\n')
}

function check(kind, label, own) {
  const allowed = new Set(legacy[kind])
  const refused = sorted(now[kind])
    .filter((n) => !allowed.has(n))
    .map((n) => [n, portugueseWords(own(n))])
    .filter(([, pt]) => pt.length)
  assert.deepEqual(
    refused.map(([n, pt]) => `${n} (${pt.join(', ')})`),
    [],
    `${label} in Portuguese. Internals are in English (docs/decisoes/0009-english-internals.md); pt-BR is only for on-screen text.`,
  )
}

test('the guard recognizes Portuguese and leaves English alone', () => {
  assert.deepEqual(portugueseWords('sessoes'), ['sessoes'])
  assert.deepEqual(portugueseWords('rota-atencao'), ['rota', 'atencao'])
  assert.deepEqual(portugueseWords('kb-coluna'), ['coluna'])
  assert.deepEqual(portugueseWords('configuração'), ['configuração'])
  assert.deepEqual(portugueseWords('autorizacao'), ['autorizacao'])
  assert.deepEqual(portugueseWords('sessionDetail'), [])
  assert.deepEqual(portugueseWords('kb-column'), [])
  assert.deepEqual(portugueseWords('status-badge'), [])
  assert.deepEqual(sorted(routes("if (url.pathname === '/api/attention') x; /^\\/api\\/decisions\\/([^/]+)\\/(confirm|dismiss)$/")), [
    '/api/attention',
    '/api/decisions/*/confirm',
    '/api/decisions/*/dismiss',
  ])
  assert.deepEqual(sorted(routes("rota: '/ui/sessions/:id', arquivo: '/ui/screens/a.js'; // src/api/x.ts")), ['/ui/screens', '/ui/sessions/*'])
  assert.deepEqual(portugueseWords('AHRENA_NUCLEO_PORTA'), ['nucleo', 'porta'])
  assert.deepEqual(portugueseWords('AHRENA_CONSOLE_CORE_PORT'), [])
  assert.deepEqual(sorted(envVars('process.env.AHRENA_X; env::var("HOME"); cmd.env("AHRENA_CONSOLE_DATA_DIR", d); process.env["NODE_ENV"]')), [
    'AHRENA_CONSOLE_DATA_DIR',
    'AHRENA_X',
    'HOME',
    'NODE_ENV',
  ])
  assert.deepEqual(sorted(cssClasses('.kb-col > .card:hover, .b-ok { color: red } /* .nada {} */')), ['b-ok', 'card', 'kb-col'])
})

test('no new API route or /ui URL in Portuguese', () => check('routes', 'Route or /ui URL', (r) => r))
test('no new file or folder name in Portuguese', () => check('paths', 'File or folder name', ownName))
test('no new CSS class in Portuguese', () => check('cssClasses', 'CSS class', (c) => c))
test('no new environment variable in Portuguese', () => check('envVars', 'Environment variable', (v) => v))
