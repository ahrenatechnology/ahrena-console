// Formatação do painel: tempo, modelo, tokens, custo e os glifos de status. Funções puras.

import type { AwaitingReason, PanelDecision, DisplayStatus, DecisionScope, InboxState, Panel, PanelSession } from '../types'

/** "agora", "40 s", "12 min", "4 h", "2 d". */
/**
 * Sem segundos: um contador que anda a cada tick redesenha o painel a cada tick, e cada redesenho
 * troca os handles dos botões (o clique duplo). O tempo muda no máximo uma vez por minuto.
 */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return '< 1 min'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} d`
}

export const since = (iso: string | null, now: number) => (iso ? duration(now - Date.parse(iso)) : '')

/** "há 4 min"; menos de um minuto fica "agora". */
export function ago(iso: string, now: number): string {
  const d = since(iso, now)
  return d === '< 1 min' ? 'agora' : `há ${d}`
}

/** `claude-opus-5-5` → "Opus 5.5"; `claude-sonnet-4-6[1m]` → "Sonnet 4.6 1M". */
export function model(id: string | null): string {
  if (!id) return 'modelo ?'
  const long = /\[1m\]/i.test(id)
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/i.exec(id)
  if (!m) return id.replace(/\[1m\]/i, '')
  const name = m[1]![0]!.toUpperCase() + m[1]!.slice(1)
  return `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}${long ? ' 1M' : ''}`
}

/** 1234 → "1,2k"; 84000 → "84k"; 1200000 → "1,2M". */
export function tokens(n: number): string {
  const comma = (v: number) => v.toFixed(1).replace('.', ',').replace(/,0$/, '')
  if (n >= 1_000_000) return `${n >= 10_000_000 ? Math.round(n / 1_000_000) : (n / 1_000_000).toFixed(1).replace('.', ',')}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${comma(n / 1000)}k`
  return String(n)
}

export const usd = (v: number | null) => (v === null ? 'sem preço' : `~US$ ${v.toFixed(2).replace('.', ',')}`)

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s)

/** "há 6 min"; de outro dia, "ontem" ou "há 3 d". */
export function when(iso: string, now: number): string {
  const ms = now - Date.parse(iso)
  if (ms < 12 * 3600_000) return ago(iso, now)
  const day = (t: number) => new Date(t).toDateString()
  if (day(Date.parse(iso)) === day(now)) return ago(iso, now)
  if (day(Date.parse(iso)) === day(now - 24 * 3600_000)) return 'ontem'
  return ago(iso, now)
}

/** "22:41", no fuso de quem olha. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const REASONS: Record<AwaitingReason, { glyph: string; label: string; urgent: boolean }> = {
  notification: { glyph: '⛉', label: 'Pede permissão', urgent: true },
  interrupted: { glyph: '⏸', label: 'Interrompida', urgent: true },
  stop: { glyph: '↵', label: 'Sua vez', urgent: false },
  session_start: { glyph: '›_', label: 'No prompt', urgent: false },
}

/** Os 5 status do console (docs/brand/tokens.json): o rótulo e o glifo de cada um. */
export const STATUS: Record<DisplayStatus, { glyph: string; label: string }> = {
  active: { glyph: '●', label: 'Ativa' },
  waiting: { glyph: '◐', label: 'Esperando você' },
  completed: { glyph: '✓', label: 'Concluída' },
  error: { glyph: '✕', label: 'Com erro' },
  abandoned: { glyph: '○', label: 'Abandonada' },
}

/** O status que as pílulas mostram: delegando e background são "Ativa". */
export function statusOf(state: InboxState | 'unknown'): DisplayStatus {
  if (state === 'delegating' || state === 'background') return 'active'
  if (state === 'unknown') return 'abandoned'
  return state
}

export const needYouText = (n: number) => (n === 1 ? '1 precisa de você' : `${n} precisam de você`)

/** A linha de status da sessão: "ahrena-console ● Ativa · 2 precisam de você". */
export function statusLine(p: Panel | null, offline: boolean): string {
  if (offline || !p) return 'ahrena-console ○ offline'
  const s: PanelSession | null = p.session
  const n = p.needYou.total
  const outside = n ? needYouText(n) : 'ninguém mais'
  const d = p.decisions
  const dec = d?.resume ? ` · ${d.resume.n} decisões herdadas` : d?.current ? ` · ${d.current === 1 ? '1 decisão' : `${d.current} decisões`}` : ''
  if (!s) return `ahrena-console ◐ No prompt${dec} · ${outside}`
  const st = STATUS[statusOf(s.state)]
  const label = s.status === 'waiting' && s.reason === 'session_start' ? 'No prompt' : st.label
  const extra = s.state === 'delegating' ? ' · delegando' : ''
  return `ahrena-console ${st.glyph} ${label}${extra}${dec} · ${outside}`
}

/** A origem de uma decisão: o glifo e o rótulo do card (P9). */
export const ORIGINS: Record<PanelDecision['origin'], { glyph: string; label: string }> = {
  suggested: { glyph: '✲', label: 'SUGERIDA' },
  correction: { glyph: '↳', label: 'CORREÇÃO SUA' },
  permission: { glyph: '⛉', label: 'PERMISSÃO' },
  question: { glyph: '?', label: 'PERGUNTA' },
  plan: { glyph: '☰', label: 'PLANO' },
}

export const DECISION_STATES: Record<PanelDecision['state'], string> = {
  current: 'Vigente',
  superseded: 'Substituída',
  to_confirm: 'A confirmar',
  dismissed: 'Descartada',
}

export const SCOPES: { value: DecisionScope; label: string }[] = [
  { value: 'session', label: 'Sessão' },
  { value: 'family', label: 'Família' },
  { value: 'branch', label: 'Branch' },
]

/** Quem decidiu: "você corrigiu", "agente propôs", "você · sessão mãe". */
export function whoDecided(d: PanelDecision): string {
  const who =
    d.state === 'to_confirm'
      ? 'agente propôs'
      : d.origin === 'suggested'
        ? d.confirmedAt ? 'você confirmou' : 'agente'
        : d.decidedBy === 'agent'
          ? 'agente'
          : d.origin === 'correction'
            ? 'você corrigiu'
            : d.origin === 'plan'
              ? 'você aprovou'
              : 'você'
  const from = d.session === 'parent' ? ' · sessão mãe' : d.session === 'family' ? ' · outra sessão' : d.session === 'branch' ? ' · pelo branch' : ''
  return who + from
}

/** "não: 20 por coluna; rolagem infinita". */
export const rejectedText = (d: PanelDecision) => `não: ${d.rejected.length ? d.rejected.join('; ') : '—'}`

/** As decisões são registro do que já se decidiu, não pendência (0.0.13): "10 decisões registradas". */
export const decisionsText = (n: number) => (n === 1 ? '1 decisão registrada' : `${n} decisões registradas`)

/** O que o "Desfazer" volta, dito para a pessoa. */
export const UNDO: Record<'confirm' | 'dismiss' | 'adjust', { done: string; revert: string }> = {
  confirm: { done: 'confirmada', revert: 'voltar a "a confirmar"' },
  dismiss: { done: 'descartada', revert: 'voltar a "a confirmar"' },
  adjust: { done: 'ajustada', revert: 'tirar o ajuste' },
}

/** Quanto tempo o "Desfazer" fica à vista depois de Confirmar, Descartar ou Ajustar. */
export const UNDO_MS = 10_000

/** "19/10 22:41", no fuso de quem olha. */
export function dateTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${clockTime(d.getTime())}`
}

/**
 * O rótulo da conta, sem e-mail (decisão 0006): a org pessoal do Claude ("<e-mail>'s Organization")
 * vira "conta pessoal", e um rótulo com e-mail vira "conta". O núcleo já manda assim; isto cobre o
 * núcleo antigo.
 */
export function accountLabel(label: string): string {
  if (/^\S+@\S+'s Organization$/i.test(label.trim())) return 'conta pessoal'
  return label.includes('@') ? 'conta' : label
}

/**
 * A mensagem do agente como texto, sem o markdown cru: o link vira só o texto (também o que veio
 * cortado no meio, "[#131](#local_…"), e saem os `**`, `__`, as crases e o "#" de título.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]\n]*)\]\([^)\s]*\)?/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
}

/** #145: o que o painel manda à sessão para desarquivar uma filha (ela chama `unarchive_session`). */
export const unarchiveRequest = (f: { title: string; local?: string | null }) => `Desarquive a sessão ${f.title} (${f.local}) com unarchive_session.`
