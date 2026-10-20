// #221 (5b): the mod finds its core through the instance registry instead of a fixed 4720. A fake
// registry (`fs.list`/`fs.read` under AHRENA_CONSOLE_HOME) and fake cores (`http.fetch` by port):
// each core answers `/api/overview` with its pid while it is up, and the P1 panel.
import { expect, mock, test } from 'claude-code/testing'

import { SCENARIOS, NOW } from './scenarios'

const HOME = '/registry-test/.ahrena-console'
const DIR = `${HOME}/instances`
const PANE = {
  component: 'Pane',
  requestId: 'ahrena-console-sessao',
  props: { title: 'Ahrena Console', isFocused: true, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } },
} as const
const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 121 } }
const CONSOLE = { command: 'console', args: '', origin: { kind: 'user' }, presentation: 'text' } as any

type Core = { pid: number; up: boolean }
type Installation = 'app' | 'dev' | 'mcpb'

const entry = (installation: Installation, pid: number, port: number, startedAt: string) => ({
  name: `${installation}-${pid}.json`,
  text: JSON.stringify({ id: `${installation}-${pid}`, installation, pid, port, version: '0.0.1', commit: null, dataDir: '/x', startedAt }),
})

function fakes(on: any, files: { name: string; text: string }[], cores: Record<number, Core>, env: Record<string, string> = { AHRENA_CONSOLE_HOME: HOME }) {
  const registry = new Map(files.map((f) => [f.name, f.text]))
  const requests: string[] = []
  const state: { panel: unknown } = { panel: SCENARIOS.p1 }
  on('fs.list', async (_$: unknown, e: { path: string }) => {
    if (e.path !== DIR) throw new Error(`ENOENT: ${e.path}`)
    return { value: [...registry.keys()].map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    const text = e.path.startsWith(`${DIR}/`) ? registry.get(e.path.slice(DIR.length + 1)) : undefined
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('http.fetch', async (_$: unknown, e: { url: string }) => {
    requests.push(e.url)
    const url = new URL(e.url)
    const core = cores[Number(url.port)]
    if (!core?.up) throw new Error(`connect ECONNREFUSED 127.0.0.1:${url.port}`)
    const body = url.pathname === '/api/overview' ? { name: 'ahrena-console', version: '0.0.1', pid: core.pid, commit: null } : state.panel
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  const timer = mock.clock(on, { now: NOW })
  mock.env(on, env)
  const pane = { open: false }
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 'sessao-teste' }))
  on('session.model', async () => ({ value: 'claude-sonnet-5-5' }))
  on('session.cwd', async () => ({ value: '/simulacao/cli-de-notas' }))
  on('ui.panes', async () => ({
    value: pane.open ? [{ id: 'ahrena-console-sessao', title: 'Ahrena Console', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.open', async () => {
    pane.open = true
    return { value: { isPlaced: true } }
  })
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return { requests, registry, timer, cores, state }
}

async function open($: any, f: ReturnType<typeof fakes>) {
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.command.run(CONSOLE)
  await f.timer.advance(5_000)
  return f
}

const panelRequests = (f: ReturnType<typeof fakes>) => f.requests.filter((u) => u.includes('/api/panel/'))

/** The server card, in both widths: `127.0.0.1:<port>` online, as before. */
async function expectCard($: any, address: string) {
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    expect(await ui.find({ key: 'offline' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: address })).toBeDefined()
    expect(await ui.find({ key: 'card-session' })).toBeDefined()
    await ui.unmount()
  }
}

test('picks the core of its own installation (dev) even when another one is older', async ($, on) => {
  const f = await open($, fakes(on, [entry('app', 101, 51001, '2026-10-01T00:00:00Z'), entry('dev', 202, 51002, '2026-10-02T00:00:00Z')], {
    51001: { pid: 101, up: true },
    51002: { pid: 202, up: true },
  }))
  expect(panelRequests(f).every((u) => u.startsWith('http://127.0.0.1:51002/api/panel/sessao-teste'))).toBe(true)
  expect(panelRequests(f).length).toBeGreaterThan(0)
  await expectCard($, '127.0.0.1:51002')
})

test('without a live dev core, falls back to the oldest live one', async ($, on) => {
  const f = await open($, fakes(on, [
    entry('mcpb', 303, 51003, '2026-10-01T00:00:00Z'),
    entry('app', 101, 51001, '2026-09-01T00:00:00Z'),
    entry('dev', 202, 51002, '2026-08-01T00:00:00Z'),
  ], {
    51001: { pid: 101, up: true },
    51002: { pid: 202, up: false },
    51003: { pid: 303, up: true },
  }))
  expect(panelRequests(f).every((u) => u.startsWith('http://127.0.0.1:51001/'))).toBe(true)
  await expectCard($, '127.0.0.1:51001')
})

test('ignores entries whose pid is gone (the port answers another pid) and malformed files', async ($, on) => {
  const f = await open($, fakes(on, [
    // the pid was reused: the port answers, but as another core
    entry('dev', 202, 51002, '2026-08-01T00:00:00Z'),
    // not JSON, not an entry, an id that does not match its file, a name outside the pattern
    { name: 'dev-404.json', text: '{ not json' },
    { name: 'dev-505.json', text: JSON.stringify({ id: 'dev-505', installation: 'dev', pid: 505, port: 'x', startedAt: '2026-01-01T00:00:00Z' }) },
    { name: 'dev-606.json', text: entry('dev', 607, 51006, '2026-01-01T00:00:00Z').text },
    { name: 'notes.json', text: entry('dev', 707, 51007, '2026-01-01T00:00:00Z').text },
    { name: '.dev-808.808.ab12.tmp', text: entry('dev', 808, 51008, '2026-01-01T00:00:00Z').text },
    entry('app', 101, 51001, '2026-10-01T00:00:00Z'),
  ], {
    51001: { pid: 101, up: true },
    51002: { pid: 999, up: true },
    51006: { pid: 607, up: true },
    51007: { pid: 707, up: true },
    51008: { pid: 808, up: true },
  }))
  expect(f.requests.some((u) => /:(51006|51007|51008)\//.test(u))).toBe(false)
  expect(panelRequests(f).every((u) => u.startsWith('http://127.0.0.1:51001/'))).toBe(true)
  await expectCard($, '127.0.0.1:51001')
  // the mod never writes or deletes registry files
  expect(f.registry.size).toBe(7)
})

test('an explicit port option wins over the registry', { options: { port: 4999 } }, async ($, on) => {
  const f = await open($, fakes(on, [entry('dev', 202, 51002, '2026-08-01T00:00:00Z')], {
    51002: { pid: 202, up: true },
    4999: { pid: 1, up: true },
  }))
  expect(f.requests.some((u) => u.includes('/api/overview'))).toBe(false)
  expect(panelRequests(f).every((u) => u.startsWith('http://127.0.0.1:4999/'))).toBe(true)
  await expectCard($, '127.0.0.1:4999')
})

for (const [label, env] of [['no live core in the registry', { AHRENA_CONSOLE_HOME: HOME }], ['no registry at all', {}]] as const) {
  test(`${label}: the Offline state is the same as before, at 127.0.0.1:4720`, async ($, on) => {
    const f = await open($, fakes(on, [entry('dev', 202, 51002, '2026-08-01T00:00:00Z')], { 51002: { pid: 202, up: false } }, { ...env }))
    expect(panelRequests(f).every((u) => u.startsWith('http://127.0.0.1:4720/'))).toBe(true)
    for (const target of [PANE, WIDE]) {
      const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
      expect(await ui.find({ key: 'offline' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^127\.0\.0\.1:4720 · sem/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Sem conexão com o núcleo|127\.0\.0\.1:4720 não respondeu/ })).toBeDefined()
      await ui.unmount()
    }
  })
}

for (const [label, env] of [['an empty registry', { AHRENA_CONSOLE_HOME: HOME }], ['no registry at all', {}]] as const) {
  test(`transition, ${label}: a core from before the registry, on 4720, still serves the panel`, async ($, on) => {
    // The app 0.0.1 and old checkouts listen on 4720 and write no entry (decision 0010, item 7).
    const f = await open($, fakes(on, [], { 4720: { pid: 4720, up: true } }, { ...env }))
    expect(panelRequests(f).length).toBeGreaterThan(0)
    expect(panelRequests(f).every((u) => u.startsWith('http://127.0.0.1:4720/'))).toBe(true)
    await expectCard($, '127.0.0.1:4720')
  })
}

test('a core restarted on a new port is found again on the next tick', async ($, on) => {
  const f = await open($, fakes(on, [entry('dev', 202, 51002, '2026-08-01T00:00:00Z')], { 51002: { pid: 202, up: true } }))
  await expectCard($, '127.0.0.1:51002')
  // the core restarts: the old port stops answering, a new entry takes its place
  f.cores[51002]!.up = false
  f.registry.delete('dev-202.json')
  const next = entry('dev', 303, 51003, '2026-10-20T00:00:00Z')
  f.registry.set(next.name, next.text)
  f.cores[51003] = { pid: 303, up: true }
  await f.timer.advance(5_000)
  expect(panelRequests(f).at(-1)!.startsWith('http://127.0.0.1:51003/')).toBe(true)
  await expectCard($, '127.0.0.1:51003')
})

test('the conversation link goes through the discovered core', async ($, on) => {
  const LOCAL = 'local_00000000-0000-4000-8000-0000000000f1'
  const f = await open($, fakes(on, [entry('dev', 202, 51002, '2026-08-01T00:00:00Z')], { 51002: { pid: 202, up: true } }))
  const p4 = SCENARIOS.p4
  f.state.panel = { ...p4, children: p4.children.map((x, i) => (i === 0 ? { ...x, local: LOCAL } : x)) }
  await f.timer.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  const hrefs = (await ui.findAll({ type: 'Link' })).map((l: any) => String(l.props.href)).filter((h: string) => h.includes('/open/'))
  expect(hrefs).toEqual([`http://localhost:51002/open/${LOCAL}`])
  await ui.unmount()
})

test('a discovered core that dies with no other live one: Offline at 127.0.0.1:4720, one lookup per tick', async ($, on) => {
  const f = await open($, fakes(on, [entry('dev', 202, 51002, '2026-08-01T00:00:00Z')], { 51002: { pid: 202, up: true } }))
  await expectCard($, '127.0.0.1:51002')
  f.cores[51002]!.up = false
  await f.timer.advance(5_000)
  expect(panelRequests(f).at(-1)!.startsWith('http://127.0.0.1:4720/')).toBe(true)
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    expect(await ui.find({ key: 'offline' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^127\.0\.0\.1:4720 · sem/ })).toBeDefined()
    await ui.unmount()
  }
  // While offline, each tick probes each registry entry once, not twice.
  const before = f.requests.filter((u) => u.includes('/api/overview')).length
  await f.timer.advance(5_000)
  expect(f.requests.filter((u) => u.includes('/api/overview')).length - before).toBe(1)
})
