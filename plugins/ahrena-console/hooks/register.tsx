// Painel lateral do Ahrena Console: esta sessão, o que roda dentro dela, o trabalho pelo
// branch e quem precisa de você em todas as contas (issues #35, #36, #37 e #116; decisões
// 0004 e 0006). Desenho em render.tsx, sobre os wireframes de docs/wireframes.
//
// Consumo (issue #81, decisão 0004): o painel só consulta o núcleo enquanto está aberto e à
// vista. Abre com /console (ou desenhado de novo depois de um reload) e para quando fecha,
// sai de cena ou a sessão termina; sessão sem painel aberto não faz nenhum pedido. A cada
// 5 s pede só GET /api/panel/<esta sessão>: um pedido, só a própria sessão. Com as decisões
// abertas (P9), o mesmo pedido leva `decisions=<scope>` e traz a lista; Confirmar e Descartar são
// um POST cada, só quando a pessoa aperta.
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, PromptOrigin, Register } from 'claude-code'

import type { PanelDecision, DecisionScope, Reading, Panel, SessionQuestion, NeedsYou, View } from '../types'
import { draw, decisionScopeOf, grid, type Actions, type Elements } from './render'
import { normalizeScope, scopeAfterAnswer, scopeOf } from './machines'
import { GRAPH_STATE, type GraphState } from './graph'
import { UNDO_MS, decisionsText, statusLine, model, unarchiveRequest, needYouText, statusGlyph, tokens } from './format'
import { LEGACY_CORE, discoverCore } from './discover'
import { ORDERS_EVERY_MS, pollOrders } from './orders'

// Id próprio: `ahrena-console` foi o do painel de teste (spikes/painel-teste), e o engine guarda
// por id o painel que a pessoa já abriu.
export const PANE = 'ahrena-console-sessao'
const EVERY_MS = 5000
// `127.0.0.1:<port>` of the core (#221, 5b). An explicit `port` option wins (the old `porta` is ignored);
// otherwise the core comes from the instance registry (hooks/discover.ts), and is looked up again
// when it stops answering (a core restarted on a new port). No live core: 127.0.0.1:4720, as before.
let core = LEGACY_CORE
/** The address set by the `port` option, or `null` to discover through the registry. */
let explicitCore: string | null = null
/** Whether `core` came from a lookup that still holds (reset when the core stops answering). */
let resolved = false

async function resolveCore($: Engine): Promise<string> {
  if (explicitCore) return (core = explicitCore)
  if (!resolved) {
    core = (await discoverCore($).catch(() => null)) ?? LEGACY_CORE
    resolved = true
  }
  return core
}

const EMPTY_READING: Reading = { panel: null, readAt: null, offline: false, error: null, nextAt: null }
const EMPTY_VIEW: View = { screen: 'session', scope: null, decisionsScope: null }
const DECISION_SCOPES: readonly DecisionScope[] = ['session', 'family', 'branch']

const reading = atom({ plugin: 'ahrena-console', key: 'reading' } as const, EMPTY_READING)
const view = atom({ plugin: 'ahrena-console', key: 'view' } as const, EMPTY_VIEW)
// A pergunta com que esta sessão terminou o turno (#140): no topo do painel até a pessoa responder.
const question = atom({ plugin: 'ahrena-console', key: 'question' } as const, null as SessionQuestion | null)

// O relógio do polling: existe só enquanto o painel está aberto (iniciar/parar).
let timer: { cancel: () => void } | undefined
// O que o painel manda junto com o id, lido uma vez por carga do módulo.
let panelQuery: string | undefined
// A largura do último desenho: decide o escopo padrão das decisões no pedido.
let columns = 38
/** As linhas do corpo no último desenho (`scroll.bodyRows`), para o polling saber o que a tela mostra. */
let bodyRows: number | undefined

// Estado salvo por outra versão do painel pode vir com outro formato: vale só o que reconhecemos.
function normalizeReading(v: unknown): Reading {
  const r = (v ?? {}) as Partial<Reading>
  const panel = r.panel && (r.panel as Panel).version === 1 && (r.panel as Panel).needYou ? (r.panel as Panel) : null
  return { ...EMPTY_READING, ...r, panel }
}

// Em andamento neste módulo: o "compactando…" vale enquanto a chamada não volta.
let compacting = false

const SCREENS: readonly View['screen'][] = ['session', 'need-you', 'decisions', 'plans', 'decision', 'subagents', 'children', 'prs']

function normalizeView(v: unknown): View {
  const r = (v ?? {}) as Partial<View>
  const decision = r.decision && typeof r.decision === 'object' && typeof r.decision.id === 'string' ? r.decision : null
  const u = r.lastAction
  return {
    screen: SCREENS.includes(r.screen as View['screen']) && (r.screen !== 'decision' || decision) ? (r.screen as View['screen']) : 'session',
    scope: normalizeScope(r.scope),
    decisionsScope: DECISION_SCOPES.includes(r.decisionsScope as DecisionScope) ? (r.decisionsScope as DecisionScope) : null,
    decision,
    adjusting: r.adjusting === true,
    lastAction: u && typeof u.id === 'string' && typeof u.at === 'number' ? u : null,
    reachable: Array.isArray(r.reachable) ? r.reachable.filter((x): x is string => typeof x === 'string') : [],
    // "compactando" não sobrevive a um reload: a chamada que o mostrava acabou com o módulo.
    compact: r.compact === 'compacting' && compacting ? 'compacting' : r.compact === 'confirm' ? 'confirm' : null,
    graph: normalizeGraph(r.graph),
  }
}

/** #146: o estado do grafo salvo por outra versão vale só no que reconhecemos. */
function normalizeGraph(v: unknown): GraphState {
  const r = (v ?? {}) as Partial<GraphState>
  const numbers = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is number => Number.isInteger(n) && n > 0) : [])
  return {
    page: Number.isInteger(r.page) && r.page! >= 0 ? r.page! : 0,
    opened: numbers(r.opened),
    closed: numbers(r.closed),
    filter: r.filter === 'active' ? 'active' : 'all',
  }
}

async function readReading($: Engine) {
  return normalizeReading(await read($, reading))
}

async function changeView($: Engine, patch: Partial<View>) {
  await update($, view, (v) => ({ ...normalizeView(v), ...patch }))
}

/** O endereço do pedido: o id da sessão e o que o painel sabe dela pelo ambiente (decisão 0006, ordem 1). */
async function panelPath($: Engine): Promise<string> {
  if (panelQuery === undefined) {
    const params: string[] = []
    const add = (k: string, v: string | undefined | null) => {
      if (v) params.push(`${k}=${encodeURIComponent(v)}`)
    }
    add('local', await $.env.get('CLAUDE_CODE_HOST_SESSION_ID'))
    add('account', await $.env.get('CLAUDE_CODE_ACCOUNT_UUID'))
    add('org', await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID'))
    add('model', await $.session.model().catch(() => null))
    add('cwd', await $.session.cwd().catch(() => null))
    panelQuery = `/api/panel/${encodeURIComponent(await $.session.id())}${params.length ? `?${params.join('&')}` : ''}`
  }
  return panelQuery
}

/**
 * O prompt é da própria pessoa? Digitado (no terminal ou no Desktop, que é um host do SDK), pelo
 * celular (bridge) ou mandado por um plugin em nome dela (`asUser`, como os botões do painel). Sem
 * `origin` (engine antigo), conta como dela.
 */
function fromThePerson(origin: PromptOrigin | undefined): boolean {
  if (!origin) return true
  if (origin.kind === 'plugin') return origin.asUser === true
  return origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'
}

/**
 * O pedido do tick: com as decisões abertas, leva o escopo para a lista vir junto. #262: every tick
 * also carries the "Ver" list's scope (`needYou=`), the person's or the width's default, so the count
 * on the main screen sums every machine; a core before #262 ignores it.
 */
async function tickPath($: Engine, v: View): Promise<string> {
  const base = await panelPath($)
  const scope = scopeOf(v, grid(columns).perRow === 1, (await readReading($)).panel)
  const decisions = v.screen === 'decisions' ? `&decisions=${decisionScopeOf(v, columns)}` : ''
  return `${base}${base.includes('?') ? '&' : '?'}needYou=${encodeURIComponent(scope)}${decisions}`
}

// O pedido de todo tick: esta sessão, a conta e quantas precisam de você, nunca a frota.

/** Os elementos de mentira: o desenho vira dados puros, sem os onPress, para comparar o que a tela mostra. */
const SHADOW = Object.fromEntries(
  ['Box', 'Text', 'Button', 'Link', 'Select', 'Svg', 'Input'].map((t) => [t, (p: Record<string, unknown>) => ({ t, ...p })]),
) as unknown as Elements
const NO_ACTIONS = new Proxy({}, { get: () => () => undefined }) as Actions

/** O que se clica numa árvore (os botões, pela key e o rótulo; os links, pelo href): o que a pessoa pode estar prestes a clicar. */
function buttonsOf(no: unknown, output: string[] = []): string[] {
  if (Array.isArray(no)) for (const n of no) buttonsOf(n, output)
  else if (no && typeof no === 'object') {
    const o = no as { t?: string; key?: unknown; children?: unknown; label?: unknown; href?: unknown }
    if (o.t === 'Button') output.push(`${String(o.key)}=${JSON.stringify(o.label ?? o.children)}`)
    if (o.t === 'Link') output.push(`link=${String(o.href)}`)
    buttonsOf(o.children, output)
  }
  return output
}

/**
 * O que a tela mostra com esta leitura: o desenho inteiro, e só os botões. O que muda nos dados
 * sem mudar o desenho (generatedAt, tokens que o rótulo arredonda, o `since` de um card que não o
 * mostra) não regrava o atom.
 */
async function whatIsSeen($: Engine, l: Reading, v: View, now: number): Promise<{ screen: string; buttons: string }> {
  try {
    const q = ((await read($, question)) ?? null) as SessionQuestion | null
    const tree = draw({ el: SHADOW, reading: l, view: v, question: q, cols: columns, lines: bodyRows, now, core, actions: NO_ACTIONS })
    return { screen: JSON.stringify(tree), buttons: buttonsOf(tree).join('\n') }
  } catch {
    // sem o desenho, cada leitura conta como mudança
    return { screen: String(now), buttons: String(now) }
  }
}

/**
 * Uma mudança que só troca números ou textos (o contexto subindo, a atividade da sessão) espera
 * isso desde a última gravação; a que troca os botões (uma pergunta, um card novo) grava na hora.
 */
const MIN_REDRAW_MS = 15_000

// A última leitura boa e quando o atom foi gravado. Ficam fora do atom: o atom só muda quando o
// desenho muda (ver `refresh`).
let last: { screen: string; buttons: string; readAt: number; writtenAt: number; status: string | null } = { screen: '', buttons: '', readAt: 0, writtenAt: 0, status: null }

function showStatus($: Engine, text: string) {
  if (last.status === text) return
  last.status = text
  $.ui.status(text)
}

/**
 * O contexto desta sessão pelo engine, o mesmo número da barra do Claude Code: ele acompanha a
 * compactação na hora, o que o núcleo (que lê o uso das respostas) só faz na próxima resposta.
 * A chamada não custa nada; sem ela (engine antigo, terminal), vale o número do núcleo.
 */
async function engineContext($: Engine): Promise<Reading['liveContext']> {
  try {
    const { context } = await $.session.usage()
    if (typeof context?.percent !== 'number' || !(context.window > 0)) return null
    return { used: typeof context.tokens === 'number' ? context.tokens : null, limit: context.window, pct: Math.round(context.percent) }
  } catch {
    return null
  }
}

/**
 * Pede o painel ao núcleo e grava o atom só quando o desenho muda: na hora, se mudam os botões; no
 * máximo a cada MIN_REDRAW_MS, se mudam só números e textos. Cada gravação redesenha o pane, e um redesenho troca os handles dos
 * Buttons ("the host holds only a handle, for the drawing's life"): um clique que chega com o handle
 * do desenho anterior é descartado (`ui_press not handled`). Gravar a cada tick de 5 s, com `readAt`
 * e `generatedAt` sempre novos, fazia o primeiro clique quase sempre cair num desenho já trocado.
 */
async function refresh($: Engine, nextView?: Partial<View>, again = false) {
  const now = await $.clock.now()
  const v = { ...normalizeView(await read($, view)), ...nextView }
  // Whether this call looks the core up itself: then a failure is not a reason to look again.
  const looked = !resolved
  try {
    await resolveCore($)
    const res = await $.http.fetch(`http://${core}${await tickPath($, v)}`)
    const panel = res.ok && res.text ? (JSON.parse(res.text) as Panel) : null
    if (!panel || panel.version !== 1) throw new Error(res.ok ? 'resposta inválida' : `HTTP ${res.status}`)
    const liveContext = await engineContext($)
    // #262: the core answered another scope than the one chosen (a remote no longer in machines.json): the Select follows it.
    const answered = scopeAfterAnswer(v.scope, panel)
    if (answered) {
      v.scope = answered
      nextView = { ...nextView, scope: answered }
    }
    const current = normalizeReading(await read($, reading))
    const fresh: Reading = { panel, readAt: now, offline: false, error: null, nextAt: null, liveContext }
    // Um clique: a tela nova, a leitura e as decisões que a conversa ainda tem vão juntas, uma
    // gravação atrás da outra, e o engine as desenha numa vez só.
    const reachable = nextView && (v.screen === 'decisions' || v.screen === 'decision') ? await reachableOf($, fresh, v) : undefined
    const newView = reachable ? { ...v, reachable } : v
    const seen = await whatIsSeen($, fresh, newView, now)
    const first = current.offline || !current.panel
    const changed = first || seen.buttons !== last.buttons || (seen.screen !== last.screen && (nextView !== undefined || now - last.writtenAt >= MIN_REDRAW_MS))
    last = { ...last, readAt: now }
    if (nextView) await update($, view, (x) => ({ ...normalizeView(x), ...nextView, ...(reachable ? { reachable } : {}) }))
    if (changed) {
      last = { ...last, ...seen, writtenAt: now }
      await update($, reading, () => fresh)
    }
    showStatus($, statusLine(panel, false))
  } catch (err) {
    // The core stopped answering: look it up again in the registry; a different one is tried at once.
    if (!explicitCore) {
      const before = core
      const stale = resolved && !looked
      resolved = false
      if (stale && !again && (await resolveCore($)) !== before) return refresh($, nextView, true)
    }
    if (nextView) await changeView($, nextView)
    // Sem núcleo: guarda a última leitura boa e tenta de novo no próximo tick, sem redesenhar a cada um.
    const current = normalizeReading(await read($, reading))
    if (!current.offline) {
      last.writtenAt = now
      await update($, reading, (v) => ({ ...normalizeReading(v), readAt: last.readAt || null, offline: true, error: String(err), nextAt: null }))
    }
    showStatus($, statusLine(null, true))
  }
}

async function ourPane($: Engine) {
  return (await $.ui.panes()).find((p) => p.id === PANE)
}

// Cada tick confere o painel antes de pedir: fechado ou não desenhado, o polling para;
// aberto atrás de outra aba, o tick passa sem pedir nada.
async function tick($: Engine) {
  try {
    const p = await ourPane($)
    if (!p?.isPlaced) return stopPolling($)
    if (!p.isShown) return
    await refresh($)
  } catch {
    // o próximo tick tenta de novo
  }
}

function startPolling($: Engine) {
  if (timer) return
  timer = $.clock.every(EVERY_MS, () => void tick($))
  void tick($)
}

// As ordens do console (#61): um relógio próprio, de toda sessão com o mod, e não só com o painel aberto.
let ordersTimer: { cancel: () => void } | undefined
let ordersBusy = false
/** Ticks to skip while the core is unreachable: 1, 2, 4… up to 15 (a minute), and 0 again at the first answer. */
let ordersSkip = 0
let ordersBackoff = 0

function startOrders($: Engine) {
  if (ordersTimer) return
  ordersTimer = $.clock.every(ORDERS_EVERY_MS, () => {
    if (ordersBusy) return
    if (ordersSkip > 0) {
      ordersSkip--
      return
    }
    ordersBusy = true
    // With the panel open, its own tick keeps `core` right (one lookup per tick); without it, this one does.
    void (timer ? Promise.resolve(core) : resolveCore($))
      .then((c) => pollOrders($, c))
      .then(() => {
        ordersBackoff = 0
      })
      .catch(() => {
        // Sem núcleo: procura de novo, mas cada vez mais espaçado, para não varrer o registro a cada 4 s em toda sessão.
        resolved = false
        ordersBackoff = Math.min(ordersBackoff * 2 || 1, 15)
        ordersSkip = ordersBackoff
      })
      .finally(() => {
        ordersBusy = false
      })
  })
}

function stopOrders() {
  ordersTimer?.cancel()
  ordersTimer = undefined
  ordersSkip = ordersBackoff = 0
}

function stopPolling($: Engine) {
  if (!timer) return
  timer.cancel()
  timer = undefined
  last.status = null
  $.ui.status(undefined)
}

/** Confirmar ou Descartar uma sugerida: um POST em nome desta sessão, e a leitura de novo. */
type DecisionAction = 'confirm' | 'dismiss' | 'adjust' | 'undo'

/** A ação dita para a pessoa, no aviso de erro. */
const VERB: Record<DecisionAction, string> = { confirm: 'confirmar', dismiss: 'descartar', adjust: 'ajustar', undo: 'desfazer' }

const DONE: Record<DecisionAction, string> = {
  confirm: 'confirmada: passa a valer',
  dismiss: 'descartada: fica só no histórico',
  adjust: 'ajustada: a sua versão passa a valer',
  undo: 'voltou ao que era',
}

/**
 * Confirmar, Descartar, Ajustar (com o texto da pessoa) ou Desfazer, pela API do núcleo. Depois de
 * uma ação, o "Desfazer" fica à vista por alguns segundos; no detalhe, a decisão aberta é a que voltou.
 */
async function decide($: Engine, id: string, label: string, action: DecisionAction, text: string | null = null) {
  try {
    const base = await panelPath($)
    const query = base.includes('?') ? base.slice(base.indexOf('?')) : ''
    await resolveCore($)
    const res = await $.http.fetch(`http://${core}/api/decisions/${encodeURIComponent(id)}/${action}${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: await $.session.id(), ...(text === null ? {} : { text }) }),
    })
    const body = (() => {
      try {
        return JSON.parse(res.text ?? '') as { error?: string; decision?: PanelDecision }
      } catch {
        return {}
      }
    })()
    if (!res.ok) {
      $.ui.toast(`Não deu para ${VERB[action]} ${label}: ${body.error ?? `HTTP ${res.status}`}.`)
    } else {
      const now = await $.clock.now()
      $.ui.toast(`${label} ${DONE[action]}.`)
      // O "Desfazer" some sozinho: um redesenho só, quando o tempo dele acaba.
      if (action !== 'undo') {
        $.clock.after(UNDO_MS + 100, () => {
          void update($, view, (v) => {
            const current = normalizeView(v)
            return current.lastAction?.at === now ? { ...current, lastAction: null } : current
          })
        })
      }
      await update($, view, (v) => {
        const current = normalizeView(v)
        return {
          ...current,
          adjusting: false,
          lastAction: action === 'undo' ? null : { id, label, action, at: now },
          decision: current.decision?.id === id && body.decision ? body.decision : current.decision,
        }
      })
    }
  } catch {
    $.ui.toast(`Sem conexão com o núcleo em ${core}; ${label} ficou como estava.`)
  }
  await refresh($)
}

/**
 * Quais decisões abertas ainda têm a mensagem na conversa: a compactação tira as antigas, e o
 * engine só rola até o que está nela. Só elas ganham "ver na conversa".
 */
async function reachableOf($: Engine, l: Reading, v: View): Promise<string[] | undefined> {
  try {
    const ids = new Set<string>()
    for (const d of [...(l.panel?.decisions?.list?.items ?? []), ...(v.decision ? [v.decision] : [])]) if (d.toolUseId) ids.add(d.toolUseId)
    if (!ids.size) return undefined
    const inConversation = new Set<string>()
    for (const m of await $.session.messages()) for (const t of m.toolUses ?? []) if (ids.has(t.tool_use_id)) inConversation.add(t.tool_use_id)
    const reachable = [...inConversation].sort()
    return JSON.stringify(reachable) === JSON.stringify(v.reachable ?? []) ? undefined : reachable
  } catch {
    // sem a leitura da conversa, nenhuma decisão ganha "ver na conversa": o detalhe traz o trecho
    return undefined
  }
}

/**
 * "ver na conversa": rola a conversa até a chamada que originou a decisão (o `tool_use_id`),
 * quando ela é desta sessão; o engine só rola a conversa em resposta a um clique da pessoa.
 * Quando não dá (de outra sessão, ou a linha não está mais na conversa), diz onde ela está.
 */
async function showInConversation($: Engine, d: PanelDecision) {
  const far =
    d.session === 'parent' ? 'na sessão mãe' : d.session === 'family' ? 'em outra sessão da família' : d.session === 'branch' ? 'em outra sessão do branch' : null
  if (far || !d.toolUseId) {
    $.ui.toast(`${d.label} foi decidida ${far ?? 'numa mensagem que esta conversa não mostra'}.`)
    return
  }
  const r = await $.ui.scroll({ to: { requestId: d.toolUseId }, block: 'center' }).catch((err: unknown) => ({ deny: String(err) }))
  if ('deny' in r && r.deny) $.ui.toast(`A mensagem de ${d.label} não está à vista nesta conversa.`)
}

/**
 * Compacta a conversa desta sessão, a mesma chamada do `/compact` (`$.session.compact()`). Só
 * entre turnos: no meio de um, o engine recusa, e o painel diz o motivo.
 */
async function compact($: Engine) {
  if (compacting) return
  compacting = true
  await changeView($, { compact: 'compacting' })
  try {
    const r = await $.session.compact()
    if (r && 'skip' in r && r.skip) $.ui.toast(`A conversa não foi compactada: ${r.skip}.`)
    else {
      const before = r && 'tokensBefore' in r ? r.tokensBefore : undefined
      const after = r && 'tokensAfter' in r ? r.tokensAfter : undefined
      $.ui.toast(before && after ? `Conversa compactada: de ${tokens(before)} para ${tokens(after)} tokens.` : 'Conversa compactada.')
    }
  } catch (err) {
    $.ui.toast(`Não deu para compactar agora: ${(err as Error)?.message ?? String(err)}`)
  } finally {
    compacting = false
    await changeView($, { compact: null })
    await refresh($)
  }
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** A caixa de próximo passo do Desktop (`wrap_up`): só quando ela pergunta algo (`ask`). */
export function questionFromWrapUp(e: Json, at: number): SessionQuestion | null {
  const ask = text(e.ask)
  if (!ask) return null
  const actions = (Array.isArray(e.actions) ? e.actions : [])
    .map(obj)
    .filter((a): a is Json => !!a)
    .map((a) => {
      const fromApp = text(a.action) !== null
      const label = text(a.label) ?? text(a.action) ?? '?'
      // Uma resposta manda a mensagem (ou o rótulo, quando a mensagem é ele mesmo); uma ação do app não manda texto.
      return { label, message: fromApp ? null : (text(a.message) ?? label), fromApp }
    })
  return { type: 'wrap-up', text: ask, actions, at }
}

/** O AskUserQuestion: as perguntas, com o cabeçalho e as opções inteiras. */
export function questionFromAskUserQuestion(e: Json, at: number): SessionQuestion | null {
  const questions = (Array.isArray(e.questions) ? e.questions : [])
    .map(obj)
    .filter((q): q is Json => !!q && text(q.question) !== null)
    .map((q) => ({
      text: text(q.question)!,
      header: text(q.header),
      options: (Array.isArray(q.options) ? q.options : [])
        .map(obj)
        .filter((o): o is Json => !!o && text(o.label) !== null)
        .map((o) => ({ label: text(o.label)!, description: text(o.description) })),
      multiple: q.multiSelect === true,
    }))
  return questions.length ? { type: 'question', questions, at } : null
}

/** O botão de uma resposta da caixa de próximo passo: manda a mensagem ao chat, como a pessoa. */
async function reply($: Engine, message: string) {
  try {
    await update($, question, () => null)
    await $.prompt.submit({ text: message, asUser: true })
  } catch (err) {
    $.ui.toast(`Não deu para mandar a resposta: ${(err as Error)?.message ?? String(err)}. Responda no chat.`)
  }
}

/**
 * #145: pede à sessão do painel para desarquivar uma filha. O plugin não tem como desarquivar (o
 * app só expõe `unarchive_session` às sessões de Claude); a sessão chama a ferramenta, e a pessoa
 * aprova. Roda quando a sessão estiver ociosa; o painel só oferece o botão nessa hora.
 */
async function unarchive($: Engine, f: { title: string; local?: string | null }) {
  if (!f.local) return
  try {
    await $.prompt.submit({ text: unarchiveRequest(f), asUser: true })
    $.ui.toast(`Pedi para desarquivar "${f.title}": aprove no chat.`)
  } catch (err) {
    $.ui.toast(`Não deu para pedir o desarquivar: ${(err as Error)?.message ?? String(err)}.`)
  }
}

/** Pede à API local que abra a conversa no Claude Desktop (no macOS, `open claude://…`). */
async function openSession($: Engine, local: string, title: string) {
  try {
    await resolveCore($)
    const res = await $.http.fetch(`http://${core}/open/${encodeURIComponent(local)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (res.ok) $.ui.toast(`Abrindo "${title}" no Claude Desktop…`)
    else {
      const error = (() => {
        try {
          return (JSON.parse(res.text ?? '') as { error?: string }).error
        } catch {
          return undefined
        }
      })()
      $.ui.toast(`Não deu para abrir "${title}": ${error ?? `HTTP ${res.status}`}.`)
    }
  } catch {
    // the next action or tick looks the core up again
    resolved = false
    $.ui.toast(`Sem conexão com o núcleo em ${core}; "${title}" não foi aberta.`)
  }
}

async function goTo($: Engine, i: NeedsYou, surface: Parameters<Engine['ui']['copy']>[0]['surface']) {
  // O mod não troca de sessão no Desktop: copia o nome e diz onde ela está.
  await $.ui.copy({ text: i.title, surface }).catch(() => undefined)
  $.ui.toast(`"${i.title}" está na barra lateral; o nome foi copiado para a busca.`)
}

export const register: Register = (on, options) => {
  // Only `port` > 0 pins the core. The old `porta` (up to 0.0.30) is ignored: settings saved by
  // those versions hold the old default, 4720, not a choice, and it would hide the registry. 0 or unset: the registry.
  const o = options as { port?: unknown } | undefined
  const port = Number(o?.port)
  explicitCore = Number.isInteger(port) && port > 0 && port < 65536 ? `127.0.0.1:${port}` : null
  core = explicitCore ?? LEGACY_CORE
  resolved = false

  // A sessão começa sem consultar nada: só registra o /console. Se o painel já estava aberto
  // (o módulo recarregou com ele à vista), retoma o polling.
  on('session.start', async ($, e, next) => {
    panelQuery = undefined
    await $.command.register({ name: 'console', description: 'Abre o painel do Ahrena Console: esta sessão e quem precisa de você' })
    if ((await ourPane($).catch(() => undefined))?.isPlaced) startPolling($)
    startOrders($)
    return next(e)
  })

  on('command.run', { command: 'console' }, async ($) => {
    const opened = await $.ui.open({ id: PANE, title: 'Ahrena Console', focus: true })
    if (opened.isPlaced) {
      startPolling($)
      return { text: 'Painel do Ahrena Console aberto.' }
    }
    // Aberto, mas sem lugar agora (largura, superfície): o engine desenha quando houver, e o
    // render começa o polling. O motivo vem do engine.
    return { text: `O painel do Ahrena Console fica aberto e aparece quando houver lugar (${opened.reason}).` }
  })

  // Fechou (a pessoa, o plugin ou um unload): o polling para na hora.
  on('ui.close', async ($, e, next) => {
    try {
      if (e.id === PANE) stopPolling($)
    } catch {
      // parar nunca deve impedir o painel de fechar
    }
    return next(e)
  })

  // #140: a pergunta com que o turno termina, direto do engine, sem passar pelo núcleo. Só a do
  // agente principal (`agentId` ausente); a de um subagente não é desta conversa.
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    try {
      if (!(e as { agentId?: string }).agentId) {
        const p = questionFromWrapUp(e as unknown as Json, await $.clock.now())
        await update($, question, () => p)
      }
    } catch {
      // a pergunta no painel nunca impede o fechamento do turno
    }
    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const isMain = !(e as { agentId?: string }).agentId
    try {
      if (isMain) {
        const p = questionFromAskUserQuestion(e as unknown as Json, await $.clock.now())
        await update($, question, () => p)
      }
    } catch {
      // idem
    }
    // A ferramenta só volta quando a pessoa responde no diálogo: aí a pergunta sai do painel.
    const r = await next(e)
    if (isMain) await update($, question, () => null).catch(() => undefined)
    return r
  })

  // A pessoa escreveu no chat: a pergunta do fechamento foi respondida (ou deixada de lado). Uma
  // mensagem que chega sozinha (outra sessão, uma notificação, um plugin) não a tira do painel.
  on('prompt.submit', async ($, e, next) => {
    if (fromThePerson((e as { origin?: PromptOrigin }).origin)) await update($, question, () => null).catch(() => undefined)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopPolling($)
    stopOrders()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Desenhado é aberto: se o polling não começou (reload, ou o painel aberto por outro
    // caminho que não o /console), começa agora; o tick confere se ele está à vista.
    startPolling($)
    const l = await readReading($)
    const now = await $.clock.now()
    if (e.surface !== 'desktop') {
      // Terminal e outras superfícies: o resumo em texto, sem a grade.
      const { Box, Text } = $.ui.resolve(e)
      const s = l.panel?.session
      return (
        <Box flexDirection="column">
          <Text bold color="#f47720">Ahrena Console</Text>
          {l.offline || !l.panel ? (
            <Text>{l.offline ? `Sem conexão com o núcleo em ${core}.` : 'Lendo o núcleo…'}</Text>
          ) : (
            <Box flexDirection="column">
              <Text>
                {s ? `${statusGlyph(s)} ${s.title} · ${model(s.model)} · turno ${s.turn}` : 'Sessão nova'}
              </Text>
              <Text dimColor>{s ? s.activity.text : ''}</Text>
              {l.panel.decisions?.current ? <Text>⊸ {decisionsText(l.panel.decisions.current)}</Text> : null}
              <Text>{l.panel.needYou.total ? `⚠ ${needYouText(l.panel.needYou.total)}` : 'ninguém mais precisa de você'}</Text>
            </Box>
          )}
        </Box>
      )
    }
    const el = $.ui.resolve(e) as unknown as Elements
    const v = normalizeView(await read($, view))
    const q = ((await read($, question)) ?? null) as SessionQuestion | null
    columns = e.props.bodyColumns ?? 38
    bodyRows = (e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows
    return draw({
      el,
      reading: l,
      view: v,
      question: q,
      cols: columns,
      lines: (e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows,
      now,
      core,
      actions: {
        showNeedYou: () => void changeView($, { screen: 'need-you' }),
        close: () => void changeView($, { screen: 'session' }),
        // #262: the list for the new scope comes at once, without waiting for the next tick.
        scope: (value) => void refresh($, { scope: normalizeScope(value) ?? 'all' }),
        retry: () => void refresh($),
        goTo: (i) => void goTo($, i, e.surface),
        openSession: (local, title) => void openSession($, local, title),
        compact: (step) =>
          void (step === 'ask' ? changeView($, { compact: 'confirm' }) : step === 'cancel' ? changeView($, { compact: null }) : compact($)),
        // Abrir as decisões ou trocar o escopo já pede a lista, sem esperar o próximo tick.
        showDecisions: () => void refresh($, { screen: 'decisions' }),
        decisionsScope: (value) =>
          void refresh($, { decisionsScope: DECISION_SCOPES.includes(value as DecisionScope) ? (value as DecisionScope) : null }),
        confirm: (d) => void decide($, d.id, d.label, 'confirm'),
        dismiss: (d) => void decide($, d.id, d.label, 'dismiss'),
        showInConversation: (d) => void showInConversation($, d),
        showPlans: () => void changeView($, { screen: 'plans' }),
        openDecision: (d) => void refresh($, { screen: 'decision', decision: d, adjusting: false }),
        backToDecisions: () => void refresh($, { screen: 'decisions', adjusting: false }),
        undo: (id, label) => void decide($, id, label, 'undo'),
        adjust: (open) => void changeView($, { adjusting: open }),
        sendAdjustment: (d, text) => void (text.trim() ? decide($, d.id, d.label, 'adjust', text) : undefined),
        showSubagents: () => void changeView($, { screen: 'subagents', graph: GRAPH_STATE }),
        graph: (patch) => void update($, view, (v) => { const current = normalizeView(v); return { ...current, graph: { ...current.graph!, ...patch } } }),
        showChildren: () => void changeView($, { screen: 'children' }),
        showPrs: () => void changeView($, { screen: 'prs' }),
        reply: (message) => void reply($, message),
        unarchive: (f) => void unarchive($, f),
      },
    })
  })
}
