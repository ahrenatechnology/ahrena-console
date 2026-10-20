// O encaixe do desenho (0.0.32): o próprio mod encurta, pela medida em colunas, todo texto de uma
// linha só. O Desktop deixou de respeitar o `wrap="truncate-end"` (a linha quebrava em quatro e
// vazava do card), então o desenho não conta mais com ele: `draw` grava a árvore como dados, este
// módulo dá a cada nó as colunas que ele tem e encurta o que passa, e só então a árvore vira os
// elementos da superfície. As mesmas medidas servem ao teste-guarda (tests/fit.test.tsx).

/** Um nó do desenho como dados: o elemento (`t`, ou `type` na árvore do kit de testes), as props e os filhos. */
export type Node = { t?: string; type?: string; props?: Record<string, unknown>; children?: unknown }
type Child = Node | string | number | null | undefined | false | Child[]

/** Px por coluna da fonte mono no Desktop: um Svg ocupa as colunas da largura dele. */
export const PX_PER_COLUMN = 7.9
/** Px por linha do Desktop (medido: um card de 7 linhas tem ~133 px). */
export const PX_PER_LINE = 19
/**
 * Colunas que a borda de um Box tira, as duas laterais: no card de 34 com `paddingX` 1 sobram 30, o
 * USABLE das listas do desenho. As linhas que nunca cortam no card Esta sessão usam 28 (UNCUT_COLUMNS).
 */
const BORDER_COLUMNS = 2

const kind = (n: Node) => n.t ?? n.type ?? ''
const props = (n: Node) => (n.props ?? n) as Record<string, unknown>
/** Os filhos de um nó, sem os vazios: na árvore gravada ficam em `props.children`; na do kit, em `children`. */
export function kids(n: Node): (Node | string)[] {
  const raw = (n.t ? props(n).children : (n.children ?? props(n).children)) as Child
  const out: (Node | string)[] = []
  const add = (x: Child) => {
    if (x === null || x === undefined || x === false || x === '') return
    if (Array.isArray(x)) return x.forEach(add)
    out.push(typeof x === 'number' ? String(x) : (x as Node | string))
  }
  add(raw)
  return out
}

export const columns = (s: string) => [...s].length
const num = (v: unknown) => (typeof v === 'number' ? v : 0)
const isBox = (n: Node) => kind(n) === 'Box'
const isRow = (n: Node) => isBox(n) && props(n).flexDirection === 'row'
const border = (n: Node) => (props(n).borderStyle ? BORDER_COLUMNS : 0)
/** O espaço entre os filhos de uma linha, em colunas (`xs` é menos de uma coluna). */
const gapOf = (n: Node) => num(props(n).columnGap ?? props(n).gap)

/** O texto de um nó, como a tela o mostra. */
export function textOf(n: Node | string): string {
  if (typeof n === 'string') return n
  const k = kind(n)
  if (k === 'Button') return String(props(n).label ?? kids(n).map(textOf).join(''))
  if (k === 'Svg' || k === 'Select' || k === 'Input') return ''
  return kids(n).map(textOf).join('')
}

/**
 * A largura de um caractere de cada tamanho, em colunas do card (34 colunas, 30 úteis). Medido no
 * print do Desktop (20/10, card Esta sessão): a última mensagem, em footnote, quebrou com ~37
 * caracteres por linha; o título, no corpo, coube com 31 e não com 42. O caption é o menor.
 */
export const SIZE: Record<string, number> = { caption: 0.68, footnote: 0.75, body: 0.85 }
/** Quantos caracteres de um tamanho cabem em `width` colunas. */
export const charsFor = (width: number, size = 'body') => Math.floor(width / (SIZE[size] ?? 1))
const sizeOf = (n: Node, inherited: string) => String(props(n).size ?? inherited)

/** As colunas que um nó pede, inteiro, numa linha só. */
export function natural(n: Node | string, size = 'body'): number {
  // Em fração: o arredondamento de cada pedaço somaria colunas que a linha não tem.
  if (typeof n === 'string') return columns(n) * (SIZE[size] ?? 1)
  const p = props(n)
  const k = kind(n)
  if (k === 'Text') return kids(n).reduce((a, x) => a + natural(x, sizeOf(n, size)), 0)
  if (typeof p.width === 'number' && k !== 'Svg') return p.width
  if (k === 'Svg') return Math.ceil(num(p.width) / PX_PER_COLUMN)
  if (k === 'Select') return Math.max(0, ...((p.options as { label?: string }[] | undefined) ?? []).map((o) => columns(o.label ?? '') * (SIZE.footnote ?? 1))) + 4
  if (k === 'Input') return 0
  if (k === 'Button') return columns(textOf(n)) * (SIZE.footnote ?? 1) + (p.plain ? 0 : 2)
  if (!isBox(n)) return columns(textOf(n)) * (SIZE.footnote ?? 1)
  const c = kids(n)
  const inner = isRow(n) ? c.reduce((a, x) => a + natural(x), 0) + gapOf(n) * Math.max(0, c.length - 1) : Math.max(0, ...c.map((x) => natural(x)))
  return inner + 2 * num(p.paddingX) + border(n)
}

/** As colunas de dentro de um Box que tem `width` colunas. */
const innerOf = (n: Node, width: number) => (typeof props(n).width === 'number' ? (props(n).width as number) : width) - 2 * num(props(n).paddingX) - border(n)

/** Um texto que tem uma linha só: o que passa é encurtado com reticências. */
export const oneLine = (n: Node) => kind(n) === 'Text' && props(n).wrap === 'truncate-end'
/** Um nó que pode ceder colunas numa linha: um texto de uma linha, ou um Box que encolhe e tem um. */
function shrinks(n: Node | string): boolean {
  if (typeof n === 'string') return false
  if (props(n).flexShrink === 0 || typeof props(n).width === 'number') return false
  if (oneLine(n)) return true
  return isBox(n) && kids(n).some(shrinks)
}

/**
 * As colunas de cada filho de uma linha: os fixos pedem as deles; o que passa da largura sai dos que
 * encolhem, do maior para o menor.
 */
function share(row: Node, width: number): number[] {
  const c = kids(row)
  const want = c.map((x) => natural(x))
  let over = want.reduce((a, x) => a + x, 0) + gapOf(row) * Math.max(0, c.length - 1) - width
  const got = [...want]
  const order = c.map((x, i) => i).filter((i) => shrinks(c[i]!)).sort((a, b) => want[b]! - want[a]!)
  for (const i of order) {
    if (over <= 0) break
    const cut = Math.min(over, Math.max(0, got[i]! - 1))
    got[i]! -= cut
    over -= cut
  }
  return got
}

/** Encurta os filhos de um texto para caber em `width` colunas, com "…" no ponto do corte. */
function truncateKids(children: (Node | string)[], width: number, rebuild: (n: Node, kids: (Node | string)[]) => Node, size = 'body'): (Node | string)[] {
  const out: (Node | string)[] = []
  let left = width - 1
  for (const x of children) {
    const w = natural(x, size)
    if (w <= left) {
      out.push(x)
      left -= w
      continue
    }
    if (typeof x === 'string') out.push(`${[...x].slice(0, Math.max(0, Math.floor(left / (SIZE[size] ?? 1)))).join('').trimEnd()}…`)
    else if (kind(x) === 'Text') out.push(rebuild(x, truncateKids(kids(x), left + 1, rebuild, sizeOf(x, size))))
    else out.push('…')
    break
  }
  return out
}

/**
 * O desenho encaixado: cada nó recebe as colunas que tem, e todo texto de uma linha que passa delas
 * é encurtado. `rebuild` refaz um nó com outros filhos (a árvore gravada guarda os filhos nas props).
 */
export function fit(n: Node | string, width: number, rebuild: (n: Node, kids: (Node | string)[]) => Node): Node | string {
  if (typeof n === 'string') return n
  if (oneLine(n)) return natural(n) > width ? rebuild(n, truncateKids(kids(n), width, rebuild, sizeOf(n, 'body'))) : n
  if (!isBox(n)) return n
  const inner = innerOf(n, width)
  const c = kids(n)
  if (isRow(n) && props(n).flexWrap !== 'wrap') {
    const cols = share(n, inner)
    return rebuild(n, c.map((x, i) => fit(x, cols[i]!, rebuild)))
  }
  return rebuild(n, c.map((x) => fit(x, inner, rebuild)))
}

/** Linhas que um texto ocupa numa largura, quebrando por palavra. */
export function textLines(text: string, width: number): number {
  if (width <= 0) return 1
  let lines = 1
  let col = 0
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const n = columns(word)
    if (col === 0) col = n
    else if (col + 1 + n <= width) col += 1 + n
    else {
      lines++
      col = n
    }
    while (col > width) {
      lines++
      col -= width
    }
  }
  return lines
}

/** As linhas que um nó ocupa em `width` colunas: o que quebra conta as linhas dele; um Box com `height`, a dele. */
export function heightOf(n: Node | string, width: number): number {
  if (typeof n === 'string') return textLines(n, width)
  const p = props(n)
  const k = kind(n)
  // O Svg mede em px (uma linha do Desktop tem ~19 px); o Box, em linhas.
  if (k === 'Svg') return Math.max(1, Math.ceil(num(p.height) / PX_PER_LINE))
  if (typeof p.height === 'number') return p.height
  // Um texto que passa da largura quebra no Desktop, com ou sem `truncate-end` (por isso o encaixe).
  if (!isBox(n)) return k === 'Text' && (p.wrap === 'wrap' || natural(n) > width) ? textLines(textOf(n), charsFor(width, sizeOf(n, 'body'))) : textOf(n) || k !== 'Text' ? 1 : 0
  const inner = innerOf(n, width)
  const c = kids(n)
  if (!c.length) return 0
  if (isRow(n)) {
    const cols = share(n, inner)
    return Math.max(...c.map((x, i) => heightOf(x, cols[i]!)))
  }
  return c.reduce((a, x) => a + heightOf(x, inner), 0) + num(p.paddingY) * 2
}

/**
 * O que passa da largura num desenho já encaixado: cada texto de uma linha que pede mais colunas do
 * que tem, com o caminho até ele. Vazio: tudo cabe.
 */
export function overflows(n: Node | string, width: number, path = ''): string[] {
  if (typeof n === 'string') return []
  const here = `${path}/${String(props(n).key ?? kind(n))}`
  if (kind(n) === 'Text') return props(n).wrap === 'wrap' || natural(n) <= width ? [] : [`${here}: ${natural(n).toFixed(1)} > ${width} "${textOf(n)}"`]
  if (!isBox(n)) return []
  const inner = innerOf(n, width)
  const c = kids(n)
  if (isRow(n) && props(n).flexWrap !== 'wrap') {
    const cols = share(n, inner)
    return c.flatMap((x, i) => overflows(x, cols[i]!, here))
  }
  return c.flatMap((x) => overflows(x, inner, here))
}
