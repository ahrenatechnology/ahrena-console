// #406: the band above the prompt (P17) and the way back in the pane (P18). Each test is named after
// the acceptance criterion of #406 it covers.
import { expect, mock, test } from 'claude-code/testing'

import { NOW, SCENARIOS } from './scenarios'

const PANE_ID = 'ahrena-console-sessao'
const CORE = 'http://127.0.0.1:4999'
const ORDERS_URL = `${CORE}/api/sessions/sessao-teste/commands`
// The test's `$` raises no `ui.close`: a plugin beside the mod closes the pane, as the person's mark
// would, through the same chain (the mod's ui.close hook, then the engine's).
const CLOSE = { command: 'close-pane', args: '', origin: { kind: 'user' }, presentation: 'text' } as any
const closer = {
  name: 'pane-closer',
  register: (on: any) => {
    // An inline plugin runs on its own: it sees none of this file's constants.
    on('command.run', { command: 'close-pane' }, async ($: any) => {
      await $.ui.close({ id: 'ahrena-console-sessao' })
      return { text: 'closed' }
    })
  },
}
const OPTIONS = { options: { port: 4999 }, plugins: [closer] }
const CONSOLE = { command: 'console', args: '', origin: { kind: 'user' }, presentation: 'text' } as any
const TOAST = 'Atalho oculto · para mostrar de novo, abra o painel'

const BAND = {
  plugin: 'ahrena-console',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 38, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const WIDE_BAND = { ...BAND, props: { ...BAND.props, bodyColumns: 121 } }
const PANE = {
  plugin: 'ahrena-console',
  component: 'Pane',
  requestId: PANE_ID,
  props: { title: 'Ahrena Console', isFocused: true, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} },
} as const
const WIDE_PANE = { ...PANE, props: { ...PANE.props, bodyColumns: 121 } }

// The engine beneath the mod: a pane list, /console's open and close, the store, the clock, toasts,
// and a fake core that records every request it gets. What the engine draws in the band when the mod
// passes (`next(e)`) is the Text "engine band".
function fakes(on: any, opts: { store?: Record<string, unknown> } = {}) {
  mock.env(on, { AHRENA_CONSOLE_HOME: '/owner-test' })
  mock.store(on, opts.store ?? {})
  const timer = mock.clock(on, { now: NOW })
  on('fs.list', async () => ({ value: [] }))
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    if (e.path !== '/owner-test/nucleo.json') throw new Error('ENOENT')
    return { value: JSON.stringify({ port: 4999, pid: 123, token: 'a'.repeat(64) }) }
  })
  const urls: string[] = []
  on('http.fetch', async (_$: unknown, e: { url: string }) => {
    urls.push(e.url)
    if (e.url === ORDERS_URL) return { value: { status: 200, ok: true, headers: {}, text: '{"orders":[]}' } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(SCENARIOS.p1) } }
  })
  const pane = { open: false }
  const opened: string[] = []
  const toasts: string[] = []
  let redraws = 0
  on('ui.panes', async () => ({
    value: pane.open ? [{ id: PANE_ID, title: 'Ahrena Console', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.open', async (_$: unknown, e: { id: string }) => {
    opened.push(e.id)
    pane.open = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', async () => {
    pane.open = false
    return { value: undefined }
  })
  on('ui.invalidate', async () => {
    redraws++
    return { value: undefined }
  })
  on('ui.toast', async (_$: unknown, e: { text?: string } | string) => {
    toasts.push(typeof e === 'string' ? e : (e?.text ?? ''))
    return { value: undefined }
  })
  on('ui.status', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 'sessao-teste' }))
  on('session.model', async () => ({ value: 'claude-sonnet-5-5' }))
  on('session.cwd', async () => ({ value: '/simulacao/cli-de-notas' }))
  on('command.register', async () => ({ value: undefined }))
  on('command.list', async () => ({ value: [] }))
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return { urls, pane, opened, toasts, timer, redraws: () => redraws }
}

const start = ($: any) => $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })

/** Lets a press's handler (`void openPane($)`, `void hideBand($)`) run to the end. */
async function settle(f: ReturnType<typeof fakes>) {
  for (let i = 0; i < 10; i++) await f.timer.advance(1)
}

/** Whether the band the mod draws is there (and not the engine's own, from `next(e)`). */
async function bandShown($: any, target: object = BAND, surface = 'desktop') {
  const ui = await $.ui.mount({ ...target, surface })
  const ours = (await ui.find({ key: 'open-pane' })) !== undefined
  const engine = (await ui.find({ type: 'Text', text: 'engine band' })) !== undefined
  await ui.unmount()
  expect(ours).toBe(!engine)
  return ours
}

test('criterion 1: on desktop with the pane closed, one row "Ahrena Console" with Abrir and Ocultar; the hint only when wide', OPTIONS, async ($, on) => {
  fakes(on)
  await start($)
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const label = await ui.find({ type: 'Text', text: 'Ahrena Console' })
  expect(label?.props.color).toBe('#f47720')
  expect((await ui.find({ key: 'open-pane' }))?.props).toMatchObject({ label: 'Abrir', plain: true })
  expect((await ui.find({ key: 'hide-band' }))?.props).toMatchObject({ label: 'Ocultar', plain: true, dimColor: true })
  expect(await ui.find({ type: 'Text', text: /painel da sessão fechado/ })).toBeUndefined()
  // One row with no border: a bordered Box gains a row on the Desktop.
  expect((await ui.findAll({ type: 'Box' })).every((b) => !b.props.borderStyle)).toBe(true)
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()

  ui = await $.ui.mount({ ...WIDE_BAND, surface: 'desktop' })
  const hint = await ui.find({ type: 'Text', text: 'painel da sessão fechado · o /console também abre' })
  expect(hint?.props).toMatchObject({ dimColor: true, wrap: 'truncate-end' })
  expect(await ui.find({ key: 'open-pane' })).toBeDefined()
  expect(await ui.find({ key: 'hide-band' })).toBeDefined()
  await ui.unmount()
})

test('criterion 2: Abrir opens the pane and starts polling, as /console does', OPTIONS, async ($, on) => {
  const f = fakes(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'open-pane' })
  await ui.unmount()
  await settle(f)
  expect(f.opened).toEqual([PANE_ID])
  await f.timer.advance(10_000)
  expect(f.urls.filter((u) => u.startsWith(`${CORE}/api/panel/sessao-teste`)).length).toBeGreaterThanOrEqual(2)
})

test('criterion 3: with the pane open the band is not drawn, and after ui.close it is back', OPTIONS, async ($, on) => {
  const f = fakes(on)
  await start($)
  expect(await bandShown($)).toBe(true)
  await $.command.run(CONSOLE)
  expect(await bandShown($)).toBe(false)
  const before = f.redraws()
  await $.command.run(CLOSE)
  // Closed: the mod asks for a redraw, and the band is drawn again.
  expect(f.redraws()).toBeGreaterThan(before)
  expect(await bandShown($)).toBe(true)
})

test('criterion 4: while the prompt shows the survey (hasSurvey) the band is not drawn', OPTIONS, async ($, on) => {
  fakes(on)
  await start($)
  expect(await bandShown($, { ...BAND, props: { ...BAND.props, hasSurvey: true } })).toBe(false)
  expect(await bandShown($, { ...WIDE_BAND, props: { ...WIDE_BAND.props, hasSurvey: true } })).toBe(false)
})

test('criterion 5: Ocultar persists in $.store across a new session; /console still opens the pane, and P18 shows the band again', OPTIONS, async ($, on) => {
  const f = fakes(on)
  await start($)
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hide-band' })
  await ui.unmount()
  await settle(f)
  expect(await bandShown($)).toBe(false)

  // A new session: the choice is still in the store.
  await start($)
  expect(await bandShown($)).toBe(false)

  // /console still opens the pane, and its last row is the way back (P18): narrow, just the button.
  await $.command.run(CONSOLE)
  await f.timer.advance(5_000)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'show-band' }))?.props).toMatchObject({ label: 'Mostrar atalho acima do prompt', plain: true })
  expect(await ui.find({ type: 'Text', text: /o atalho acima do prompt está oculto/ })).toBeUndefined()
  await ui.unmount()
  // Wide: the grey text on the left, the button on the right.
  ui = await $.ui.mount({ ...WIDE_PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'o atalho acima do prompt está oculto' })).toBeDefined()
  await ui.press({ key: 'show-band' })
  await ui.unmount()
  await settle(f)

  // Shown again: the row leaves the pane; the band waits for the pane to close (P17, state 3).
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'show-band' })).toBeUndefined()
  await ui.unmount()
  expect(await bandShown($)).toBe(false)
  await $.command.run(CLOSE)
  expect(await bandShown($)).toBe(true)
})

test('criterion 5: a hidden band stored by an earlier session stays hidden, and the pane offers the way back', OPTIONS, async ($, on) => {
  const f = fakes(on, { store: { aboveBandHidden: true } })
  await start($)
  expect(await bandShown($)).toBe(false)
  expect(await bandShown($, WIDE_BAND)).toBe(false)
  await $.command.run(CONSOLE)
  await f.timer.advance(5_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'show-band' })).toBeDefined()
  await ui.unmount()
})

test('criterion 5: the pane shows no P18 row while the band was never hidden', OPTIONS, async ($, on) => {
  const f = fakes(on)
  await start($)
  await $.command.run(CONSOLE)
  await f.timer.advance(5_000)
  for (const target of [PANE, WIDE_PANE]) {
    const ui = await $.ui.mount({ ...target, surface: 'desktop' })
    expect(await ui.find({ key: 'card-session' })).toBeDefined()
    expect(await ui.find({ key: 'show-band' })).toBeUndefined()
    await ui.unmount()
  }
})

test('criterion 5: the "Atalho oculto" toast shows on the first Ocultar only, never again after showing the band and hiding it', OPTIONS, async ($, on) => {
  const f = fakes(on)
  await start($)
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hide-band' })
  await ui.unmount()
  await settle(f)
  expect(f.toasts).toEqual([TOAST])

  await $.command.run(CONSOLE)
  await f.timer.advance(5_000)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'show-band' })
  await ui.unmount()
  await settle(f)
  await $.command.run(CLOSE)

  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hide-band' })
  await ui.unmount()
  await settle(f)
  expect(await bandShown($)).toBe(false)
  expect(f.toasts).toEqual([TOAST])
})

test('criterion 5: a toast already shown by an earlier session is not shown again', OPTIONS, async ($, on) => {
  const f = fakes(on, { store: { aboveBandToastShown: true } })
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'hide-band' })
  await ui.unmount()
  await settle(f)
  expect(await bandShown($)).toBe(false)
  expect(f.toasts).toEqual([])
})

// The proof for decision 0004 / #81: the band adds no request to the core. With the pane closed, the
// band drawn on both widths, Ocultar pressed and a minute on the clock either side, every request the
// core got is the order fetch (startOrders), and nothing else.
test('criterion 6: with the pane closed, the band and Ocultar make no core request besides the order fetch', OPTIONS, async ($, on) => {
  const f = fakes(on)
  await start($)
  for (const target of [BAND, WIDE_BAND]) expect(await bandShown($, target)).toBe(true)
  await f.timer.advance(60_000)
  const ui = await $.ui.mount({ ...WIDE_BAND, surface: 'desktop' })
  await ui.press({ key: 'hide-band' })
  await ui.unmount()
  await settle(f)
  for (const target of [BAND, WIDE_BAND]) expect(await bandShown($, target)).toBe(false)
  await f.timer.advance(60_000)

  expect(f.opened).toEqual([])
  expect(f.urls.length).toBeGreaterThan(0)
  expect(f.urls.filter((u) => u !== ORDERS_URL)).toEqual([])
  expect([...new Set(f.urls)]).toEqual([ORDERS_URL])
})

test('criterion 7: off the desktop surface the band is next(e)', OPTIONS, async ($, on) => {
  fakes(on)
  await start($)
  for (const surface of ['terminal', 'vscode', 'mobile']) {
    expect(await bandShown($, BAND, surface)).toBe(false)
    expect(await bandShown($, WIDE_BAND, surface)).toBe(false)
  }
})
