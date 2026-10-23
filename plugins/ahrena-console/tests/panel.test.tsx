import { expect, mock, test } from 'claude-code/testing'

import type { Panel } from '../types'
import { paleta } from '../hooks/brand'
import { UNCUT_COLUMNS, modelLine, viewLines, highlightedSteps, sessionPills } from '../hooks/render'
import { CARD_LINES } from '../hooks/height'
import { clockTime } from '../hooks/format'
import { NOW, SCENARIOS } from './scenarios'

type ScenarioName = keyof typeof SCENARIOS
type Request = { method: string; url: string }

const PANE = {
  component: 'Pane',
  requestId: 'ahrena-console-sessao',
  props: { title: 'Ahrena Console', isFocused: true, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } },
} as const
const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 121 } }
const CONSOLE = { command: 'console', args: '', origin: { kind: 'user' }, presentation: 'text' } as any

// Núcleo e engine falsos: o núcleo responde o cenário pedido (ou cai, com `outside`); o engine tem
// a lista de painéis abertos, o /console que abre e o ambiente da sessão, como o Claude Desktop.
function fakes(on: any, opts: { scenario?: ScenarioName; outside?: boolean; env?: Record<string, string>; noRoom?: string } = {}) {
  const requests: Request[] = []
  const state: { scenario: ScenarioName; outside: boolean; panel?: Panel } = { scenario: opts.scenario ?? 'p1', outside: opts.outside ?? false }
  on('http.fetch', async (_$: unknown, e: { url: string; init?: { method?: string } }) => {
    // The orders of the console (#61) have their own clock and their own test (orders.test.tsx).
    if (/\/api\/sessions\/[^/]+\/commands/.test(e.url)) return { value: { status: 200, ok: true, headers: {}, text: '{"orders":[]}' } }
    requests.push({ method: e.init?.method ?? 'GET', url: e.url })
    if (state.outside) throw new Error('connect ECONNREFUSED 127.0.0.1:4720')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(state.panel ?? SCENARIOS[state.scenario]) } }
  })
  const timer = mock.clock(on, { now: NOW })
  mock.env(on, opts.env ?? {})
  const pane = { open: false, shown: true }
  const status: (string | undefined)[] = []
  on('ui.status', async (_$: unknown, e: { text?: string }) => {
    status.push(e?.text)
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', async (_$: unknown, e: { text?: string } | string) => {
    toasts.push(typeof e === 'string' ? e : (e?.text ?? ''))
    return { value: undefined }
  })
  on('session.id', async () => ({ value: 'sessao-teste' }))
  on('session.model', async () => ({ value: 'claude-sonnet-5-5' }))
  on('session.cwd', async () => ({ value: '/simulacao/cli-de-notas' }))
  on('ui.panes', async () => ({
    value: pane.open ? [{ id: 'ahrena-console-sessao', title: 'Ahrena Console', isShown: pane.shown, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.open', async () => {
    if (opts.noRoom) return { value: { isPlaced: false, reason: opts.noRoom } }
    pane.open = true
    return { value: { isPlaced: true } }
  })
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return { requests, timer, pane, state, status, toasts }
}

async function open($: any, on: any, opts: Parameters<typeof fakes>[1] = {}) {
  const f = fakes(on, opts)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.command.run(CONSOLE)
  return f
}

const CARDS = ['card-session', 'card-context', 'card-work', 'card-plan', 'card-subagents', 'card-children']

test('closed, it does not poll: only with the panel open, one request every 5 s, only for this session', async ($, on) => {
  const f = fakes(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await f.timer.advance(60_000)
  expect(f.requests).toHaveLength(0)

  await $.command.run(CONSOLE)
  await f.timer.advance(30_000)
  expect(f.requests.length).toBeGreaterThanOrEqual(6)
  expect(f.requests.length).toBeLessThanOrEqual(8)
  expect(f.requests.every((p) => p.method === 'GET' && p.url.startsWith('http://127.0.0.1:4720/api/panel/sessao-teste'))).toBe(true)

  // Fechou: no máximo o tick em curso, e mais nenhum pedido.
  f.pane.open = false
  await f.timer.advance(5_000)
  const closed = f.requests.length
  await f.timer.advance(60_000)
  expect(f.requests).toHaveLength(closed)
})

test('behind another tab it does not poll; visible again, it resumes', async ($, on) => {
  const f = await open($, on)
  f.pane.shown = false
  await f.timer.advance(5_000)
  const hidden = f.requests.length
  await f.timer.advance(60_000)
  expect(f.requests).toHaveLength(hidden)
  f.pane.shown = true
  await f.timer.advance(5_000)
  expect(f.requests.length).toBeGreaterThan(hidden)
})

test('sends what it reads from the environment: account, org, Desktop session, model and folder (decision 0006)', async ($, on) => {
  const f = await open($, on, {
    env: {
      CLAUDE_CODE_ACCOUNT_UUID: '00000000-0000-4000-8000-00000000000a',
      CLAUDE_CODE_ORGANIZATION_UUID: '00000000-0000-4000-8000-0000000000aa',
      CLAUDE_CODE_HOST_SESSION_ID: 'local_00000000-0000-4000-8000-000000000001',
    },
  })
  await f.timer.advance(5_000)
  const url = new URL(f.requests[0]!.url)
  expect(url.searchParams.get('account')).toBe('00000000-0000-4000-8000-00000000000a')
  expect(url.searchParams.get('org')).toBe('00000000-0000-4000-8000-0000000000aa')
  expect(url.searchParams.get('local')).toBe('local_00000000-0000-4000-8000-000000000001')
  expect(url.searchParams.get('model')).toBe('claude-sonnet-5-5')
  expect(url.searchParams.get('cwd')).toBe('/simulacao/cli-de-notas')
})

test('P1 narrow and wide: the six cards, all the same size, and "1 precisa de você" (#140: the interrupted one is only your turn)', async ($, on) => {
  const f = await open($, on)
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    for (const key of CARDS) expect(await ui.find({ key })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Kanban de sessões no artefato/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /rodando Bash · npm test/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5 · 12 min · turno 18/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~US\$ 1,8/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#42/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 precisa de você/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 na sua vez/ })).toBeDefined()
    expect(await ui.find({ key: 'show-need-you' })).toBeDefined()
    expect(await ui.find({ key: 'banner' })).toBeUndefined()
    await ui.unmount()
  }
  expect(f.status.at(-1)).toBe('ahrena-console ● Ativa · 1 precisa de você')
})

test('P2 and P3: the banner carries the question or the permission; P5: the error', async ($, on) => {
  const f = await open($, on, { scenario: 'p2' })
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  expect(await ui.find({ key: 'banner' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sigo com SQLite em memória ou subo um Postgres no Docker\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3 opções · responda na conversa ao lado/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ninguém mais precisa de você/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sem PR · branch sem push/ })).toBeDefined()
  await ui.unmount()

  f.state.scenario = 'p3'
  await f.timer.advance(5_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  expect(await ui.find({ type: 'Text', text: /Bash quer rodar npm run migrate em \/simulacao\/motor-de-regras/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /permitir ou negar na conversa ao lado/ })).toBeDefined()
  await ui.unmount()

  f.state.scenario = 'p5'
  await f.timer.advance(5_000)
  // Alto o bastante para tudo aparecer inteiro: este teste é do conteúdo, não da altura.
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 120 } } })
  expect(await ui.find({ type: 'Text', text: /API 529 · overloaded_error/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /mande uma mensagem na conversa para retomar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /CI ✕ 2 falhas/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ajustes pedidos/ })).toBeDefined()
  await ui.unmount()
  expect(f.status.at(-1)).toBe('ahrena-console ✕ Com erro · 1 precisa de você')
})

test('P4: parallel subagents and the child sessions', async ($, on) => {
  await open($, on, { scenario: 'p4' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /esperando 3 subagentes/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3 ativos/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /code-reviewer/ })).toBeDefined()
  // P1: até 3 linhas, os ativos primeiro; o concluído fica fora, e o pé abre o grafo (P11).
  expect((await ui.find({ key: 'show-subagents' }))?.props.label).toBe('+1 · grafo ›')
  // Filhas (pnFilhas do P1): até 3 linhas, a ativa primeiro; a ociosa, "Ociosa" neutra à direita (#245); "ver todas".
  const children = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('child-')).map((b) => b.key)
  expect(children).toEqual(['child-sim-panel-catalogo-exemplo', 'child-sim-panel-fila-de-tarefas', 'child-sim-panel-blog-estatico'])
  const idle = await ui.find({ type: 'Text', text: 'Ociosa' })
  expect(idle?.props.color).toBe(paleta.gray['200'])
  // Com as 3 à vista, sem "ver todas": o link seria redundante.
  expect(await ui.find({ key: 'show-children' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /CI … 3\/7/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /aprovado/ })).toBeDefined()
  await ui.unmount()
})

test('CI with counts: "CI ✓ 6/6", "CI ✕ 2 falhas", "CI … 3/7"; without the count, as before', async ($, on) => {
  const f = await open($, on, { scenario: 'p4' })
  const p4 = SCENARIOS.p4
  const cases: [NonNullable<NonNullable<Panel['work']>['pr']>['ci'], { total: number; ok: number; failed: number; running: number } | null, RegExp][] = [
    ['ok', { total: 6, ok: 6, failed: 0, running: 0 }, /CI ✓ 6\/6/],
    ['failed', { total: 7, ok: 5, failed: 2, running: 0 }, /CI ✕ 2 falhas/],
    ['failed', { total: 3, ok: 2, failed: 1, running: 0 }, /CI ✕ 1 falha $/],
    ['running', { total: 7, ok: 3, failed: 0, running: 4 }, /CI … 3\/7/],
    ['ok', null, /^ CI ✓ $/],
  ]
  for (const [ci, checks, re] of cases) {
    f.state.panel = { ...p4, work: { ...p4.work!, pr: { ...p4.work!.pr!, ci, checks } } }
    // Só o texto da pílula muda: aparece no redesenho seguinte ao intervalo mínimo.
    await f.timer.advance(15_000)
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
    expect(await ui.find({ type: 'Text', text: re })).toBeDefined()
    await ui.unmount()
  }
})

test(`0.0.14: nothing cut and no raw markdown; the org's e-mail never shows`, async ($, on) => {
  const f = await open($, on, { scenario: 'p1' })
  const p1 = SCENARIOS.p1
  const account = { ...(p1.session!.account ?? { id: 'c', color: '#1baf7a', source: 'config' as const }), label: "pessoa@exemplo.test's Organization" }
  f.state.panel = {
    ...p1,
    session: { ...p1.session!, account, state: 'waiting', status: 'waiting', reason: 'stop', activity: { type: 'your-turn', text: '"Fechei o [#131](#local_00000000-0000-4000-8000-000000000001) com **tudo** verde e o `npm test` ok"' } },
    needYou: { ...p1.needYou, total: 0, yourTurn: 2, byAccount: [{ account, n: 1 }] },
    prs: { total: 1, items: [{ number: 7, title: 'pr sintético', url: 'https://example.invalid/pr/7', repo: 'exemplo/sintetico', session: { id: 's', title: 'sessão sintética', local: null } }] },
    work: { branch: 'feat/podium-replay-com-um-nome-sintetico-bem-comprido', repo: 'exemplo/sintetico', issue: null, pr: null, notPushed: false, error: null },
  }
  await f.timer.advance(5_000)
  for (const [base, lines] of [[PANE, 45], [PANE, 120], [WIDE, 120]] as const) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, lines) })
    const texts = (await ui.findAll({ type: 'Text' })).map((t) => t.text ?? '')
    // O e-mail não aparece em lugar nenhum; a org pessoal é "conta pessoal".
    expect(texts.some((t) => t.includes('@'))).toBe(false)
    expect(texts.some((t) => /conta pessoal/.test(t))).toBe(true)
    // A última mensagem sem o markdown cru, numa linha só, encurtada pelo mod (0.0.32).
    expect(texts.some((t) => /"Fechei o #131 com tudo verde e o npm\S*…$/.test(t))).toBe(true)
    expect(texts.some((t) => /\]\(|\*\*|`/.test(t))).toBe(false)
    // As faixas de uma linha quebram em vez de cortar.
    const needYou = await ui.find({ key: 'need-you' })
    expect(needYou?.text).toMatch(/○ ninguém mais precisa de você · 2 na sua vez/)
    expect((await ui.findAll({ type: 'Text' })).find((t) => /ninguém mais precisa de você/.test(t.text ?? ''))?.props.wrap).toBe('wrap')
    expect((await ui.find({ key: 'prs' }))?.text).toMatch(base === PANE ? /⇄ 1 PR p\/ aprovar/ : /⇄ 1 PR aguardando sua aprovação/)
    // O branch numa linha, com reticências no fim (P1), encurtado pelo mod (0.0.32).
    expect(texts.some((t) => /⎇ feat\/podium-replay-com-um-nome-\S*…$/.test(t))).toBe(true)
    expect(texts.some((t) => /feat\/podium-rep[^l]*…/.test(t))).toBe(false)
    await ui.unmount()
  }
})

test('0.0.15: the account name never gets cut next to "ESTA SESSÃO"; when narrow the chip shortens to "5 s" or goes away', async ($, on) => {
  const f = await open($, on, { scenario: 'p1' })
  const p1 = SCENARIOS.p1
  const withAccount = (label: string): Panel => ({ ...p1, session: { ...p1.session!, account: { id: 'c', label, color: '#1baf7a', source: 'config' } } })
  const cases: [string, string | null][] = [['conta pessoal', '5 s'], ['cliente sintético longo!', null]]
  for (const [label, chip] of cases) {
    f.state.panel = withAccount(label)
    await f.timer.advance(15_000)
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
    const section = await ui.find({ key: 'section-ESTA SESSÃO' })
    expect(section?.text).toMatch(new RegExp(`◆ ${label}`))
    if (chip) expect(section?.text).toMatch(/5 s$/)
    else expect(section?.text).not.toMatch(/5 s/)
    await ui.unmount()
  }
  // No largo, o chip inteiro.
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  expect((await ui.find({ key: 'section-ESTA SESSÃO' }))?.text).toMatch(/auto · 5 s/)
  await ui.unmount()
})

test('0.0.20: every Svg in the panel has an explicit, bounded width and height (the Desktop stretches the ones without)', async ($, on) => {
  const f = await open($, on, { scenario: 'p1' })
  const ALT_LIMIT: Record<string, number> = { 'Ahrena Console': 28, 'sem conexão': 24 }
  for (const panel of [SCENARIOS.p1, SCENARIOS.p4, SCENARIOS.p6, loaded()]) {
    f.state.panel = panel
    await f.timer.advance(15_000)
    for (const base of [PANE, WIDE]) {
      const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, 120) })
      const svgs = await ui.findAll({ type: 'Svg' })
      expect(svgs.length).toBeGreaterThan(0)
      for (const svg of svgs) {
        const { width, height, alt } = svg.props as { width?: number; height?: number; alt: string }
        expect([alt, typeof width, typeof height]).toEqual([alt, 'number', 'number'])
        // As barras e a linha do custo são finas; o anel do plano e o logo, quadrados pequenos.
        const max = ALT_LIMIT[alt] ?? (/^plano /.test(alt) ? 50 : 10)
        expect([alt, height! <= max]).toEqual([alt, true])
        expect([alt, width! <= 240]).toEqual([alt, true])
      }
      await ui.unmount()
    }
  }
})

test('0.0.20: Subagents with 20 and 0 active: the thin bar, 3 lines and "+17 · grafo ›"', async ($, on) => {
  const f = await open($, on, { scenario: 'p4' })
  const p4 = SCENARIOS.p4
  const base = p4.subagents.items.find((i) => i.status === 'completed')!
  const items = Array.from({ length: 20 }, (_, i) => ({ ...base, id: `sim-sub-${i}`, name: 'general-purpose', task: `Revisar a parte ${i}`, until: new Date(NOW - i * 60_000).toISOString() }))
  f.state.panel = { ...p4, subagents: { active: 0, items } }
  await f.timer.advance(15_000)
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    const card = await ui.find({ key: 'card-subagents' })
    expect(card?.text).toMatch(/SUBAGENTES\s*0 ativos/)
    const bar = (await ui.findAll({ type: 'Svg' })).find((x) => x.props.alt === '0 ativos de 20')
    expect([bar?.props.width, bar?.props.height]).toEqual([236, 5])
    const lines = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('sub-'))
    expect(lines.map((b) => b.key)).toEqual(['sub-sim-sub-0', 'sub-sim-sub-1', 'sub-sim-sub-2'])
    expect((await ui.find({ key: 'show-subagents' }))?.props.label).toBe('+17 · grafo ›')
    await ui.unmount()
  }
})

test(`0.0.21 (Fernando's decision): what needs attention comes at the top, before the cards; the neutral, below`, async ($, on) => {
  on('tool.call', async () => ({ result: 'ok' }))
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  const f = await open($, on, { scenario: 'p1' })
  const p1 = SCENARIOS.p1
  const pr = { number: 7, title: 'pr sintético', url: 'https://example.invalid/pr/7', repo: 'exemplo/sintetico', session: { id: 's', title: 'sessão sintética', local: null } }
  // Tudo pendente: a pergunta, quem precisa, os PRs e as a confirmar no topo, nessa ordem.
  await ($ as any).tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'feito', ask: 'Sigo?' })
  f.state.panel = { ...p1, prs: { total: 1, items: [pr] }, decisions: { current: 4, toConfirm: 1, resume: null, list: null } }
  await f.timer.advance(5_000)
  for (const base of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, 200) })
    const keys = ['question', 'need-you', 'prs', 'to-confirm', 'card-session', 'decisions']
    const pos = await Promise.all(keys.map(async (k) => (await ui.findAll({ type: 'Box' })).findIndex((b: any) => b.key === k)))
    expect(pos.every((x) => x >= 0)).toBe(true)
    expect([...pos].sort((a, b) => a - b)).toEqual(pos)
    await ui.unmount()
  }
  // Nada pendente: o topo não ganha faixa; "ninguém mais precisa de você" fica embaixo, depois dos cards.
  await ($ as any).prompt.submit({ text: 'sim', origin: { kind: 'sdk' } })
  f.state.panel = { ...p1, needYou: { ...p1.needYou, total: 0, yourTurn: 0 }, prs: { total: 0, items: [] }, decisions: { current: 4, toConfirm: 0, resume: null, list: null } }
  await f.timer.advance(15_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(PANE, 200) })
  const boxes = await ui.findAll({ type: 'Box' })
  for (const k of ['question', 'prs', 'to-confirm']) expect(boxes.some((b: any) => b.key === k)).toBe(false)
  const idx = (k: string) => boxes.findIndex((b: any) => b.key === k)
  expect(idx('card-children')).toBeLessThan(idx('decisions'))
  expect(idx('decisions')).toBeLessThan(idx('need-you'))
  await ui.unmount()
})

test('every card has 10 lines (~190 px on the Desktop) and the same breathing room, with two spaces at the bottom', async ($, on) => {
  const f = await open($, on, { scenario: 'p4' })
  for (const panel of [SCENARIOS.p1, SCENARIOS.p4, SCENARIOS.p6, loaded()]) {
    f.state.panel = panel
    await f.timer.advance(15_000)
    for (const base of [PANE, WIDE]) {
      const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, 200) })
      const cards = (await ui.findAll({ type: 'Box' })).filter((b: any) => /^card-/.test(b.key ?? ''))
      expect(cards.length).toBeGreaterThanOrEqual(5)
      for (const card of cards) {
        expect([card.key, card.props.height, card.props.paddingX, card.props.paddingBottom]).toEqual([card.key, 10, 1, 2])
      }
      await ui.unmount()
    }
  }
})

test('0.0.22: the PRs to review open straight on GitHub: with one, the banner is the link; with several, one link per PR in the list', async ($, on) => {
  const f = await open($, on, { scenario: 'p1' })
  const p1 = SCENARIOS.p1
  const pr = (number: number) => ({ number, title: `pr sintético ${number}`, url: `https://github.com/exemplo/sintetico/pull/${number}`, repo: 'exemplo/sintetico', session: { id: 's', title: 'sessão sintética', local: null } })
  f.state.panel = { ...p1, prs: { total: 1, items: [pr(7)] } }
  await f.timer.advance(5_000)
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 200) })
  // O Link não guarda a key: procura pelo href, dentro da faixa.
  const banner = await ui.find({ key: 'prs' })
  expect(banner?.text).toMatch(/1 PR aguardando sua aprovação/)
  expect((await ui.findAll({ type: 'Link' })).map((l: any) => l.props.href)).toContain('https://github.com/exemplo/sintetico/pull/7')
  await ui.unmount()
  f.state.panel = { ...p1, prs: { total: 2, items: [pr(7), pr(8)] } }
  // O link da faixa sai: o que se clica mudou, e o painel redesenha na hora.
  await f.timer.advance(5_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 200) })
  // Com dois, a faixa não é link de um PR só: "Ver" abre a lista.
  expect((await ui.findAll({ type: 'Link' })).some((l: any) => /\/pull\/[78]$/.test(l.props.href))).toBe(false)
  await ui.press({ key: 'show-prs' })
  const hrefs = (await ui.findAll({ type: 'Link' })).map((l: any) => l.props.href).filter((h: string) => /\/pull\//.test(h))
  expect(hrefs).toEqual(['https://github.com/exemplo/sintetico/pull/7', 'https://github.com/exemplo/sintetico/pull/8'])
  await ui.unmount()
})

test(`0.0.24: the "#N" in a subagent's description is a link to the PR, whole; without a repository, plain text`, async ($, on) => {
  const f = await open($, on, { scenario: 'p4' })
  const p4 = SCENARIOS.p4
  const base = p4.subagents.items[0]!
  const withTask = (task: string): Panel => ({ ...p4, subagents: { active: 1, items: [{ ...base, name: 'general-purpose', task }] } })
  f.state.panel = withTask('Revisar PR #139')
  await f.timer.advance(15_000)
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    const links = (await ui.findAll({ type: 'Link' })).filter((l: any) => /\/pull\/139$/.test(l.props.href))
    expect(links.map((l: any) => l.props.href)).toEqual([`https://github.com/${p4.work!.repo}/pull/139`])
    // O número inteiro, nunca "#13…".
    expect(links[0]!.text).toMatch(/#139$/)
    expect((await ui.find({ key: `sub-${base.id}` }))?.text).toMatch(/#139/)
    await ui.unmount()
  }
  // Uma descrição longa: o texto antes do número encurta; o "#N" fica.
  f.state.panel = withTask('Revisar com calma o PR inteiro, arquivo por arquivo, #139')
  await f.timer.advance(15_000)
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect((await ui.findAll({ type: 'Link' })).some((l: any) => /\/pull\/139$/.test(l.props.href) && /#139$/.test(l.text))).toBe(true)
  await ui.unmount()
  // Sem repositório conhecido: texto puro, sem link.
  f.state.panel = { ...withTask('Revisar PR #139'), work: { ...p4.work!, repo: null } }
  await f.timer.advance(15_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect((await ui.findAll({ type: 'Link' })).some((l: any) => /\/pull\/139$/.test(l.props.href))).toBe(false)
  // O número inteiro também sem link: o que corta é o texto antes dele.
  expect((await ui.find({ key: `sub-${base.id}` }))?.text).toMatch(/ · \S*… #139/)
  await ui.unmount()
})

test('#145: archived children count, come last and are unarchived through the session, only while it is idle', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', async (_$: unknown, e: { text: string }) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const f = await open($, on, { scenario: 'p4' })
  const p4 = SCENARIOS.p4
  const base = p4.children[0]!
  const child = (i: number, extra: object) => ({ ...base, id: `sim-filha-${i}`, title: `filha-sintetica-${i}`, local: `local_00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, since: new Date(NOW - i * 60_000).toISOString(), ...extra })
  const children = [
    ...Array.from({ length: 9 }, (_, i) => child(i, { state: 'completed', reason: null, archived: true })),
    child(9, { state: 'active', reason: null, doing: 'pensando' }),
    ...Array.from({ length: 5 }, (_, i) => child(10 + i, { state: 'completed', reason: null })),
  ]
  const idle = { ...p4.session!, state: 'waiting' as const, status: 'waiting' as const, reason: 'stop' as const }
  f.state.panel = { ...p4, session: idle, children }
  await f.timer.advance(15_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 200) })
  // O total com as arquivadas, e quantas são; o pé no padrão.
  expect((await ui.find({ key: 'card-children' }))?.text).toMatch(/SESSÕES FILHAS\s*15 · 9 arquivadas/)
  expect((await ui.find({ key: 'show-children' }))?.props.label).toBe('15 sessões filhas ›')
  // No card, a ativa primeiro; nenhuma arquivada entre as 3.
  const inCard = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.key?.startsWith('child-')).map((b: any) => b.key)
  expect(inCard[0]).toBe('child-sim-filha-9')
  // Na lista completa, as arquivadas por último, com "arquivada" e o "Desarquivar".
  await ui.press({ key: 'show-children' })
  const list = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.key?.startsWith('child-')).map((b: any) => b.key)
  const archivedCount = children.filter((x) => x.archived).map((x) => `child-${x.id}`)
  expect(list.slice(-9).sort()).toEqual([...archivedCount].sort())
  expect((await ui.find({ key: 'child-sim-filha-0' }))?.text).toMatch(/filha-sintetica-0 · arquivada/)
  // O clique manda à sessão o pedido para desarquivar, como a pessoa.
  await ui.press({ key: 'unarchive-sim-filha-0' })
  for (let i = 0; i < 20 && !sent.length; i++) await f.timer.advance(10)
  expect(sent).toEqual(['Desarquive a sessão filha-sintetica-0 (local_00000000-0000-4000-8000-000000000000) com unarchive_session.'])
  await ui.unmount()
  // No meio de um turno: sem o botão, "aguarde o turno".
  f.state.panel = { ...p4, session: { ...p4.session!, state: 'active', status: 'active', reason: null }, children }
  await f.timer.advance(5_000)
  const ui2 = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 200) })
  expect(await ui2.find({ key: 'unarchive-sim-filha-0' })).toBeUndefined()
  expect(await ui2.find({ type: 'Text', text: 'aguarde o turno' })).toBeDefined()
  await ui2.press({ key: 'back-session' })
  await ui2.unmount()
})

test('P6: a new session, empty cards in place', async ($, on) => {
  await open($, on, { scenario: 'p6' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  for (const key of CARDS) expect(await ui.find({ key })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /esperando o primeiro prompt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sem plano nesta sessão/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /nenhum nesta sessão/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sem issue ligada a este branch/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 precisam de você/ })).toBeDefined()
  await ui.unmount()
})

test('P7: "Ver" opens who needs you; family when narrow, the whole machine in the Select', async ($, on) => {
  await open($, on, { scenario: 'p7' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'show-need-you' })
  expect(await ui.find({ key: 'card-session' })).toBeUndefined()
  // Na família: a mãe pede permissão (precisa); a filha só está na sua vez, num grupo à parte.
  expect(await ui.find({ type: 'Text', text: /PRECISAM DE VOCÊ · 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /SUA VEZ · 1/ })).toBeDefined()
  expect(await ui.find({ key: 'needs-sim-panel-motor-de-regras' })).toBeDefined()
  expect(await ui.find({ key: 'needs-sim-panel-fila-de-tarefas' })).toBeDefined()
  expect(await ui.find({ key: 'needs-sim-panel-painel-de-metricas' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /mãe desta · Opus 5\.5/ })).toBeDefined()
  await ui.select({ key: 'scope', value: 'machine' })
  expect(await ui.find({ type: 'Text', text: /PRECISAM DE VOCÊ · 2/ })).toBeDefined()
  expect(await ui.find({ key: 'needs-sim-panel-painel-de-metricas' })).toBeDefined()
  await ui.press({ key: 'go-sim-panel-motor-de-regras' })
  await ui.press({ key: 'close-need-you' })
  expect(await ui.find({ key: 'card-session' })).toBeDefined()
  await ui.unmount()
})

test('P8: without the core, the panel says so and retries on its own', async ($, on) => {
  const f = await open($, on, { outside: true })
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    expect(await ui.find({ key: 'offline' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Sem conexão com o núcleo/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /nova tentativa a cada 5 s/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /sem dados de outras sessões/ })).toBeDefined()
    await ui.unmount()
  }
  expect(f.status.at(-1)).toBe('ahrena-console ○ offline')
  // O núcleo volta: o próximo tick já desenha a sessão.
  f.state.outside = false
  await f.timer.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  expect(await ui.find({ key: 'offline' })).toBeUndefined()
  expect(await ui.find({ key: 'card-session' })).toBeDefined()
  await ui.unmount()
})

test('in the terminal, the panel falls back to the text summary', async ($, on) => {
  await open($, on, { scenario: 'p1' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Kanban de sessões no artefato · Opus 5\.5 · turno 18/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 precisa de você/ })).toBeDefined()
  await ui.unmount()
})

test('with no room for the panel, /console tells the reason the engine gave', async ($, on) => {
  const f = fakes(on, { noRoom: 'no-surface' })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const r = (await $.command.run(CONSOLE)) as { text?: string }
  expect(r?.text).toMatch(/no-surface/)
  expect(f.requests).toHaveLength(0)
})

test('Plan: the ring with the % and three highlighted steps around the current one; the rest opens in the detail', async ($, on) => {
  await open($, on, { scenario: 'p1' })
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    const card = await ui.find({ key: 'card-plan' })
    expect(card?.props.height).toBe(10)
    const ring = (await ui.findAll({ type: 'Svg' })).find((x) => /plano 50% feito, 3 de 6/.test(String(x.props.alt)))
    expect([ring?.props.width, ring?.props.height]).toEqual([50, 50])
    expect(card?.text).toMatch(/PLANO\s*3\/6/)
    // O último feito, o atual (em negrito) e o próximo.
    expect(card?.text).toMatch(/✓ Ligar ao núcleo● Rodando a bateria|✓ Ligar ao núcleo● Rodar a bateria/)
    expect(card?.text).toMatch(/○ Abrir o PR/)
    expect(card?.text).not.toMatch(/Ler o artefato|Pedir review/)
    // O resto dos passos e os planos anteriores, numa linha própria que abre o detalhe.
    expect((await ui.find({ key: 'show-plans' }))?.props.label).toBe('6 passos · 2 planos anteriores ›')
    expect(await ui.find({ key: 'plan-2' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Plan: the highlighted steps', () => {
  const step = (id: string, state: 'pending' | 'in_progress' | 'completed') => ({ id, text: id, activeText: null, state, owner: { type: 'main' as const, name: null, agentId: null } })
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id)
  expect(ids(highlightedSteps([step('a', 'completed'), step('b', 'completed'), step('c', 'in_progress'), step('d', 'pending'), step('e', 'pending')]))).toEqual(['b', 'c', 'd'])
  expect(ids(highlightedSteps([step('a', 'in_progress'), step('b', 'pending'), step('c', 'pending'), step('d', 'pending')]))).toEqual(['a', 'b', 'c'])
  expect(ids(highlightedSteps([step('a', 'completed'), step('b', 'completed'), step('c', 'completed'), step('d', 'completed')]))).toEqual(['b', 'c', 'd'])
  expect(ids(highlightedSteps([step('a', 'completed'), step('b', 'pending')]))).toEqual(['a', 'b'])
})

test(`#131: the Plan's "N/M ›" opens the detail: the current plan's steps and the previous plans`, async ($, on) => {
  await open($, on, { scenario: 'p1' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  await ui.press({ key: 'show-plans' })
  expect(await ui.find({ key: 'card-plan' })).toBeUndefined()
  const steps = await ui.find({ key: 'steps-of-plan' })
  expect(steps?.text).toMatch(/✓ Ler o artefato/)
  expect(steps?.text).toMatch(/● Rodando a bateria|● Rodar a bateria/)
  expect(await ui.find({ type: 'Text', text: /PLANOS DA SESSÃO · 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 ✓ · 1 ◐/ })).toBeDefined()
  for (const n of [3, 2, 1]) expect(await ui.find({ key: `plan-${n}` })).toBeDefined()
  expect((await ui.find({ key: 'plan-2' }))?.text).toMatch(/Prototipar o arrastar · 1\/4.*3 min/s)
  await ui.press({ key: 'close-plans' })
  expect(await ui.find({ key: 'card-plan' })).toBeDefined()
  await ui.unmount()
})

test('#131 after /clear: with no plan in progress, the previous ones open from the card', async ($, on) => {
  const f = await open($, on, { scenario: 'p1' })
  const p1 = SCENARIOS.p1
  f.state.panel = { ...p1, plan: null, plans: (p1.plans ?? []).map((x) => (x.outcome === 'current' ? { ...x, outcome: 'abandoned' as const, current: null, end: x.start } : x)) }
  await f.timer.advance(15_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  expect(await ui.find({ type: 'Text', text: /nenhum plano em andamento/ })).toBeDefined()
  expect((await ui.find({ key: 'show-plans' }))?.props.label).toBe('3 planos anteriores ›')
  await ui.press({ key: 'show-plans' })
  for (const n of [3, 2, 1]) expect(await ui.find({ key: `plan-${n}` })).toBeDefined()
  await ui.unmount()
})

test('#131 a core without the history: the card shows the plan, and the detail only the steps', async ($, on) => {
  const f = await open($, on, { scenario: 'p1' })
  const { plans: _, ...noHistory } = SCENARIOS.p1
  f.state.panel = noHistory as Panel
  await f.timer.advance(15_000)
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    expect(await ui.find({ type: 'Text', text: /Rodar a bateria/ })).toBeDefined()
    await ui.press({ key: 'show-plans' })
    expect(await ui.find({ key: 'steps-of-plan' })).toBeDefined()
    expect(await ui.find({ key: 'plan-1' })).toBeUndefined()
    await ui.press({ key: 'close-plans' })
    await ui.unmount()
  }
})

test(`footer: the plugin's and the API's versions, discreet, in both widths and without the core`, async ($, on) => {
  const f = await open($, on, { scenario: 'p1' })
  f.state.panel = { ...SCENARIOS.p1, api: { version: '0.0.1', commit: 'abc1234', folder: 'abc1234', opensSession: false } }
  await f.timer.advance(5_000)
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    expect(await ui.find({ type: 'Text', text: /plugin \d+\.\d+\.\d+ · api 0\.0\.1 \(abc1234\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /reinicie a API/ })).toBeUndefined()
    await ui.unmount()
  }
  // A pasta já está em outro commit: a API no ar é a de antes, e o rodapé pede para reiniciar.
  f.state.panel = { ...SCENARIOS.p1, api: { version: '0.0.1', commit: 'abc1234', folder: 'def5678', opensSession: false } }
  // Só o texto do rodapé muda: aparece no redesenho depois do intervalo mínimo.
  await f.timer.advance(15_000)
  const changed = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await changed.find({ type: 'Text', text: /pasta em def5678: reinicie a API/ })).toBeDefined()
  await changed.unmount()
  // Núcleo de antes do rodapé, sem `api`: a versão do plugin aparece mesmo assim.
  const { api: _, ...noApi } = SCENARIOS.p1
  f.state.panel = noApi as Panel
  await f.timer.advance(15_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /plugin \d+\.\d+\.\d+ · api —/ })).toBeDefined()
  await ui.unmount()
})

test(`"← voltar" at the top and bottom of every screen that takes the session's place; "fechar" no longer shows`, async ($, on) => {
  await open($, on, { scenario: 'p1' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ key: 'back-session' })).toBeUndefined()
  for (const openScreen of ['show-need-you', 'show-plans']) {
    await ui.press({ key: openScreen })
    expect(await ui.find({ key: 'card-session' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /← voltar/ })).toBeDefined()
    await ui.press({ key: 'back-session' })
    expect(await ui.find({ key: 'card-session' })).toBeDefined()
  }
  await ui.press({ key: 'show-need-you' })
  expect((await ui.find({ key: 'close-need-you' }))?.text).toBe('← voltar')
  expect((await ui.findAll({ type: 'Text' })).some((t) => /\bfechar\b/.test(t.text ?? ''))).toBe(false)
  await ui.unmount()
})

test('"← voltar" on the decisions screen too', async ($, on) => {
  await open($, on, { scenario: 'p9' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  await ui.press({ key: 'show-decisions' })
  expect(await ui.find({ key: 'card-session' })).toBeUndefined()
  await ui.press({ key: 'back-session' })
  expect(await ui.find({ key: 'card-session' })).toBeDefined()
  await ui.unmount()
})

test(`#131: a session in the Desktop's index becomes a link (through the core, to claude://) in the children and in "precisam de você"; a terminal-only one does not`, async ($, on) => {
  const LOCAL = 'local_00000000-0000-4000-8000-0000000000f1'
  const f = await open($, on, { scenario: 'p4' })
  const p4 = SCENARIOS.p4
  f.state.panel = { ...p4, children: p4.children.map((x, i) => (i === 0 ? { ...x, local: LOCAL } : x)) }
  await f.timer.advance(5_000)
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  const links = (await ui.findAll({ type: 'Link' })).filter((l) => /\/open\//.test(l.props.href))
  const link = links[0]
  expect(link?.props.href).toBe(`http://localhost:4720/open/${LOCAL}`)
  // No card (P1), o nome em negrito na cor do texto, dentro do link.
  const name = await ui.find({ type: 'Text', text: 'fila-de-tarefas' })
  expect([name?.props.weight, name?.props.color]).toEqual(['bold', undefined])
  expect(links).toHaveLength(1)
  await ui.unmount()

  const p7 = SCENARIOS.p7
  f.state.panel = { ...p7, needYou: { ...p7.needYou, machine: p7.needYou.machine.map((x, i) => (i === 0 ? { ...x, local: LOCAL } : x)) } }
  await f.timer.advance(5_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  await ui.press({ key: 'show-need-you' })
  await ui.select({ key: 'scope', value: 'machine' })
  const first = p7.needYou.machine[0]!
  // O nome e o "Ir para a sessão" do card dela.
  const opening = (await ui.findAll({ type: 'Link' })).filter((l) => l.props.href === `http://localhost:4720/open/${LOCAL}`)
  expect(opening.map((l) => l.props.label)).toEqual([first.title, 'Ir para a sessão'])
  expect(await ui.find({ key: `go-${first.id}` })).toBeUndefined()
  // Sem `local` (só de terminal): o botão de antes, que copia o nome.
  expect((await ui.find({ key: `go-${p7.needYou.machine[1]!.id}` }))?.type).toBe('Button')
  await ui.unmount()
})


// --- Altura (#131): tudo dentro da janela, sem rolagem ---

const high = (target: typeof PANE | typeof WIDE, lines: number) => ({ ...target, props: { ...target.props, scroll: { offset: 0, bodyRows: lines } } })
const HEIGHTS = [32, 45, 60, 90, 200]

/** Um painel carregado: título e mensagem longos, 15 subagentes, 6 filhas e 5 planos anteriores. */
function loaded(): Panel {
  const p4 = SCENARIOS.p4
  const sub = p4.subagents.items[3]!
  // Os dois primeiros revisores ainda trabalham: os ativos aparecem todos no card, os concluídos no "+N".
  const reviewer = (i: number) => ({ ...sub, id: `sim-sub-${i}`, name: `revisor-sintetico-com-nome-longo-${i}`, task: 'uma tarefa sintética de descrição longa', ...(i < 2 ? { status: 'working' as const, until: null } : {}) })
  const subagents = [...Array.from({ length: 2 }, (_, i) => reviewer(i)), ...p4.subagents.items, ...Array.from({ length: 9 }, (_, i) => reviewer(i + 2))]
  const children = [...p4.children, ...p4.children].map((f, i) => ({ ...f, id: `${f.id}-${i}`, title: `${f.title}-${i}` }))
  const prev = (p4.plans ?? []).filter((x) => x.outcome !== 'current')
  const plans = [...(p4.plans ?? []), ...prev.slice(0, 2).map((x, i) => ({ ...x, number: -i, summary: `Plano sintético ${i}` }))]
  return {
    ...p4,
    session: {
      ...p4.session!,
      title: 'Uma sessão sintética com um título bem comprido que não cabe numa linha só do card',
      state: 'waiting',
      status: 'waiting',
      reason: 'stop',
      turn: 212,
      activity: { type: 'your-turn', text: `"Mandei os dois pedidos para a sessão filha, ${'e depois conferi tudo de novo com calma '.repeat(5)}fim"` },
    },
    subagents: { active: p4.subagents.active + 2, items: subagents },
    children,
    plans,
  }
}

test('height: the six P1 cards always show, whole and the same size, at any height; no summaries card', async ($, on) => {
  const f = await open($, on, { scenario: 'p4' })
  f.state.panel = loaded()
  await f.timer.advance(5_000)
  for (const base of [PANE, WIDE]) {
    for (const lines of [30, 60, 400]) {
      const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, lines) })
      for (const key of CARDS) {
        const card = await ui.find({ key })
        expect([card?.props.width, card?.props.height]).toEqual([34, 10])
      }
      expect(await ui.find({ key: 'summaries' })).toBeUndefined()
      // O título nunca corta (0.0.32, regra do Fernando): quebra em até 2 linhas, sem reticências.
      const title = await ui.find({ type: 'Text', text: /título bem comprido/ })
      expect([title?.props.wrap, /…/.test(title?.text ?? '')]).toEqual(['wrap', false])
      await ui.unmount()
    }
  }
  // A altura que a visão pede (para saber a partir de quantas linhas o pane não rola).
  const panel = loaded()
  for (const cols of [38, 121]) expect(viewLines({ now: NOW, core: '127.0.0.1:4720', cols, actions: {} } as any, panel)).toBeGreaterThan(0)
})

test(`P1: Subagents and child sessions have up to 3 lines; the Subagents footer opens the graph and the children's the list, with "← voltar"`, async ($, on) => {
  const f = await open($, on, { scenario: 'p4' })
  const panel = loaded()
  f.state.panel = panel
  await f.timer.advance(5_000)
  for (const base of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, 400) })
    // Os ativos primeiro; o que não cabe nas 3 linhas soma o total no "+N".
    const subs = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('sub-'))
    expect(subs.map((b) => b.key)).toEqual(['sub-sim-sub-0', 'sub-sim-sub-1', `sub-${SCENARIOS.p4.subagents.items[0]!.id}`])
    expect((await ui.find({ key: 'show-subagents' }))?.props.label).toBe('+12 · grafo ›')
    expect((await ui.find({ key: 'card-subagents' }))?.text).toMatch(/SUBAGENTES\s*5 ativos/)
    // As filhas: até 3 linhas e "ver todas as N ›".
    expect((await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('child-'))).toHaveLength(3)
    expect((await ui.find({ key: 'show-children' }))?.props.label).toBe(`${panel.children.length} sessões filhas ›`)
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 400) })
  await ui.press({ key: 'show-subagents' })
  expect(await ui.find({ type: 'Text', text: /GRAFO · 15 SUBAGENTES/ })).toBeDefined()
  await ui.press({ key: 'back-session' })
  await ui.press({ key: 'show-children' })
  expect(await ui.find({ type: 'Text', text: new RegExp(`SESSÕES FILHAS · ${panel.children.length}`) })).toBeDefined()
  await ui.press({ key: 'back-session' })
  expect(await ui.find({ key: 'card-subagents' })).toBeDefined()
  await ui.unmount()
})

test(`height: the screens that take the session's place fit too, with "+N que não cabem nesta altura"`, async ($, on) => {
  const f = await open($, on, { scenario: 'p4' })
  const panel = loaded()
  const prev = (panel.plans ?? [])[1]!
  panel.plans = [...(panel.plans ?? []), ...Array.from({ length: 30 }, (_, i) => ({ ...prev, number: 100 + i, summary: `Plano sintético ${i}` }))]
  f.state.panel = panel
  await f.timer.advance(5_000)
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(PANE, 50) })
  await ui.press({ key: 'show-plans' })
  const lines = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('plan-')).length
  expect(lines).toBeGreaterThan(0)
  expect(await ui.find({ type: 'Text', text: new RegExp(`\\+${panel.plans.length - lines} que não cabem nesta altura`) })).toBeDefined()
  await ui.press({ key: 'back-session' })
  await ui.unmount()

  // "Precisam de você": só as fileiras de cards que cabem.
  f.state.panel = SCENARIOS.p7
  await f.timer.advance(5_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(PANE, 32) })
  await ui.press({ key: 'show-need-you' })
  await ui.select({ key: 'scope', value: 'machine' })
  expect((await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('needs-'))).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /\+2 que não cabem nesta altura/ })).toBeDefined()
  await ui.unmount()
})

test(`#131: on macOS, the session's name opens the conversation straight through the API, without the browser`, async ($, on) => {
  const LOCAL = 'local_00000000-0000-4000-8000-0000000000f1'
  const f = await open($, on, { scenario: 'p4' })
  const p4 = SCENARIOS.p4
  f.state.panel = { ...p4, api: { version: '0.0.1', commit: null, folder: null, opensSession: true }, children: p4.children.map((x, i) => (i === 0 ? { ...x, local: LOCAL } : x)) }
  await f.timer.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  const child = p4.children[0]!
  expect((await ui.findAll({ type: 'Link' })).some((l) => /\/open\//.test(l.props.href))).toBe(false)
  await ui.press({ key: `child-name-${child.id}` })
  const request = f.requests.find((x) => x.method === 'POST' && x.url === `http://127.0.0.1:4720/open/${LOCAL}`)
  expect(request).toBeDefined()
  expect(f.toasts.at(-1)).toMatch(/Abrindo "fila-de-tarefas" no Claude Desktop/)
  await ui.unmount()
})

test(`#131: in the cards' lists, each item is one line with an ellipsis and the time in a fixed column; whole only on the list screen`, async ($, on) => {
  const f = await open($, on, { scenario: 'p4' })
  f.state.panel = loaded()
  await f.timer.advance(5_000)
  for (const base of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, 120) })
    // Os planos anteriores ficam no detalhe do Plano, nas duas larguras (P1).
    for (const prefix of ['sub-', 'child-']) {
      const items = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith(prefix))
      expect(items.length).toBeGreaterThan(0)
    }
    // O tipo longo encurta para a descrição aparecer: "revisor-… · uma tarefa…".
    const texts = (await ui.findAll({ type: 'Text' })).filter((t) => /revisor-\S*… · uma tarefa/.test(t.text ?? ''))
    expect((await ui.find({ type: 'Text', text: /revisor-sintetico-com-nome-longo-0/ }))).toBeUndefined()
    expect(texts.some((t) => t.props.wrap === 'truncate-end')).toBe(true)
    expect(texts.some((t) => t.props.wrap === 'wrap')).toBe(false)
    // A coluna de tempo tem largura fixa e não encolhe.
    const columns = (await ui.findAll({ type: 'Box' })).filter((b) => b.props.width === 7 && b.props.flexShrink === 0)
    expect(columns.length).toBeGreaterThan(0)
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  await ui.press({ key: 'show-subagents' })
  // No grafo, cada linha é uma só, com reticências: o nome longo nunca quebra a linha.
  expect(await ui.find({ type: 'Text', text: /GRAFO · 15 SUBAGENTES/ })).toBeDefined()
  const names = (await ui.findAll({ type: 'Text' })).filter((t) => /revisor-sintetico-com-nome-longo-0/.test(t.text ?? ''))
  expect(names.length).toBeGreaterThan(0)
  expect(names.every((t) => t.props.wrap !== 'wrap')).toBe(true)
  await ui.unmount()
})

test('Plan: without the steps (old core), the P1 summary: "✓ N feitas", the current one and "○ próximo · +N"', async ($, on) => {
  const f = await open($, on, { scenario: 'p1' })
  const p1 = SCENARIOS.p1
  f.state.panel = { ...p1, plan: { ...p1.plan!, steps: undefined } }
  await f.timer.advance(15_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  const card = await ui.find({ key: 'card-plan' })
  expect(card?.text).toMatch(/✓ 3 feitas/)
  expect(card?.text).toMatch(/● Rodar a bateria/)
  expect(card?.text).toMatch(/○ Abrir o PR · \+1/)
  expect((await ui.find({ key: 'show-plans' }))?.props.label).toBe('2 planos anteriores ›')
  await ui.unmount()
})

test('#131 double click: polling rewrites the atom only when the drawing changes (usage, PRs, your turn and the question included)', async ($, on) => {
  // Conta as gravações do atom `reading`: cada uma redesenha o pane e troca os handles dos botões.
  let writes = 0
  on('state.set', async (_$: unknown, e: { key?: string; ref?: { key?: string } }, next: (e: unknown) => unknown) => {
    if ((e.ref?.key ?? e.key) === 'reading') writes++
    return next(e)
  })
  // O uso pelo engine, que muda a cada resposta.
  const usage = { tokens: 120_100, percent: 12.01 }
  on('session.usage', async () => ({ value: { startedAt: NOW, context: { tokens: usage.tokens, window: 1_000_000, percent: usage.percent }, rateLimits: [] } }))
  on('tool.call', async () => ({ result: 'ok' }))
  const f = await open($, on, { scenario: 'p4' })
  const p4 = SCENARIOS.p4
  // Uma pergunta no painel, um PR aguardando e alguém na sua vez.
  await ($ as any).tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'feito', ask: 'Sigo?', actions: [{ label: 'Sim' }] })
  const pr = { number: 7, title: 'pr sintético', url: 'https://example.invalid/pr/7', repo: 'ahrena/sintetico', session: { id: 'sim-s', title: 'sessão sintética', local: null } }
  // Os horários do cenário andam com o relógio: os "há N min" ficam parados, e o que mudar no
  // desenho é o que o tick trouxe.
  const advanceBy = (p: Panel, ms: number): Panel =>
    JSON.parse(JSON.stringify(p).replace(/"(\d{4}-\d\d-\d\dT[^"]+Z)"/g, (_, d: string) => JSON.stringify(new Date(Date.parse(d) + ms).toISOString())))
  let t = 0
  const base = (i: number, extra: Partial<Panel> = {}): Panel => ({
    ...advanceBy({ ...p4, prs: { total: 1, items: [pr] }, ...extra }, t),
    // O que muda a cada tick sem mudar a tela: a hora da resposta e o `since` de quem está na sua
    // vez (a tela principal só mostra quantos).
    generatedAt: new Date(NOW + t + i).toISOString(),
    needYou: { ...p4.needYou, family: p4.needYou.family.map((x) => ({ ...x, since: new Date(NOW - i * 7_000).toISOString() })) },
  })
  const tick = async (ms = 5_000) => {
    t += ms
    await f.timer.advance(ms)
  }
  f.state.panel = base(0)
  await tick()
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(PANE, 120) })
  const before = writes
  expect(before).toBeGreaterThan(0)
  // Seis ticks: o uso sobe dentro do mesmo arredondamento (120.1k, 12%), e nada visível muda.
  for (let i = 1; i <= 6; i++) {
    usage.tokens = 120_100 + i * 7
    usage.percent = 12.01 + i * 0.01
    // A resposta do próximo tick, com os horários já andados até ele.
    f.state.panel = advanceBy(base(i), 5_000)
    await tick()
  }
  expect(writes).toBe(before)
  // O mesmo botão continua lá, com o mesmo desenho: o clique da pessoa chega.
  expect(await ui.find({ key: 'reply-0' })).toBeDefined()
  // Uma mudança visível que não troca os botões espera o intervalo mínimo; depois, grava uma vez.
  usage.percent = 14
  usage.tokens = 140_000
  for (let i = 0; i < 4; i++) {
    f.state.panel = advanceBy(base(7), 5_000)
    await tick()
  }
  expect(writes).toBe(before + 1)
  // O que troca os botões grava na hora: mais um PR aguardando muda o cabeçalho do card.
  f.state.panel = advanceBy(base(8, { prs: { total: 2, items: [pr, { ...pr, number: 8 }] } }), 5_000)
  await tick()
  expect(writes).toBe(before + 2)
  await ui.unmount()
})

test('P1: working children come first, then those that need you and those on your turn; the full list says what each one does', async ($, on) => {
  const f = await open($, on, { scenario: 'p4' })
  const p4 = SCENARIOS.p4
  const base = p4.children[0]!
  const child = (i: number, extra: object) => ({ ...base, id: `sim-filha-${i}`, title: `filha-sintetica-${i}`, since: new Date(NOW - (15 - i) * 60_000).toISOString(), ...extra })
  const children = [
    ...Array.from({ length: 9 }, (_, i) => child(i, { state: 'completed', reason: null })),
    child(9, { state: 'waiting', reason: 'stop' }),
    child(10, { state: 'waiting', reason: 'interrupted' }),
    child(11, { state: 'waiting', reason: 'notification' }),
    child(12, { state: 'active', reason: null, doing: 'pensando' }),
    child(13, { state: 'waiting', reason: 'stop' }),
    child(14, { state: 'active', reason: null, doing: 'rodando Bash' }),
  ]
  f.state.panel = { ...p4, children }
  await f.timer.advance(5_000)
  for (const b of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(b, 90) })
    // No card (P1): 3 linhas, as que trabalham primeiro (a mais recente antes), depois a que precisa.
    const lines = (await ui.findAll({ type: 'Box' })).filter((x) => x.key?.startsWith('child-')).map((x) => x.key)
    expect(lines).toEqual(['child-sim-filha-14', 'child-sim-filha-12', 'child-sim-filha-11'])
    expect((await ui.find({ key: 'card-children' }))?.text).toMatch(/SESSÕES FILHAS\s*15/)
    // À direita, o tempo; ou, em âmbar, o que pede você.
    expect((await ui.find({ type: 'Text', text: 'Precisa' }))?.props.color).toBe(paleta.yellow['500'])
    expect((await ui.find({ key: 'show-children' }))?.props.label).toBe('15 sessões filhas ›')
    // Na lista completa, a ordem inteira e o que cada uma que trabalha está fazendo.
    await ui.press({ key: 'show-children' })
    const all = (await ui.findAll({ type: 'Box' })).filter((x) => x.key?.startsWith('child-')).map((x) => x.key)
    expect(all.slice(0, 6)).toEqual(['child-sim-filha-14', 'child-sim-filha-12', 'child-sim-filha-11', 'child-sim-filha-13', 'child-sim-filha-10', 'child-sim-filha-9'])
    expect(await ui.find({ type: 'Text', text: /· rodando Bash/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /· pensando/ })).toBeDefined()
    // Três ociosas (#245): duas no fim do turno e uma depois do Esc.
    expect((await ui.findAll({ type: 'Text', text: 'Ociosa' })).length).toBe(3)
    await ui.press({ key: 'back-session' })
    await ui.unmount()
  }
})

test('Compact: from 80%, in the Context card footer, on the right; asks for confirmation; compacts only this session and tells the result', async ($, on) => {
  let calls = 0
  let release: (() => void) | null = null
  let refuse: string | null = null
  let veto: string | null = null
  // O engine falso: a compactação desta sessão (o que o /compact faz), ou a recusa no meio de um turno.
  on('session.compact', async () => {
    calls++
    if (veto) return { skip: veto }
    if (refuse) throw new Error(refuse)
    await new Promise<void>((r) => (release = r))
    return { messages: [{ role: 'user', text: 'resumo sintético da conversa', toolUses: [] }], tokensBefore: 180_000, tokensAfter: 40_000 }
  })
  const f = await open($, on, { scenario: 'p1' })
  const p1 = SCENARIOS.p1
  // Abaixo de 80% (P1): o card não tem Compactar, e o cabeçalho diz "estimativa".
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  expect(await ui.find({ key: 'compact' })).toBeUndefined()
  expect(await ui.find({ key: 'kpi-background' })).toBeDefined()
  expect((await ui.find({ key: 'card-context' }))?.text).toMatch(/CONTEXTO E CUSTO\s*estimativa/)
  await ui.unmount()

  // A partir de 80%: "Compactar agora", em destaque.
  f.state.panel = { ...p1, context: { used: 172_000, limit: 200_000, pct: 86 } }
  await f.timer.advance(5_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  const now = await ui.find({ key: 'compact' })
  // A linha de pé, como as dos outros cards: sem moldura (plain), nada de botão primário.
  expect(now?.props.label).toBe('Compactar agora ›')
  expect(now?.props.plain).toBe(true)
  expect(now?.props.variant).toBeUndefined()
  // No pé do card, à direita; os quatro tiles ficam.
  expect(await ui.find({ key: 'kpi-background' })).toBeDefined()
  expect((await ui.find({ key: 'foot-of-card' }))?.props.justifyContent).toBe('flex-end')

  // Cancelar não compacta.
  await ui.press({ key: 'compact' })
  expect(await ui.find({ type: 'Text', text: 'Compactar a conversa desta sessão?' })).toBeDefined()
  await ui.press({ key: 'compact-no' })
  expect(await ui.find({ key: 'confirm-compact' })).toBeUndefined()
  expect(calls).toBe(0)

  // Confirmar: "compactando…" até o engine terminar; depois, o resultado.
  await ui.press({ key: 'compact' })
  await ui.press({ key: 'compact-yes' })
  for (let i = 0; i < 20 && !release; i++) await f.timer.advance(10)
  expect(calls).toBe(1)
  expect(await ui.find({ type: 'Text', text: 'compactando…' })).toBeDefined()
  release!()
  for (let i = 0; i < 20 && !(f.toasts.at(-1) ?? '').startsWith('Conversa'); i++) await f.timer.advance(10)
  expect(f.toasts.at(-1)).toBe('Conversa compactada: de 180k para 40k tokens.')
  expect(await ui.find({ type: 'Text', text: 'compactando…' })).toBeUndefined()

  // Um hook vetou: o painel diz o motivo do veto.
  veto = 'no meio de um turno'
  await ui.press({ key: 'compact' })
  await ui.press({ key: 'compact-yes' })
  for (let i = 0; i < 20 && !(f.toasts.at(-1) ?? '').startsWith('A conversa não'); i++) await f.timer.advance(10)
  expect(f.toasts.at(-1)).toBe('A conversa não foi compactada: no meio de um turno.')

  // O engine recusou (no meio de um turno, ele rejeita a chamada): o painel diz o motivo.
  veto = null
  refuse = 'a turn is running'
  await ui.press({ key: 'compact' })
  await ui.press({ key: 'compact-yes' })
  for (let i = 0; i < 20 && !(f.toasts.at(-1) ?? '').startsWith('Não deu'); i++) await f.timer.advance(10)
  expect(f.toasts.at(-1)).toMatch(/^Não deu para compactar agora: .+/)
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  await ui.unmount()
})

// --- #140: precisa de você × sua vez × PRs aguardando ---

test('#140: your turn alone gets no highlight and no count; it shows neutral, and "Ver" splits the groups', async ($, on) => {
  const f = await open($, on, { scenario: 'p7' })
  const p7 = SCENARIOS.p7
  const yourTurn = p7.needYou.machine.map((i) => ({ ...i, level: 'your-turn' as const, why: 'your-turn' as const, urgent: false }))
  f.state.panel = { ...p7, needYou: { total: 0, yourTurn: yourTurn.length, byAccount: [], family: [], machine: yourTurn } }
  await f.timer.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  const line = await ui.find({ key: 'need-you' })
  // Sem o amarelo de quem está bloqueada: borda neutra.
  expect(line?.props.borderColor).not.toBe(paleta.yellow['500'])
  expect(line?.props.backgroundColor).toBe(paleta.gray['800'])
  expect(line?.text).toMatch(/ninguém mais precisa de você · 3 na sua vez/)
  expect(await ui.find({ type: 'Text', text: /precisam? de você$/ })).toBeUndefined()
  expect(f.status.at(-1)).toMatch(/ninguém mais$/)
  // P1: com zero, sem o "Ver"; a sua vez fica ao lado, neutra.
  expect(await ui.find({ key: 'show-need-you' })).toBeUndefined()
  await ui.unmount()
})

test('#140: who needs you is highlighted, with the reason; your turn adds up beside it, without highlight', async ($, on) => {
  const f = await open($, on, { scenario: 'p7' })
  const p7 = SCENARIOS.p7
  const [a, b, c] = p7.needYou.machine
  const machine = [
    { ...a!, level: 'needs' as const, why: 'decision' as const },
    { ...b!, level: 'needs' as const, why: 'question' as const },
    { ...c!, level: 'your-turn' as const, why: 'your-turn' as const },
  ]
  f.state.panel = { ...p7, needYou: { ...p7.needYou, total: 2, yourTurn: 1, machine } }
  await f.timer.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  expect((await ui.find({ key: 'need-you' }))?.props.borderColor).toBe(paleta.yellow['500'])
  expect((await ui.find({ key: 'need-you' }))?.text).toMatch(/2 precisam de você.*Decisão pedida.*Pergunta.*1 na sua vez/s)
  await ui.unmount()
})

// --- #245: precisa de você × ociosa ---

test('#245 P2: blocked on a question, "Precisa de você" in yellow with the strong reason chip, in both widths', async ($, on) => {
  const f = await open($, on, { scenario: 'p2' })
  for (const pane of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(pane, 120) })
    const card = await ui.find({ key: 'card-session' })
    expect(card?.props.borderColor).toBe(paleta.yellow['500'])
    expect(card?.text).toMatch(/● Precisa/)
    expect(card?.text).toMatch(/\? Pergunta/)
    expect(card?.text).not.toMatch(/Esperando|Ociosa/)
    await ui.unmount()
  }
  expect(f.status.at(-1)).toBe('ahrena-console ◐ Precisa de você · ninguém mais')
})

test('#245 P6: the new session is idle, "○ Ociosa" and "No prompt", neutral, with no yellow', async ($, on) => {
  const f = await open($, on, { scenario: 'p6' })
  for (const pane of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(pane, 120) })
    const card = await ui.find({ key: 'card-session' })
    expect(card?.props.borderColor).not.toBe(paleta.yellow['500'])
    expect(card?.props.backgroundColor).toBe(paleta.gray['800'])
    const status = await ui.find({ type: 'Text', text: ' ○ Ociosa ' })
    expect(status?.props.color).toBe(paleta.gray['200'])
    const reason = await ui.find({ type: 'Text', text: ' ›_ No prompt ' })
    expect(reason?.props.color).toBe(paleta.gray['200'])
    expect(reason?.props.weight).not.toBe('bold')
    await ui.unmount()
  }
  expect(f.status.at(-1)).toMatch(/^ahrena-console ◌ Ociosa · No prompt · /)
})

test("#245: the core's attention wins over the old state; idle after the turn ends never shows as blocked", async ($, on) => {
  const f = await open($, on, { scenario: 'p2' })
  const p2 = SCENARIOS.p2
  f.state.panel = { ...p2, session: { ...p2.session!, banner: null, reason: 'stop', attention: { level: 'idle', reason: 'turn_ended' } } }
  await f.timer.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  const card = await ui.find({ key: 'card-session' })
  expect(card?.props.borderColor).not.toBe(paleta.yellow['500'])
  expect(card?.text).toMatch(/○ Ociosa.*↵ Sua vez/s)
  expect(f.status.at(-1)).toMatch(/◌ Ociosa · Sua vez/)
  // A core from before #245, without the field: a permission is blocked, the end of the turn idle.
  f.state.panel = { ...p2, session: { ...p2.session!, attention: undefined, reason: 'notification' } }
  await f.timer.advance(5_000)
  expect(f.status.at(-1)).toMatch(/◐ Precisa de você/)
  await ui.unmount()
})

test('#245: the needs-you band counts only blocked sessions, with the new levels; idle stays beside it, neutral', async ($, on) => {
  const f = await open($, on, { scenario: 'p7' })
  const p7 = SCENARIOS.p7
  const [a, b, c] = p7.needYou.machine
  const machine = [
    { ...a!, level: 'blocked' as const, why: 'plan' as const },
    { ...b!, level: 'idle' as const, why: 'interrupted' as const },
    { ...c!, level: 'idle' as const, why: 'first_prompt' as const },
  ]
  f.state.panel = { ...p7, needYou: { total: 1, idle: 2, byAccount: [], family: [], machine } }
  await f.timer.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  const band = await ui.find({ key: 'need-you' })
  expect(band?.props.borderColor).toBe(paleta.yellow['500'])
  expect(band?.text).toMatch(/1 precisa de você · .*\(Plano para aprovar\) · 2 na sua vez/)
  expect(band?.text).not.toMatch(/Interrompida|No prompt/)
  await ui.press({ key: 'show-need-you' })
  expect((await ui.find({ type: 'Text', text: /PRECISAM DE VOCÊ · 1/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /SUA VEZ · 2/ }))).toBeDefined()
  const idle = await ui.find({ type: 'Text', text: ' ⏸ Interrompida ' })
  expect(idle?.props.color).toBe(paleta.gray['200'])
  expect((await ui.find({ type: 'Text', text: ' ☰ Plano para aprovar ' }))?.props.color).toBe(paleta.yellow['500'])
  await ui.unmount()
})

test('#140: PRs awaiting approval in their own indicator, with the list of links', async ($, on) => {
  const f = await open($, on, { scenario: 'p1' })
  const prs = Array.from({ length: 7 }, (_, i) => ({
    number: 100 + i,
    url: `https://github.com/exemplo/simulacao/pull/${100 + i}`,
    repo: 'exemplo/simulacao',
    title: `#${40 + i} Uma issue sintética`,
    session: { id: `sim-${i}`, title: `sessao-${i}`, local: null },
  }))
  f.state.panel = { ...SCENARIOS.p1, prs: { total: 7, items: prs } }
  await f.timer.advance(5_000)
  for (const base of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, 120) })
    expect((await ui.find({ key: 'prs' }))?.text).toMatch(base === WIDE ? /7 PRs aguardando sua aprovação/ : /7 PRs p\/ aprovar/)
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  await ui.press({ key: 'show-prs' })
  expect(await ui.find({ type: 'Text', text: /PRS AGUARDANDO SUA APROVAÇÃO · 7/ })).toBeDefined()
  const links = (await ui.findAll({ type: 'Link' })).filter((l) => /\/pull\/1\d\d$/.test(l.props.href))
  expect(links).toHaveLength(7)
  // O texto vai dentro do link, em laranja (pn-link): o href leva ao PR.
  expect(links[0]!.text).toMatch(/PR #100 · #40 Uma issue sintética/)
  await ui.press({ key: 'close-prs' })
  expect(await ui.find({ key: 'card-session' })).toBeDefined()
  await ui.unmount()
  // Sem PR aguardando: nenhum indicador.
  f.state.panel = { ...SCENARIOS.p1, prs: { total: 0, items: [] } }
  await f.timer.advance(5_000)
  const without = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await without.find({ key: 'prs' })).toBeUndefined()
  await without.unmount()
})

// --- 0.0.11: o contexto depois de compactar e o "Compactar" sem esmagar a telemetria ---

test(`context: the engine's (the Claude Code bar's) wins, already down after /compact; the core's is the fallback`, async ($, on) => {
  let percent: number | null = 17
  on('session.usage', async () => ({ value: { startedAt: NOW, context: percent === null ? { window: 1_000_000 } : { tokens: percent * 10_000, window: 1_000_000, percent }, rateLimits: [] } }))
  const f = await open($, on, { scenario: 'p1' })
  // O núcleo ainda diz 89% (o pico de antes da compactação).
  f.state.panel = { ...SCENARIOS.p1, context: { used: 890_000, limit: 1_000_000, pct: 89 } }
  await f.timer.advance(5_000)
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  expect(await ui.find({ type: 'Text', text: '17%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '89%' })).toBeUndefined()
  expect((await ui.find({ key: 'compact' }))?.props.variant).toBeUndefined()
  await ui.unmount()
  // Sem o número do engine: o do núcleo.
  percent = null
  await f.timer.advance(5_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  expect(await ui.find({ type: 'Text', text: '89%' })).toBeDefined()
  await ui.unmount()
})

test('0.0.25: "Compactar agora" sits in the Context footer, on the right, only from 80%; the four tiles stay', async ($, on) => {
  const f = await open($, on, { scenario: 'p1' })
  for (const [pct, appears] of [[79, false], [80, true], [86, true]] as const) {
    f.state.panel = { ...SCENARIOS.p1, context: { ...SCENARIOS.p1.context!, used: pct * 2000, limit: 200_000, pct } }
    await f.timer.advance(15_000)
    for (const [base, lines] of [[WIDE, 120], [PANE, 45]] as const) {
      const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, lines) })
      const card = await ui.find({ key: 'card-context' })
      for (const kpi of ['kpi-context', 'kpi-cost', 'kpi-tokens', 'kpi-background']) expect(await ui.find({ key: kpi })).toBeDefined()
      expect(card?.props.height).toBe(10)
      expect(card?.text).toMatch(/CONTEXTO E CUSTO\s*estimativa/)
      expect([pct, !!(await ui.find({ key: 'compact' }))]).toEqual([pct, appears])
      if (appears) {
        // O pé: o último filho do card, depois do espaçador, alinhado à direita.
        const content = ((card as any).children as any[]).filter(Boolean)
        expect(content.at(-1)?.props.key).toBe('foot-of-card')
        expect(content.at(-2)?.props.key).toBe('footer-space')
        expect(content.at(-1)?.props.justifyContent).toBe('flex-end')
      }
      await ui.unmount()
    }
  }
})

test('0.0.25: the "see more" links in the card footers, with the singular, after the spacer; the Subagents one opens the graph (P11)', async ($, on) => {
  const f = await open($, on, { scenario: 'p4' })
  const p4 = SCENARIOS.p4
  const sub = p4.subagents.items.find((i) => i.status === 'completed')!
  const subs = (n: number) => Array.from({ length: n }, (_, i) => ({ ...sub, id: `sim-sub-${i}`, until: new Date(NOW - i * 60_000).toISOString() }))
  const child = p4.children[0]!
  const children = (n: number) => Array.from({ length: n }, (_, i) => ({ ...child, id: `sim-filha-${i}` }))
  const prev = (p4.plans ?? []).find((x) => x.outcome !== 'current')!
  const cases: [Panel, Record<string, string>][] = [
    [{ ...p4, plan: null, plans: [prev], subagents: { active: 0, items: subs(4) }, children: children(4) }, { 'show-plans': '1 plano anterior ›', 'show-subagents': '+1 · grafo ›', 'show-children': '4 sessões filhas ›' }],
    [{ ...p4, plan: null, plans: [prev, { ...prev, number: 99 }], subagents: { active: 0, items: subs(20) }, children: children(15) }, { 'show-plans': '2 planos anteriores ›', 'show-subagents': '+17 · grafo ›', 'show-children': '15 sessões filhas ›' }],
  ]
  for (const [panel, expected] of cases) {
    f.state.panel = panel
    await f.timer.advance(15_000)
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 200) })
    for (const [key, text] of Object.entries(expected)) {
      expect((await ui.find({ key }))?.props.label).toBe(text)
      // O pé é o último filho do card, logo depois do espaçador: a mesma altura em todos.
      const card = await ui.find({ key: key === 'show-plans' ? 'card-plan' : key === 'show-subagents' ? 'card-subagents' : 'card-children' })
      const content = ((card as any).children as any[]).filter(Boolean)
      expect([key, content.at(-1)?.props.key, content.at(-2)?.props.key]).toEqual([key, 'foot-of-card', 'footer-space'])
    }
    await ui.unmount()
  }
})

// --- #140 (6 e 7): a pergunta com que a sessão terminou o turno, no topo ---

test('#140: the next-step box (wrap_up with ask) goes to the top, whole; the button sends the answer to the chat', async ($, on) => {
  const sent: { text: string; asUser?: boolean }[] = []
  on('tool.call', async () => ({ result: 'ok' }))
  on('prompt.submit', async (_$: unknown, e: { text: string; origin?: { kind?: string; asUser?: boolean } }) => {
    sent.push({ text: e.text, asUser: e.origin?.asUser })
    return { text: e.text }
  })
  const f = await open($, on, { scenario: 'p1' })
  const ask = 'Faço o merge do #141 agora ou espero o Fernando validar a 0.0.11 no painel dele antes de seguir?'
  await ($ as any).tool.call({
    tool: 'mcp__ccd_turn__wrap_up',
    recap: 'feito',
    ask,
    actions: [
      { label: 'Merge agora', message: 'Pode fazer o merge do #141.' },
      { label: 'Esperar' },
      { action: 'create_pr' },
    ],
  })
  await f.timer.advance(10)
  for (const base of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, 120) })
    const banner = await ui.find({ key: 'question' })
    expect(banner).toBeDefined()
    // O texto inteiro, quebrando linha, nunca cortado.
    const t = await ui.find({ type: 'Text', text: ask })
    expect(t?.props.wrap).toBe('wrap')
    expect((await ui.find({ key: 'reply-0' }))?.props.label).toBe('Merge agora')
    expect((await ui.find({ key: 'reply-1' }))?.props.label).toBe('Esperar')
    // A ação do app não tem mensagem: no chat.
    expect(banner?.text).toMatch(/create_pr: no chat ↓/)
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  await ui.press({ key: 'reply-0' })
  for (let i = 0; i < 20 && !sent.length; i++) await f.timer.advance(10)
  expect(sent).toEqual([{ text: 'Pode fazer o merge do #141.', asUser: true }])
  expect(await ui.find({ key: 'question' })).toBeUndefined()
  await ui.unmount()
})

test(`#140: a wrap_up without a question shows nothing; the person's prompt in the chat clears the question`, async ($, on) => {
  on('tool.call', async () => ({ result: 'ok' }))
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  const f = await open($, on, { scenario: 'p1' })
  await ($ as any).tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'feito' })
  await f.timer.advance(10)
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  expect(await ui.find({ key: 'question' })).toBeUndefined()
  await ui.unmount()
  await ($ as any).tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'feito', ask: 'Sigo?' })
  await f.timer.advance(10)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  expect(await ui.find({ key: 'question' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /responder no chat ↓/ })).toBeDefined()
  await ui.unmount()
  // A pessoa respondeu no chat.
  await ($ as any).prompt.submit({ text: 'sim' })
  await f.timer.advance(10)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  expect(await ui.find({ key: 'question' })).toBeUndefined()
  await ui.unmount()
})

test('#140: the question stays in the panel until the person answers; automatic messages do not clear it', async ($, on) => {
  on('tool.call', async () => ({ result: 'ok' }))
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  const f = await open($, on, { scenario: 'p1' })
  await ($ as any).tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'feito', ask: 'Sigo com o merge?' })
  await f.timer.advance(10)
  const hasQuestion = async () => {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
    const found = (await ui.find({ key: 'question' })) !== undefined
    await ui.unmount()
    return found
  }
  expect(await hasQuestion()).toBe(true)
  // Outra sessão, uma notificação de tarefa, um gatilho agendado, um plugin falando por si: a pergunta fica.
  for (const origin of [{ kind: 'peer' }, { kind: 'task-notification' }, { kind: 'scheduled-trigger' }, { kind: 'plugin', name: 'outro' }, { kind: 'unclassified' }]) {
    await ($ as any).prompt.submit({ text: 'mensagem automática', origin })
    await f.timer.advance(10)
    expect(await hasQuestion()).toBe(true)
  }
  // Guardada no $.state: um desenho novo (reload do painel) e os ticks seguintes ainda a mostram.
  await f.timer.advance(60_000)
  expect(await hasQuestion()).toBe(true)
  // A pessoa escreveu no Desktop (o host do SDK): sai.
  await ($ as any).prompt.submit({ text: 'pode', origin: { kind: 'sdk' } })
  await f.timer.advance(10)
  expect(await hasQuestion()).toBe(false)
  // Digitada no terminal, também.
  await ($ as any).tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'feito', ask: 'E agora?' })
  await f.timer.advance(10)
  expect(await hasQuestion()).toBe(true)
  await ($ as any).prompt.submit({ text: 'segue', origin: { kind: 'composer' } })
  await f.timer.advance(10)
  expect(await hasQuestion()).toBe(false)
})

test('#140: AskUserQuestion shows at the top with the whole questions and options, until the person answers', async ($, on) => {
  let release: (() => void) | null = null
  on('tool.call', async () => {
    await new Promise<void>((r) => (release = r))
    return { result: { answers: {} } }
  })
  const f = await open($, on, { scenario: 'p1' })
  const call = ($ as any).tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        header: 'Banco',
        question: 'Nos testes de integração, sigo com SQLite em memória ou subo um Postgres no Docker para chegar mais perto da produção?',
        multiSelect: false,
        options: [
          { label: 'SQLite em memória', description: 'rápido, sem dependência' },
          { label: 'Postgres no Docker', description: 'igual à produção' },
        ],
      },
    ],
  })
  for (let i = 0; i < 20 && !release; i++) await f.timer.advance(10)
  for (const base of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, 120) })
    const banner = await ui.find({ key: 'question' })
    expect(banner?.text).toMatch(/Banco · Nos testes de integração, sigo com SQLite em memória ou subo um Postgres no Docker para chegar mais perto da produção\?/)
    expect(banner?.text).toMatch(/SQLite em memória · rápido, sem dependência/)
    expect(banner?.text).toMatch(/Postgres no Docker · igual à produção/)
    expect(banner?.text).toMatch(/responder no chat ↓/)
    // Sem botões de resposta: o diálogo do engine é que responde.
    expect(await ui.find({ key: 'reply-0' })).toBeUndefined()
    await ui.unmount()
  }
  release!()
  await call
  await f.timer.advance(10)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(WIDE, 120) })
  expect(await ui.find({ key: 'question' })).toBeUndefined()
  await ui.unmount()
})


test('P1: the Context and cost card has the four tiles in both widths, even with little height', async ($, on) => {
  await open($, on, { scenario: 'p1' })
  for (const [base, lines] of [[PANE, 45], [WIDE, 30]] as const) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, lines) })
    expect((await ui.find({ key: 'card-context' }))?.props.height).toBe(10)
    for (const kpi of ['kpi-context', 'kpi-cost', 'kpi-tokens', 'kpi-background']) expect(await ui.find({ key: kpi })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CONTEXTO E CUSTO/ })).toBeDefined()
    await ui.unmount()
  }
})

test('P1: the Subagents and child sessions cards never show only the header; with at least one item, or in the summaries strip', async ($, on) => {
  const f = await open($, on, { scenario: 'p4' })
  f.state.panel = loaded()
  await f.timer.advance(5_000)
  for (const base of [PANE, WIDE]) {
    for (const lines of [41, 50, 60, 80, 120]) {
      const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...high(base, lines) })
      for (const [card, prefix] of [['card-subagents', 'sub-'], ['card-children', 'child-']] as const) {
        if (!(await ui.find({ key: card }))) continue
        expect((await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith(prefix)).length).toBeGreaterThan(0)
      }
      await ui.unmount()
    }
  }
})

// --- 0.0.30: a linha do modelo no card Esta sessão nunca corta ---

test('0.0.30: the model line shortens in steps, without an ellipsis: "Opus 5.5" → "Opus", "turno 262" → "t262"', () => {
  const days = (d: number) => new Date(NOW - d * 86_400_000).toISOString()
  expect(modelLine({ model: 'claude-opus-5-5', startedAt: new Date(NOW - 12 * 60_000).toISOString(), turn: 18 }, NOW)).toBe('Opus 5.5 · 12 min · turno 18')
  expect(modelLine({ model: 'claude-opus-5-5[1m]', startedAt: days(2), turn: 262 }, NOW)).toBe('Opus 1M · 2 d · turno 262')
  expect(modelLine({ model: 'claude-sonnet-5-5[1m]', startedAt: days(12), turn: 1234 }, NOW)).toBe('Sonnet 1M · 12 d · t1234')
})

test('0.0.30: the largest real case (long model, "12 d", "turno 1234") fits whole in the card, in both widths', async ($, on) => {
  const f = await open($, on, { scenario: 'p1' })
  const p1 = SCENARIOS.p1
  f.state.panel = { ...p1, session: { ...p1.session!, model: 'claude-sonnet-5-5[1m]', startedAt: new Date(NOW - 12 * 86_400_000).toISOString(), turn: 1234 } }
  await f.timer.advance(15_000)
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    const line = await ui.find({ type: 'Text', text: /t1234/ })
    expect(line?.text).toBe('Sonnet 1M · 12 d · t1234')
    expect([...(line?.text ?? '')].length).toBeLessThanOrEqual(UNCUT_COLUMNS)
    // Nunca com reticências: o que não coube quebra a linha.
    expect(line?.props.wrap).toBe('wrap')
    expect(line?.text).not.toMatch(/…/)
    await ui.unmount()
  }
})

test(`0.0.30: the This session card's pills fit on one line in every state and every reason`, () => {
  const width = (l: { text: string }[]) => l.reduce((a, x) => a + [...x.text].length + 2, 0) + (l.length - 1)
  // #245: blocked, "● Precisa de você" shortens to "● Precisa" and then to the dot; idle fits whole.
  expect(sessionPills('● Precisa de você', { level: 'blocked', reason: 'question' }, '● Precisa').map((x) => x.text)).toEqual(['● Precisa', '? Pergunta'])
  expect(sessionPills('● Precisa de você', { level: 'blocked', reason: 'permission' }, '● Precisa').map((x) => x.text)).toEqual(['●', '⛉ Pede permissão'])
  expect(sessionPills('○ Ociosa', { level: 'idle', reason: 'first_prompt' }).map((x) => x.text)).toEqual(['○ Ociosa', '›_ No prompt'])
  for (const status of ['● Ativa', '● Concluída', '● Com erro', '● Abandonada']) expect(width(sessionPills(status, null))).toBeLessThanOrEqual(UNCUT_COLUMNS)
  for (const reason of ['permission', 'question', 'plan', 'decision', 'error'] as const) {
    expect(width(sessionPills('● Precisa de você', { level: 'blocked', reason }, '● Precisa'))).toBeLessThanOrEqual(UNCUT_COLUMNS)
  }
  for (const reason of ['turn_ended', 'interrupted', 'first_prompt'] as const) {
    const pills = sessionPills('○ Ociosa', { level: 'idle', reason })
    expect(pills[0]!.text).toBe('○ Ociosa')
    expect(width(pills)).toBeLessThanOrEqual(UNCUT_COLUMNS)
  }
})

test('0.0.30: the This session card fits its height in every state, in both widths, with the whole model line', async ($, on) => {
  const f = await open($, on, { scenario: 'p1' })
  const p1 = SCENARIOS.p1
  const longText = { model: 'claude-opus-5-5', startedAt: new Date(NOW - 2 * 86_400_000).toISOString(), turn: 262 }
  const states: Partial<NonNullable<Panel['session']>>[] = [
    { state: 'active', status: 'active', reason: null },
    { state: 'waiting', status: 'waiting', reason: 'stop', activity: { type: 'your-turn', text: `"Passei sua decisão para a sessão filha e ${'conferi tudo de novo '.repeat(4)}"` } },
    { state: 'waiting', status: 'waiting', reason: 'notification', activity: { type: 'permission', text: 'Bash: npm run migrate' } },
    { state: 'waiting', status: 'waiting', reason: 'interrupted', activity: { type: 'interrupted', text: 'Esc no meio do turno' } },
    { state: 'error', status: 'error', reason: null, activity: { type: 'error', text: 'API 529. Parou.' } },
    { state: 'completed', status: 'completed', reason: null, activity: { type: 'completed', text: 'terminou sem erro' } },
  ]
  for (const e of states) {
    f.state.panel = { ...p1, session: { ...p1.session!, ...longText, ...e } as NonNullable<Panel['session']> }
    await f.timer.advance(15_000)
    for (const target of [PANE, WIDE]) {
      const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
      const card = await ui.find({ key: 'card-session' })
      const content = ((card as any).children as any[]).filter(Boolean)
      // Cabeçalho, pills, título, modelo e atividade: cada um numa linha, dentro das linhas do card.
      expect(content.length).toBeLessThanOrEqual(CARD_LINES)
      const pills = content[1]
      const pillsText = (await ui.findAll({ type: 'Text' })).filter((t) => t.key === 'status' || t.key === 'reason').map((t) => t.text ?? '')
      expect(pillsText.join(' ').length).toBeLessThanOrEqual(UNCUT_COLUMNS)
      expect(pills?.props.flexWrap).toBe('nowrap')
      const model = await ui.find({ type: 'Text', text: /turno 262|t262/ })
      expect([...(model?.text ?? '')].length).toBeLessThanOrEqual(UNCUT_COLUMNS)
      expect(model?.text).not.toMatch(/…/)
      await ui.unmount()
    }
  }
})

// #278 (P14): the session runs on a remote machine whose connection is down.

/** The Workstation of P14: the tunnel fell when the SSO session expired; the last reading is from 5 h ago. */
const READ_AT = NOW - 5 * 3_600_000
function onWorkstation(connection: NonNullable<Panel['machine']>['connection']): Panel {
  return { ...SCENARIOS.p1, machine: { id: 'workstation', label: 'Workstation', lastReadAt: new Date(READ_AT).toISOString(), connection } }
}
const SSO_EXPIRED: NonNullable<Panel['machine']>['connection'] = {
  state: 'down',
  since: new Date(READ_AT).toISOString(),
  lastError: { reason: 'sso-expired', at: new Date(READ_AT).toISOString(), exitCode: null, holder: null },
}

test('P14 narrow and wide: a band at the top of the current-session card with the reason and the link to resolve it in the console', async ($, on) => {
  const f = await open($, on)
  f.state.panel = onWorkstation(SSO_EXPIRED)
  await f.timer.advance(5_000)
  const at = clockTime(READ_AT)
  for (const [target, title, detail] of [
    [PANE, '⊘ Sem conexão · SSO expirado', `Roda na Workstation · última leitura ${at}`],
    [WIDE, '⊘ Workstation sem conexão · SSO expirado', `Esta sessão roda na Workstation. O que você vê é a última leitura, de ${at}; o túnel caiu quando a sessão AWS expirou.`],
  ] as const) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    const band = await ui.find({ key: 'machine-banner' })
    expect(band).toBeDefined()
    expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: detail })).toBeDefined()
    const links = (await ui.findAll({ type: 'Link' })).map((l: any) => l.props.href)
    expect(links).toContain('http://localhost:4720/ui/machines/workstation')
    expect(await ui.find({ type: 'Text', text: 'resolver no console ›' })).toBeDefined()
    // First under the section label, before the cards; the panel offers nothing that runs.
    const keys = (await ui.findAll({ type: 'Box' })).map((b: any) => b.key)
    expect(keys.indexOf('machine-banner')).toBeGreaterThan(keys.indexOf('section-ESTA SESSÃO'))
    expect(keys.indexOf('machine-banner')).toBeLessThan(keys.indexOf('cards'))
    expect((await ui.findAll({ type: 'Button' })).some((b: any) => /Entrar|Reconectar|Subir/.test(String(b.props.label)))).toBe(false)
    await ui.unmount()
  }
})

test('P14: the other reasons and states in plain words; no band when the connection is up, on this machine, or from an older core', async ($, on) => {
  const f = await open($, on)
  const cases: [NonNullable<Panel['machine']>['connection'], string][] = [
    [{ state: 'failing', since: null, lastError: { reason: 'port-busy', holder: 'node' } }, '⊘ Workstation sem conexão · porta ocupada'],
    [{ state: 'failing', since: null, lastError: { reason: 'ssm-agent-offline', exitCode: 255 } }, '⊘ Workstation sem conexão · agente SSM offline'],
    [{ state: 'failing', since: null, lastError: { reason: 'exit-code', exitCode: 255 } }, '⊘ Workstation sem conexão · o comando falhou'],
    [{ state: 'down', since: null, lastError: { reason: 'core-not-answering' } }, '⊘ Workstation sem conexão · núcleo de lá parado'],
    [{ state: 'down', since: null, lastError: null }, '⊘ Workstation sem conexão · túnel fora'],
    [{ state: 'down', since: null, lastError: { reason: 'motivo-novo' } }, '⊘ Workstation sem conexão · túnel fora'],
    [{ state: 'stopped', since: null, lastError: null }, '⊘ Workstation sem conexão · parada por você'],
    [{ state: 'starting', since: null, lastError: { reason: 'sso-expired' } }, '⊘ Workstation sem conexão · subindo o túnel'],
  ]
  for (const [connection, title] of cases) {
    f.state.panel = onWorkstation(connection)
    await f.timer.advance(15_000)
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
    expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
    await ui.unmount()
  }
  const none: Panel[] = [
    onWorkstation({ state: 'up', since: null, lastError: null }),
    onWorkstation(null),
    { ...onWorkstation(SSO_EXPIRED), machine: { ...onWorkstation(SSO_EXPIRED).machine!, id: 'local' } },
    SCENARIOS.p1,
  ]
  for (const panel of none) {
    f.state.panel = panel
    await f.timer.advance(15_000)
    for (const target of [PANE, WIDE]) {
      const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
      expect(await ui.find({ key: 'machine-banner' })).toBeUndefined()
      await ui.unmount()
    }
  }
})
