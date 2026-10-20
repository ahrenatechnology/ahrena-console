// As decisões da sessão no painel (#102, wireframes P9 e P10), nas duas larguras. O núcleo falso
// responde o cenário P9 do simulador (tests/scenarios.ts) e, com `?decisions=<scope>`, a lista
// gravada daquele escopo; o Confirmar e o Descartar mudam a resposta como o núcleo mudaria.
import { expect, mock, test } from 'claude-code/testing'

import type { PanelDecision, DecisionScope, DecisionList, Panel } from '../types'
import { NOW, SCENARIOS, P9_LISTS } from './scenarios'

type Request = { method: string; url: string; headers?: Record<string, string>; body?: string }

const PANE = {
  component: 'Pane',
  requestId: 'ahrena-console-sessao',
  props: { title: 'Ahrena Console', isFocused: true, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } },
} as const
const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 121 } }
const CONSOLE = { command: 'console', args: '', origin: { kind: 'user' }, presentation: 'text' } as any

const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

function fakes(on: any, base: Panel = SCENARIOS.p9, conversation: 'full' | 'compacted' = 'full') {
  const requests: Request[] = []
  const toasts: string[] = []
  const scrolls: unknown[] = []
  const status: (string | undefined)[] = []
  const panel = copy(base)
  const lists = copy(P9_LISTS) as Record<DecisionScope, DecisionList>
  const outside = new Map<string, PanelDecision>()
  on('http.fetch', async (_$: unknown, e: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }) => {
    requests.push({ method: e.init?.method ?? 'GET', url: e.url, headers: e.init?.headers, body: e.init?.body })
    const url = new URL(e.url)
    const action = /^\/api\/decisions\/([^/]+)\/(confirm|dismiss|adjust|undo)$/.exec(url.pathname)
    if (action) {
      const id = decodeURIComponent(action[1]!)
      let answer: PanelDecision | null = null
      for (const l of Object.values(lists)) {
        const d = l.items.find((i) => i.id === id) ?? outside.get(id)
        if (!d) continue
        if (action[2] === 'confirm') {
          l.toConfirm--
          d.state = 'current'
          d.confirmedAt = new Date(NOW).toISOString()
          d.undo = 'confirm'
          l.current++
        } else if (action[2] === 'dismiss') {
          l.toConfirm--
          d.state = 'dismissed'
          d.undo = 'dismiss'
          outside.set(id, d)
          l.items = l.items.filter((i) => i.id !== id)
        } else if (action[2] === 'adjust') {
          d.state = 'superseded'
          d.undo = 'adjust'
        } else {
          d.state = 'to_confirm'
          d.undo = null
          if (!l.items.includes(d)) l.items.unshift(d)
        }
        answer = copy(d)
      }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ decision: answer }) } }
    }
    const scope = url.searchParams.get('decisions') as DecisionScope | null
    const body = panel.decisions ? { ...panel, decisions: { ...panel.decisions, list: scope ? lists[scope] : null } } : panel
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  const timer = mock.clock(on, { now: NOW })
  mock.env(on, {})
  on('ui.status', async (_$: unknown, e: { text?: string }) => {
    status.push(e?.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$: unknown, e: { text?: string } | string) => {
    toasts.push(typeof e === 'string' ? e : (e?.text ?? ''))
    return { value: undefined }
  })
  on('ui.scroll', async (_$: unknown, e: unknown) => {
    scrolls.push(e)
    return { value: {} }
  })
  // A conversa como o engine a tem: inteira (as mensagens das decisões estão nela) ou compactada (não estão).
  const ids = Object.values(P9_LISTS).flatMap((l) => l.items.map((d) => d.toolUseId)).filter((x): x is string => !!x)
  on('session.messages', async () => ({
    value: conversation === 'full' ? [{ role: 'assistant', text: '', toolUses: ids.map((tool_use_id) => ({ tool_use_id, tool: 'AskUserQuestion', input: {} })) }] : [{ role: 'user', text: 'resumo da compactação', toolUses: [] }],
  }))
  on('session.id', async () => ({ value: 'sessao-teste' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', async () => ({ value: '/simulacao/ahrena-demo' }))
  on('ui.panes', async () => ({ value: [{ id: 'ahrena-console-sessao', title: 'Ahrena Console', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return { requests, toasts, scrolls, status, timer, panel, lists }
}

async function open($: any, on: any, base?: Panel, conversation: 'full' | 'compacted' = 'full') {
  const f = fakes(on, base, conversation)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.command.run(CONSOLE)
  await f.timer.advance(5_000)
  return f
}

const byLabel = (scope: DecisionScope, label: string) => P9_LISTS[scope].items.find((i) => i.label === label) as PanelDecision
const card = (d: PanelDecision) => `decision-${d.id}`

test('the neutral "N decisões registradas" line, and those to confirm at the top, in both widths and in the status line', async ($, on) => {
  const f = await open($, on)
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    expect(await ui.find({ key: 'card-session' })).toBeDefined()
    expect(await ui.find({ key: 'decisions' })).toBeDefined()
    // pnDec do P1: "⊸ N decisões registradas" e "Ver", neutra; as a confirmar, numa faixa própria no topo.
    expect((await ui.find({ key: 'decisions' }))?.text).toMatch(target === WIDE ? /4 decisões registradas nesta sessão/ : /4 decisões registradas/)
    expect((await ui.find({ key: 'decisions' }))?.text).not.toMatch(/a confirmar/)
    expect((await ui.find({ key: 'to-confirm' }))?.text).toMatch(/1 decisão a confirmar/)
    expect(await ui.find({ type: 'Text', text: /4 decisões registradas/ })).toBeDefined()
    // Registro, não pendência: sem cara de ação.
    expect((await ui.find({ key: 'decisions' }))?.text).not.toMatch(/vigentes/)
    expect(await ui.find({ key: 'show-decisions' })).toBeDefined()
    expect(await ui.find({ key: 'resume' })).toBeUndefined()
    await ui.unmount()
  }
  expect(f.status.at(-1)).toBe('ahrena-console ● Ativa · 4 decisões · 1 precisa de você')
})

test('without decisions, the line says there are none', async ($, on) => {
  await open($, on, SCENARIOS.p1)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /nenhuma decisão registrada/ })).toBeDefined()
  await ui.unmount()
})

test('a core from before decisions, without the field: the panel does not draw the line', async ($, on) => {
  const old = copy(SCENARIOS.p1)
  delete old.decisions
  await open($, on, old)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ key: 'card-session' })).toBeDefined()
  expect(await ui.find({ key: 'decisions' })).toBeUndefined()
  await ui.unmount()
})

test('P9 narrow: Sessão, 3 cards 34 × 6 and "+2 · troque o escopo"', async ($, on) => {
  const f = await open($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'show-decisions' })
  expect(f.requests.at(-1)!.url).toMatch(/[?&]decisions=session\b/)
  expect(await ui.find({ key: 'card-session' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /DECISÕES · 3 VIGENTES/ })).toBeDefined()
  expect((await ui.find({ key: 'decisions-scope' }))?.props.value).toBe('session')

  const cards = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('decision-'))
  expect(cards).toHaveLength(3)
  for (const c of cards) {
    expect(c.props.width).toBe(34)
    // Todo card do P1 tem a mesma altura fixa: a borda e 7 linhas.
    expect(c.props.height).toBe(10)
    expect(c.props.overflow).toBe('hidden')
  }

  // A sugerida: origem, há quanto tempo, título, "não: …", pílula, quem, os dois botões e a borda.
  const suggested = byLabel('session', 'D6')
  const s = await ui.find({ key: card(suggested) })
  expect(s?.props.borderColor).not.toBe(cards[1]!.props.borderColor)
  expect(s?.text).toMatch(/✲ SUGERIDA/)
  expect(s?.text).toMatch(/há 6 min/)
  expect(s?.text).toMatch(/10 cards por coluna, com "mostrar mais"/)
  expect(s?.text).toMatch(/não: 20 por coluna; rolagem infinita/)
  expect(s?.text).toMatch(/A confirmar/)
  expect(s?.text).toMatch(/agente propôs/)
  expect(await ui.find({ key: `confirm-${suggested.id}` })).toBeDefined()
  expect(await ui.find({ key: `dismiss-${suggested.id}` })).toBeDefined()

  const correction = await ui.find({ key: card(byLabel('session', 'D4')) })
  expect(correction?.text).toMatch(/↳ CORREÇÃO SUA/)
  expect(correction?.text).toMatch(/há 14 min/)
  expect(correction?.text).toMatch(/não: Postgres no Docker/)
  expect(correction?.text).toMatch(/Vigente/)
  expect(correction?.text).toMatch(/você corrigiu/)
  expect(correction?.text).toMatch(/ver na conversa/)
  const permission = await ui.find({ key: card(byLabel('session', 'D5')) })
  expect(permission?.text).toMatch(/⛉ PERMISSÃO/)
  expect(permission?.text).toMatch(/Permitir npm test sem perguntar/)

  expect(await ui.find({ type: 'Text', text: /\+2 · troque o escopo/ })).toBeDefined()
  await ui.press({ key: 'close-decisions' })
  expect(await ui.find({ key: 'card-session' })).toBeDefined()
  await ui.unmount()
})

test('P9 wide: Família, the 6 cards, the superseded one struck through pointing at D4, and the scope footer', async ($, on) => {
  const f = await open($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  await ui.press({ key: 'show-decisions' })
  expect(f.requests.at(-1)!.url).toMatch(/[?&]decisions=family\b/)
  expect(await ui.find({ type: 'Text', text: /DECISÕES · 4 VIGENTES/ })).toBeDefined()
  expect((await ui.find({ key: 'decisions-scope' }))?.props.value).toBe('family')
  const cards = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('decision-'))
  expect(cards).toHaveLength(6)
  expect(cards.every((c) => c.props.width === 34 && c.props.height === 10)).toBe(true)

  const old = await ui.find({ key: card(byLabel('family', 'D3')) })
  expect(old?.text).toMatch(/Substituída/)
  expect(old?.text).toMatch(/substituída por D4/)
  expect(old?.text).not.toMatch(/ver na conversa/)
  const title = await ui.find({ type: 'Text', text: 'Postgres no Docker nos testes' })
  expect(title?.props.strikethrough).toBe(true)

  expect((await ui.find({ key: card(byLabel('family', 'D2')) }))?.text).toMatch(/☰ PLANO.*há 40 min/s)
  expect((await ui.find({ key: card(byLabel('family', 'D2')) }))?.text).toMatch(/você aprovou/)
  const parent = await ui.find({ key: card(byLabel('family', 'D1')) })
  expect(parent?.text).toMatch(/\? PERGUNTA/)
  expect(parent?.text).toMatch(/ontem/)
  expect(parent?.text).toMatch(/você · sessão mãe/)
  expect(await ui.find({ type: 'Text', text: /escopo: Sessão · Família · Branch · mais recentes primeiro/ })).toBeDefined()

  // O Select troca o escopo e já pede a lista dele.
  await ui.select({ key: 'decisions-scope', value: 'branch' })
  expect(f.requests.at(-1)!.url).toMatch(/[?&]decisions=branch\b/)
  expect((await ui.find({ key: 'decisions-scope' }))?.props.value).toBe('branch')
  await ui.unmount()
})

test('Confirm and Dismiss: a JSON POST with the session, and the list read again', async ($, on) => {
  const f = await open($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'show-decisions' })
  const suggested = byLabel('session', 'D6')
  await ui.press({ key: `confirm-${suggested.id}` })
  const post = f.requests.find((p) => p.method === 'POST')!
  expect(post.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:4720/api/decisions/${encodeURIComponent(suggested.id)}/confirm`))
  expect(post.headers?.['content-type']).toBe('application/json')
  expect(JSON.parse(post.body!)).toEqual({ session: 'sessao-teste' })
  expect(f.requests.at(-1)!.method).toBe('GET')
  expect(f.toasts.at(-1)).toMatch(/D6 confirmada/)
  const confirmed = await ui.find({ key: card(suggested) })
  expect(confirmed?.text).toMatch(/Vigente/)
  expect(confirmed?.text).toMatch(/você confirmou/)
  expect(await ui.find({ key: `confirm-${suggested.id}` })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /DECISÕES · 4 VIGENTES/ })).toBeDefined()
  await ui.unmount()
})

test('Dismiss removes the suggested decision from the list', async ($, on) => {
  const f = await open($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  await ui.press({ key: 'show-decisions' })
  const suggested = byLabel('family', 'D6')
  await ui.press({ key: `dismiss-${suggested.id}` })
  expect(f.requests.some((p) => p.method === 'POST' && p.url.includes('/dismiss'))).toBe(true)
  expect(f.toasts.at(-1)).toMatch(/D6 descartada/)
  expect(await ui.find({ key: card(suggested) })).toBeUndefined()
  await ui.unmount()
})

test(`"ver na conversa" asks to scroll to this session's message; the parent session's one shows the excerpt`, async ($, on) => {
  const f = await open($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  await ui.press({ key: 'show-decisions' })
  await ui.press({ key: `show-${byLabel('family', 'D4').id}` })
  // O kit de testes não tem a conversa: o pedido de rolagem é recusado e o painel diz isso.
  expect(f.scrolls.length ? JSON.stringify(f.scrolls.at(-1)) : f.toasts.at(-1)).toMatch(/sim-toolu-p9-4|D4 não está à vista/)
  // A da sessão mãe não está nesta conversa: sem "ver na conversa", o trecho original no detalhe.
  const d1 = byLabel('family', 'D1')
  expect(await ui.find({ key: `show-${d1.id}` })).toBeUndefined()
  await ui.press({ key: `detail-${d1.id}` })
  expect((await ui.find({ key: 'decision-detail' }))?.text).toMatch(/TRECHO ORIGINAL.*na sessão mãe:/s)
  await ui.unmount()
})

test('P10: the resume banner shows only when the core sends it, in both widths', async ($, on) => {
  const resume = copy(SCENARIOS.p6)
  resume.decisions = { current: 4, toConfirm: 0, resume: { n: 4, tokens: 620, from: 'Kanban de sessões' }, list: null }
  const f = await open($, on, resume)
  const wide = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  expect(await wide.find({ key: 'resume' })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: /4 decisões da sessão anterior continuam valendo/ })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: /~620 tokens/ })).toBeDefined()
  expect(await wide.find({ type: 'Text', text: /4 decisões registradas/ })).toBeDefined()
  await wide.unmount()
  const narrow = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await narrow.find({ type: 'Text', text: /4 decisões da sessão anterior$/ })).toBeDefined()
  await narrow.press({ key: 'show-resume' })
  expect(await narrow.find({ key: 'decisions-scope' })).toBeDefined()
  await narrow.unmount()
  expect(f.status.at(-1)).toBe('ahrena-console ◐ No prompt · 4 decisões herdadas · 2 precisam de você')
})

test('#131: clicking the title opens the whole decision, with "← voltar" to the list', async ($, on) => {
  await open($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'show-decisions' })
  const d = byLabel('session', 'D4')
  await ui.press({ key: `open-${d.id}` })
  expect(await ui.find({ key: 'decision-detail' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /DECISÃO D4/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^DECIDIDO$/ })).toBeDefined()
  expect((await ui.find({ key: 'decision-detail' }))?.text).toMatch(/NÃO.*Postgres no Docker/s)
  expect(await ui.find({ key: `conversation-${d.id}` })).toBeDefined()
  expect(await ui.find({ key: `adjust-${d.id}` })).toBeDefined()
  await ui.press({ key: 'back-decisions' })
  expect(await ui.find({ key: 'decision-detail' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /DECISÕES · 3 VIGENTES/ })).toBeDefined()
  await ui.unmount()
})

test('#131: after Dismiss, "Desfazer" stays visible for a few seconds and brings the suggestion back', async ($, on) => {
  const f = await open($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'show-decisions' })
  const suggested = byLabel('session', 'D6')
  await ui.press({ key: `dismiss-${suggested.id}` })
  expect(await ui.find({ key: card(suggested) })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /D6 descartada/ })).toBeDefined()
  await ui.press({ key: 'undo-last' })
  expect(f.requests.find((p) => p.method === 'POST' && /\/undo\b/.test(p.url))).toBeDefined()
  expect(await ui.find({ key: card(suggested) })).toBeDefined()
  expect(await ui.find({ key: 'undo-bar' })).toBeUndefined()

  // Passados os segundos, a barra some.
  await ui.press({ key: `confirm-${suggested.id}` })
  expect(await ui.find({ key: 'undo-bar' })).toBeDefined()
  await f.timer.advance(15_000)
  expect(await ui.find({ key: 'undo-bar' })).toBeUndefined()
  await ui.unmount()
})

test(`#131: Adjust opens a field; the person's text goes to the core and the detail offers to undo the adjustment`, async ($, on) => {
  const f = await open($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  await ui.press({ key: 'show-decisions' })
  const suggested = byLabel('family', 'D6')
  await ui.press({ key: `open-${suggested.id}` })
  expect(await ui.find({ key: 'adjustment-text' })).toBeUndefined()
  await ui.press({ key: `adjust-${suggested.id}` })
  expect(await ui.find({ key: 'adjustment-text' })).toBeDefined()
  await ui.input({ key: 'adjustment-text', text: 'Sim, mas com 15 cards por coluna' })
  const post = f.requests.find((p) => p.method === 'POST' && /\/adjust\b/.test(p.url))!
  expect(JSON.parse(post.body!)).toEqual({ session: 'sessao-teste', text: 'Sim, mas com 15 cards por coluna' })
  expect(await ui.find({ key: 'adjustment-text' })).toBeUndefined()
  expect(await ui.find({ key: `undo-${suggested.id}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /D6 ajustada/ })).toBeDefined()
  await ui.unmount()
})

test('0.0.13: a decision from before compaction has no "ver na conversa"; the detail shows the original excerpt, with no error', async ($, on) => {
  await open($, on, undefined, 'compacted')
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'show-decisions' })
  const d = byLabel('session', 'D4')
  expect(await ui.find({ key: `show-${d.id}` })).toBeUndefined()
  expect((await ui.find({ key: card(d) }))?.text).toMatch(/ver o trecho/)
  await ui.press({ key: `detail-${d.id}` })
  const detail = await ui.find({ key: 'decision-detail' })
  expect(detail?.text).toMatch(/TRECHO ORIGINAL/)
  expect(detail?.text).toMatch(/você, \d\d\/\d\d \d\d:\d\d, nesta sessão, antes de uma compactação:/)
  expect(detail?.text).toMatch(/SQLite em memória nos testes/)
  expect(detail?.text).not.toMatch(/não está à vista|não está visível/)
  expect(await ui.find({ key: `conversation-${d.id}` })).toBeUndefined()
  await ui.unmount()
})

test(`0.0.23: the scope selector in normal case, with each scope's count; with all three equal, the notice`, async ($, on) => {
  const f = await open($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  await ui.press({ key: 'show-decisions' })
  const select = await ui.find({ key: 'decisions-scope' })
  const p9 = P9_LISTS.family.byScope!
  expect(select?.props.options.map((o: { label: string }) => o.label)).toEqual([`Sessão ${p9.session}`, `Família ${p9.family}`, `Branch ${p9.branch}`])
  // Nos dados do P9 os escopos diferem: sem aviso.
  expect(await ui.find({ type: 'Text', text: /mesmo resultado em Sessão/ })).toBeUndefined()
  await ui.unmount()

  // Todas as decisões desta sessão: os três escopos dão o mesmo, e o painel diz isso.
  const same = { session: 10, family: 10, branch: 10 }
  f.lists.family = { ...f.lists.family, byScope: same }
  f.lists.session = { ...f.lists.session, byScope: same }
  f.lists.branch = { ...f.lists.branch, byScope: same }
  const ui2 = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...WIDE })
  await ui2.select({ key: 'decisions-scope', value: 'session' })
  const warning = () => ui2.find({ type: 'Text', text: /mesmo resultado em Sessão, Família e Branch/ })
  for (let i = 0; i < 20 && !(await warning()); i++) await f.timer.advance(10)
  expect(await warning()).toBeDefined()
  expect((await ui2.find({ key: 'decisions-scope' }))?.props.options.map((o: { label: string }) => o.label)).toEqual(['Sessão 10', 'Família 10', 'Branch 10'])
  await ui2.unmount()
})
