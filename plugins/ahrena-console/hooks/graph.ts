// O grafo da sessão com os subagentes (#146, wireframes P11 a P13): a montagem, sem desenho. Recebe
// os subagentes como o núcleo manda (com `parent` e `wave`) e devolve as linhas, na ordem da tela:
// a sessão na raiz, cada subagente pendurado em quem o disparou e, nas sessões caóticas, agrupado
// por onda (o que um mesmo turno da sessão disparou), com as ondas só de concluídos recolhidas.

import type { PanelSubagent } from '../types'

/** Acima disso, o grafo agrupa por onda e oferece o filtro (P13); até isso, a árvore direta (P12). */
export const GROUP_ABOVE = 10
/** Até este nível, um subagente tem linha própria; abaixo, entra no "+N" da linha de cima. */
export const MAX_LEVEL = 2

export type GraphFilter = 'all' | 'active'

/** O que a pessoa mexeu no grafo: a página, as ondas que abriu ou fechou e o filtro. */
export type GraphState = { page: number; opened: number[]; closed: number[]; filter: GraphFilter }

export const GRAPH_STATE: GraphState = { page: 0, opened: [], closed: [], filter: 'all' }

export type Count = { active: number; completed: number; errors: number }

export type GraphLine =
  | { type: 'wave'; number: number; total: number; types: string[]; count: Count; start: number; end: number | null; open: boolean; marks: number[]; inParallel: boolean }
  | {
      type: 'node'
      sub: PanelSubagent
      level: number
      /** O trilho à esquerda, de quem disparou quem: "├", "│ ╰", com o recuo da onda no agrupado. */
      rail: string
      /** Os de baixo do último nível com linha: quantos e em que estado. */
      more: Count | null
    }

export type Graph = {
  lines: GraphLine[]
  grouped: boolean
  total: number
  count: Count
  /** Quantos começaram enquanto outro ainda rodava. */
  parallel: number
}

const isActive = (s: PanelSubagent) => s.status === 'working' || s.status === 'waiting'
const t = (iso: string) => Date.parse(iso)
const endOf = (s: PanelSubagent) => (s.until ? t(s.until) : null)

export function tally(items: readonly PanelSubagent[]): Count {
  return {
    active: items.filter(isActive).length,
    completed: items.filter((s) => s.status === 'completed').length,
    errors: items.filter((s) => s.status === 'error').length,
  }
}

/** Quantos começaram com outro ainda rodando: o paralelismo, visto nas barras sobrepostas. */
export function parallel(items: readonly PanelSubagent[], now: number): number {
  const ord = [...items].sort((a, b) => t(a.since) - t(b.since))
  let n = 0
  ord.forEach((s, i) => {
    if (ord.slice(0, i).some((o) => (endOf(o) ?? now) > t(s.since))) n++
  })
  return n
}

/** O pai dentro do conjunto; fora dele (ou sem pai), a sessão. */
function parentInSet(s: PanelSubagent, ids: Set<string>) {
  return s.parent && ids.has(s.parent) ? s.parent : null
}

/** O de cima da cadeia, com um limite contra um ciclo nos dados. */
function rootOf(s: PanelSubagent, byId: Map<string, PanelSubagent>, ids: Set<string>) {
  let r = s
  for (let i = 0; i < 32; i++) {
    const p = parentInSet(r, ids)
    if (!p) break
    r = byId.get(p)!
  }
  return r
}

/**
 * A chave da onda de cada subagente. Com a onda do núcleo em todos, ela; sem, a sobreposição no
 * tempo: os de cima, na ordem do início, ficam na mesma onda enquanto um começa antes de a anterior
 * acabar. O aninhado vai com o de cima.
 */
export function wavesOf(items: readonly PanelSubagent[], now: number): Map<string, number> {
  const ids = new Set(items.map((s) => s.id))
  const byId = new Map(items.map((s) => [s.id, s]))
  const roots = items.filter((s) => !parentInSet(s, ids)).sort((a, b) => t(a.since) - t(b.since))
  const fromRoot = new Map<string, number>()
  if (roots.every((s) => typeof s.wave === 'number')) {
    for (const r of roots) fromRoot.set(r.id, r.wave!)
  } else {
    let k = 0
    let until = -Infinity
    for (const r of roots) {
      if (t(r.since) >= until) k++
      until = Math.max(until, endOf(r) ?? now)
      fromRoot.set(r.id, k)
    }
  }
  return new Map(items.map((s) => [s.id, fromRoot.get(rootOf(s, byId, ids).id)!]))
}

/**
 * A árvore de um conjunto: cada um depois de quem o disparou, irmãos pela ordem do início. Até o
 * MAX_LEVEL, linha própria; abaixo, a contagem entra no "+N" da linha de cima.
 */
function tree(items: readonly PanelSubagent[], indent: string): Extract<GraphLine, { type: 'node' }>[] {
  const ids = new Set(items.map((s) => s.id))
  const content = new Map<string | null, PanelSubagent[]>()
  for (const s of items) {
    const p = parentInSet(s, ids)
    content.set(p, [...(content.get(p) ?? []), s])
  }
  for (const l of content.values()) l.sort((a, b) => t(a.since) - t(b.since) || a.id.localeCompare(b.id))
  const descendants = (id: string, seen = new Set<string>()): PanelSubagent[] =>
    (content.get(id) ?? []).filter((f) => !seen.has(f.id) && seen.add(f.id)).flatMap((f) => [f, ...descendants(f.id, seen)])
  const output: Extract<GraphLine, { type: 'node' }>[] = []
  const visit = (parent: string | null, level: number, prefix: string) => {
    const l = content.get(parent) ?? []
    l.forEach((s, i) => {
      const last = i === l.length - 1
      const background = level >= MAX_LEVEL ? descendants(s.id) : []
      output.push({ type: 'node', sub: s, level, rail: `${indent}${prefix}${last ? '╰' : '├'}`, more: background.length ? tally(background) : null })
      if (level < MAX_LEVEL) visit(s.id, level + 1, `${prefix}${last ? '  ' : '│ '}`)
    })
  }
  visit(null, 1, '')
  return output
}

/** Com o filtro "Ativos e erros": os ativos e os com erro, e quem os disparou, para o trilho fazer sentido. */
function onlyActiveAndErrors(items: readonly PanelSubagent[]): PanelSubagent[] {
  const byId = new Map(items.map((s) => [s.id, s]))
  const kept = new Set<string>()
  for (const s of items) {
    if (!isActive(s) && s.status !== 'error') continue
    let x: PanelSubagent | undefined = s
    for (let i = 0; x && i < 32 && !kept.has(x.id); i++) {
      kept.add(x.id)
      x = x.parent ? byId.get(x.parent) : undefined
    }
  }
  return items.filter((s) => kept.has(s.id))
}

/**
 * O grafo inteiro. Até GROUP_ABOVE subagentes, a árvore direta (P12). Acima, por onda (P13): a onda
 * com algum ativo abre, a só de concluídos recolhe numa linha; a pessoa abre e fecha cada uma. Na
 * onda recolhida, o ativo e o com erro continuam à vista, embaixo dela.
 */
export function buildGraph(items: readonly PanelSubagent[], now: number, state: GraphState = GRAPH_STATE): Graph {
  const total = items.length
  const base = { total, count: tally(items), parallel: parallel(items, now) }
  const grouped = total > GROUP_ABOVE
  const filtered = grouped && state.filter === 'active' ? onlyActiveAndErrors(items) : [...items]
  if (!grouped) return { ...base, grouped, lines: tree(filtered, '') }

  const key = wavesOf(items, now)
  const groups = new Map<number, PanelSubagent[]>()
  for (const s of items) groups.set(key.get(s.id)!, [...(groups.get(key.get(s.id)!) ?? []), s])
  // Numeradas de 1 em diante, na ordem em que cada onda começou.
  const order = [...groups.entries()].sort(([, a], [, b]) => Math.min(...a.map((s) => t(s.since))) - Math.min(...b.map((s) => t(s.since))))
  const lines: GraphLine[] = []
  order.forEach(([, ofGroup], i) => {
    const number = i + 1
    const ids = new Set(ofGroup.map((s) => s.id))
    const visible = filtered.filter((s) => ids.has(s.id))
    if (visible.length === 0) return
    const count = tally(ofGroup)
    const fallback = count.active > 0
    const open = state.filter === 'active' || (state.opened.includes(number) ? true : state.closed.includes(number) ? false : fallback)
    const start = Math.min(...ofGroup.map((s) => t(s.since)))
    const end = ofGroup.some((s) => !s.until) ? null : Math.max(...ofGroup.map((s) => endOf(s)!))
    const types = [...new Set(ofGroup.map((s) => s.name))]
    lines.push({ type: 'wave', number, total: ofGroup.length, types, count, start, end, open, marks: ofGroup.map((s) => t(s.since)).sort((a, b) => a - b), inParallel: parallel(ofGroup, now) > 0 })
    if (open) {
      lines.push(...tree(visible, '  '))
      return
    }
    // Recolhida: os que não podem sumir (ativo e com erro) ficam soltos embaixo dela.
    const loose = visible.filter((s) => isActive(s) || s.status === 'error').sort((a, b) => t(a.since) - t(b.since))
    loose.forEach((s, j) => lines.push({ type: 'node', sub: s, level: 1, rail: `  ${j === loose.length - 1 ? '╰' : '├'}`, more: null }))
  })
  return { ...base, grouped, lines }
}

/**
 * As linhas de uma página: `perPage` linhas, uma delas o "⋯ +N" quando há mais páginas. A página
 * pedida além da última vira a última (o grafo encolheu).
 */
export function paginate<T>(lines: readonly T[], perPage: number, page: number): { lines: T[]; page: number; pages: number; after: number } {
  const fits = Math.max(1, Math.floor(perPage))
  if (lines.length <= fits) return { lines: [...lines], page: 0, pages: 1, after: 0 }
  const usable = Math.max(1, fits - 1)
  const pages = Math.ceil(lines.length / usable)
  const p = Math.max(0, Math.min(page, pages - 1))
  const chunk = lines.slice(p * usable, (p + 1) * usable)
  return { lines: chunk, page: p, pages, after: Math.max(0, lines.length - (p + 1) * usable) }
}

/** O texto curto de uma contagem: "4 ● 1 ✕ 6 ✓", na ordem de importância. */
export function shortCount(c: Count): { text: string; st: 'active' | 'error' | 'completed' }[] {
  return [
    c.active ? { text: `${c.active} ●`, st: 'active' as const } : null,
    c.errors ? { text: `${c.errors} ✕`, st: 'error' as const } : null,
    c.completed ? { text: `${c.completed} ✓`, st: 'completed' as const } : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null)
}
