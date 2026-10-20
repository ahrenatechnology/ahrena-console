// #146: o grafo da sessão com os subagentes (wireframes P11 a P13). Os cenários P12 e P13 são a
// resposta do núcleo montada dos eventos gravados pelo simulador (packages/nucleo/test/api/record-panel-scenarios.ts).
import { expect, mock, test } from 'claude-code/testing'

import type { Panel, PanelSubagent } from '../types'
import { GROUP_ABOVE, GRAPH_STATE, buildGraph, wavesOf, paginate, type GraphLine } from '../hooks/graph'
import { NOW, SCENARIOS } from './scenarios'

const P12 = SCENARIOS.p12.subagents.items
const P13 = SCENARIOS.p13.subagents.items

/** Uma linha do grafo em texto curto, para comparar a ordem e o trilho. */
const summary = (l: GraphLine) => (l.type === 'wave' ? `${l.open ? '▾' : '▸'} Onda ${l.number}` : `${l.rail}${l.sub.name}${l.sub.task ? ` · ${l.sub.task}` : ''}`)

// --- A montagem, sem desenho ---

test('P12: up to 10 subagents, the plain tree in start order, no waves', () => {
  const g = buildGraph(P12, NOW)
  expect(g.grouped).toBe(false)
  expect(g.lines.map(summary)).toEqual(['├Plan · plano da extração', '├Explore · achar usos', '╰test-runner · bateria'])
  // O Explore e o test-runner rodaram juntos: um começou com o outro rodando.
  expect(g.parallel).toBe(1)
  expect(g.count).toEqual({ active: 1, completed: 2, errors: 0 })
})

test('P13: over 10, by wave; a wave with active ones opens, all-completed ones collapse, the error stays under its parent', () => {
  const g = buildGraph(P13, NOW)
  expect(P13.length).toBeGreaterThan(GROUP_ABOVE)
  expect(g.grouped).toBe(true)
  expect(g.count).toEqual({ active: 4, completed: 20, errors: 1 })
  expect(g.lines.map(summary)).toEqual([
    '▸ Onda 1',
    '▸ Onda 2',
    '  ╰test-runner · lint e tipos',
    '▸ Onda 3',
    '▾ Onda 4',
    '  ├general-purpose · migrar a cobrança',
    '  │ ├Explore · rotas de cobrança',
    '  │ ├Explore · webhooks',
    '  │ ├general-purpose · contratos',
    '  │ ╰test-runner · api de cobrança',
    '  ├docs-writer · README do serviço',
    '  ├code-reviewer · diff do serviço',
    '  ╰test-runner · e2e',
    '▸ Onda 5',
  ])
  const waves = g.lines.filter((l): l is Extract<GraphLine, { type: 'wave' }> => l.type === 'wave')
  expect(waves.map((o) => [o.total, o.count])).toEqual([
    [6, { active: 0, completed: 6, errors: 0 }],
    [6, { active: 0, completed: 5, errors: 1 }],
    [1, { active: 0, completed: 1, errors: 0 }],
    [10, { active: 4, completed: 6, errors: 0 }],
    [2, { active: 0, completed: 2, errors: 0 }],
  ])
  expect(waves[0]!.types).toEqual(['Explore'])
  // Do 3º nível para baixo, sem linha própria: o "+2 ✓" na linha do general-purpose de contratos.
  const contracts = g.lines.find((l) => l.type === 'node' && l.sub.task === 'contratos')
  expect(contracts?.type === 'node' && contracts.more).toEqual({ active: 0, completed: 2, errors: 0 })
  expect(g.lines.some((l) => l.type === 'node' && l.sub.task === 'esquemas')).toBe(false)
})

test('P13: the person opens and closes a wave; collapsed, the active and the errored stay visible', () => {
  const g = buildGraph(P13, NOW, { ...GRAPH_STATE, opened: [1], closed: [4] })
  const names = g.lines.map(summary)
  expect(names.slice(0, 7)).toEqual(['▾ Onda 1', '  ├Explore · mapear módulos', '  ├Explore · rotas', '  ├Explore · modelos', '  ├Explore · eventos', '  ├Explore · filas', '  ╰Explore · configuração'])
  const i = names.indexOf('▸ Onda 4')
  expect(names.slice(i, i + 5)).toEqual(['▸ Onda 4', '  ├general-purpose · migrar a cobrança', '  ├code-reviewer · diff do serviço', '  ├test-runner · e2e', '  ╰test-runner · api de cobrança'])
})

test('P13: the "Ativos e erros" filter keeps the active, the errored and whoever spawned them', () => {
  const g = buildGraph(P13, NOW, { ...GRAPH_STATE, filter: 'active' })
  expect(g.lines.map(summary)).toEqual([
    '▾ Onda 2',
    '  ╰test-runner · lint e tipos',
    '▾ Onda 4',
    '  ├general-purpose · migrar a cobrança',
    '  │ ╰test-runner · api de cobrança',
    '  ├code-reviewer · diff do serviço',
    '  ╰test-runner · e2e',
  ])
})

test(`without the core's wave, groups by overlap in time; a nested one goes with its parent`, () => {
  const sub = (id: string, start: number, end: number | null, parent: string | null = null): PanelSubagent => ({
    id, name: 'Explore', task: id, status: end === null ? 'working' : 'completed',
    since: new Date(NOW - (60 - start) * 60_000).toISOString(), until: end === null ? null : new Date(NOW - (60 - end) * 60_000).toISOString(), parent, wave: null,
  })
  const items = [sub('a', 0, 5), sub('b', 2, 8), sub('c', 10, 12), sub('d', 11, 20, 'c'), sub('e', 30, null)]
  const waves = wavesOf(items, NOW)
  expect(['a', 'b', 'c', 'd', 'e'].map((id) => waves.get(id))).toEqual([1, 1, 2, 2, 3])
})

test(`paginate: the page's lines, one of them the "⋯ +N"; a page past the last becomes the last`, () => {
  const l = Array.from({ length: 10 }, (_, i) => i)
  expect(paginate(l, 20, 0)).toEqual({ lines: l, page: 0, pages: 1, after: 0 })
  expect(paginate(l, 4, 0)).toEqual({ lines: [0, 1, 2], page: 0, pages: 4, after: 7 })
  expect(paginate(l, 4, 3)).toEqual({ lines: [9], page: 3, pages: 4, after: 0 })
  expect(paginate(l, 4, 9).page).toBe(3)
})

// --- No painel ---

const PANE = {
  component: 'Pane',
  requestId: 'ahrena-console-sessao',
  props: { title: 'Ahrena Console', isFocused: true, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } },
} as const
const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 121 } }
const high = (base: typeof PANE | typeof WIDE, lines: number) => ({ ...base, props: { ...base.props, scroll: { offset: 0, bodyRows: lines } } })
const CONSOLE = { command: 'console', args: '', origin: { kind: 'user' }, presentation: 'text' } as any

async function open($: any, on: any, panel: Panel) {
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(panel) } }))
  const timer = mock.clock(on, { now: NOW })
  mock.env(on, {})
  const pane = { open: false }
  on('ui.status', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 'sessao-teste' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', async () => ({ value: '/simulacao/vitrine-demo' }))
  on('ui.panes', async () => ({ value: pane.open ? [{ id: 'ahrena-console-sessao', title: 'Ahrena Console', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.open', async () => {
    pane.open = true
    return { value: { isPlaced: true } }
  })
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.command.run(CONSOLE)
  await timer.advance(0)
  return { timer }
}

/** As linhas do grafo na tela, pela key, na ordem. */
async function linesOnScreen(ui: any): Promise<string[]> {
  return (await ui.findAll({ type: 'Box' })).map((b: any) => b.key as string).filter((k: string) => /^graph-(root|wave|node)/.test(k ?? ''))
}

test('P11: the Subagents card footer opens the graph: "ver o grafo ›" with all in the card, "+N · E com erro · grafo ›" with more', async ($, on) => {
  await open($, on, SCENARIOS.p12)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect((await ui.find({ key: 'show-subagents' }))?.props.label).toBe('ver o grafo ›')
  await ui.unmount()
})

test('P11: with 25, "+22 · 1 com erro · grafo ›", in both widths', async ($, on) => {
  await open($, on, SCENARIOS.p13)
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    expect((await ui.find({ key: 'show-subagents' }))?.props.label).toBe('+22 · 1 com erro · grafo ›')
    await ui.unmount()
  }
})

test('P12: the graph in place of the cards, in both widths: ruler, root, one node per subagent and "← voltar"', async ($, on) => {
  await open($, on, SCENARIOS.p12)
  for (const [target, title] of [[PANE, /GRAFO · 3$/], [WIDE, /GRAFO · 3 SUBAGENTES/]] as const) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    await ui.press({ key: 'show-subagents' })
    expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
    expect(await ui.find({ key: 'card-subagents' })).toBeUndefined()
    const ids = P12.map((s) => s.id).sort((a, b) => Date.parse(P12.find((x) => x.id === a)!.since) - Date.parse(P12.find((x) => x.id === b)!.since))
    expect(await linesOnScreen(ui)).toEqual(['graph-root', ...ids.map((id) => `graph-node-${id}`)])
    // Sem ondas nem filtro até 10 subagentes; sem paginação quando cabe.
    expect(await ui.find({ key: 'graph-filter' })).toBeUndefined()
    expect(await ui.find({ key: 'graph-next' })).toBeUndefined()
    // Todo Svg com largura e altura explícitas.
    for (const s of await ui.findAll({ type: 'Svg' })) expect([typeof s.props.width, typeof s.props.height]).toEqual(['number', 'number'])
    // Toda linha numa linha só: nada quebra.
    for (const t of await ui.findAll({ type: 'Text' })) expect(t.props.wrap).not.toBe('wrap')
    if (target === WIDE) {
      expect(await ui.find({ type: 'Text', text: /1 em paralelo/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /barras sobrepostas rodaram em paralelo/ })).toBeDefined()
    }
    await ui.press({ key: 'close-graph' })
    expect(await ui.find({ key: 'card-subagents' })).toBeDefined()
    await ui.unmount()
  }
})

test('P13 wide: the waves, wave 4 open, the loose error and the filter; ▸ opens the wave', async ($, on) => {
  await open($, on, SCENARIOS.p13)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  await ui.press({ key: 'show-subagents' })
  expect(await ui.find({ type: 'Text', text: /GRAFO · 25 SUBAGENTES/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 com erro/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /4 ativos/ })).toBeDefined()
  expect((await ui.find({ key: 'wave-1' }))?.props.label).toBe('▸ Onda 1')
  expect((await ui.find({ key: 'wave-4' }))?.props.label).toBe('▾ Onda 4')
  expect(await ui.find({ key: 'graph-filter' })).toBeDefined()
  expect(await ui.find({ key: 'graph-next' })).toBeUndefined()
  const before = (await linesOnScreen(ui)).length
  await ui.press({ key: 'wave-1' })
  expect((await ui.find({ key: 'wave-1' }))?.props.label).toBe('▾ Onda 1')
  expect((await linesOnScreen(ui)).length).toBe(before + 6)
  await ui.press({ key: 'wave-1' })
  expect((await linesOnScreen(ui)).length).toBe(before)
  await ui.unmount()
})

test('P13 narrow: pages by height, ‹ 1/2 ›, never cutting a line; the "⋯ +N" says what comes next', async ($, on) => {
  await open($, on, SCENARIOS.p13)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(PANE, 36) })
  await ui.press({ key: 'show-subagents' })
  expect(await ui.find({ type: 'Text', text: /GRAFO · 25$/ })).toBeDefined()
  const page1 = await linesOnScreen(ui)
  expect(await ui.find({ key: 'graph-next' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1\/\d$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⋯ \+\d+ na pág\. 2/ })).toBeDefined()
  await ui.press({ key: 'graph-next' })
  const page2 = await linesOnScreen(ui)
  expect(await ui.find({ type: 'Text', text: /^2\/\d$/ })).toBeDefined()
  // A raiz se repete; as outras linhas não.
  expect(page2.filter((k) => k !== 'graph-root' && page1.includes(k))).toEqual([])
  await ui.press({ key: 'graph-previous' })
  expect(await linesOnScreen(ui)).toEqual(page1)
  await ui.unmount()
})

test('P13: an open graph stays open, on the same page, after a tick with no change', async ($, on) => {
  const { timer } = await open($, on, SCENARIOS.p13)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  await ui.press({ key: 'show-subagents' })
  await ui.press({ key: 'wave-3' })
  await timer.advance(5_000)
  expect((await ui.find({ key: 'wave-3' }))?.props.label).toBe('▾ Onda 3')
  await ui.unmount()
})
