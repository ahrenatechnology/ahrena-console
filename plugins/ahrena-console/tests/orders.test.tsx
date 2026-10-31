// #61, mod part: the console's orders to this session. The mod fetches `GET /api/sessions/<id>/commands`
// on its own clock, runs the command with `$.command.run`, and confirms with POST …/done { ok, reason }.
import { expect, mock, test } from 'claude-code/testing'

import { NOW } from './scenarios'

type Sent = { method: string; url: string; body: any }

function fakes(on: any, opts: { orders: { orderId: string; kind: string }[]; commands: string[]; run?: (command: string) => { text?: string } | Error }) {
  mock.env(on, { AHRENA_CONSOLE_HOME: '/owner-test' })
  on('fs.list', async () => ({ value: [] }))
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    if (e.path !== '/owner-test/nucleo.json') throw new Error('ENOENT')
    return { value: JSON.stringify({ port: 4999, pid: 123, token: 'a'.repeat(64) }) }
  })
  const sent: Sent[] = []
  const ran: string[] = []
  let queue = [...opts.orders]
  const timer = mock.clock(on, { now: NOW })
  on('session.id', async () => ({ value: 'sessao-teste' }))
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.panes', async () => ({ value: [] }))
  on('ui.status', async () => ({ value: undefined }))
  on('command.list', async () => ({ value: opts.commands.map((name) => ({ name, description: '', source: 'builtin' })) }))
  on('command.run', async (_$: unknown, e: { command: string }) => {
    ran.push(e.command)
    const r = opts.run?.(e.command) ?? {}
    if (r instanceof Error) throw r
    return r
  })
  on('http.fetch', async (_$: unknown, e: { url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }) => {
    expect(e.init?.headers?.authorization).toBe(`Bearer ${'a'.repeat(64)}`)
    const method = e.init?.method ?? 'GET'
    sent.push({ method, url: e.url, body: e.init?.body ? JSON.parse(e.init.body) : null })
    if (method === 'GET' && e.url.endsWith('/commands')) {
      const orders = queue
      queue = []
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ orders }) } }
    }
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })
  return { sent, ran, timer }
}

/** The tick fires, then the fetch, the command and the confirmation each take a turn of the loop. */
async function tick(f: ReturnType<typeof fakes>, ms = 4_000) {
  await f.timer.advance(ms)
  for (let i = 0; i < 10; i++) await f.timer.advance(1)
}

const confirmations = (f: ReturnType<typeof fakes>) => f.sent.filter((s) => s.method === 'POST')

test('runs /compact when the console orders it, and confirms ok', { options: { port: 4999 } }, async ($, on) => {
  const f = fakes(on, { orders: [{ orderId: 'o-1', kind: 'compact' }], commands: ['compact', 'clear'] })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await tick(f)
  expect(f.sent[0]).toMatchObject({ method: 'GET', url: 'http://127.0.0.1:4999/api/sessions/sessao-teste/commands' })
  expect(f.ran).toEqual(['compact'])
  expect(confirmations(f)).toEqual([{ method: 'POST', url: 'http://127.0.0.1:4999/api/sessions/sessao-teste/commands/o-1/done', body: { ok: true } }])
})

test('runs /clear, and ignores a kind it does not know', { options: { port: 4999 } }, async ($, on) => {
  const f = fakes(on, { orders: [{ orderId: 'o-2', kind: 'clear' }, { orderId: 'o-3', kind: 'rm -rf' }], commands: ['compact', 'clear'] })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await tick(f)
  expect(f.ran).toEqual(['clear'])
  expect(confirmations(f).map((c) => c.url.split('/').at(-2))).toEqual(['o-2'])
})

test('Remote control: tries the command the Claude Code has and says why it did not turn on', { options: { port: 4999 } }, async ($, on) => {
  const f = fakes(on, {
    orders: [{ orderId: 'o-4', kind: 'remote-control' }],
    commands: ['compact', 'remote-control'],
    run: () => ({ text: 'Remote Control is not available on your plan.' }),
  })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await tick(f)
  expect(f.ran).toEqual(['remote-control'])
  expect(confirmations(f)[0]!.body).toEqual({ ok: false, reason: 'Remote Control is not available on your plan.' })
})

test('a Claude Code without the command, and a command that throws, confirm ok: false', { options: { port: 4999 } }, async ($, on) => {
  const f = fakes(on, { orders: [{ orderId: 'o-5', kind: 'remote-control' }, { orderId: 'o-6', kind: 'compact' }], commands: ['compact'], run: () => new Error('a sessão está ocupada') })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await tick(f)
  const by = Object.fromEntries(confirmations(f).map((c) => [c.url.split('/').at(-2), c.body]))
  expect(by['o-5']).toEqual({ ok: false, reason: 'esta versão do Claude Code não tem o comando /remote-control' })
  expect(by['o-6']).toMatchObject({ ok: false })
  expect(typeof (by['o-6'] as { reason: string }).reason).toBe('string')
  expect(f.ran).toEqual(['compact'])
})

test('asks once per tick and stops when the session ends', { options: { port: 4999 } }, async ($, on) => {
  const f = fakes(on, { orders: [], commands: ['compact'] })
  on('session.end', async (_$: unknown, e: unknown) => e)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await tick(f, 8_000)
  expect(f.sent.filter((s) => s.method === 'GET').length).toBe(2)
})
