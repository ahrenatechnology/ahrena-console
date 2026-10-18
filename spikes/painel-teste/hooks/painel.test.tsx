import { expect, mock, test } from 'claude-code/testing'

const FLEET = {
  totals: { projects: 3, sessions: 10, active: 1, idle: 2, sizeMb: 5 },
  recent: [
    { project: 'demo · a', id: 's1', state: 'ativa', lastActivity: new Date().toISOString(), sizeKb: 12 },
    { project: 'demo · b', id: 's2', state: 'ociosa', lastActivity: new Date().toISOString(), sizeKb: 40 },
  ],
  activityByHour: [1, 0, 2, 3, 0, 0, 1, 0, 0, 0, 2, 4],
  topProjects: [{ project: 'demo · a', sessions: 7 }],
  generatedAt: new Date().toISOString(),
} as const

const PANE = {
  component: 'Pane',
  requestId: 'ahrena-console',
  props: { title: 'Ahrena Console', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 60 } },
} as const

const fakeCore = (on: Parameters<Parameters<typeof test>[1] & ((...a: never[]) => unknown)>[1] | any) =>
  (on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(FLEET) } })),
   mock.clock(on, { now: Date.now() }),
   on('ui.status', async () => ({ value: undefined })))

test('o painel desenha todos os componentes no desktop e reage a filtro e seleção', async ($, on) => {
  fakeCore(on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'desktop', ...PANE })
  await ui.press({ key: 'retry' })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ type: 'Client' })).toBeDefined()
  expect(await ui.find({ type: 'Select' })).toBeDefined()
  expect(await ui.find({ type: 'Input' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  expect(await ui.find({ type: 'Link' })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).length).toBeGreaterThan(3)

  await ui.press({ key: 's1' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()

  await ui.select({ key: 'filtro', value: 'ociosa' })
  expect(await ui.find({ key: 's1' })).toBeUndefined()
  expect(await ui.find({ key: 's2' })).toBeDefined()
  await ui.unmount()
})

test('em outras superfícies o painel cai para a versão simples', async ($, on) => {
  fakeCore(on)
  const desk = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'desktop', ...PANE })
  await desk.press({ key: 'retry' })
  await desk.unmount()
  const ui = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /1 ativa/ })).toBeDefined()
  await ui.unmount()
})

