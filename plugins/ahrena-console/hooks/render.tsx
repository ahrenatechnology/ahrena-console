// O desenho do painel (wireframes P0 a P13, docs/wireframes): só elementos nativos do mod
// (Box, Text, Button, Link, Select, Svg), sem HTML. Recebe a leitura e devolve a árvore; quem
// pede ao núcleo e guarda o estado é o register.tsx.
//
// Grade (P1, `.pc`): todo card tem CARD_W colunas e CARD_H linhas, fixas e iguais. A largura do
// painel decide quantos cabem por linha (1 no estreito de 38 colunas, 3 no largo de 121). Dentro do
// card, cada linha é uma só, com reticências, como no P1; o inteiro fica no detalhe. Os seis cards
// aparecem sempre; a altura que sobra fica vazia embaixo, e a que falta o corpo do pane rola.
// Cabeçalho, faixa e linhas de baixo ocupam a largura da grade.

import type { RenderElement } from 'claude-code'

import type {
  PanelAccount,
  PanelDecision,
  DecisionScope,
  PanelChild,
  Reading,
  Panel,
  SessionQuestion,
  PanelStep,
  SessionPlan,
  WaitingPr,
  NeedsYou,
  PanelResume,
  PanelSession,
  PanelSubagent,
  PanelWork,
  View,
} from '../types'
import {
  SCOPES,
  DECISION_STATES,
  REASONS,
  ORIGINS,
  STATUS,
  truncate,
  decisionsText,
  since,
  duration,
  ago,
  clockTime,
  model,
  rejectedText,
  UNDO,
  UNDO_MS,
  dateTime,
  plural,
  needYouText,
  when,
  whoDecided,
  accountLabel,
  stripMarkdown,
  statusOf,
  tokens,
  usd,
} from './format'
import { gridHeight, CARD_BORDER, SPACE, CARD_LINES, textLines } from './height'
import { GRAPH_STATE, shortCount, buildGraph, paginate, type GraphState, type GraphLine } from './graph'
import { paleta, status as STATUS_COR } from './brand'
import { charsFor, columns, fit, kids, type Node } from './fit'

export const CARD_W = 34
/** Todo card tem a mesma altura, ~190 px no Desktop (ver CARD_LINES): a borda e as linhas de conteúdo. */
export const CARD_H = CARD_BORDER + CARD_LINES
export const GAP = 2
/** A versão deste plugin; o teste do núcleo confere com o plugin.json. */
export const PLUGIN_VERSION = '0.0.32'
const KPI_W = 15
/** No estreito, quantos cards de decisão cabem antes do rodapé "+N". */
const DECISIONS_WHEN_NARROW = 3
const HOW_TO_START = 'https://github.com/ahrenatechnology/ahrena-console/tree/main/plugins/ahrena-console#subir-o-núcleo'

const ORANGE = paleta.orange['500']
const ROSE = paleta.rose['500']
const YELLOW = paleta.yellow['500']
const GREEN = paleta.green['500']
const RED = paleta.red['500']
const RED_TEXT = STATUS_COR.error.dark.text
const GRAY = paleta.gray['200']
const BORDER = paleta.gray['500']
const KPI_BG = paleta.gray['900']
const CARD_BG = paleta.gray['800']
const BADGE = {
  orange: STATUS_COR.active.dark.badge,
  yellow: STATUS_COR.waiting.dark.badge,
  green: STATUS_COR.completed.dark.badge,
  red: STATUS_COR.error.dark.badge,
  gray: STATUS_COR.abandoned.dark.badge,
}
/** A cor da conta vem em hex do núcleo; qualquer outra coisa vira cinza. */
const accountColor = (c: PanelAccount) => (/^#[0-9a-f]{6}$/i.test(c.color) ? c.color : GRAY)
/** Cor e fundo de cada status (docs/brand/tokens.json, tema escuro). */
const STATUS_COLOR = {
  active: { color: STATUS_COR.active.dark.text, background: BADGE.orange, border: ORANGE },
  waiting: { color: STATUS_COR.waiting.dark.text, background: BADGE.yellow, border: YELLOW },
  completed: { color: STATUS_COR.completed.dark.text, background: BADGE.green, border: GREEN },
  error: { color: RED_TEXT, background: BADGE.red, border: RED },
  abandoned: { color: STATUS_COR.abandoned.dark.text, background: BADGE.gray, border: BORDER },
} as const

/** Os elementos que o desenho usa, da tabela da superfície. */
export type Elements = {
  Box: (p: any) => RenderElement
  Text: (p: any) => RenderElement
  Button: (p: any) => RenderElement
  Link: (p: any) => RenderElement
  Select: (p: any) => RenderElement
  Svg: (p: any) => RenderElement
  Input: (p: any) => RenderElement
}

export type Actions = {
  showNeedYou: () => void
  close: () => void
  scope: (value: string) => void
  retry: () => void
  goTo: (p: NeedsYou) => void
  /** O "Compactar" do card Contexto: abre a confirmação, confirma ou cancela. */
  compact: (step: 'ask' | 'confirm' | 'cancel') => void
  /** Abre a conversa no Claude Desktop pela API local (`open`, no macOS). */
  openSession: (local: string, title: string) => void
  showDecisions: () => void
  decisionsScope: (value: string) => void
  confirm: (d: PanelDecision) => void
  dismiss: (d: PanelDecision) => void
  showInConversation: (d: PanelDecision) => void
  showPlans: () => void
  /** #131: o detalhe da decisão, o Desfazer, o Ajustar e as listas completas. */
  openDecision: (d: PanelDecision) => void
  backToDecisions: () => void
  undo: (id: string, label: string) => void
  adjust: (open: boolean) => void
  sendAdjustment: (d: PanelDecision, text: string) => void
  showSubagents: () => void
  /** #146: mexe no grafo da sessão: a página, as ondas abertas e fechadas, o filtro. */
  graph: (patch: Partial<GraphState>) => void
  showChildren: () => void
  /** #140: a lista dos PRs aguardando a sua aprovação. */
  showPrs: () => void
  /** #140: manda ao chat a resposta de um botão da caixa de próximo passo. */
  reply: (message: string) => void
  /** #145: pede à sessão do painel para desarquivar a filha (`unarchive_session`, a pessoa aprova). */
  unarchive: (f: PanelChild) => void
}

export type DrawContext = {
  el: Elements
  reading: Reading
  view: View
  /** Colunas do corpo do painel. */
  cols: number
  /** Linhas do corpo do painel (`scroll.bodyRows`); sem elas, sem limite de altura. */
  lines?: number
  /** #140: a pergunta com que esta sessão terminou o turno, em destaque no topo. */
  question?: SessionQuestion | null
  now: number
  /** `127.0.0.1:<porta>` do núcleo. */
  core: string
  actions: Actions
}

// --- SVG (barras, rosca, linha do custo, logo, ícone sem conexão) ---

const svg = (w: number, h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`

export function logoSvg() {
  return svg(32, 32, `<rect width="32" height="32" rx="8" fill="${ORANGE}"/><path d="M9 23 L16 8 L23 23" stroke="${paleta.gray['900']}" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 16.5 L19 16.5 L16 21.5 Z" fill="${ROSE}" stroke="${ROSE}" stroke-width="1" stroke-linejoin="round"/>`)
}

function barSvg(pct: number, color: string) {
  const w = Math.round(Math.max(0, Math.min(100, pct)) * 1.6)
  return svg(160, 6, `<rect width="160" height="6" rx="3" fill="${BORDER}"/>${w ? `<rect width="${w}" height="6" rx="3" fill="${color}"/>` : ''}`)
}

function lineSvg(series: number[]) {
  const pts = series.length >= 2 ? series : [0, 0]
  const max = Math.max(...pts) || 1
  const xy = pts.map((v, i) => `${((i / (pts.length - 1)) * 100).toFixed(1)},${(9 - (v / max) * 7).toFixed(1)}`).join(' ')
  return svg(100, 10, `<polyline points="${xy}" fill="none" stroke="${ORANGE}" stroke-width="1.2" stroke-linejoin="round"/>`)
}

/** O anel do plano (P1): o feito em laranja sobre o trilho, e o % no meio. */
function ringSvg(pct: number) {
  const r = 20
  const circumference = 2 * Math.PI * r
  const arc = (Math.max(0, Math.min(100, pct)) / 100) * circumference
  return svg(
    50,
    50,
    `<circle cx="25" cy="25" r="${r}" fill="none" stroke="${BORDER}" stroke-width="6"/>` +
      (arc ? `<circle cx="25" cy="25" r="${r}" fill="none" stroke="${ORANGE}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${arc.toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 25 25)"/>` : '') +
      `<text x="25" y="28.5" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="10" fill="${paleta.gray['100']}">${pct}%</text>`,
  )
}

/** A barra dos Subagentes, em px: a largura útil do card (30 colunas × ~7,9 px) e uma linha fina. */
const BAR_W = 236
const BAR_H = 5

function subagentsSvg(items: PanelSubagent[]) {
  const total = Math.max(1, items.length)
  const parts: [number, string][] = [
    [items.filter((s) => s.status === 'working' || s.status === 'waiting').length, ORANGE],
    [items.filter((s) => s.status === 'completed').length, GREEN],
    [items.filter((s) => s.status === 'error').length, RED],
  ]
  let x = 0
  const rects = parts
    .filter(([n]) => n > 0)
    .map(([n, color]) => {
      const w = (n / total) * 200
      const r = `<rect x="${x.toFixed(1)}" width="${w.toFixed(1)}" height="5" fill="${color}"/>`
      x += w
      return r
    })
    .join('')
  // Esticada sem manter a proporção, no tamanho que o Svg dá (BAR_W × BAR_H).
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 5" preserveAspectRatio="none"><clipPath id="b"><rect width="200" height="5" rx="2.5"/></clipPath><g clip-path="url(#b)"><rect width="200" height="5" fill="${BORDER}"/>${rects}</g></svg>`
}

function offlineSvg() {
  return svg(
    24,
    24,
    `<g fill="none" stroke="${RED_TEXT}" stroke-width="1.8" stroke-linecap="round"><path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5 12a10.5 10.5 0 0 1 14 0"/><path d="M8.5 15.5a5.5 5.5 0 0 1 7 0"/><path d="M3 3l18 18"/></g><circle cx="12" cy="19.5" r="1.3" fill="${RED_TEXT}"/>`,
  )
}

// --- Peças ---

/** Pílula: o glifo e o rótulo na cor, sobre o fundo do status. */
function pill(c: DrawContext, key: string, text: string, color: string, background: string, bold = false) {
  const { Text } = c.el
  return (
    <Text key={key} mono size="caption" weight={bold ? 'bold' : 'medium'} color={color} backgroundColor={background}>
      {` ${text} `}
    </Text>
  )
}

function statusPill(c: DrawContext, key: string, state: PanelSession['state'] | PanelChild['state']) {
  const st = statusOf(state)
  const color = STATUS_COLOR[st]
  return pill(c, key, `● ${STATUS[st].label}`, color.color, color.background)
}

function reasonPill(c: DrawContext, key: string, reason: NonNullable<PanelSession['reason']>) {
  const m = REASONS[reason]
  return pill(c, key, `${m.glyph} ${m.label}`, YELLOW, BADGE.yellow, m.urgent)
}

/**
 * Cabeçalho de card (`.pc .t` do P1): ícone e título em versalete à esquerda; à direita um valor
 * pequeno, em cor neutra e sem caixa alta (`.pc .t .r`). Não é clicável: no Desktop, todo Button é
 * o botão nativo, no tamanho do corpo, e quebraria o cabeçalho.
 */
function header(c: DrawContext, icon: string, title: string, right: string, options: { color?: string } = {}) {
  const { Box, Text } = c.el
  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
      {/* O título nunca corta: quem cede é o valor da direita. */}
      <Box flexShrink={0}>
        <Text mono size="caption" weight="semibold" dimColor>
          {icon} {title}
        </Text>
      </Box>
      <Text mono size="caption" tabular color={options.color} dimColor={!options.color} wrap="truncate-end">
        {right}
      </Text>
    </Box>
  )
}

/**
 * O respiro de todo card, num lugar só: dos lados, uma coluna (o que já estava bom); embaixo, dois
 * espaços (~20 px no Desktop), para o pé nunca encostar na borda de baixo. Em cima, o respiro que o
 * Desktop já dá ao Box com borda.
 */
export const CARD_BREATHING = { paddingX: 1, paddingBottom: 2 } as const

/**
 * Todo card do P1: a mesma largura, a mesma altura fixa, a mesma borda, o mesmo raio e o mesmo
 * respiro. Com `footer`, um espaçador empurra o pé para o fundo do card, logo acima do respiro de baixo,
 * na mesma altura em todos os cards.
 */
function cardBox(c: DrawContext, key: string, content: (RenderElement | false | null)[], border: string = BORDER, background: string = CARD_BG, footer: RenderElement | null = null) {
  const { Box } = c.el
  return (
    <Box key={key} flexDirection="column" width={CARD_W} height={CARD_H} flexShrink={0} overflow="hidden" borderStyle="round" borderColor={border} backgroundColor={background} {...CARD_BREATHING} gap="xs">
      {content.filter(Boolean)}
      {footer ? <Box key="footer-space" flexGrow={1} /> : null}
      {footer}
    </Box>
  )
}

/**
 * O pé do card: uma linha só, ancorada no fundo (ver `cardBox`), à esquerda (os "ver mais": "93
 * planos anteriores ›") ou à direita (o "Compactar agora" do Contexto).
 */
function cardFooter(c: DrawContext, inner: RenderElement, align: 'left' | 'right' = 'left') {
  const { Box } = c.el
  return (
    <Box key="foot-of-card" flexDirection="row" flexShrink={0} justifyContent={align === 'right' ? 'flex-end' : 'flex-start'}>
      {inner}
    </Box>
  )
}

/** "1 plano anterior", "93 planos anteriores": o número primeiro, por extenso, com a concordância. */
const countOf = (n: number, singular: string, many: string) => `${n} ${n === 1 ? singular : many}`

/** O link do P1 (`pn-link`): laranja e sublinhado. */
function link(c: DrawContext, key: string, href: string, text: string) {
  const { Link, Text } = c.el
  return (
    <Link key={key} href={href}>
      <Text mono size="footnote" color={ORANGE} underline>
        {text}
      </Text>
    </Link>
  )
}

/** Uma referência a PR no texto: "#139" ou "PR #139". */
const PR_REF = /#(\d+)\b/g

/**
 * O texto com cada "#N" como link laranja para o PR no GitHub, no repositório da sessão (o do card
 * Trabalho). Sem "#N", o texto puro, que a linha corta. Com `max`, o texto cabe em `max` colunas
 * cortando o que vem antes do número, nunca o "#N" ("Revisar… #139"), com ou sem repositório.
 */
export function textWithPrs(c: DrawContext, text: string, max?: number): (string | RenderElement)[] {
  const repo = c.reading.panel?.work?.repo ?? null
  const refs = [...text.matchAll(PR_REF)]
  // Sem "#N" a proteger, o texto inteiro: a linha corta com reticências, no Desktop.
  if (refs.length === 0) return [text]
  let t = text
  if (max !== undefined && [...t].length > max) {
    // Corta o que vem antes da primeira referência; o número e o que vem depois ficam.
    const first = refs[0]!
    const after = t.slice(first.index!)
    const rest = max - [...after].length - 2
    t = rest >= 1 ? `${truncate(t.slice(0, first.index!).trimEnd(), rest + 1)} ${after}` : after
  }
  // Sem repositório conhecido, texto puro (com o número inteiro).
  if (!repo) return [t]
  const { Link, Text } = c.el
  const parts: (string | RenderElement)[] = []
  let last = 0
  for (const m of t.matchAll(PR_REF)) {
    if (m.index! > last) parts.push(t.slice(last, m.index!))
    parts.push(
      <Link key={`pr-${m[1]}-${m.index}`} href={`https://github.com/${repo}/pull/${m[1]}`}>
        <Text color={ORANGE} underline>
          {m[0]}
        </Text>
      </Link>,
    )
    last = m.index! + m[0].length
  }
  if (last < t.length) parts.push(t.slice(last))
  return parts
}

/**
 * Um texto que abre algo, numa linha própria do card. No Desktop todo Button é nativo e ignora o
 * estilo do Text de dentro: o rótulo vai em `label`, sem moldura (`plain`), e neutro com `dimColor`.
 */
function opener(c: DrawContext, key: string, text: string, action: () => void, neutral = false) {
  const { Button } = c.el
  return <Button key={key} plain dimColor={neutral} label={text} onPress={action} />
}

/** Colunas de texto dentro de um card: a largura menos a borda e o respiro. */
const USABLE = CARD_W - 4

/**
 * O link que abre a conversa da sessão no Claude Desktop. O Desktop abre `claude://claude.ai/
 * epitaxy/<local_…>`, mas o `Link` do mod só leva `https:` ou `http://localhost`: o link vai ao
 * núcleo local (`/open/<local_…>`), que redireciona para o endereço do Desktop.
 */
/** O id `local_<uuid>` do índice do Claude Desktop, o mesmo padrão que a API exige. */
const DESKTOP_LOCAL = /^local_[0-9a-f-]{36}$/

/** A API abre a sessão direto no Claude Desktop, sem passar pelo navegador? */
const opensDirectly = (c: DrawContext, local: string | null | undefined) => !!local && DESKTOP_LOCAL.test(local) && c.reading.panel?.api?.opensSession === true

export function sessionUrl(c: Pick<DrawContext, 'core'>, local: string | null | undefined): string | null {
  if (!local || !DESKTOP_LOCAL.test(local)) return null
  const port = c.core.split(':')[1] ?? '4720'
  return `http://localhost:${port}/open/${local}`
}

/** Quantos cards cabem por linha e a largura da grade, em colunas. */
export function grid(cols: number) {
  const perRow = Math.max(1, Math.min(3, Math.floor((cols - 2 + GAP) / (CARD_W + GAP))))
  return { perRow, width: perRow * CARD_W + (perRow - 1) * GAP }
}

// --- Cabeçalho do painel e rótulo da seção ---

function top(c: DrawContext, width: number) {
  const { Box, Text, Svg } = c.el
  const off = c.reading.offline
  return (
    <Box key="top" flexDirection="row" alignItems="center" gap={1} width={width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1}>
      <Svg source={logoSvg()} alt="Ahrena Console" width={28} height={28} />
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text mono weight="semibold">Ahrena Console</Text>
        <Text mono size="caption" dimColor wrap="truncate-end">
          {off ? `${c.core} · sem resposta` : c.core}
        </Text>
      </Box>
      {pill(c, 'connection', off ? '● Offline' : '● Online', off ? RED_TEXT : GREEN, off ? BADGE.red : BADGE.green)}
    </Box>
  )
}

function sectionLabel(c: DrawContext, width: number, title: string, right: RenderElement | null, account?: PanelAccount | null) {
  const { Box, Text } = c.el
  return (
    <Box key={`section-${title}`} flexDirection="row" justifyContent="space-between" alignItems="center" width={width}>
      <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0}>
        <Box flexShrink={0}>
          <Text mono size="caption" weight="semibold" dimColor>
            {title}
          </Text>
        </Box>
        {account && (
          <Text mono size="caption" color={accountColor(account)} wrap="truncate-end">
            ◆ {accountLabel(account.label)}
          </Text>
        )}
      </Box>
      {right}
    </Box>
  )
}

/**
 * O "auto · 5 s" ao lado de "ESTA SESSÃO" e da conta. O nome da conta nunca corta: no estreito, o
 * chip encurta para "5 s" e, se ainda não couber, sai.
 */
function sectionChip(c: DrawContext, width: number, narrow: boolean, account: PanelAccount | null | undefined): RenderElement | null {
  if (!narrow) return chip(c, 'chip', 'auto · 5 s')
  // O título, o espaço e "◆ rótulo"; antes do chip, um espaço.
  const ofAccount = account ? 1 + 2 + [...accountLabel(account.label)].length : 0
  const used = [...'ESTA SESSÃO'].length + ofAccount
  return used + 1 + [...'5 s'].length <= width ? chip(c, 'chip', '5 s') : null
}

/**
 * O chip do P1 (`.pn-sec .r`): no Desktop, um Box com borda ganha respiro vertical e o chip ficava
 * com duas linhas de altura. Sem borda: só o texto pequeno e neutro, numa linha.
 */
function chip(c: DrawContext, key: string, text: string) {
  const { Text } = c.el
  return (
    <Text key={key} mono size="caption" dimColor>
      {text}
    </Text>
  )
}

// --- Faixa (pergunta, permissão, erro) ---

/** O tipo da faixa como a tela sempre o mostrou ("pergunta · há 4 min"). */
const BANNER_WORD: Record<NonNullable<PanelSession['banner']>['type'], string> = { question: 'pergunta', permission: 'permissao', error: 'erro' }

function banner(c: DrawContext, s: PanelSession, width: number, narrow: boolean) {
  const f = s.banner
  if (!f) return null
  const { Box, Text } = c.el
  const error = f.type === 'error'
  const color = error ? STATUS_COLOR.error : STATUS_COLOR.waiting
  return (
    <Box key="banner" flexDirection="column" width={width} borderStyle="round" borderColor={color.border} backgroundColor={color.background} paddingX={1} gap="xs">
      <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
        {error ? statusPill(c, 'banner-status', 'error') : statusPill(c, 'banner-status', 'waiting')}
        {!error && s.reason && reasonPill(c, 'banner-reason', s.reason)}
        {(!narrow || error) && (
          <Text mono size="caption">
            {error ? `${ago(f.since, c.now)} · turno ${s.turn}` : `${BANNER_WORD[f.type]} · ${ago(f.since, c.now)}`}
          </Text>
        )}
      </Box>
      <Text mono weight="semibold" wrap={narrow ? 'wrap' : 'truncate-end'}>
        {narrow ? truncate(stripMarkdown(f.text), 64) : stripMarkdown(f.text)}
      </Text>
      <Text mono size="caption" wrap="truncate-end">
        {f.footer}
      </Text>
    </Box>
  )
}

// --- Os seis cards ---

const ACTIVITY_GLYPH: Record<string, string> = {
  tool: '↻', delegating: '⋔', question: '?', permission: '⛉', error: '⊗', prompt: '›_', 'your-turn': '↵', interrupted: '⏸', completed: '', abandoned: '', idle: '',
}
/** A atividade da sessão como texto: a do erro, a primeira frase; a última mensagem, sem o markdown cru. */
const activityText = (s: PanelSession) => stripMarkdown(s.activity.type === 'error' ? s.activity.text.split('.')[0]! : s.activity.text)
/**
 * Colunas que uma linha de texto do card ocupa sem cortar no Desktop. A conta nominal é USABLE (30), mas
 * o Desktop acrescenta respiro ao Box com borda: "Opus 5.5 · 12 min · turno 18" (28) cabe, e a linha
 * de uma sessão de dias com o modelo 1M ("Opus 5.5 1M · 2 d · turno 262", 29) saiu cortada.
 */
export const UNCUT_COLUMNS = USABLE - 2

/** O título do card Esta sessão nunca é cortado: quebra em até 2 linhas (0.0.32, regra do Fernando). */
export const TITLE_LINES = 2

/**
 * O título do card Esta sessão: inteiro em até TITLE_LINES linhas do card; se não couber,
 * encurtado por palavra, sem reticências e nunca no meio de uma palavra.
 */
export function sessionTitle(title: string): { text: string; lines: number } {
  const words = title.split(/\s+/).filter(Boolean)
  for (let n = words.length; n > 0; n--) {
    const text = n === words.length ? words.join(' ') : words.slice(0, n).join(' ').replace(/\s*[·:,;–—-]$/, '')
    const lines = textLines(text, charsFor(USABLE, 'body'))
    if (lines <= TITLE_LINES) return { text, lines }
  }
  return { text: words[0] ?? '', lines: TITLE_LINES }
}

/** A última mensagem no card Esta sessão: uma linha só, encurtada no fim pelo próprio mod. */
export function sessionMessage(glyph: string, text: string, max = charsFor(USABLE, 'footnote')): string {
  const room = max - (glyph ? columns(glyph) + 1 : 0)
  return columns(text) > room ? `${[...text].slice(0, Math.max(1, room - 1)).join('').trimEnd()}…` : text
}

/**
 * A linha do modelo no card Esta sessão, que nunca corta com reticências: inteira se couber; senão o
 * modelo sem a versão ("Opus 5.5" → "Opus"); depois o turno curto ("turno 262" → "t262"). Se nem
 * assim couber, a linha quebra (o desenho usa `wrap`).
 */
export function modelLine(s: Pick<PanelSession, 'model' | 'startedAt' | 'turn'>, now: number, max = UNCUT_COLUMNS): string {
  const name = model(s.model)
  const short = name.replace(/^(Opus|Sonnet|Haiku|Fable) \d+(?:\.\d+)?/, '$1')
  const time = since(s.startedAt, now)
  const options = [`${name} · ${time} · turno ${s.turn}`, `${short} · ${time} · turno ${s.turn}`, `${short} · ${time} · t${s.turn}`]
  return options.find((x) => [...x].length <= max) ?? options.at(-1)!
}
/**
 * O card "Esta sessão" (pnEstado do P1): a duração à direita do cabeçalho, as pills, o título, o
 * modelo e o que ela faz agora, cada um numa linha. No card de altura fixa, o título e a atividade
 * cortam com reticências, como no P1; inteiros, ficam na conversa.
 */
function sessionCard(c: DrawContext, s: PanelSession) {
  const { Box, Text } = c.el
  const st = statusOf(s.state)
  const color = STATUS_COLOR[st]
  const tinted = st === 'waiting' || st === 'error'
  const a = s.activity
  const activityColor =
    a.type === 'error' ? RED_TEXT : a.type === 'tool' || a.type === 'delegating' ? ORANGE : a.type === 'completed' || a.type === 'abandoned' ? undefined : YELLOW
  const glyph = ACTIVITY_GLYPH[a.type] ?? ''
  const title = sessionTitle(s.title)
  return cardBox(
    c,
    'card-session',
    [
      header(c, '∿', 'ESTA SESSÃO', since(s.startedAt, c.now)),
      // Uma linha só, em qualquer estado (ver pilulasDaSessao): duas pills largas quebravam a linha, e
      // o card de altura fixa esmagava a linha do modelo.
      <Box flexDirection="row" gap={1} flexWrap="nowrap">
        {sessionPills(st === 'waiting' ? s.reason : null, statusOf(s.state)).map((x, i) =>
          i === 0 ? pill(c, 'status', x.text, color.color, color.background) : pill(c, 'reason', x.text, YELLOW, BADGE.yellow, REASONS[s.reason!].urgent),
        )}
      </Box>,
      // O título nunca corta: até 2 linhas; com 2, a última mensagem sai para o card não crescer.
      <Text mono weight="bold" wrap="wrap">
        {title.text}
      </Text>,
      // Nunca com reticências: encurta e, em último caso, quebra (ver linhaDoModelo).
      <Text mono size="footnote" dimColor wrap="wrap">
        {modelLine(s, c.now)}
      </Text>,
      title.lines < TITLE_LINES ? (
        <Text mono size="footnote" wrap="truncate-end">
          {glyph ? <Text color={activityColor ?? GRAY}>{glyph} </Text> : null}
          <Text color={a.type === 'error' ? RED_TEXT : undefined} dimColor={!activityColor && a.type !== 'error'}>
            {sessionMessage(glyph, activityText(s))}
          </Text>
        </Text>
      ) : null,
    ],
    color.border,
    tinted ? color.background : CARD_BG,
  )
}

/**
 * As pills do card Esta sessão, numa linha que cabe em UNCUT_COLUMNS. Cada pill ocupa o texto e
 * um espaço de cada lado; entre elas, uma coluna. Sem caber, "Esperando você" vira "Esperando" e,
 * por último, o status fica só com o glifo: o motivo, que diz por que a sessão espera, fica inteiro.
 */
export function sessionPills(reason: PanelSession['reason'] | null, st: ReturnType<typeof statusOf>): { text: string }[] {
  const status = `● ${STATUS[st].label}`
  if (!reason) return [{ text: status }]
  const m = REASONS[reason]
  const fullReason = `${m.glyph} ${m.label}`
  const options: [string, string][] = [[status, fullReason], ['● Esperando', fullReason], ['●', fullReason]]
  const width = ([a, b]: [string, string]) => [...a].length + 2 + 1 + [...b].length + 2
  const [a, b] = options.find((o) => width(o) <= UNCUT_COLUMNS) ?? options.at(-1)!
  return [{ text: a }, { text: b }]
}

/**
 * Um tile do P1 (`.tile`), com borda: o rótulo pequeno, o valor e, embaixo, a barra ou a linha. O
 * card tem a altura que as duas fileiras pedem no Desktop (ver CARD_LINES).
 */
function kpi(c: DrawContext, key: string, label: string, value: RenderElement | string, footer?: RenderElement | null, valueColor?: string) {
  const { Box, Text } = c.el
  return (
    <Box key={key} flexDirection="column" width={KPI_W} flexShrink={0} overflow="hidden" borderStyle="round" borderColor={BORDER} backgroundColor={KPI_BG} paddingX={1}>
      <Text mono size="caption" weight="semibold" dimColor>
        {label}
      </Text>
      <Text mono size="footnote" weight="bold" color={valueColor} wrap="truncate-end">
        {value}
      </Text>
      {footer}
    </Box>
  )
}

/** A partir daqui, o "Compactar agora" aparece no pé do card Contexto. */
export const HIGH_CONTEXT = 80

/** O contexto desta sessão: o do engine (acompanha a compactação na hora) ou, sem ele, o do núcleo. */
const sessionContext = (c: Pick<DrawContext, 'reading'>, p: Panel | null) => c.reading?.liveContext ?? p?.context ?? null

/**
 * O "Compactar agora" do pé do card Contexto (a partir de 80%): a mesma linha de pé dos outros
 * cards, à direita, sem moldura. O botão primário nativo do Desktop (~28 px, branco) não cabia
 * acima do respiro e destoava dos outros pés. Enquanto o engine compacta, "compactando…".
 */
function compactButton(c: DrawContext) {
  const { Text } = c.el
  return c.view.compact === 'compacting' ? (
    <Text key="compacting" mono size="footnote" color={YELLOW}>
      compactando…
    </Text>
  ) : (
    opener(c, 'compact', 'Compactar agora ›', () => c.actions.compact('ask'))
  )
}

/**
 * O card Contexto e custo (pnMetricas do P1): "estimativa" à direita do cabeçalho e os quatro
 * tiles em 2×2. Até 79%, como no P1, sem Compactar; a partir de 80%, o "Compactar agora" no pé do
 * card, à direita: o card se basta sozinho.
 */
function contextCard(c: DrawContext, p: Panel | null) {
  const { Box, Svg } = c.el
  const ctx = sessionContext(c, p)
  const pct = ctx?.pct ?? 0
  const high = pct >= HIGH_CONTEXT
  const ctxColor = high ? RED : ORANGE
  const error = p?.session?.status === 'error'
  const bg = p?.background ?? { total: 0, first: null }
  const tk = p?.tokens
  return cardBox(c, 'card-context', [
    header(c, '◠', 'CONTEXTO E CUSTO', 'estimativa'),
    <Box flexDirection="row" gap={1} flexShrink={0}>
      {kpi(c, 'kpi-context', 'CONTEXTO', `${pct}%`, <Svg source={barSvg(pct, ctxColor)} alt={`contexto em ${pct}%`} width={96} height={5} />, high ? RED_TEXT : undefined)}
      {kpi(c, 'kpi-cost', 'CUSTO', usd(p?.cost?.usd ?? 0), <Svg source={lineSvg(p?.cost?.series ?? [])} alt="custo acumulado da sessão" width={96} height={10} />)}
    </Box>,
    <Box flexDirection="row" gap={1} flexShrink={0}>
      {kpi(c, 'kpi-tokens', 'TOKENS', tk ? `↑${tokens(tk.input)} ↓${tokens(tk.output)}` : '—')}
      {kpi(c, 'kpi-background', 'BACKGROUND', bg.total ? `${bg.total} · ${bg.first ?? ''}` : '0 · nenhum', null, bg.total && error ? RED_TEXT : undefined)}
    </Box>,
  ], BORDER, CARD_BG, high ? cardFooter(c, compactButton(c), 'right') : null)
}

/**
 * #140 (6 e 7): a pergunta com que a sessão terminou o turno, no topo, inteira e em destaque. Na
 * caixa de próximo passo, cada resposta com mensagem é um botão que a manda ao chat; as ações do app
 * (commit, criar PR) e o AskUserQuestion se respondem no chat.
 */
function questionBanner(c: DrawContext, width: number) {
  const q = c.question
  if (!q) return null
  const { Box, Button, Text } = c.el
  const inChat = (
    <Text key="reply-in-chat" mono size="footnote" color={YELLOW}>
      responder no chat ↓
    </Text>
  )
  if (q.type === 'wrap-up') {
    const answers = q.actions.filter((a) => a.message !== null)
    const fromApp = q.actions.filter((a) => a.fromApp)
    return (
      <Box key="question" flexDirection="column" width={width} borderStyle="round" borderColor={YELLOW} backgroundColor={BADGE.yellow} paddingX={1} gap="xs">
        <Text mono size="caption" weight="semibold" color={YELLOW}>
          ? ESTA SESSÃO PERGUNTA
        </Text>
        <Text mono weight="bold" wrap="wrap">
          {stripMarkdown(q.text)}
        </Text>
        <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
          {answers.map((a, i) => (
            <Button key={`reply-${i}`} label={a.label} variant={i === 0 ? 'primary' : 'secondary'} onPress={() => c.actions.reply(a.message!)} />
          ))}
          {fromApp.length ? (
            <Text mono size="footnote" dimColor wrap="wrap">
              {fromApp.map((a) => a.label).join(' · ')}: no chat ↓
            </Text>
          ) : null}
          {answers.length === 0 && !fromApp.length ? inChat : null}
        </Box>
      </Box>
    )
  }
  return (
    <Box key="question" flexDirection="column" width={width} borderStyle="round" borderColor={YELLOW} backgroundColor={BADGE.yellow} paddingX={1} gap="xs">
      <Text mono size="caption" weight="semibold" color={YELLOW}>
        ? ESTA SESSÃO PERGUNTA
      </Text>
      {q.questions.map((p, i) => (
        <Box key={`question-${i}`} flexDirection="column">
          <Text mono weight="bold" wrap="wrap">
            {p.header ? <Text color={YELLOW}>{p.header} · </Text> : null}
            {p.text}
          </Text>
          {p.options.map((o, j) => (
            <Text key={`option-${i}-${j}`} mono size="footnote" wrap="wrap">
              <Text color={YELLOW}>{p.multiple ? '☐' : '○'} </Text>
              <Text weight="semibold">{o.label}</Text>
              {o.description ? <Text dimColor> · {o.description}</Text> : null}
            </Text>
          ))}
        </Box>
      ))}
      {inChat}
    </Box>
  )
}

/** Linhas da faixa da pergunta (com o espaço antes dela): a borda, o rótulo, os textos e as ações. */
function questionLines(c: Pick<DrawContext, 'question'>, width: number): number {
  const q = c.question
  if (!q) return 0
  const usable = width - 4
  if (q.type === 'wrap-up') {
    const actions = q.actions.map((a) => a.label).join('    ')
    return 1 + 2 + 1 + textLines(q.text, usable) + Math.max(1, textLines(actions, usable) * 2)
  }
  let n = 1 + 2 + 1 + 1
  for (const p of q.questions) {
    n += textLines(`${p.header ?? ''} · ${p.text}`, usable)
    for (const o of p.options) n += textLines(`○ ${o.label}${o.description ? ` · ${o.description}` : ''}`, usable)
  }
  return n
}

/** A confirmação do "Compactar", no topo: age só nesta sessão. */
function compactBanner(c: DrawContext, width: number) {
  if (c.view.compact !== 'confirm') return null
  const { Box, Button, Text } = c.el
  return (
    <Box key="confirm-compact" flexDirection="column" width={width} borderStyle="round" borderColor={YELLOW} backgroundColor={BADGE.yellow} paddingX={1} gap="xs">
      <Text mono weight="semibold" wrap="truncate-end">
        Compactar a conversa desta sessão?
      </Text>
      <Box flexDirection="row" gap={1}>
        <Button key="compact-yes" label="Compactar" variant="primary" onPress={() => c.actions.compact('confirm')} />
        <Button key="compact-no" label="Cancelar" variant="secondary" onPress={() => c.actions.compact('cancel')} />
      </Box>
    </Box>
  )
}

/**
 * O card Trabalho (pnTrabalho do P1): com issue, "#N título", as sub-issues com a barra, o PR com o
 * estado e "abrir", e as pills de CI e review. Sem issue, o branch numa linha com reticências (como
 * no P1: o nome inteiro fica no GitHub) e "ligar uma issue".
 */
/** O estado do PR como a tela sempre o mostrou ("PR #12 · aberto"). */
const PR_STATE_WORD: Record<NonNullable<PanelWork['pr']>['state'], string> = { draft: 'rascunho', open: 'aberto', merged: 'mergeado', closed: 'fechado' }

function workCard(c: DrawContext, t: PanelWork | null) {
  const { Box, Text, Svg } = c.el
  const body: (RenderElement | false | null)[] = [header(c, '⎇', 'TRABALHO', 'pelo branch')]
  if (!t) {
    body.push(
      <Text mono size="footnote" dimColor>
        lendo o branch desta sessão…
      </Text>,
    )
    return cardBox(c, 'card-work', body)
  }
  if (!t.issue) {
    body.push(
      <Text mono size="footnote" dimColor wrap="truncate-end">
        ⎇ {t.branch}
      </Text>,
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {t.error ? `GitHub: ${t.error}` : 'sem issue ligada a este branch'}
      </Text>,
      t.repo ? link(c, 'link-issue', `https://github.com/${t.repo}/issues`, 'ligar uma issue') : null,
    )
    return cardBox(c, 'card-work', body)
  }
  const i = t.issue
  const sub = i.subIssues
  body.push(
    <Text mono size="footnote" weight="semibold" wrap="truncate-end">
      <Text color={ORANGE}>#{i.number}</Text> {i.title}
    </Text>,
    <Box flexDirection="row" gap={1} alignItems="center">
      <Text mono size="footnote" dimColor>
        {sub ? `sub-issues ${sub.done}/${sub.total}` : 'sem sub-issues'}
      </Text>
      {sub && <Svg source={barSvg(sub.total ? (sub.done / sub.total) * 100 : 0, ORANGE)} alt={`${sub.done} de ${sub.total} sub-issues`} width={80} height={5} />}
    </Box>,
  )
  if (!t.pr) {
    body.push(
      <Text mono size="footnote" dimColor>
        sem PR{t.notPushed ? ' · branch sem push' : ''}
      </Text>,
    )
    return cardBox(c, 'card-work', body)
  }
  const pr = t.pr
  body.push(
    <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
      <Text mono size="footnote" wrap="truncate-end">
        <Text dimColor>⇄ </Text>PR #{pr.number} <Text dimColor>· {PR_STATE_WORD[pr.state]}</Text>
      </Text>
      {link(c, 'open-pr', pr.url, 'abrir')}
    </Box>,
  )
  const pills: RenderElement[] = []
  // Com a contagem: "CI ✓ 6/6", "CI ✕ 2 falhas", "CI … 3/7" (as que terminaram).
  const k = pr.checks
  if (pr.ci === 'ok') pills.push(pill(c, 'ci', k ? `CI ✓ ${k.ok}/${k.total}` : 'CI ✓', GREEN, BADGE.green))
  if (pr.ci === 'failed') pills.push(pill(c, 'ci', k?.failed ? `CI ✕ ${k.failed} ${k.failed === 1 ? 'falha' : 'falhas'}` : 'CI ✕ falhou', RED_TEXT, BADGE.red))
  if (pr.ci === 'running') pills.push(pill(c, 'ci', k ? `CI … ${k.total - k.running}/${k.total}` : 'CI … rodando', YELLOW, BADGE.yellow))
  if (pr.review === 'approved') pills.push(pill(c, 'review', 'aprovado', GREEN, BADGE.green))
  if (pr.review === 'changes-requested') pills.push(pill(c, 'review', 'ajustes pedidos', RED_TEXT, BADGE.red))
  if (pr.review === 'pending') pills.push(pill(c, 'review', 'review pendente', YELLOW, BADGE.yellow, true))
  if (pills.length) body.push(<Box flexDirection="row" gap={1}>{pills}</Box>)
  return cardBox(c, 'card-work', body)
}

/** Largura fixa da coluna de tempo das listas: "< 10 s", "19 min", "3 h". */
const TIME_W = 7

/**
 * Uma linha de lista (planos, subagentes, sessões filhas): o texto numa linha só, com reticências,
 * e o tempo numa coluna de largura fixa à direita, que nunca divide espaço com o texto. Na tela
 * "+N" (`full`), o texto quebra e aparece inteiro.
 */
function listLine(c: DrawContext, key: string, text: (RenderElement | string | null)[], time: string, full = false, left?: RenderElement, timeColor?: string) {
  const { Box, Text } = c.el
  return (
    <Box key={key} flexDirection="row" gap={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        {left ?? (
          <Text mono size="footnote" wrap={full ? 'wrap' : 'truncate-end'}>
            {text}
          </Text>
        )}
      </Box>
      <Box width={TIME_W} flexShrink={0} flexDirection="row" justifyContent="flex-end">
        <Text mono size="footnote" dimColor={!timeColor} color={timeColor} tabular>
          {time}
        </Text>
      </Box>
    </Box>
  )
}


/** Quanto o plano durou; o atual, até agora. */
const planDuration = (p: SessionPlan, now: number) => duration((p.end ? Date.parse(p.end) : now) - Date.parse(p.start))

/** Uma linha de plano: ✓ concluído, ◐ abandonado (X/Y) ou ● o atual, o resumo e a duração. */
function planLine(c: DrawContext, p: SessionPlan, detail = false) {
  const { Text } = c.el
  const mark = p.outcome === 'completed' ? { g: '✓', color: GREEN } : p.outcome === 'abandoned' ? { g: '◐', color: YELLOW } : { g: '●', color: ORANGE }
  return listLine(
    c,
    `plan-${p.number}`,
    [
      <Text color={mark.color}>{mark.g} </Text>,
      <Text weight={p.outcome === 'current' ? 'semibold' : undefined}>{textWithPrs(c, p.summary)}</Text>,
      p.outcome === 'completed' && !detail ? null : <Text dimColor> · {p.done}/{p.total}</Text>,
      detail && p.current ? <Text dimColor> · {p.current}</Text> : null,
    ],
    planDuration(p, c.now),
    detail,
  )
}

/** Colunas do texto de um passo no card do Plano: a largura útil menos o anel (~7) e o glifo. */
const STEP_IN_CARD = USABLE - 9 - 2

/** Quantos passos o card do Plano destaca ao lado do anel. */
const STEPS_IN_CARD = 3

/**
 * Os passos que o card destaca: em volta do atual (o último feito, o atual e os próximos); sem
 * atual, os primeiros pendentes; tudo feito, os últimos.
 */
export function highlightedSteps(steps: readonly PanelStep[]): PanelStep[] {
  if (steps.length <= STEPS_IN_CARD) return [...steps]
  const current = steps.findIndex((x) => x.state === 'in_progress')
  const pending = steps.findIndex((x) => x.state === 'pending')
  const focusIndex = current >= 0 ? current : pending >= 0 ? pending : steps.length - 1
  const start = Math.max(0, Math.min(focusIndex - 1, steps.length - STEPS_IN_CARD))
  return steps.slice(start, start + STEPS_IN_CARD)
}

/**
 * O card Plano (pnPlano do P1, com a área útil): o anel com o % à esquerda e, à direita, três
 * passos do plano em destaque (✓ feito, ● o atual em negrito, ○ pendente). Os outros passos e os
 * planos anteriores ficam no detalhe, que a última linha abre.
 */
function planCard(c: DrawContext, p: Panel['plan'], plans: SessionPlan[]) {
  const { Box, Text, Svg } = c.el
  const previous = plans.filter((x) => x.outcome !== 'current')
  const value = p ? `${p.done}/${p.total}` : '0/0'
  const body: (RenderElement | false | null)[] = [header(c, '☰', 'PLANO', value, { color: ORANGE })]
  if (!p) {
    body.push(
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {previous.length ? 'nenhum plano em andamento' : 'sem plano nesta sessão'}
      </Text>,
    )
    const footer = previous.length ? cardFooter(c, opener(c, 'show-plans', `${countOf(previous.length, 'plano anterior', 'planos anteriores')} ›`, c.actions.showPlans, true)) : null
    return cardBox(c, 'card-plan', body, BORDER, CARD_BG, footer)
  }
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
  const steps = p.steps ?? []
  const highlight = highlightedSteps(steps)
  const line = (x: PanelStep) => {
    const done = x.state === 'completed'
    const current = x.state === 'in_progress'
    return (
      <Text key={`step-${x.id}`} mono size="footnote" wrap="truncate-end" dimColor={!done && !current}>
        <Text color={done ? GREEN : current ? ORANGE : undefined}>{done ? '✓' : current ? '●' : '○'} </Text>
        <Text weight={current ? 'bold' : undefined}>{textWithPrs(c, current ? (x.activeText ?? x.text) : x.text, STEP_IN_CARD)}</Text>
      </Text>
    )
  }
  // Sem os passos (núcleo antigo): o resumo do P1, "✓ N feitas", o atual e o próximo.
  const summary = [
    <Text key="done" mono size="footnote" color={GREEN} wrap="truncate-end">
      ✓ {p.done} {p.done === 1 ? 'feita' : 'feitas'}
    </Text>,
    <Text key="current" mono size="footnote" wrap="truncate-end">
      {p.current ? (
        <Text>
          <Text color={ORANGE}>● </Text>
          <Text weight="bold">{p.current}</Text>
        </Text>
      ) : (
        <Text color={GREEN} weight="semibold">
          concluído ✓
        </Text>
      )}
    </Text>,
    p.current && p.next ? (
      <Text key="next" mono size="footnote" dimColor wrap="truncate-end">
        ○ {p.next}
        {p.remaining ? ` · +${p.remaining}` : ''}
      </Text>
    ) : null,
  ]
  body.push(
    <Box flexDirection="row" gap={2} alignItems="center">
      <Svg source={ringSvg(pct)} alt={`plano ${pct}% feito, ${p.done} de ${p.total}`} width={50} height={50} />
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        {highlight.length ? highlight.map(line) : summary}
      </Box>
    </Box>,
  )
  // O plano inteiro (os passos) e os anteriores, no detalhe: "6 passos · 2 planos anteriores ›".
  const parts = [steps.length ? countOf(steps.length, 'passo', 'passos') : null, previous.length ? countOf(previous.length, 'plano anterior', 'planos anteriores') : null].filter(Boolean)
  const footer = cardFooter(c, opener(c, 'show-plans', parts.length ? `${parts.join(' · ')} ›` : 'ver o plano ›', c.actions.showPlans, true))
  return cardBox(c, 'card-plan', body, BORDER, CARD_BG, footer)
}

/** Colunas do texto de uma linha de lista no card: a largura útil menos a coluna de tempo e o espaço. */
const LINE_TEXT = CARD_W - 4 - TIME_W - 1
/** Na linha do subagente, quantos caracteres da descrição ficam à vista antes de o tipo encurtar. */
const DESCRIPTION_MIN = 8
/** O tipo nunca encurta abaixo disso ("gener…"). */
const TYPE_MIN = 6

function subagentLine(c: DrawContext, s: PanelSubagent, full = false) {
  const { Text } = c.el
  const mark =
    s.status === 'completed' ? { g: '✓', color: GREEN } : s.status === 'error' ? { g: '✕', color: RED_TEXT } : { g: '●', color: ORANGE }
  const time = s.until ? duration(Date.parse(s.until) - Date.parse(s.since)) : since(s.since, c.now)
  // O que distingue um subagente é a descrição: no card, se ela não couber com pelo menos
  // DESCRIPTION_MIN caracteres, é o tipo que encurta ("general…").
  const name = full || !s.task ? s.name : truncate(s.name, Math.max(TYPE_MIN, LINE_TEXT - 2 - 3 - Math.min([...s.task].length, DESCRIPTION_MIN)))
  return listLine(
    c,
    `sub-${s.id}`,
    [
      <Text color={mark.color}>{mark.g} </Text>,
      <Text weight="bold">{name}</Text>,
      // O "#N" da descrição é link para o PR; no card, o texto cabe na linha sem cortar o número.
      s.task ? <Text dimColor> · {textWithPrs(c, s.task, full ? undefined : Math.max(1, LINE_TEXT - 2 - [...name].length - 3))}</Text> : null,
    ],
    time,
    full,
  )
}


/** Os ativos primeiro; depois os encerrados, mais recentes antes. */
function subagentsInOrder(s: Panel['subagents']) {
  const active = s.items.filter(activeSubagent)
  const ended = s.items.filter((i) => !activeSubagent(i)).sort((x, y) => (y.until ?? y.since).localeCompare(x.until ?? x.since))
  return [...active, ...ended]
}

const activeSubagent = (i: PanelSubagent) => i.status === 'working' || i.status === 'waiting'


/** Quantos itens cabem em `lines`; quando nem todos cabem, uma linha fica para o "+N". */
function howManyFit(heights: number[], lines: number): number {
  if (heights.reduce((a, b) => a + b, 0) <= lines) return heights.length
  let used = 0
  let n = 0
  for (const h of heights) {
    if (used + h + 1 > lines) break
    used += h
    n++
  }
  return n
}

/** No card (P1), até 3 linhas: os ativos primeiro, e os encerrados mais recentes até completar. */
const LIST_LINES = 3

/**
 * O pé do card Subagentes (P11), que abre o grafo da sessão: com todos no card, "ver o grafo ›"; com
 * mais, quantos ficaram fora e, entre eles, os com erro: "+22 · 1 com erro · grafo ›".
 */
function subagentsFooter(outside: PanelSubagent[]): string {
  if (outside.length === 0) return 'ver o grafo ›'
  const errors = outside.filter((i) => i.status === 'error').length
  const long = `+${outside.length}${errors ? ` · ${errors} com erro` : ''} · grafo ›`
  // O botão nativo não quebra: sem caber, o erro vira o glifo ("+22 · 1 ✕ · grafo ›").
  return [...long].length <= UNCUT_COLUMNS ? long : `+${outside.length}${errors ? ` · ${errors} ✕` : ''} · grafo ›`
}

/**
 * O card Subagentes (pnSubs do P1): "N ativos" à direita do cabeçalho, a barra por estado (ativo
 * laranja, concluído verde, erro vermelho) e até 3 linhas "glifo tipo · descrição … tempo", os
 * concluídos também. O pé abre o grafo da sessão (P11). Nunca só o cabeçalho.
 */
function subagentsCard(c: DrawContext, s: Panel['subagents']) {
  const { Text, Svg } = c.el
  const body: (RenderElement | false | null)[] = [header(c, '⑂', 'SUBAGENTES', plural(s.active, 'ativo', 'ativos'))]
  if (s.items.length === 0) {
    body.push(
      <Text mono size="footnote" dimColor>
        nenhum nesta sessão
      </Text>,
    )
    return cardBox(c, 'card-subagents', body)
  }
  const all = subagentsInOrder(s)
  const outside = all.slice(LIST_LINES)
  body.push(
    // Largura e altura explícitas: sem elas, o Desktop dá ao Svg a altura do próprio desenho na
    // largura que sobra, e a barra virava um bloco do tamanho do card. BAR_W é a largura útil do
    // card no Desktop (~7,9 px por coluna), de borda a borda.
    <Svg source={subagentsSvg(s.items)} alt={`${s.active} ativos de ${s.items.length}`} width={BAR_W} height={BAR_H} />,
    ...all.slice(0, LIST_LINES).map((i) => subagentLine(c, i)),
  )
  const footer = cardFooter(c, opener(c, 'show-subagents', subagentsFooter(outside), c.actions.showSubagents, true))
  return cardBox(c, 'card-subagents', body, BORDER, CARD_BG, footer)
}

/** O nome da sessão: um link que abre a conversa no Claude Desktop, quando ela está no índice dele. */
function sessionName(c: DrawContext, key: string, title: string, local: string | null | undefined, max: number, full = false, asInCard = false) {
  const { Button, Link, Text } = c.el
  const label = full ? title : truncate(title, max)
  // No card (P1), o nome em negrito na cor do texto; na lista, o link em laranja.
  const text = (
    <Text mono size="footnote" weight={asInCard ? 'bold' : 'semibold'} color={asInCard ? undefined : ORANGE} underline={!asInCard} wrap={full ? 'wrap' : 'truncate-end'}>
      {label}
    </Text>
  )
  // No macOS, a API abre a conversa direto; fora dele, o link de reserva passa pelo navegador.
  // No Desktop o Button é nativo e ignora o Text de dentro: o nome vai no `label`.
  if (opensDirectly(c, local)) return <Button key={key} plain label={label} onPress={() => c.actions.openSession(local!, title)} />
  const href = sessionUrl(c, local)
  if (href) return asInCard ? <Link key={key} href={href}>{text}</Link> : <Link key={key} href={href} label={label} />
  return (
    <Text key={key} mono size="footnote" weight={asInCard ? 'bold' : 'semibold'} wrap={full ? 'wrap' : 'truncate-end'}>
      {title}
    </Text>
  )
}

/** Onde a filha entra na lista: trabalhando, precisando de você, na sua vez ou parada. */
export type ChildGroup = 'working' | 'needs' | 'your-turn' | 'stopped' | 'archived'

export function childGroup(f: PanelChild): ChildGroup {
  // #145: a arquivada no Desktop vem por último, seja qual for o estado em que parou.
  if (f.archived) return 'archived'
  if (f.state === 'active' || f.state === 'delegating' || f.state === 'background') return 'working'
  if (f.state === 'error') return 'needs'
  // Uma permissão ou uma pergunta chega como `notification`; o fim do turno e o Esc são a sua vez.
  if (f.state === 'waiting') return f.reason === 'notification' ? 'needs' : 'your-turn'
  return 'stopped'
}

const CHILD_ORDER: ChildGroup[] = ['working', 'needs', 'your-turn', 'stopped', 'archived']

/** O que vem depois do nome, em cor neutra: o que a filha que trabalha está fazendo. */
const childDoing = (f: PanelChild) => (childGroup(f) === 'working' ? (f.doing ?? null) : null)

/** A coluna da direita (P1): o tempo, ou o estado que pede você, em âmbar ("Sua vez", "Precisa"). */
function childRight(f: PanelChild, now: number): { text: string; color?: string } {
  const group = childGroup(f)
  if (group === 'your-turn') return { text: 'Sua vez', color: YELLOW }
  if (group === 'needs') return { text: f.state === 'error' ? 'Erro' : 'Precisa', color: f.state === 'error' ? RED_TEXT : YELLOW }
  // Na coluna de 7: "arquiv." (na lista completa, "· arquivada" vai depois do nome).
  if (group === 'archived') return { text: 'arquiv.' }
  return { text: since(f.since, now) }
}

/** Uma filha (P1): "glifo nome … estado ou tempo"; na lista completa, a que trabalha com o que faz depois do nome. */
function childLine(c: DrawContext, f: PanelChild, max: number, full = false, withDoing = true) {
  const { Box, Text } = c.el
  const st = statusOf(f.state)
  const g = st === 'waiting' ? '◐' : st === 'completed' ? '✓' : st === 'error' ? '✕' : st === 'abandoned' ? '○' : '●'
  // No card (P1) é "nome … tempo"; o que ela está fazendo aparece na lista completa.
  const doing = withDoing ? childDoing(f) : null
  const right = childRight(f, c.now)
  return listLine(
    c,
    `child-${f.id}`,
    [],
    right.text,
    full,
    <Box flexDirection="row" flexShrink={1} minWidth={0}>
      <Text mono size="footnote" color={STATUS_COLOR[st].color}>
        {g}{' '}
      </Text>
      <Box flexShrink={1} minWidth={0}>
        {sessionName(c, `child-name-${f.id}`, f.title, f.local, max, full, !withDoing)}
      </Box>
      {doing ? (
        <Box flexShrink={2} minWidth={0}>
          <Text mono size="footnote" dimColor wrap={full ? 'wrap' : 'truncate-end'}>
            {' '}· {textWithPrs(c, doing)}
          </Text>
        </Box>
      ) : null}
    </Box>,
    right.color,
  )
}

/** A sessão do painel está no meio de um turno? O `prompt.submit` de um plugin só roda com ela ociosa. */
const inTurn = (s: PanelSession | null | undefined) => !!s && (s.state === 'active' || s.state === 'delegating')

/**
 * Uma filha arquivada na lista completa (#145): o nome e "· arquivada" em cor neutra e, à direita,
 * "Desarquivar", que pede à sessão do painel para chamar `unarchive_session` (a pessoa aprova). Com a
 * sessão no meio de um turno, o pedido só rodaria depois: "aguarde o turno" no lugar do botão.
 */
function archivedLine(c: DrawContext, f: PanelChild, session: PanelSession | null | undefined) {
  const { Box, Button, Text } = c.el
  return (
    <Box key={`child-${f.id}`} flexDirection="row" alignItems="center" gap={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text mono size="footnote" dimColor wrap="wrap">
          ○ {f.title} · arquivada
        </Text>
      </Box>
      {!f.local ? null : inTurn(session) ? (
        <Text key={`wait-${f.id}`} mono size="footnote" dimColor>
          aguarde o turno
        </Text>
      ) : (
        <Button key={`unarchive-${f.id}`} label="Desarquivar" variant="secondary" onPress={() => c.actions.unarchive(f)} />
      )}
    </Box>
  )
}

/** Na ordem do card: as trabalhando, as que precisam, as na sua vez e as paradas; em cada grupo, a mais recente antes. */
const childrenInOrder = (children: PanelChild[]) =>
  [...children].sort(
    (a, b) => CHILD_ORDER.indexOf(childGroup(a)) - CHILD_ORDER.indexOf(childGroup(b)) || (b.since ?? '').localeCompare(a.since ?? ''),
  )

/**
 * O card Sessões filhas (pnFilhas do P1): a contagem à direita do cabeçalho, até 3 linhas, as que
 * trabalham primeiro, e "ver todas as N ›" na última quando há mais do que cabe. Nunca só o cabeçalho.
 */
function childrenCard(c: DrawContext, allChildren: PanelChild[]) {
  const children = childrenInOrder(allChildren)
  const { Text } = c.el
  // O total com as arquivadas, e quantas são (#145): "15 · 9 arquivadas".
  const archivedCount = children.filter((f) => f.archived).length
  const body: (RenderElement | false | null)[] = [header(c, '⑃', 'SESSÕES FILHAS', `${children.length}${archivedCount ? ` · ${countOf(archivedCount, 'arquivada', 'arquivadas')}` : ''}`)]
  if (children.length === 0) {
    body.push(
      <Text mono size="footnote" dimColor>
        nenhuma aberta por esta
      </Text>,
    )
    return cardBox(c, 'card-children', body)
  }
  body.push(
    // O nome no card é cortado só no link (que não quebra linha); o resto corta com reticências.
    ...children.slice(0, LIST_LINES).map((f) => childLine(c, f, USABLE - TIME_W - 3, false, false)),
  )
  // O pé ("N sessões filhas ›") só quando há mais filhas do que as linhas do card.
  const footer = children.length > LIST_LINES ? cardFooter(c, opener(c, 'show-children', `${countOf(children.length, 'sessão filha', 'sessões filhas')} ›`, c.actions.showChildren, true)) : null
  return cardBox(c, 'card-children', body, BORDER, CARD_BG, footer)
}

/**
 * Folga abaixo da altura do corpo: a estimativa das linhas não conta a pintura do desktop ao
 * pixel, e o dono não quer nenhuma rolagem.
 */
export const SLACK = 2

/** Linhas livres numa tela que toma o lugar da sessão, descontado o que ela tem em volta e a folga. */
const free = (c: DrawContext, around: number) =>
  c.lines === undefined ? Number.POSITIVE_INFINITY : c.lines - around - SLACK - (footerLines(c.reading.panel) - 1)
/** O que não coube nesta altura: o painel não rola. */
function didNotFit(c: DrawContext, key: string, n: number) {
  if (n <= 0) return null
  const { Text } = c.el
  return (
    <Text key={key} mono size="footnote" dimColor>
      +{n} que não cabem nesta altura
    </Text>
  )
}
/** Quantas fileiras de cards de 9 linhas cabem (com o espaço entre elas). */
const rowsThatFit = (lines: number) => Math.max(1, Math.floor((lines + 1) / (CARD_BORDER + CARD_LINES + 1)))

/** A lista completa das sessões filhas, no lugar dos cards. */
function childrenScreen(c: DrawContext, p: Panel, g: ReturnType<typeof grid>) {
  const { Box, Text, Button } = c.el
  const usable = g.width - 4
  const heights = p.children.map((f) => (sessionUrl(c, f.local) ? 1 : textLines(`● ${f.title}`, usable - TIME_W - 3)))
  // Em volta: respiro, topo, voltar, rótulo, borda da caixa, rodapé, versão e os espaços.
  const n = howManyFit(heights, free(c, 2 + 4 + 1 + 1 + 2 + 1 + 1 + 5))
  const items = childrenInOrder(p.children).slice(0, n).map((f) => (f.archived ? archivedLine(c, f, p.session) : childLine(c, f, g.width, true)))
  return [
    sectionLabel(c, g.width, `SESSÕES FILHAS · ${p.children.length}`, chip(c, 'chip-children', 'desta sessão')),
    <Box key="list-children" flexDirection="column" width={g.width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1} gap="xs">
      {items.length ? [...items, didNotFit(c, 'did-not-fit', p.children.length - n)] : [<Text key="empty" mono dimColor>nada por aqui</Text>]}
    </Box>,
    <Box key="footer-children" flexDirection="row" justifyContent="flex-end" width={g.width}>
      <Button key="close-children" plain onPress={c.actions.close}>
        <Text color={ORANGE} underline>
          ← voltar
        </Text>
      </Button>
    </Box>,
  ]
}

// --- O grafo da sessão (#146, P12 e P13) ---

/** Px por coluna da fonte mono no Desktop (ver BAR_W): a barra do tempo tem a largura das colunas dela. */
const PX_PER_COLUMN = 7.9
const GRAPH_BAR_H = 10
/** As colunas de cada linha do grafo: no estreito, nome, barra e tempo; no largo, também estado e início. */
const GRAPH_COLUMNS = {
  narrow: { name: 14, bar: 7, state: 0, start: 0, time: TIME_W },
  wide: { name: 40, bar: 36, state: 9, start: 6, time: TIME_W },
} as const
/** O que o grafo tem em volta, em linhas: o respiro, o topo, os dois "← voltar", o rótulo, a borda da caixa, a régua, a raiz, o pé e a versão. */
const AROUND_GRAPH = 2 + 4 + 1 + 1 + 2 + 2 + 2 + 2 + 1 + 5

const SUB_COLOR = (s: PanelSubagent['status']) => (s === 'completed' ? GREEN : s === 'error' ? RED : ORANGE)
const SUB_GLYPH = (s: PanelSubagent['status']) => (s === 'completed' ? '✓' : s === 'error' ? '✕' : '●')
const SUB_STATE = (s: PanelSubagent['status']) => (s === 'completed' ? 'concluído' : s === 'error' ? 'com erro' : 'ativo')
const SESSION_STATE: Record<ReturnType<typeof statusOf>, string> = { active: 'ativa', waiting: 'esperando', completed: 'concluída', error: 'com erro', abandoned: 'abandonada' }

/** O minuto da sessão, como na régua: "33′". */
const sessionMinute = (t0: number, t: number) => `${Math.max(0, Math.round((t - t0) / 60_000))}′`

/**
 * A barra do tempo de uma linha: o trilho fino da sessão inteira e, nele, de quando começou a quando
 * acabou (ou até agora, com um traço no fim). Numa onda recolhida, a faixa da onda, clara, com um
 * traço por subagente. Largura e altura explícitas, como todo Svg do mod.
 */
function graphBarSvg(w: number, t0: number, t1: number, start: number, end: number | null, color: string, marks?: number[]) {
  const h = GRAPH_BAR_H
  const x = (v: number) => 1 + ((Math.max(t0, Math.min(t1, v)) - t0) / Math.max(1, t1 - t0)) * (w - 2)
  const from = x(start)
  const until = x(end ?? t1)
  const barWidth = Math.max(3, until - from).toFixed(1)
  const rail = `<rect x="0" y="${h / 2 - 1}" width="${w}" height="2" rx="1" fill="${BORDER}"/>`
  if (marks) {
    return svg(w, h, `${rail}<rect x="${from.toFixed(1)}" y="1" width="${barWidth}" height="${h - 2}" rx="2" fill="${color}" fill-opacity="0.3"/>${marks.map((m) => `<rect x="${x(m).toFixed(1)}" y="1" width="2" height="${h - 2}" fill="${color}"/>`).join('')}`)
  }
  const now = end === null ? `<rect x="${(until - 2).toFixed(1)}" y="0" width="2" height="${h}" fill="${color}"/>` : ''
  return svg(w, h, `${rail}<rect x="${from.toFixed(1)}" y="1" width="${barWidth}" height="${h - 2}" rx="2" fill="${color}"/>${now}`)
}

/** A régua do largo: 0′ à esquerda, a duração da sessão à direita e as dezenas (ou os cincos) no meio. */
function graphRulerSvg(w: number, minutes: number) {
  const step = minutes < 30 ? 5 : 10
  const marks = Array.from({ length: Math.floor(minutes / step) + 1 }, (_, i) => i * step).filter((m) => m === 0 || m <= minutes - step / 2)
  const x = (m: number) => 1 + (m / Math.max(1, minutes)) * (w - 2)
  const source = `font-family="ui-monospace, Menlo, monospace" font-size="9" fill="${paleta.gray['300']}"`
  return svg(
    w,
    14,
    marks.map((m) => `<rect x="${x(m).toFixed(1)}" y="10" width="1" height="4" fill="${paleta.gray['300']}"/><text x="${m === 0 ? 0 : (x(m) - 3).toFixed(1)}" y="8" ${source}>${m}′</text>`).join('') +
      `<rect x="${w - 1}" y="10" width="1" height="4" fill="${paleta.gray['300']}"/><text x="${w}" y="8" text-anchor="end" ${source}>${minutes}′</text>`,
  )
}

/** Uma linha do grafo: as colunas de largura fixa, que nunca dividem espaço uma com a outra. */
function graphLine(
  c: DrawContext,
  key: string,
  wide: boolean,
  name: RenderElement | RenderElement[],
  bar: RenderElement | null,
  right: { state?: string; stateColor?: string; start?: string; time: string },
  background?: string,
) {
  const { Box, Text } = c.el
  const k = wide ? GRAPH_COLUMNS.wide : GRAPH_COLUMNS.narrow
  const cell = (key: string, w: number, text: string | undefined, color?: string, alignRight = false) => (
    <Box key={key} width={w} flexShrink={0} flexDirection="row" justifyContent={alignRight ? 'flex-end' : 'flex-start'} overflow="hidden">
      <Text mono size="footnote" tabular color={color} dimColor={!color} wrap="truncate-end">
        {text ?? ''}
      </Text>
    </Box>
  )
  return (
    <Box key={key} flexDirection="row" gap={1} alignItems="center" backgroundColor={background}>
      <Box key="name" width={k.name} flexShrink={0} flexDirection="row" alignItems="center" overflow="hidden">
        {name}
      </Box>
      <Box key="bar" width={k.bar} flexShrink={0} flexDirection="row" alignItems="center">
        {bar}
      </Box>
      {wide ? cell('estado', k.state, right.state, right.stateColor) : null}
      {wide ? cell('inicio', k.start, right.start) : null}
      {cell('tempo', k.time, right.time, undefined, true)}
    </Box>
  )
}

/** Uma onda: ▸/▾ (botão nativo) que abre e fecha, o que ela tem e, recolhida, a faixa dela no tempo. */
function waveLine(c: DrawContext, o: Extract<GraphLine, { type: 'wave' }>, wide: boolean, t0: number, state: GraphState) {
  const { Svg, Text, Button } = c.el
  const k = wide ? GRAPH_COLUMNS.wide : GRAPH_COLUMNS.narrow
  const w = Math.round(k.bar * PX_PER_COLUMN)
  const toggle = () =>
    c.actions.graph(
      o.open
        ? { opened: state.opened.filter((n) => n !== o.number), closed: [...state.closed.filter((n) => n !== o.number), o.number] }
        : { closed: state.closed.filter((n) => n !== o.number), opened: [...state.opened.filter((n) => n !== o.number), o.number] },
    )
  const what = o.types.length === 1 ? `${o.total} ${o.types[0]}` : `${o.total} subagentes`
  const waveColor = o.count.errors ? RED : o.count.active ? ORANGE : GREEN
  const name = [
    <Button key={`wave-${o.number}`} plain label={`${o.open ? '▾' : '▸'} Onda ${o.number}`} onPress={toggle} />,
    <Text key="summary" mono size="footnote" wrap="truncate-end">
      <Text dimColor> · {wide ? `${what}${o.open && o.inParallel ? ' em paralelo' : ''} ` : ''}</Text>
      {shortCount(o.count).map((x, i) => (
        <Text key={`count-${i}`} color={STATUS_COLOR[x.st].color}>
          {i ? ' ' : ''}
          {x.text}
        </Text>
      ))}
    </Text>,
  ]
  const end = o.end ?? c.now
  const bar = o.open ? null : <Svg source={graphBarSvg(w, t0, c.now, o.start, o.end, waveColor, o.marks)} alt={`onda ${o.number}`} width={w} height={GRAPH_BAR_H} />
  const waveState = o.count.errors ? { state: 'com erro', stateColor: RED_TEXT } : o.count.active ? { state: 'ativa', stateColor: ORANGE } : { state: 'concluída' }
  return graphLine(c, `graph-wave-${o.number}`, wide, name, bar, o.open ? { time: '' } : { ...waveState, start: sessionMinute(t0, o.start), time: duration(end - o.start) })
}

/** Um subagente: o trilho de quem o disparou, o glifo do estado, o tipo e a descrição, e a barra. */
function nodeLine(c: DrawContext, n: Extract<GraphLine, { type: 'node' }>, wide: boolean, t0: number) {
  const { Svg, Text } = c.el
  const s = n.sub
  const k = wide ? GRAPH_COLUMNS.wide : GRAPH_COLUMNS.narrow
  const w = Math.round(k.bar * PX_PER_COLUMN)
  const start = Date.parse(s.since)
  const end = s.until ? Date.parse(s.until) : null
  const color = SUB_COLOR(s.status)
  const more = n.more && wide ? shortCount(n.more).map((x) => x.text.replace(/^(\d+)/, '+$1')).join(' ') : null
  const name = (
    <Text key="node" mono size="footnote" wrap="truncate-end">
      <Text dimColor>{n.rail}</Text>
      <Text color={s.status === 'error' ? RED_TEXT : color}>{SUB_GLYPH(s.status)} </Text>
      <Text weight="bold">{s.name}</Text>
      {s.task && (wide || n.level === 1) ? <Text dimColor> · {s.task}</Text> : null}
      {more ? <Text dimColor> · {more}</Text> : null}
    </Text>
  )
  const state = s.status === 'error' ? { state: 'com erro', stateColor: RED_TEXT } : s.status === 'completed' ? { state: 'concluído' } : { state: 'ativo', stateColor: ORANGE }
  return graphLine(
    c,
    `graph-node-${s.id}`,
    wide,
    name,
    <Svg source={graphBarSvg(w, t0, c.now, start, end, color)} alt={`${s.name}: ${SUB_STATE(s.status)}`} width={w} height={GRAPH_BAR_H} />,
    { ...state, start: sessionMinute(t0, start), time: duration((end ?? c.now) - start) },
    s.status === 'error' ? BADGE.red : undefined,
  )
}

/**
 * O grafo da sessão (P12 e P13), no lugar dos cards, aberto pelo pé do card Subagentes (P11): a
 * sessão na raiz, cada subagente pendurado em quem o disparou e a barra de quando rodou; barras
 * sobrepostas rodaram em paralelo. Com mais de GROUP_ABOVE, por onda, com o filtro; pagina pela
 * altura do painel, sem cortar uma linha.
 */
function graphScreen(c: DrawContext, p: Panel, g: ReturnType<typeof grid>, narrow: boolean) {
  const { Box, Text, Button, Select, Svg } = c.el
  const wide = !narrow
  const k = wide ? GRAPH_COLUMNS.wide : GRAPH_COLUMNS.narrow
  const items = p.subagents.items
  const state = c.view.graph ?? GRAPH_STATE
  const graph = buildGraph(items, c.now, state)
  const s = p.session
  const t0 = Math.min(s ? Date.parse(s.startedAt) : c.now, ...items.map((x) => Date.parse(x.since)))
  const minutes = Math.max(1, Math.round((c.now - t0) / 60_000))
  const pg = paginate(graph.lines, free(c, AROUND_GRAPH), state.page)
  const w = Math.round(k.bar * PX_PER_COLUMN)

  const count = graph.count
  const chips = (
    <Box key="chips-graph" flexDirection="row" gap={2} flexShrink={0}>
      {count.errors ? (
        <Text key="errors" mono size="caption" color={RED_TEXT}>
          {count.errors} {narrow ? '✕' : 'com erro'}
        </Text>
      ) : null}
      {wide && graph.parallel ? chip(c, 'parallel', `${graph.parallel} em paralelo`) : null}
      {chip(c, 'active', plural(count.active, 'ativo', 'ativos'))}
    </Box>
  )
  const ruler = graphLine(
    c,
    'graph-ruler',
    wide,
    <Text key="who" mono size="caption" dimColor wrap="truncate-end">
      {wide ? 'quem disparou quem' : 'quem disparou'}
    </Text>,
    wide ? (
      <Svg source={graphRulerSvg(w, minutes)} alt={`de 0 a ${minutes} minutos`} width={w} height={14} />
    ) : (
      <Text mono size="caption" dimColor>
        0–{minutes}′
      </Text>
    ),
    { state: 'estado', start: 'início', time: wide ? 'duração' : 'tempo' },
  )
  const st = s ? statusOf(s.state) : 'active'
  const root = graphLine(
    c,
    'graph-root',
    wide,
    <Text key="root" mono size="footnote" wrap="truncate-end">
      <Text color={ORANGE}>◆ </Text>
      <Text weight="bold">Esta sessão</Text>
      {wide && s?.model ? <Text dimColor> · {model(s.model)}</Text> : null}
    </Text>,
    <Svg source={graphBarSvg(w, t0, c.now, t0, null, STATUS_COLOR[st].border)} alt="esta sessão" width={w} height={GRAPH_BAR_H} />,
    { state: SESSION_STATE[st], stateColor: st === 'active' ? ORANGE : STATUS_COLOR[st].color, start: '0′', time: duration(c.now - t0) },
  )
  const lines = pg.lines.map((l) => (l.type === 'wave' ? waveLine(c, l, wide, t0, state) : nodeLine(c, l, wide, t0)))
  const after = pg.after ? (
    <Text key="graph-after" mono size="footnote" dimColor>
      {'  '}⋯ +{pg.after} na pág. {pg.page + 2}
    </Text>
  ) : null
  const filter = graph.grouped ? (
    <Select
      key="graph-filter"
      value={state.filter}
      options={[
        { value: 'all', label: 'Todos' },
        { value: 'active', label: 'Ativos e erros' },
      ]}
      onSelect={(v: string) => c.actions.graph({ filter: v === 'active' ? 'active' : 'all', page: 0 })}
    />
  ) : null
  const pages =
    pg.pages > 1
      ? [
          <Button key="graph-previous" plain label="‹" onPress={() => c.actions.graph({ page: Math.max(0, pg.page - 1) })} />,
          <Text key="graph-page" mono size="footnote" dimColor tabular>
            {pg.page + 1}/{pg.pages}
          </Text>,
          <Button key="graph-next" plain label="›" onPress={() => c.actions.graph({ page: Math.min(pg.pages - 1, pg.page + 1) })} />,
        ]
      : []
  // No estreito, a legenda só cabe quando o pé não tem a paginação nem o filtro.
  const legend =
    wide || (!pages.length && !filter) ? (
      <Box key="legend" flexShrink={1} minWidth={0}>
        <Text mono size="footnote" dimColor wrap="truncate-end">
          {wide ? `barras sobrepostas rodaram em paralelo${graph.grouped ? ' · ▸ abre a onda' : ''}` : 'sobrepostas: em paralelo'}
        </Text>
      </Box>
    ) : null
  return [
    sectionLabel(c, g.width, narrow ? `GRAFO · ${graph.total}` : `GRAFO · ${graph.total} SUBAGENTES`, chips),
    <Box key="graph" flexDirection="column" width={g.width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1}>
      {ruler}
      {root}
      {lines.length ? lines : [<Text key="empty" mono size="footnote" dimColor>nenhum nesta sessão</Text>]}
      {after}
    </Box>,
    <Box key="graph-footer" flexDirection="row" alignItems="center" gap={1} width={g.width}>
      {pages}
      {filter}
      {legend}
      <Box key="space" flexGrow={1} />
      <Button key="close-graph" plain onPress={c.actions.close}>
        <Text color={ORANGE} underline>
          ← voltar
        </Text>
      </Button>
    </Box>,
  ]
}

// --- Linha de baixo: "N precisam de você" ---

/** O nível da sessão em "precisam de você"; núcleo antigo, sem o campo: conta como precisa. */
const needs = (i: NeedsYou) => i.level !== 'your-turn'

/** O que bloqueia, dito curto: o motivo da espera ou o erro. */
const WHY: Record<NonNullable<NeedsYou['why']>, string> = {
  permission: 'Pede permissão',
  question: 'Pergunta',
  plan: 'Plano para aprovar',
  decision: 'Pede decisão',
  error: 'Com erro',
  'your-turn': 'Sua vez',
  interrupted: 'Interrompida',
  'no-prompt': 'No prompt',
}
const whyOf = (i: NeedsYou) => (i.why ? WHY[i.why] : i.state === 'error' ? 'Com erro' : i.reason ? REASONS[i.reason].label : 'Esperando')

/**
 * "Precisam de você" (#140): o destaque é só de quem está bloqueada até você agir (permissão,
 * pergunta, plano, decisão pedida, erro). A sua vez no bate-bola aparece em cor neutra, ao lado,
 * sem somar na contagem.
 */
/** Quem precisa de você, pelo nome e pelo motivo: as duas primeiras, no largo. */
const namesThatNeed = (p: Panel) =>
  p.needYou.machine
    .filter(needs)
    .slice(0, 2)
    .map((i) => `${i.title} (${whyOf(i)})`)
    .join(', ')

/** As partes da linha de quem precisa de você: o que desenha e o que a estimativa da altura mede. */
function needYouParts(p: Panel, narrow: boolean) {
  const n = p.needYou.total
  const yourTurnN = p.needYou.yourTurn ?? 0
  const onTurn = yourTurnN ? `${yourTurnN} na sua vez` : ''
  const names = !narrow && n > 0 ? namesThatNeed(p) : ''
  const isMain = n === 0 ? '○ ninguém mais precisa de você' : `🔔 ${needYouText(n)}`
  return { n, yourTurnN, onTurn, names, text: `${isMain}${names ? ` · ${names}` : ''}${onTurn ? ` · ${onTurn}` : ''}`, isMain }
}

/** O botão "Ver" ao lado e o espaço antes dele, em colunas. */
const SEE_BUTTON = 7

/** Linhas da faixa de quem precisa de você: o texto quebra linha, nunca corta; com zero, sem botão (P1). */
const needYouLines = (p: Panel, usable: number, narrow: boolean) =>
  LOOSE_LINE - 1 + textLines(needYouParts(p, narrow).text, usable - (p.needYou.total ? SEE_BUTTON : 0))

function needYouLine(c: DrawContext, p: Panel, width: number, narrow: boolean) {
  const { Box, Text, Button } = c.el
  const { n, onTurn, names, isMain } = needYouParts(p, narrow)
  if (n === 0) {
    // P1: com zero, em cor neutra e sem o "Ver"; a sua vez ao lado, também neutra.
    return (
      <Box key="need-you" flexDirection="row" alignItems="center" width={width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1}>
        <Text mono dimColor wrap="wrap">
          {isMain}
          {onTurn ? ` · ${onTurn}` : ''}
        </Text>
      </Box>
    )
  }
  const split = p.needYou.byAccount.map((d) => `${d.account ? accountLabel(d.account.label) : 'sem conta'} ${d.n}`).join(' · ')
  return (
    <Box key="need-you" flexDirection="column" width={width} borderStyle="round" borderColor={YELLOW} backgroundColor={BADGE.yellow} paddingX={1} hover={{ borderColor: ORANGE }}>
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text mono weight="bold" color={YELLOW} wrap="wrap">
            {isMain}
            {names ? <Text weight="regular" color={paleta.gray['100']}> · {names}</Text> : null}
            {onTurn ? <Text weight="regular" color={GRAY}> · {onTurn}</Text> : null}
          </Text>
        </Box>
        <Button key="show-need-you" label="Ver" variant="primary" onPress={c.actions.showNeedYou} />
      </Box>
      <Box display="none" hover={{ display: 'flex' }}>
        <Text mono size="caption" color={YELLOW} wrap="truncate-end">
          por conta: {split}
        </Text>
      </Box>
    </Box>
  )
}

/** #140: o indicador próprio dos PRs que aguardam a sua aprovação, com a lista de links. */
/**
 * "⇄ 1 PR aguardando sua aprovação"; no estreito, "⇄ 1 PR p/ aprovar", que cabe sem cortar. Em
 * laranja, o destaque: vermelho, no P1, é erro.
 */
const prsText = (n: number, narrow: boolean) => `⇄ ${n === 1 ? '1 PR' : `${n} PRs`} ${narrow ? 'p/ aprovar' : 'aguardando sua aprovação'}`

function prsLine(c: DrawContext, p: Panel, width: number, narrow: boolean) {
  const n = p.prs?.total ?? 0
  if (n === 0) return null
  const { Box, Text, Button, Link } = c.el
  const one = n === 1 ? (p.prs?.items[0] ?? null) : null
  return (
    <Box key="prs" flexDirection="row" alignItems="center" gap={1} width={width} borderStyle="round" borderColor={ORANGE} backgroundColor={CARD_BG} paddingX={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        {/* Com um PR só, o texto já é o link para ele no GitHub; com mais, "Ver" abre a lista, um link por PR. */}
        {one ? (
          <Link key="open-the-pr" href={one.url}>
            <Text mono weight="bold" color={ORANGE} underline wrap="wrap">
              {prsText(n, narrow)}
            </Text>
          </Link>
        ) : (
          <Text mono weight="bold" color={ORANGE} wrap="wrap">
            {prsText(n, narrow)}
          </Text>
        )}
      </Box>
      <Button key="show-prs" label="Ver" variant="secondary" onPress={c.actions.showPrs} />
    </Box>
  )
}

/** A lista dos PRs: um por linha, o número e o título como link, e a sessão que o abriu. */
function prsScreen(c: DrawContext, p: Panel, g: ReturnType<typeof grid>) {
  const { Box, Text, Button, Link } = c.el
  const items = p.prs?.items ?? []
  // Em volta: respiro, topo, voltar, rótulo, borda da caixa, rodapé, versão e os espaços.
  const fit = howManyFit(items.map(() => 1), free(c, 2 + 4 + 1 + 1 + 2 + 1 + 1 + 5))
  const line = (pr: WaitingPr) => (
    <Box key={`pr-${pr.url}`} flexDirection="row" gap={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        {link(c, `link-pr-${pr.url}`, pr.url, truncate(`PR #${pr.number} · ${pr.title}`, Math.max(20, g.width - 24)))}
      </Box>
      <Box width={18} flexShrink={0} flexDirection="row" justifyContent="flex-end">
        <Text mono size="footnote" dimColor wrap="truncate-end">
          {pr.session.title}
        </Text>
      </Box>
    </Box>
  )
  return [
    sectionLabel(c, g.width, `PRS AGUARDANDO SUA APROVAÇÃO · ${items.length}`, chip(c, 'chip-prs', 'review pendente')),
    <Box key="list-prs" flexDirection="column" width={g.width} borderStyle="round" borderColor={ORANGE} backgroundColor={CARD_BG} paddingX={1} gap="xs">
      {items.length ? [...items.slice(0, fit).map(line), didNotFit(c, 'did-not-fit', items.length - fit)] : [<Text key="empty" mono dimColor>nenhum PR aguardando</Text>]}
    </Box>,
    <Box key="footer-prs" flexDirection="row" justifyContent="flex-end" width={g.width}>
      <Button key="close-prs" plain onPress={c.actions.close}>
        <Text color={ORANGE} underline>
          ← voltar
        </Text>
      </Button>
    </Box>,
  ]
}

// --- Decisões: a linha "N decisões registradas", a faixa da retomada (P10) e a lista (P9) ---

/** O escopo das decisões na vista, ou o da largura: sessão no estreito, família no largo. */
export function decisionScopeOf(view: View, cols: number): DecisionScope {
  return view.decisionsScope ?? (grid(cols).perRow === 1 ? 'session' : 'family')
}

// No estreito, "· N a confirmar" não cabe ao lado do "Ver": desce para a linha de baixo.
/**
 * As decisões (pnDec do P1), com o rótulo de registro: "⊸ N decisões registradas" e "Ver", neutra,
 * depois dos cards. As a confirmar ficam numa faixa própria no topo. Sem nenhuma, "nenhuma decisão
 * registrada ainda", sem botão.
 */
function decisionsLine(c: DrawContext, p: Panel, width: number, narrow: boolean) {
  const d = p.decisions
  if (!d) return null
  const { Box, Text, Button } = c.el
  const none = d.current === 0
  return (
    <Box key="decisions" flexDirection="row" alignItems="center" gap={1} width={width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        {none ? (
          <Text mono dimColor wrap="wrap">
            ⊸ nenhuma decisão registrada ainda
          </Text>
        ) : (
          <Text mono wrap="wrap">
            <Text color={ORANGE}>⊸ </Text>
            <Text weight="bold">{decisionsText(d.current)}</Text>
            {narrow ? '' : ' nesta sessão'}
          </Text>
        )}
      </Box>
      {none ? null : <Button key="show-decisions" label="Ver" variant="secondary" onPress={c.actions.showDecisions} />}
    </Box>
  )
}

/** O texto da faixa de decisões, para a estimativa da altura. */
const decisionsLineText = (p: Panel, narrow: boolean) => {
  const d = p.decisions
  if (!d || d.current === 0) return '⊸ nenhuma decisão registrada ainda'
  return `⊸ ${decisionsText(d.current)}${narrow ? '' : ' nesta sessão'}`
}

/** As decisões a confirmar, no topo (pedem a atenção da pessoa): "⊸ N a confirmar" e "Ver". */
function toConfirmBanner(c: DrawContext, p: Panel, width: number) {
  const n = p.decisions?.toConfirm ?? 0
  if (!n) return null
  const { Box, Text, Button } = c.el
  return (
    <Box key="to-confirm" flexDirection="row" alignItems="center" gap={1} width={width} borderStyle="round" borderColor={YELLOW} backgroundColor={BADGE.yellow} paddingX={1}>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text mono weight="bold" color={YELLOW} wrap="wrap">
          ⊸ {n === 1 ? '1 decisão a confirmar' : `${n} decisões a confirmar`}
        </Text>
      </Box>
      <Button key="show-to-confirm" label="Ver" variant="primary" onPress={c.actions.showDecisions} />
    </Box>
  )
}

/** P10: depois de um /clear, quantas decisões da sessão anterior continuam valendo. Só com dado (#100). */
function resumeBanner(c: DrawContext, r: PanelResume | null | undefined, width: number, narrow: boolean) {
  if (!r || r.n <= 0) return null
  const { Box, Text, Button } = c.el
  const cost = r.tokens ? ` (~${tokens(r.tokens)} tokens)` : ''
  const from = r.from ? (
    <Text>
      Esta sessão continua a <Text weight="bold">{r.from}</Text> depois de um /clear.
    </Text>
  ) : (
    <Text>Esta sessão continua a anterior depois de um /clear.</Text>
  )
  return (
    <Box key="resume" flexDirection="column" width={width} borderStyle="round" borderColor={ORANGE} backgroundColor={BADGE.orange} paddingX={1}>
      <Text mono weight="bold" wrap="truncate-end">
        <Text color={ORANGE}>⊸ </Text>
        {plural(r.n, 'decisão', 'decisões')} da sessão anterior{narrow ? '' : r.n === 1 ? ' continua valendo' : ' continuam valendo'}
      </Text>
      <Text mono size="footnote" wrap="wrap">
        {from}
        {narrow ? '' : ` As decisões vigentes foram injetadas no início${cost}.`}
      </Text>
      <Box flexDirection="row" gap={1} alignItems="center">
        <Button key="show-resume" plain onPress={c.actions.showDecisions}>
          <Text mono size="footnote" color={ORANGE} underline>
            ver {r.n === 1 ? 'a decisão' : `as ${r.n}`}
          </Text>
        </Button>
        <Text mono size="footnote" dimColor>
          · desligar a injeção
        </Text>
      </Box>
    </Box>
  )
}

function decisionPill(c: DrawContext, d: PanelDecision) {
  const label = DECISION_STATES[d.state]
  if (d.state === 'to_confirm') return pill(c, 'state', label, YELLOW, BADGE.yellow, true)
  if (d.state === 'superseded') return pill(c, 'state', label, STATUS_COR.abandoned.dark.text, BADGE.gray)
  return pill(c, 'state', label, GREEN, BADGE.green)
}

function decisionCard(c: DrawContext, d: PanelDecision) {
  const { Box, Text, Button } = c.el
  const o = ORIGINS[d.origin]
  const suggested = d.state === 'to_confirm'
  const old = d.state === 'superseded'
  let action: RenderElement
  if (suggested) {
    action = (
      <Box flexDirection="row" gap={1}>
        <Button key={`confirm-${d.id}`} label="Confirmar" variant="primary" onPress={() => c.actions.confirm(d)} />
        <Button key={`dismiss-${d.id}`} label="Descartar" variant="secondary" onPress={() => c.actions.dismiss(d)} />
      </Box>
    )
  } else if (old) {
    action = (
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {d.supersededBy ? `substituída por ${d.supersededBy}` : 'substituída'}
      </Text>
    )
  } else {
    // "ver na conversa" só quando a mensagem ainda está na conversa; senão, o detalhe traz o trecho.
    action = (
      <Box flexDirection="row">
        {isReachable(c, d) ? (
          <Button key={`show-${d.id}`} plain onPress={() => c.actions.showInConversation(d)}>
            <Text mono size="footnote" color={ORANGE} underline>
              ver na conversa
            </Text>
          </Button>
        ) : (
          <Button key={`detail-${d.id}`} plain onPress={() => c.actions.openDecision(d)}>
            <Text mono size="footnote" color={ORANGE} underline>
              ver o trecho
            </Text>
          </Button>
        )}
      </Box>
    )
  }
  return cardBox(
    c,
    `decision-${d.id}`,
    [
      header(c, o.glyph, o.label, when(d.decidedAt, c.now)),
      // O título corta no card; clicar nele abre a decisão inteira.
      <Button key={`open-${d.id}`} plain onPress={() => c.actions.openDecision(d)}>
        <Text mono weight="bold" wrap="truncate-end" strikethrough={old} dimColor={old}>
          {d.title}
        </Text>
      </Button>,
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {rejectedText(d)}
      </Text>,
      <Box flexDirection="row" gap={1} alignItems="center">
        {decisionPill(c, d)}
        <Text mono size="footnote" dimColor={old} wrap="truncate-end">
          {whoDecided(d)}
        </Text>
      </Box>,
      action,
    ],
    suggested ? YELLOW : BORDER,
    suggested ? BADGE.yellow : CARD_BG,
  )
}

function decisionsScreen(c: DrawContext, p: Panel, g: ReturnType<typeof grid>, narrow: boolean) {
  const { Box, Text, Button, Select } = c.el
  const scope = decisionScopeOf(c.view, c.cols)
  const list = p.decisions?.list?.scope === scope ? p.decisions.list : null
  const byScope = list?.byScope ?? null
  // Os três escopos com as mesmas decisões (todas desta sessão): a troca funciona, mas não muda nada.
  const same = !!byScope && byScope.session === byScope.family && byScope.family === byScope.branch
  const select = (
    <Select
      key="decisions-scope"
      value={scope}
      // Grafia normal, com a contagem de cada escopo quando o núcleo a manda: "Sessão 10".
      options={SCOPES.map((e) => ({ value: e.value, label: byScope ? `${e.label} ${byScope[e.value]}` : e.label }))}
      onSelect={(v: string) => c.actions.decisionsScope(v)}
    />
  )
  const current = list?.current ?? (scope === 'family' ? (p.decisions?.current ?? 0) : null)
  const title = `DECISÕES${current === null ? '' : ` · ${current} ${current === 1 ? 'VIGENTE' : 'VIGENTES'}`}`
  const items = list?.items ?? []
  // Em volta: respiro, topo, voltar, rótulo, a barra do Desfazer, o rodapé com borda, versão e os espaços.
  const bar = c.view.lastAction && c.now - c.view.lastAction.at <= UNDO_MS ? 4 : 0
  const fit = rowsThatFit(free(c, 2 + 4 + 1 + 1 + bar + 3 + 1 + 5 + (same ? 2 : 0))) * g.perRow
  const shown = items.slice(0, Math.min(fit, narrow ? DECISIONS_WHEN_NARROW : items.length))
  const outside = items.length - shown.length
  let inner: RenderElement[]
  if (!p.decisions) inner = [<Text key="none" mono dimColor>o núcleo não trouxe as decisões</Text>]
  else if (!list) inner = [<Text key="reading" mono dimColor>lendo as decisões…</Text>]
  else if (!items.length) inner = [<Text key="empty" mono dimColor>nenhuma decisão {scope === 'session' ? 'nesta sessão' : scope === 'family' ? 'na família' : 'neste branch'}</Text>]
  else inner = shown.map((d) => decisionCard(c, d))
  const close = (
    <Button key="close-decisions" plain onPress={c.actions.close}>
      <Text color={ORANGE} underline>
        ← voltar
      </Text>
    </Button>
  )
  const footer = narrow ? (
    <Text mono wrap="truncate-end">{outside > 0 ? `+${outside} · troque o escopo` : 'mais recentes primeiro'}</Text>
  ) : (
    <Text mono wrap="truncate-end">
      escopo:{' '}
      {SCOPES.map((e, i) => (
        <Text key={`scope-${e.value}`} color={e.value === scope ? ORANGE : undefined} weight={e.value === scope ? 'bold' : 'regular'}>
          {i ? ' · ' : ''}
          {e.label}
        </Text>
      ))}
      {' · mais recentes primeiro'}
    </Text>
  )
  return [
    sectionLabel(c, g.width, title, select),
    same ? (
      <Text key="same-scopes" mono size="footnote" dimColor wrap="wrap">
        mesmo resultado em Sessão, Família e Branch: as decisões são todas desta sessão
      </Text>
    ) : null,
    undoBar(c, g.width),
    <Box key="list-decisions" flexDirection="row" flexWrap="wrap" columnGap={GAP} rowGap={1} width={g.width}>
      {inner}
    </Box>,
    narrow ? null : didNotFit(c, 'did-not-fit', outside),
    <Box key="footer-decisions" flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} width={g.width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1}>
      <Box flexDirection="row" flexShrink={1} minWidth={0}>
        {footer}
      </Box>
      {close}
    </Box>,
  ]
}

/** "D4 descartada · Desfazer", por alguns segundos depois de Confirmar, Descartar ou Ajustar. */
function undoBar(c: DrawContext, width: number) {
  const u = c.view.lastAction
  if (!u || c.now - u.at > UNDO_MS) return null
  const { Box, Text, Button } = c.el
  return (
    <Box key="undo-bar" flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} width={width} borderStyle="round" borderColor={ORANGE} backgroundColor={BADGE.orange} paddingX={1}>
      <Text mono wrap="truncate-end">
        {u.label} {UNDO[u.action].done}
      </Text>
      <Button key="undo-last" label="Desfazer" variant="secondary" onPress={() => c.actions.undo(u.id, u.label)} />
    </Box>
  )
}

/** Um bloco do detalhe: o rótulo em versalete e o texto inteiro, quebrando linha. */
function detailBlock(c: DrawContext, key: string, label: string, text: string, color?: string) {
  const { Box, Text } = c.el
  return (
    <Box key={key} flexDirection="column">
      <Text mono size="caption" weight="semibold" dimColor>
        {label}
      </Text>
      <Text mono wrap="wrap" color={color}>
        {text}
      </Text>
    </Box>
  )
}

/** A mensagem da decisão ainda está na conversa desta sessão? (Sai dela numa compactação.) */
const isReachable = (c: DrawContext, d: PanelDecision) => d.session === 'this' && !!d.toolUseId && (c.view.reachable ?? []).includes(d.toolUseId)

/**
 * O trecho original da decisão, quando a mensagem não está mais na conversa (antes de uma
 * compactação, ou de outra sessão): quem disse, quando e o texto. Sem aviso de erro.
 */
function originalExcerpt(c: DrawContext, d: PanelDecision) {
  const { Box, Text } = c.el
  const who = d.decidedBy === 'agent' ? 'o agente' : 'você'
  const where = d.session === 'this' ? 'nesta sessão, antes de uma compactação' : d.session === 'parent' ? 'na sessão mãe' : 'em outra sessão'
  return (
    <Box key="excerpt" flexDirection="column">
      <Text mono size="caption" weight="semibold" dimColor>
        TRECHO ORIGINAL
      </Text>
      <Text mono size="footnote" dimColor wrap="wrap">
        {who}, {dateTime(d.decidedAt)}, {where}:
      </Text>
      <Text mono wrap="wrap">“{d.text ?? d.title}”</Text>
    </Box>
  )
}

/** A decisão inteira: escolha, o que foi descartado, contexto, quem, quando, origem e as ações. */
function decisionScreen(c: DrawContext, g: ReturnType<typeof grid>) {
  const { Box, Text, Button, Input } = c.el
  const d = c.view.decision
  if (!d) return [<Text key="no-decision" mono dimColor>nenhuma decisão aberta</Text>]
  const o = ORIGINS[d.origin]
  const suggested = d.state === 'to_confirm'
  const actions: RenderElement[] = []
  if (suggested) {
    actions.push(
      <Button key={`confirm-${d.id}`} label="Confirmar" variant="primary" onPress={() => c.actions.confirm(d)} />,
      <Button key={`dismiss-${d.id}`} label="Descartar" variant="secondary" onPress={() => c.actions.dismiss(d)} />,
    )
  }
  if ((suggested || d.state === 'current') && !c.view.adjusting) {
    actions.push(<Button key={`adjust-${d.id}`} label="Ajustar" variant="secondary" onPress={() => c.actions.adjust(true)} />)
  }
  if (d.undo) {
    actions.push(<Button key={`undo-${d.id}`} label={`Desfazer: ${UNDO[d.undo].revert}`} variant="secondary" onPress={() => c.actions.undo(d.id, d.label)} />)
  }
  if (isReachable(c, d)) {
    actions.push(
      <Button key={`conversation-${d.id}`} plain onPress={() => c.actions.showInConversation(d)}>
        <Text mono size="footnote" color={ORANGE} underline>
          ver na conversa
        </Text>
      </Button>,
    )
  }
  return [
    sectionLabel(c, g.width, `DECISÃO ${d.label}`, decisionPill(c, d)),
    undoBar(c, g.width),
    <Box key="decision-detail" flexDirection="column" width={g.width} borderStyle="round" borderColor={suggested ? YELLOW : BORDER} backgroundColor={suggested ? BADGE.yellow : CARD_BG} paddingX={1} gap="xs">
      <Text mono size="caption" weight="semibold" dimColor wrap="wrap">
        {o.glyph} {o.label.toUpperCase()} · {whoDecided(d)} · {dateTime(d.decidedAt)}
      </Text>
      {detailBlock(c, 'decided', 'DECIDIDO', d.text ?? d.title)}
      {d.context ? detailBlock(c, 'context', 'CONTEXTO', d.context) : null}
      {d.rejected.length ? detailBlock(c, 'rejected', 'NÃO', d.rejected.join('\n')) : null}
      {d.supersededBy ? detailBlock(c, 'superseded', 'SUBSTITUÍDA POR', d.supersededBy) : null}
      {isReachable(c, d) ? null : originalExcerpt(c, d)}
      {c.view.adjusting ? (
        <Box key="adjustment" flexDirection="column" gap="xs">
          <Input key="adjustment-text" autoFocus placeholder="a versão certa, ou um comentário" submitLabel="gravar" onSubmit={(v: string) => c.actions.sendAdjustment(d, v)} />
          <Button key="cancel-adjustment" plain onPress={() => c.actions.adjust(false)}>
            <Text mono size="footnote" dimColor underline>
              cancelar
            </Text>
          </Button>
        </Box>
      ) : null}
      <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
        {actions}
      </Box>
    </Box>,
    <Box key="footer-decision" flexDirection="row" justifyContent="flex-end" width={g.width}>
      <Button key="close-decision" plain onPress={c.actions.backToDecisions}>
        <Text color={ORANGE} underline>
          ← voltar
        </Text>
      </Button>
    </Box>,
  ]
}

// --- P7: a lista de quem precisa de você ---

function needsYouCard(c: DrawContext, i: NeedsYou) {
  const { Box, Text, Button, Link } = c.el
  const error = i.state === 'error'
  // A sua vez em cor neutra (#140): sem o amarelo de quem está bloqueada.
  const neutral = { color: GRAY, background: CARD_BG, border: BORDER }
  const color = !needs(i) ? neutral : error ? STATUS_COLOR.error : STATUS_COLOR.waiting
  const relation = i.relation === 'parent' ? 'mãe desta' : i.relation === 'child' ? 'filha desta' : i.relation === 'sibling' ? 'irmã desta' : i.sameProject ? 'mesmo projeto' : 'outro projeto'
  return cardBox(
    c,
    `needs-${i.id}`,
    [
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        {sessionUrl(c, i.local) ? (
          <Box flexDirection="row" flexShrink={1} minWidth={0}>
            <Text mono color={color.border}>● </Text>
            {sessionName(c, `name-${i.id}`, i.title, i.local, 22)}
          </Box>
        ) : (
          <Text mono weight="bold" wrap="truncate-end">
            <Text color={color.border}>● </Text>
            {i.title}
          </Text>
        )}
        <Text mono size="caption" dimColor>
          {since(i.since, c.now)}
        </Text>
      </Box>,
      <Box flexDirection="row" gap={1} alignItems="center">
        {!needs(i)
          ? pill(c, 'mt', `↵ ${whyOf(i)}`, GRAY, BADGE.gray)
          : error
            ? statusPill(c, 'st', 'error')
            : i.why
              ? pill(c, 'mt', whyOf(i), YELLOW, BADGE.yellow, true)
              : i.reason
                ? reasonPill(c, 'mt', i.reason)
                : null}
        {i.urgent && (
          <Text mono size="caption" dimColor>
            urgente
          </Text>
        )}
      </Box>,
      <Text mono size="footnote" wrap="truncate-end" color={error ? RED_TEXT : undefined}>
        {stripMarkdown(i.text)}
      </Text>,
      <Text mono size="footnote" dimColor wrap="truncate-end">
        {relation} · {model(i.model)}
        {i.account ? <Text color={accountColor(i.account)}> · ◆ {accountLabel(i.account.label)}</Text> : null}
      </Text>,
      <Box flexDirection="row">
        {opensDirectly(c, i.local) ? (
          <Button key={`go-${i.id}`} label="Ir para a sessão" variant="secondary" onPress={() => c.actions.openSession(i.local!, i.title)} />
        ) : sessionUrl(c, i.local) ? (
          <Link key={`go-${i.id}`} href={sessionUrl(c, i.local)!} label="Ir para a sessão" />
        ) : (
          <Button key={`go-${i.id}`} label="Ir para a sessão" variant="secondary" onPress={() => c.actions.goTo(i)} />
        )}
      </Box>,
    ],
    color.border,
    color.background,
  )
}

function needYouScreen(c: DrawContext, p: Panel, g: ReturnType<typeof grid>, narrow: boolean) {
  const { Box, Text, Button, Select } = c.el
  const scope = c.view.scope ?? (narrow && p.needYou.family.length ? 'family' : 'machine')
  const items = scope === 'family' ? p.needYou.family : p.needYou.machine
  // #140: quem precisa de você primeiro, com destaque; a sua vez depois, neutra, num grupo à parte.
  const ofLevel = items.filter(needs)
  const onTurn = items.filter((i) => !needs(i))
  // Em volta: respiro, topo, voltar, rótulo, o rótulo da sua vez, rodapé com borda, versão, o "+N" e os espaços.
  const fit = rowsThatFit(free(c, 2 + 4 + 1 + 1 + (onTurn.length ? 2 : 0) + 3 + 1 + 2 + 5)) * g.perRow
  const shown = [...ofLevel, ...onTurn].slice(0, fit)
  const showNeeds = shown.filter(needs)
  const showYourTurn = shown.filter((i) => !needs(i))
  const select = (
    <Select
      key="scope"
      value={scope}
      options={[
        { value: 'family', label: 'Família' },
        { value: 'machine', label: 'Máquina inteira' },
      ]}
      onSelect={(v: string) => c.actions.scope(v)}
    />
  )
  return [
    sectionLabel(c, g.width, `PRECISAM DE VOCÊ · ${ofLevel.length}`, select),
    <Box key="list" flexDirection="row" flexWrap="wrap" gap={GAP} width={g.width}>
      {ofLevel.length ? showNeeds.map((i) => needsYouCard(c, i)) : [<Text key="empty" mono dimColor>ninguém {scope === 'family' ? 'da família' : ''} precisa de você agora</Text>]}
    </Box>,
    showYourTurn.length ? (
      <Text key="label-your-turn" mono size="caption" weight="semibold" dimColor>
        SUA VEZ · {onTurn.length} · sem pendência, só a vez de responder
      </Text>
    ) : null,
    showYourTurn.length ? (
      <Box key="list-your-turn" flexDirection="row" flexWrap="wrap" gap={GAP} width={g.width}>
        {showYourTurn.map((i) => needsYouCard(c, i))}
      </Box>
    ) : null,
    didNotFit(c, 'did-not-fit', items.length - shown.length),
    <Box key="footer-need-you" flexDirection="row" justifyContent="space-between" alignItems="center" width={g.width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1}>
      <Text mono wrap="truncate-end">urgentes primeiro{narrow ? '' : ' · esperando e com erro'}</Text>
      <Button key="close-need-you" plain onPress={c.actions.close}>
        <Text color={ORANGE} underline>
          ← voltar
        </Text>
      </Button>
    </Box>,
  ]
}

// --- Os planos da sessão (issue #131) ---

function plansScreen(c: DrawContext, p: Panel, g: ReturnType<typeof grid>, narrow: boolean) {
  const { Box, Text, Button } = c.el
  const plans = p.plans ?? []
  const account = (r: SessionPlan['outcome']) => plans.filter((x) => x.outcome === r).length
  // Em volta: respiro, topo, voltar, rótulo, borda da caixa, rodapé com borda, versão e os espaços.
  const usable = g.width - 4 - TIME_W - 1
  // O plano atual, passo a passo, em cima: o que o card do P1 resume no anel e nas três linhas.
  const steps = p.plan?.steps ?? []
  const aroundSteps = steps.length ? 1 + 2 + 1 + steps.length : 0
  const fit = howManyFit(plans.map((x) => (narrow ? 1 : textLines(`● ${x.summary} · ${x.done}/${x.total}${x.current ? ` · ${x.current}` : ''}`, usable))), free(c, 2 + 4 + 1 + 1 + 2 + 3 + 1 + 5 + aroundSteps))
  const mark = (e: PanelStep['state']) => (e === 'completed' ? { g: '✓', color: GREEN } : e === 'in_progress' ? { g: '●', color: ORANGE } : { g: '○', color: undefined })
  return [
    steps.length ? (
      <Box key="steps-of-plan" flexDirection="column" width={g.width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1}>
        {header(c, '☰', 'PLANO ATUAL', `${p.plan!.done}/${p.plan!.total}`, { color: ORANGE })}
        {steps.map((x) => (
          <Text key={`step-${x.id}`} mono size="footnote" wrap="wrap" dimColor={x.state === 'pending'}>
            <Text color={mark(x.state).color}>{mark(x.state).g} </Text>
            <Text weight={x.state === 'in_progress' ? 'bold' : undefined}>{textWithPrs(c, x.state === 'in_progress' ? (x.activeText ?? x.text) : x.text)}</Text>
          </Text>
        ))}
      </Box>
    ) : null,
    sectionLabel(c, g.width, `PLANOS DA SESSÃO · ${plans.length}`, chip(c, 'chip-plans', `${account('completed')} ✓ · ${account('abandoned')} ◐`)),
    <Box key="list-plans" flexDirection="column" width={g.width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1} gap="xs">
      {plans.length ? [...plans.slice(0, fit).map((x) => planLine(c, x, !narrow)), didNotFit(c, 'did-not-fit', plans.length - fit)] : [<Text key="empty" mono dimColor>sem plano nesta sessão</Text>]}
    </Box>,
    <Box key="footer-plans" flexDirection="row" justifyContent="space-between" alignItems="center" width={g.width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1}>
      <Text mono wrap="truncate-end">mais recente primeiro{narrow ? '' : ' · ✓ concluído · ◐ abandonado'}</Text>
      <Button key="close-plans" plain onPress={c.actions.close}>
        <Text color={ORANGE} underline>
          ← voltar
        </Text>
      </Button>
    </Box>,
  ]
}

// --- P8: sem conexão ---

function offlineScreen(c: DrawContext, g: ReturnType<typeof grid>, narrow: boolean) {
  const { Box, Text, Button, Link, Svg } = c.el
  const readAt = c.reading.readAt
  return [
    <Box key="offline" flexDirection="column" alignItems="center" width={g.width} borderStyle="round" borderColor={RED} backgroundColor={BADGE.red} paddingX={2} paddingY={1} gap="xs">
      <Svg source={offlineSvg()} alt="sem conexão" width={24} height={24} />
      <Text mono weight="bold">Sem conexão com o núcleo</Text>
      <Text mono size="footnote" wrap="wrap">
        {c.core} não respondeu. {readAt ? `Mostrando a última leitura, de ${clockTime(readAt)}.` : 'Ainda não houve leitura.'}
      </Text>
      {!narrow && (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Button key="retry" label="Tentar de novo" variant="primary" onPress={c.actions.retry} />
          <Link href={HOW_TO_START} label="como iniciar o núcleo" />
        </Box>
      )}
    </Box>,
    <Box key="no-data" flexDirection="row" width={g.width} borderStyle="round" borderColor={BORDER} backgroundColor={CARD_BG} paddingX={1}>
      <Text mono dimColor>
        ○ sem dados de outras sessões
      </Text>
    </Box>,
  ]
}

/** "← voltar" no topo de toda tela que toma o lugar da sessão; o botão de baixo diz o mesmo. */
function backLink(c: DrawContext, width: number, onBack: () => void = c.actions.close, key = 'back-session') {
  const { Box, Button, Text } = c.el
  return (
    <Box key="back" flexDirection="row" width={width}>
      <Button key={key} plain onPress={onBack}>
        <Text mono color={ORANGE} underline>
          ← voltar
        </Text>
      </Button>
    </Box>
  )
}

/**
 * As linhas do painel fora da grade de cards: o respiro, o topo, o rótulo, as faixas, as linhas
 * de decisões e de "precisam de você", o rodapé e o espaço entre eles.
 */
/** Uma faixa de uma linha com borda e um botão, no desktop. */
const LOOSE_LINE = 2

function linesOutsideGrid(p: Panel, g: ReturnType<typeof grid>, narrow: boolean, compact: View['compact'] = null): number {
  const usable = g.width - 4
  // No desktop a borda é um traço fino, não uma linha: o topo (logo e duas linhas de texto) ocupa
  // 3, e cada faixa de uma linha com borda (decisões, precisam, PRs) ocupa 2, com o botão.
  // O topo ocupa 3; o rótulo da seção, 1 (o chip não tem borda).
  const parts = [3, 1]
  if (compact === 'confirm') parts.push(4)
  const r = p.decisions?.resume
  if (r && r.n > 0) parts.push(2 + 1 + (narrow ? 3 : 2) + 1)
  const f = p.session?.banner
  if (f) parts.push(2 + 1 + (narrow ? textLines(truncate(f.text, 64), usable) : 1) + 1)
  parts.push(0) // a grade
  if (p.decisions) parts.push(LOOSE_LINE - 1 + textLines(decisionsLineText(p, narrow), usable - SEE_BUTTON))
  if (p.decisions?.toConfirm) parts.push(LOOSE_LINE)
  parts.push(needYouLines(p, usable, narrow))
  if ((p.prs?.total ?? 0) > 0) parts.push(LOOSE_LINE - 1 + textLines(prsText(p.prs!.total, narrow), usable - SEE_BUTTON))
  parts.push(footerLines(p))
  return 2 * SPACE + parts.reduce((a, b) => a + b, 0) + (parts.length - 1) * SPACE
}

/** Os cards da grade, na ordem do P1. */
const GRID_CARDS = ['session', 'context', 'work', 'plan', 'subagents', 'children'] as const

/**
 * A altura estimada da visão da sessão, em linhas: o que fica fora da grade e a grade, com os seis
 * cards sempre inteiros (P1). Quando o pane é mais baixo que isso, o corpo dele rola. Para os testes.
 */
export function viewLines(c: DrawContext, p: Panel): number {
  const g = grid(c.cols)
  const narrow = g.perRow === 1
  const inside = GRID_CARDS.filter((id) => id !== 'session' || p.session)
  return linesOutsideGrid(p, g, narrow, c.view?.compact) + questionLines(c, g.width) + gridHeight(inside.map(() => CARD_LINES), g.perRow)
}

/**
 * O painel inteiro, no desktop, encaixado (0.0.32): o desenho é gravado como dados, todo texto de
 * uma linha que passa das colunas que tem é encurtado pelo próprio mod (hooks/fit.ts), e só então
 * vira os elementos da superfície. O Desktop deixou de encurtar o `wrap="truncate-end"`.
 */
export function draw(c: DrawContext): RenderElement {
  const record = Object.fromEntries(Object.keys(c.el).map((t) => [t, (props: Record<string, unknown>) => ({ t, props })])) as unknown as Elements
  const tree = drawTree({ ...c, el: record }) as unknown as Node
  const rebuild = (n: Node, children: (Node | string)[]): Node => ({ t: n.t, props: { ...n.props, children } })
  const toElement = (n: Node | string): unknown => {
    if (typeof n === 'string') return n
    const { children: _, ...props } = (n.props ?? {}) as Record<string, unknown>
    return h(c.el[n.t as keyof Elements] as never, props, ...kids(n).map(toElement))
  }
  return toElement(fit(tree, c.cols, rebuild)) as RenderElement
}

function drawTree(c: DrawContext): RenderElement {
  const { Box } = c.el
  const g = grid(c.cols)
  const narrow = g.perRow === 1
  const p = c.reading.panel
  const offline = c.reading.offline
  const s = p?.session ?? null

  let body: (RenderElement | null)[]
  if (offline || !p) {
    body = [
      sectionLabel(c, g.width, 'ESTA SESSÃO', chip(c, 'chip', offline ? 'nova tentativa a cada 5 s' : 'lendo…')),
      ...(offline ? offlineScreen(c, g, narrow) : []),
    ]
  } else if (c.view.screen === 'need-you') {
    body = [backLink(c, g.width), ...needYouScreen(c, p, g, narrow)]
  } else if (c.view.screen === 'decisions') {
    body = [backLink(c, g.width), ...decisionsScreen(c, p, g, narrow)]
  } else if (c.view.screen === 'plans') {
    body = [backLink(c, g.width), ...plansScreen(c, p, g, narrow)]
  } else if (c.view.screen === 'decision') {
    body = [backLink(c, g.width, c.actions.backToDecisions, 'back-decisions'), ...decisionScreen(c, g)]
  } else if (c.view.screen === 'prs') {
    body = [backLink(c, g.width), ...prsScreen(c, p, g)]
  } else if (c.view.screen === 'subagents') {
    body = [backLink(c, g.width), ...graphScreen(c, p, g, narrow)]
  } else if (c.view.screen === 'children') {
    body = [backLink(c, g.width), ...childrenScreen(c, p, g)]
  } else {
    // Os seis cards do P1, sempre inteiros e no lugar deles.
    const cards = [
      s ? sessionCard(c, s) : null,
      contextCard(c, p),
      workCard(c, p.work),
      planCard(c, p.plan, p.plans ?? []),
      subagentsCard(c, p.subagents),
      childrenCard(c, p.children),
    ].filter((x): x is RenderElement => x !== null)
    body = [
      sectionLabel(c, g.width, 'ESTA SESSÃO', sectionChip(c, g.width, narrow, s?.account), s?.account),
      // Decisão do Fernando (desvio aprovado do P1): o que pede a atenção dele sobe para o topo,
      // antes dos cards: a pergunta, quem precisa de você, os PRs e as decisões a confirmar. Com a
      // rolagem, no fim do painel, elas saíam de vista.
      questionBanner(c, g.width),
      p.needYou.total > 0 ? needYouLine(c, p, g.width, narrow) : null,
      prsLine(c, p, g.width, narrow),
      toConfirmBanner(c, p, g.width),
      resumeBanner(c, p.decisions?.resume, g.width, narrow),
      s ? banner(c, s, g.width, narrow) : null,
      compactBanner(c, g.width),
      <Box key="cards" flexDirection="row" flexWrap="wrap" columnGap={GAP} rowGap={1} width={g.width}>
        {cards}
      </Box>,
      // Embaixo, só o que é informativo e neutro.
      decisionsLine(c, p, g.width, narrow),
      p.needYou.total > 0 ? null : needYouLine(c, p, g.width, narrow),
    ]
  }

  return (
    <Box flexDirection="column" alignItems="center" gap={1} paddingY={1} minWidth={0}>
      {top(c, g.width)}
      {body.filter((x): x is RenderElement => x !== null)}
      {footer(c, g.width)}
    </Box>
  )
}

/** A pasta da API mudou desde que ela subiu: o código no ar é outro. */
const folderChanged = (p: Panel | null) => !!p?.api?.folder && !!p.api.commit && p.api.folder !== p.api.commit

/** Linhas do rodapé: a versão e, quando a pasta mudou, o aviso para reiniciar a API. */
const footerLines = (p: Panel | null) => (folderChanged(p) ? 2 : 1)

/**
 * "plugin 0.0.8 · api 0.0.1 (1f9de92)": para saber que o painel e a API são os da mesma versão. O
 * commit é o do código que a API carregou; se a pasta já está em outro, o rodapé pede para reiniciar.
 */
function footer(c: DrawContext, width: number) {
  const { Box, Text } = c.el
  const p = c.reading.panel
  const api = p?.api
  return (
    <Box key="footer-version" flexDirection="column" alignItems="center" width={width}>
      <Text mono size="caption" dimColor wrap="truncate-end">
        plugin {PLUGIN_VERSION} · api {api ? `${api.version}${api.commit ? ` (${api.commit})` : ''}` : '—'}
      </Text>
      {folderChanged(p) ? (
        <Text mono size="caption" color={YELLOW} wrap="truncate-end">
          pasta em {api!.folder}: reinicie a API
        </Text>
      ) : null}
    </Box>
  )
}
