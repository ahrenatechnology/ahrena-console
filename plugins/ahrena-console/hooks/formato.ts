// Formatação do painel: tempo, modelo, tokens, custo e os glifos de status. Funções puras.

import type { AwaitingReason, DisplayStatus, EstadoDoInbox, Painel, SessaoDoPainel } from '../types'

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
  if (!s) return `ahrena-console ◐ No prompt · ${fora}`
  const st = STATUS[statusDe(s.estado)]
  const rotulo = s.status === 'waiting' && s.motivo === 'session_start' ? 'No prompt' : st.rotulo
  const extra = s.estado === 'delegating' ? ' · delegando' : ''
  return `ahrena-console ${st.glifo} ${rotulo}${extra} · ${fora}`
}
