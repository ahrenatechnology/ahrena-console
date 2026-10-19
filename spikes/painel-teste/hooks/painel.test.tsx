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
const SESSAO = {
  session: { project: 'demo · a', id: 's1', state: 'ativa', lastActivity: NOW, sizeKb: 12 },
  needsYou: 2,
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

// Kanban do Project: três raias na ordem do Status; a primeira com mais cards que o limite.
const kcard = (id: string, n: number, statusId: string | null, extra: Record<string, unknown> = {}) => ({
  itemId: id, kind: 'Issue', key: `acme/app#${n}`, repo: 'acme/app', number: n, title: `Card ${n}`, url: `https://github.com/acme/app/issues/${n}`,
  state: 'OPEN', updatedAt: NOW, type: 'Task', parent: null, statusId, ...extra,
})
const OPTIONS = [
  { id: 'opt-todo', name: 'Todo', color: 'GREEN' },
  { id: 'opt-prog', name: 'In Progress', color: 'YELLOW' },
  { id: 'opt-done', name: 'Done', color: 'PURPLE' },
]
const KANBAN_ITEMS = [
  ...Array.from({ length: 10 }, (_, i) => kcard(`item-${i + 1}`, i + 1, 'opt-todo')),
  kcard('item-20', 20, 'opt-prog', { parent: 'acme/app#2', type: 'Spike' }),
  kcard('item-30', 30, 'opt-done', { state: 'CLOSED' }),
  kcard('item-40', 40, 'opt-done', { kind: 'DraftIssue', key: null, repo: null, number: null, url: null, type: null }),
]
const board = (items: ReturnType<typeof kcard>[]) => ({
  owner: 'acme', number: 1, title: 'Projeto de teste', url: 'https://github.com/orgs/acme/projects/1', field: 'Status',
  lanes: OPTIONS.map(o => ({ ...o, items: items.filter(i => i.statusId === o.id) })),
  count: items.length, fetchedAt: Date.now(), stale: false, staleReason: null,
})

const PANE = {
  component: 'Pane',
  requestId: 'ahrena-console',
  props: { title: 'Ahrena Console', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } },
} as const

type Call = { method: string; url: string; body: any }
// Núcleo falso: sessões, trabalho e o kanban; mover muda o Status do item, como o núcleo
// de verdade, ou falha com `moveError` (ex.: token sem o escopo `project`).
const fakeCore = (on: any, opts: { moveError?: { status: number; error: string } } = {}) => {
  const calls: Call[] = []
  let items = KANBAN_ITEMS.map(i => ({ ...i }))
  const reply = (status: number, body: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) } })
  on('http.fetch', async (_$: unknown, e: { url: string; init?: { method?: string; body?: string } }) => {
    const call = { method: e.init?.method ?? 'GET', url: e.url, body: e.init?.body ? JSON.parse(e.init.body) : undefined }
    calls.push(call)
    if (e.url.includes('/api/sessao/')) return reply(200, SESSAO)
    if (e.url.endsWith('/api/work')) return reply(200, WORK)
    if (call.method === 'POST' && e.url.endsWith('/api/kanban/move')) {
      if (opts.moveError) return reply(opts.moveError.status, { error: opts.moveError.error })
      items = items.map(i => (i.itemId === call.body.itemId ? { ...i, statusId: call.body.optionId } : i))
      return reply(200, board(items))
    }
    if (e.url.includes('/api/kanban')) return reply(200, board(items))
    return reply(200, FLEET)
  })
  const clock = mock.clock(on, { now: Date.now() })
  on('ui.status', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 'sessao-teste' }))
  return Object.assign(calls, { clock })
}

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
  await ui.select({ key: 'modo', value: 'kanban' })
  expect(await ui.find({ key: 'fluxo-narrow' })).toBeDefined()
  expect(await ui.find({ key: 'lane-revisao' })).toBeDefined()
  expect(await ui.find({ key: 'card-acme/app#3' })).toBeDefined()
  expect(await ui.find({ key: 'card-acme/app#4' })).toBeDefined()
  await ui.select({ key: 'modo', value: 'estagio' })
  await ui.select({ key: 'stage', value: 'ci falhou' })
  expect(await ui.find({ key: 'card-acme/app#3' })).toBeDefined()
  expect(await ui.find({ key: 'card-acme/app#4' })).toBeUndefined()
  await ui.unmount()
})

test('a aba Kanban mostra o GitHub Project por Status, na ordem das raias', async ($, on) => {
  fakeCore(on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'desktop', ...PANE })
  await ui.press({ key: 'retry' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab-kanban' })
  expect(await ui.find({ key: 'kanban-narrow' })).toBeDefined()
  for (const lane of ['lane-opt-todo', 'lane-opt-prog', 'lane-opt-done']) expect(await ui.find({ key: lane })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Projeto de teste/ })).toBeDefined()
  expect(await ui.find({ key: 'card-item-20' })).toBeDefined()
  expect(await ui.find({ key: 'card-item-40' })).toBeDefined()
  // A raia passa do limite: mostra os primeiros e abre o resto no "+N mais".
  expect(await ui.find({ key: 'card-item-8' })).toBeDefined()
  expect(await ui.find({ key: 'card-item-9' })).toBeUndefined()
  await ui.press({ key: 'more-opt-todo' })
  expect(await ui.find({ key: 'card-item-10' })).toBeDefined()
  // Na primeira raia não há para onde voltar; na última, para onde avançar.
  expect(await ui.find({ key: 'move-prev-item-1' })).toBeUndefined()
  expect(await ui.find({ key: 'move-next-item-30' })).toBeUndefined()
  expect(await ui.find({ key: 'move-prev-item-30' })).toBeDefined()
  // A busca filtra os cards.
  await ui.input({ key: 'busca-kanban', text: 'Card 20' })
  expect(await ui.find({ key: 'card-item-20' })).toBeDefined()
  expect(await ui.find({ key: 'card-item-1' })).toBeUndefined()
  await ui.unmount()
})

test('mover um card pede ao núcleo para mudar o Status e o card vai para a outra raia', async ($, on) => {
  const calls = fakeCore(on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'desktop', ...PANE })
  await ui.press({ key: 'retry' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab-kanban' })
  const reads = calls.filter(c => c.url.includes('/api/kanban')).length
  await ui.press({ key: 'move-next-item-1' })
  const move = calls.filter(c => c.method === 'POST')
  expect(move).toHaveLength(1)
  expect(move[0]!.url).toMatch(/\/api\/kanban\/move$/)
  expect(move[0]!.body).toEqual({ itemId: 'item-1', optionId: 'opt-prog' })
  // O núcleo devolve o quadro já atualizado: o painel não relê o kanban.
  expect(calls.filter(c => c.url.includes('/api/kanban')).length).toBe(reads + 1)
  // Agora em In Progress: dá para voltar a Todo e avançar a Done.
  expect(await ui.find({ key: 'move-prev-item-1' })).toBeDefined()
  expect(await ui.find({ key: 'move-next-item-1' })).toBeDefined()
  await ui.press({ key: 'move-prev-item-1' })
  expect(calls.filter(c => c.method === 'POST').at(-1)!.body).toEqual({ itemId: 'item-1', optionId: 'opt-todo' })
  expect(await ui.find({ key: 'move-prev-item-1' })).toBeUndefined()
  await ui.unmount()
})

test('sem permissão no Project, o painel mostra o erro e o card fica onde estava', async ($, on) => {
  fakeCore(on, { moveError: { status: 403, error: 'sem permissão no GitHub Project (o token do `gh` precisa do escopo `project`: rode `gh auth refresh -s project`)' } })
  const ui = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'desktop', ...PANE })
  await ui.press({ key: 'retry' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab-kanban' })
  await ui.press({ key: 'move-next-item-1' })
  expect(await ui.find({ type: 'Text', text: /Não deu para mover: .*gh auth refresh -s project/ })).toBeDefined()
  expect(await ui.find({ key: 'move-prev-item-1' })).toBeUndefined()
  expect(await ui.find({ key: 'move-next-item-1' })).toBeDefined()
  await ui.unmount()
})

test('em outras superfícies o painel cai para a versão simples', async ($, on) => {
  fakeCore(on)
  const desk = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'desktop', ...PANE })
  await desk.press({ key: 'retry' })
  await desk.unmount()
  const ui = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Esta sessão: ativa · 2 precisam de você/ })).toBeDefined()
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
  expect(await ui.find({ key: 'move-next-item-20' })).toBeDefined()
  await ui.press({ key: 'tab-trabalho' })
  await ui.select({ key: 'modo', value: 'kanban' })
  expect(await ui.find({ key: 'fluxo-wide' })).toBeDefined()
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
  await ui.press({ key: 'tab-kanban' })
  expect(await ui.find({ key: 'kanban-narrow' })).toBeDefined()
  expect(await ui.find({ key: 'move-next-item-1' })).toBeDefined()
  await ui.press({ key: 'tab-trabalho' })
  await ui.select({ key: 'modo', value: 'arvore' })
  await ui.press({ key: 'expand-all' })
  expect(await ui.find({ key: 'card-acme/app#3' })).toBeDefined()
  await ui.unmount()
})

// Engine falso para o ciclo de vida do painel: a lista de painéis abertos (`$.ui.panes()`)
// e o /console que abre, como o Claude Desktop faz. `pane.close()` é a pessoa fechando:
// o painel some da lista do engine.
const fakePanes = (on: any) => {
  const pane = { open: false, shown: true, close: () => { pane.open = false } }
  on('ui.panes', async () => ({
    value: pane.open ? [{ id: 'ahrena-console', title: 'Ahrena Console', isShown: pane.shown, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.open', async () => {
    pane.open = true
    return { value: { isPlaced: true } }
  })
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return pane
}
const CONSOLE = { command: 'console', args: '', origin: { kind: 'user' }, presentation: 'text' } as any

test('fechado não consulta: só com o painel aberto, e só a própria sessão', async ($, on) => {
  const calls = fakeCore(on)
  const pane = fakePanes(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  // Sessão aberta, painel fechado: um minuto sem nenhum pedido ao núcleo.
  await calls.clock.advance(60_000)
  expect(calls).toHaveLength(0)

  // /console abre o painel: um pedido a cada 5 s, só desta sessão; nunca a frota.
  await $.command.run(CONSOLE)
  await calls.clock.advance(30_000)
  expect(calls.length).toBeGreaterThanOrEqual(6)
  expect(calls.every(c => c.url.endsWith('/api/sessao/sessao-teste'))).toBe(true)

  // Fechou: no máximo o tick em curso, e mais nenhum pedido.
  pane.close()
  await calls.clock.advance(5_000)
  const fechado = calls.length
  await calls.clock.advance(60_000)
  expect(calls).toHaveLength(fechado)
})

test('aberto atrás de outra aba, o painel não consulta; à vista de novo, volta', async ($, on) => {
  const calls = fakeCore(on)
  const pane = fakePanes(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.command.run(CONSOLE)
  pane.shown = false
  await calls.clock.advance(5_000)
  const escondido = calls.length
  await calls.clock.advance(60_000)
  expect(calls).toHaveLength(escondido)
  pane.shown = true
  await calls.clock.advance(5_000)
  expect(calls.length).toBeGreaterThan(escondido)
})

test('a frota só é pedida com a aba dela à vista', async ($, on) => {
  const calls = fakeCore(on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console-painel', surface: 'desktop', ...PANE })
  await ui.press({ key: 'retry' })
  expect(await ui.find({ type: 'Text', text: /2 precisam de você/ })).toBeDefined()
  expect(calls.some(c => c.url.includes('/api/fleet'))).toBe(false)
  await ui.press({ key: 'tab-sessoes' })
  expect(calls.some(c => c.url.includes('/api/fleet'))).toBe(true)
  await ui.unmount()
})
