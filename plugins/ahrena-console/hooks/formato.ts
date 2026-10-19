// Formatação do painel: tempo, modelo, tokens, custo e os glifos de status. Funções puras.

import type { AwaitingReason, DecisaoDoPainel, DisplayStatus, EscopoDasDecisoes, EstadoDoInbox, Painel, SessaoDoPainel } from '../types'

/** "agora", "40 s", "12 min", "4 h", "2 d". */
export function duracao(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 10) return 'agora'
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} d`
}

export const desde = (iso: string | null, agora: number) => (iso ? duracao(agora - Date.parse(iso)) : '')

/** "há 4 min"; "agora" fica "agora". */
export function ha(iso: string, agora: number): string {
  const d = desde(iso, agora)
  return d === 'agora' ? d : `há ${d}`
}

/** `claude-opus-5-5` → "Opus 5.5"; `claude-sonnet-4-6[1m]` → "Sonnet 4.6 1M". */
export function modelo(id: string | null): string {
  if (!id) return 'modelo ?'
  const longo = /\[1m\]/i.test(id)
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/i.exec(id)
  if (!m) return id.replace(/\[1m\]/i, '')
  const nome = m[1]![0]!.toUpperCase() + m[1]!.slice(1)
  return `${nome} ${m[2]}${m[3] ? `.${m[3]}` : ''}${longo ? ' 1M' : ''}`
}

/** 1234 → "1,2k"; 84000 → "84k"; 1200000 → "1,2M". */
export function tokens(n: number): string {
  const virgula = (v: number) => v.toFixed(1).replace('.', ',').replace(/,0$/, '')
  if (n >= 1_000_000) return `${n >= 10_000_000 ? Math.round(n / 1_000_000) : (n / 1_000_000).toFixed(1).replace('.', ',')}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${virgula(n / 1000)}k`
  return String(n)
}

export const usd = (v: number | null) => (v === null ? 'sem preço' : `~US$ ${v.toFixed(2).replace('.', ',')}`)

export const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`

export const corta = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s)

/** "há 6 min"; de outro dia, "ontem" ou "há 3 d". */
export function quando(iso: string, agora: number): string {
  const ms = agora - Date.parse(iso)
  if (ms < 12 * 3600_000) return ha(iso, agora)
  const dia = (t: number) => new Date(t).toDateString()
  if (dia(Date.parse(iso)) === dia(agora)) return ha(iso, agora)
  if (dia(Date.parse(iso)) === dia(agora - 24 * 3600_000)) return 'ontem'
  return ha(iso, agora)
}

/** "22:41", no fuso de quem olha. */
export function hora(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const MOTIVOS: Record<AwaitingReason, { glifo: string; rotulo: string; urgente: boolean }> = {
  notification: { glifo: '⛉', rotulo: 'Pede permissão', urgente: true },
  interrupted: { glifo: '⏸', rotulo: 'Interrompida', urgente: true },
  stop: { glifo: '↵', rotulo: 'Sua vez', urgente: false },
  session_start: { glifo: '›_', rotulo: 'No prompt', urgente: false },
}

/** Os 5 status do console (docs/brand/tokens.json): o rótulo e o glifo de cada um. */
export const STATUS: Record<DisplayStatus, { glifo: string; rotulo: string }> = {
  active: { glifo: '●', rotulo: 'Ativa' },
  waiting: { glifo: '◐', rotulo: 'Esperando você' },
  completed: { glifo: '✓', rotulo: 'Concluída' },
  error: { glifo: '✕', rotulo: 'Com erro' },
  abandoned: { glifo: '○', rotulo: 'Abandonada' },
}

/** O status que as pílulas mostram: delegando e background são "Ativa". */
export function statusDe(estado: EstadoDoInbox | 'desconhecido'): DisplayStatus {
  if (estado === 'delegating' || estado === 'background') return 'active'
  if (estado === 'desconhecido') return 'abandoned'
  return estado
}

export const precisamTexto = (n: number) => (n === 1 ? '1 precisa de você' : `${n} precisam de você`)

/** A linha de status da sessão: "ahrena-console ● Ativa · 2 precisam de você". */
export function linhaDeStatus(p: Painel | null, offline: boolean): string {
  if (offline || !p) return 'ahrena-console ○ offline'
  const s: SessaoDoPainel | null = p.sessao
  const n = p.precisam.total
  const fora = n ? precisamTexto(n) : 'ninguém mais'
  const d = p.decisoes
  const dec = d?.retomada ? ` · ${d.retomada.n} decisões herdadas` : d?.vigentes ? ` · ${d.vigentes === 1 ? '1 decisão' : `${d.vigentes} decisões`}` : ''
  if (!s) return `ahrena-console ◐ No prompt${dec} · ${fora}`
  const st = STATUS[statusDe(s.estado)]
  const rotulo = s.status === 'waiting' && s.motivo === 'session_start' ? 'No prompt' : st.rotulo
  const extra = s.estado === 'delegating' ? ' · delegando' : ''
  return `ahrena-console ${st.glifo} ${rotulo}${extra}${dec} · ${fora}`
}

/** A origem de uma decisão: o glifo e o rótulo do card (P9). */
export const ORIGENS: Record<DecisaoDoPainel['origem'], { glifo: string; rotulo: string }> = {
  sugerida: { glifo: '✲', rotulo: 'SUGERIDA' },
  correcao: { glifo: '↳', rotulo: 'CORREÇÃO SUA' },
  permissao: { glifo: '⛉', rotulo: 'PERMISSÃO' },
  pergunta: { glifo: '?', rotulo: 'PERGUNTA' },
  plano: { glifo: '☰', rotulo: 'PLANO' },
}

export const ESTADOS_DA_DECISAO: Record<DecisaoDoPainel['estado'], string> = {
  vigente: 'Vigente',
  substituida: 'Substituída',
  a_confirmar: 'A confirmar',
}

export const ESCOPOS: { valor: EscopoDasDecisoes; rotulo: string }[] = [
  { valor: 'sessao', rotulo: 'Sessão' },
  { valor: 'familia', rotulo: 'Família' },
  { valor: 'branch', rotulo: 'Branch' },
]

/** Quem decidiu: "você corrigiu", "agente propôs", "você · sessão mãe". */
export function quemDecidiu(d: DecisaoDoPainel): string {
  const quem =
    d.estado === 'a_confirmar'
      ? 'agente propôs'
      : d.origem === 'sugerida'
        ? d.confirmadaEm ? 'você confirmou' : 'agente'
        : d.decididaPor === 'agente'
          ? 'agente'
          : d.origem === 'correcao'
            ? 'você corrigiu'
            : d.origem === 'plano'
              ? 'você aprovou'
              : 'você'
  const de = d.sessao === 'mae' ? ' · sessão mãe' : d.sessao === 'familia' ? ' · outra sessão' : d.sessao === 'branch' ? ' · pelo branch' : ''
  return quem + de
}

/** "não: 20 por coluna; rolagem infinita". */
export const naoTexto = (d: DecisaoDoPainel) => `não: ${d.nao.length ? d.nao.join('; ') : '—'}`

export const decisoesTexto = (n: number) => (n === 1 ? '1 decisão vigente' : `${n} decisões vigentes`)
