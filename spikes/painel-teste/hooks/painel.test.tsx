import { expect, mock, test } from 'claude-code/testing'

const NOW = new Date().toISOString()
const FLEET = {
  totals: { projects: 3, sessions: 10, active: 1, idle: 2, sizeMb: 5 },
  recent: [
    { project: 'demo · a', id: 's1', state: 'ativa', lastActivity: NOW, sizeKb: 12 },
    { project: 'demo · b', id: 's2', state: 'ociosa', lastActivity: NOW, sizeKb: 40 },
  ],
  activityByHour: [1, 0, 2, 3, 0, 0, 1, 0, 0, 0, 2, 4],
  topProjects: [{ project: 'demo · a', sessions: 7 }],
  generatedAt: NOW,
}
const node = (key: string, type: string, children: string[], extra: Record<string, unknown> = {}) => ({
  key, repo: key.split('#')[0], number: Number(key.split('#')[1]), title: `Item ${key}`, url: `https://github.com/${key.replace('#', '/issues/')}`,
  state: 'OPEN', updatedAt: NOW, type, rank: 0, progress: children.length ? { total: children.length, completed: 0, pct: 0 } : null,
  assignees: [], labels: [], prs: [], stage: 'a fazer', parent: null, children, ...extra,
})
const WORK = {
  nodes: {
    'acme/app#1': node('acme/app#1', 'Initiative', ['acme/app#2']),
    'acme/app#2': node('acme/app#2', 'Epic / Milestone', ['acme/app#3'], { parent: 'acme/app#1' }),
    'acme/app#3': node('acme/app#3', 'Task', [], {
      parent: 'acme/app#2', stage: 'ci falhou',
      prs: [{ number: 9, state: 'OPEN', isDraft: false, url: 'https://github.com/acme/app/pull/9', review: null, ci: 'FAILURE' }],
    }),
    'acme/app#4': node('acme/app#4', 'Bug', []),
  },
  roots: ['acme/app#1', 'acme/app#4'],
  byType: { Initiative: 1, 'Epic / Milestone': 1, Task: 1, Bug: 1 },
  count: 4,
  generatedAt: NOW,
}

const PANE = {
  component: 'Pane',
  requestId: 'ahrena-console',
  props: { title: 'Ahrena Console', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } },
} as const

const fakeCore = (on: any) => (
  on('http.fetch', async (_$: unknown, e: { url: string }) => ({
    value: { status: 200, ok: true, headers: {}, text: JSON.stringify(e.url.endsWith('/api/work') ? WORK : FLEET) },
  })),
  mock.clock(on, { now: Date.now() }),
  on('ui.status', async () => ({ value: undefined }))
)

test('a aba Sessões desenha os componentes e reage a filtro e seleção', async ($, on) => {
  fakeCore(on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'desktop', ...PANE })
  await ui.press({ key: 'retry' })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ type: 'Client' })).toBeDefined()
  await ui.press({ key: 'tab-sessoes' })
  expect(await ui.find({ type: 'Select' })).toBeDefined()
  expect(await ui.find({ type: 'Input' })).toBeDefined()
  await ui.press({ key: 's1' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  await ui.select({ key: 'filtro', value: 'ociosa' })
  expect(await ui.find({ key: 's1' })).toBeUndefined()
  expect(await ui.find({ key: 's2' })).toBeDefined()
  await ui.unmount()
})

test('a aba Trabalho mostra a hierarquia em cards e agrupa por estágio', async ($, on) => {
  fakeCore(on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'desktop', ...PANE })
  await ui.press({ key: 'retry' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab-trabalho' })
  await ui.select({ key: 'modo', value: 'arvore' })
  expect(await ui.find({ key: 'card-acme/app#1' })).toBeDefined()
  expect(await ui.find({ key: 'card-acme/app#2' })).toBeUndefined()
  await ui.press({ key: 'toggle-acme/app#1' })
  expect(await ui.find({ key: 'card-acme/app#2' })).toBeDefined()
  await ui.press({ key: 'expand-all' })
  expect(await ui.find({ key: 'card-acme/app#3' })).toBeDefined()
  await ui.press({ key: 'tab-kanban' })
  expect(await ui.find({ key: 'kanban-narrow' })).toBeDefined()
  expect(await ui.find({ key: 'lane-revisao' })).toBeDefined()
  expect(await ui.find({ key: 'card-acme/app#3' })).toBeDefined()
  expect(await ui.find({ key: 'card-acme/app#4' })).toBeDefined()
  await ui.press({ key: 'tab-trabalho' })
  await ui.select({ key: 'modo', value: 'estagio' })
  await ui.select({ key: 'stage', value: 'ci falhou' })
  expect(await ui.find({ key: 'card-acme/app#3' })).toBeDefined()
  expect(await ui.find({ key: 'card-acme/app#4' })).toBeUndefined()
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

test('com o painel largo, as raias do kanban ficam lado a lado', async ($, on) => {
  fakeCore(on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'desktop', ...PANE, props: { ...PANE.props, bodyColumns: 180 } })
  await ui.press({ key: 'retry' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab-kanban' })
  expect(await ui.find({ key: 'kanban-wide' })).toBeDefined()
  expect(await ui.find({ key: 'kanban-narrow' })).toBeUndefined()
  await ui.unmount()
})

test('num painel bem estreito tudo continua desenhando', async ($, on) => {
  fakeCore(on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'desktop', ...PANE, props: { ...PANE.props, bodyColumns: 36 } })
  await ui.press({ key: 'retry' })
  await ui.press({ key: 'refresh' })
  for (const tab of ['visao', 'kanban', 'trabalho', 'sessoes']) {
    await ui.press({ key: `tab-${tab}` })
    expect(await ui.find({ type: 'Button' })).toBeDefined()
  }
  await ui.press({ key: 'tab-trabalho' })
  await ui.select({ key: 'modo', value: 'arvore' })
  await ui.press({ key: 'expand-all' })
  expect(await ui.find({ key: 'card-acme/app#3' })).toBeDefined()
  await ui.unmount()
})
