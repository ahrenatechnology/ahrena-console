// Guarda do encaixe (0.0.32): em todo cenário, nas duas larguras e em cada estado da sessão, nenhum
// texto passa da largura que tem e o conteúdo de cada card cabe na altura dele. A medida é a do mod
// (hooks/fit.ts), em colunas, e não a prop `wrap`: o Desktop deixou de encurtar o `truncate-end`.
import { expect, mock, test } from 'claude-code/testing'

import type { Panel, PanelSession } from '../types'
import { CARD_LINES } from '../hooks/height'
import { CARD_W, TITLE_LINES, sessionTitle } from '../hooks/render'
import { heightOf, kids, overflows, textOf, type Node } from '../hooks/fit'
import { NOW, SCENARIOS } from './scenarios'

const PANE = {
  component: 'Pane',
  requestId: 'ahrena-console-sessao',
  props: { title: 'Ahrena Console', isFocused: true, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} },
} as const
const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 121 } }
const CONSOLE = { command: 'console', args: '', origin: { kind: 'user' }, presentation: 'text' } as any

/** A altura de conteúdo de um card: as linhas dele menos a do respiro de baixo (`paddingBottom` 2, ~1 linha). */
const CARD_CONTENT_LINES = CARD_LINES - 1

/** O texto longo de 300 caracteres que o card mostra como a última mensagem. */
const LONG_MESSAGE =
  '"A sessão da #221 explicou o que acontece com o MCP quando o núcleo passar a usar porta aleatória. O registro do MCP no Claude Code deixa de apontar para a porta certa depois de um reinício, e a sessão propõe ler a porta do arquivo do núcleo a cada chamada, com a 4720 só como reserva para o núcleo antigo."'

/**
 * O caso real do print do Fernando (anonimizado): a sessão de 3 dias, no turno 313, esperando a sua
 * vez, com o título longo e a última mensagem longa.
 */
const REAL: Panel = {
  ...SCENARIOS.p1,
  session: {
    ...SCENARIOS.p1.session!,
    title: 'PM da rodada · Ahrena Console · 17/10/2026',
    model: 'claude-opus-5-5',
    startedAt: new Date(NOW - 3 * 86_400_000).toISOString(),
    turn: 313,
    status: 'waiting',
    state: 'waiting',
    reason: 'stop',
    activity: { type: 'your-turn', text: LONG_MESSAGE },
  },
}

const LONG_TITLE = 'Revisar a migração do núcleo para porta aleatória com o registro do MCP e o app do Desktop · rodada de 20/10/2026'

/** Os estados da sessão em que o card Esta sessão é desenhado. */
const STATES: Record<string, Partial<PanelSession>> = {
  active: { state: 'active', status: 'active', reason: null, attention: null, activity: { type: 'tool', text: 'rodando Bash · npm test' } },
  waiting: { state: 'waiting', status: 'waiting', reason: 'stop', attention: { level: 'idle', reason: 'turn_ended' }, activity: { type: 'your-turn', text: LONG_MESSAGE } },
  permission: { state: 'waiting', status: 'waiting', reason: 'notification', attention: { level: 'blocked', reason: 'permission' }, activity: { type: 'permission', text: `Bash: ${'npm run migrate -- --all '.repeat(8)}` } },
  error: { state: 'error', status: 'error', reason: null, attention: { level: 'blocked', reason: 'error' }, activity: { type: 'error', text: `API 529: ${'sobrecarga no servidor '.repeat(10)}. Parou.` } },
  completed: { state: 'completed', status: 'completed', reason: null, attention: null, activity: { type: 'completed', text: LONG_MESSAGE } },
  // #245: every reason of "Precisa de você" and of "Ociosa", and a core from before it (no field).
  ...Object.fromEntries(
    (['question', 'plan', 'decision', 'interrupted', 'first_prompt'] as const).map((reason) => [
      reason,
      {
        state: 'waiting',
        status: 'waiting',
        reason: reason === 'interrupted' ? 'interrupted' : reason === 'first_prompt' ? 'session_start' : 'notification',
        attention: { level: reason === 'interrupted' || reason === 'first_prompt' ? 'idle' : 'blocked', reason },
        activity: { type: 'question', text: LONG_MESSAGE },
      } satisfies Partial<PanelSession>,
    ]),
  ),
  'old-core': { state: 'waiting', status: 'waiting', reason: 'stop', attention: undefined, activity: { type: 'your-turn', text: LONG_MESSAGE } },
}

/** Os painéis do guarda: os cenários, o caso real e o título longo, em cada estado. */
function cases(): [string, Panel][] {
  const out: [string, Panel][] = []
  const bases: [string, Panel][] = [
    ...(['p1', 'p4', 'p6', 'p12', 'p13'] as const).map((k) => [k, SCENARIOS[k]] as [string, Panel]),
    ['real', REAL],
    ['long-title', { ...REAL, session: { ...REAL.session!, title: LONG_TITLE } }],
    // #278 (P14): the band of a machine without connection, with the longest reason.
    ['p14', { ...REAL, machine: { id: 'workstation', label: 'Workstation', lastReadAt: new Date(NOW - 5 * 3_600_000).toISOString(), connection: { state: 'failing', since: null, lastError: { reason: 'core-not-answering' } } } }],
  ]
  for (const [name, p] of bases) {
    if (!p.session) {
      out.push([name, p])
      continue
    }
    for (const [st, e] of Object.entries(STATES)) out.push([`${name}/${st}`, { ...p, session: { ...p.session, ...e } as PanelSession }])
  }
  return out
}

function fakes(on: any) {
  const state: { panel: Panel } = { panel: SCENARIOS.p1 }
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(state.panel) } }))
  const timer = mock.clock(on, { now: NOW })
  mock.env(on, {})
  let open = false
  on('session.id', async () => ({ value: 'sessao-teste' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', async () => ({ value: '/simulacao/ahrena-demo' }))
  on('ui.panes', async () => ({ value: open ? [{ id: 'ahrena-console-sessao', title: 'Ahrena Console', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.open', async () => ((open = true), { value: { isPlaced: true } }))
  on('ui.status', async () => ({ value: undefined }))
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return { state, timer }
}

/** Os cards de um desenho e o que passa da largura ou da altura em cada um. */
async function problems(ui: any, cols: number): Promise<string[]> {
  const out: string[] = []
  const root = (await ui.findAll({ type: 'Box' }))[0] as Node
  out.push(...overflows(root, cols))
  for (const card of (await ui.findAll({ type: 'Box' })).filter((b: any) => /^card-/.test(b.key ?? '')) as Node[]) {
    const key = String((card as { key?: string }).key)
    const inner = CARD_W - 2 - 2
    const lines = kids(card).reduce((a, x) => a + heightOf(x, inner), 0)
    if (lines > CARD_CONTENT_LINES) out.push(`${key}: ${lines} linhas > ${CARD_CONTENT_LINES} (${kids(card).map((x) => textOf(x).slice(0, 30)).join(' | ')})`)
  }
  return out
}

test('every text fits its width and every card fits its height, in every scenario, state and width', async ($, on) => {
  const f = fakes(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.command.run(CONSOLE)
  const found: string[] = []
  for (const [name, panel] of cases()) {
    f.state.panel = panel
    await f.timer.advance(15_000)
    for (const target of [PANE, WIDE]) {
      const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
      for (const p of await problems(ui, target.props.bodyColumns)) found.push(`${name} @${target.props.bodyColumns}: ${p}`)
      await ui.unmount()
    }
  }
  expect(found).toEqual([])
})

/** As linhas de conteúdo do card Esta sessão, como os filhos dele: cabeçalho, pills, título, modelo e a mensagem. */
async function sessionCard(ui: any) {
  const card = (await ui.find({ key: 'card-session' })) as Node
  return kids(card).map((x) => textOf(x))
}

test('the last message: one line, shortened at the end, in the Waiting state, in both widths, with the 0.0.30 line count', async ($, on) => {
  const f = fakes(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.command.run(CONSOLE)
  // Um título que cabe numa linha, como o do P1: o card tem as 5 linhas da 0.0.30.
  f.state.panel = { ...REAL, session: { ...REAL.session!, title: 'Kanban de sessões no artefato' } }
  await f.timer.advance(15_000)
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    const lines = await sessionCard(ui)
    expect(lines).toHaveLength(5)
    expect(lines[2]).toBe('Kanban de sessões no artefato')
    const message = lines[4]!
    expect(message.startsWith('↵ "A sessão da #221 explicou')).toBe(true)
    expect(message.endsWith('…')).toBe(true)
    expect([...message].length).toBeLessThan(LONG_MESSAGE.length / 4)
    const text = (await ui.findAll({ type: 'Text' })).find((t: any) => (t.text ?? '').startsWith('↵ "A sessão'))
    expect(text?.props.wrap).toBe('truncate-end')
    await ui.unmount()
  }
})

test('the title never gets cut: up to 2 lines; with 2 the last message leaves; past 2, shortened by whole words', async ($, on) => {
  const f = fakes(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.command.run(CONSOLE)
  // O caso real do print: o título em 2 linhas, inteiro, e o card com as mesmas 5 linhas.
  f.state.panel = REAL
  await f.timer.advance(15_000)
  for (const target of [PANE, WIDE]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...target })
    const lines = await sessionCard(ui)
    // Cabeçalho, pills, o título (2 linhas) e o modelo: as 5 linhas da 0.0.30, sem a mensagem.
    expect(lines.slice(2)).toEqual(['PM da rodada · Ahrena Console · 17/10/2026', 'Opus 5.5 · 3 d · turno 313'])
    expect(lines.some((l) => l.includes('A sessão da #221'))).toBe(false)
    await ui.unmount()
  }
  // Mais longo que 2 linhas: encurta por palavra inteira, sem reticências.
  const long = sessionTitle(LONG_TITLE)
  expect(long.lines).toBe(TITLE_LINES)
  expect(long.text).not.toMatch(/…/)
  expect(LONG_TITLE.startsWith(long.text)).toBe(true)
  expect(LONG_TITLE[long.text.length]).toBe(' ')
  expect(sessionTitle('PM da rodada · Ahrena Console · 17/10/2026')).toEqual({ text: 'PM da rodada · Ahrena Console · 17/10/2026', lines: 2 })
  expect(sessionTitle('Kanban de sessões no artefato')).toEqual({ text: 'Kanban de sessões no artefato', lines: 1 })
})
