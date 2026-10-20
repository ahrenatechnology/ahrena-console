// O grafo da sessão com os subagentes (#146, wireframes P11 a P13): a montagem, sem desenho. Recebe
// os subagentes como o núcleo manda (com `pai` e `onda`) e devolve as linhas, na ordem da tela:
// a sessão na raiz, cada subagente pendurado em quem o disparou e, nas sessões caóticas, agrupado
// por onda (o que um mesmo turno da sessão disparou), com as ondas só de concluídos recolhidas.

import type { SubagenteDoPainel } from '../types'

/** Acima disso, o grafo agrupa por onda e oferece o filtro (P13); até isso, a árvore direta (P12). */
export const AGRUPAR_ACIMA = 10
/** Até este nível, um subagente tem linha própria; abaixo, entra no "+N" da linha de cima. */
export const NIVEL_MAXIMO = 2

export type FiltroDoGrafo = 'todos' | 'ativos'

/** O que a pessoa mexeu no grafo: a página, as ondas que abriu ou fechou e o filtro. */
export type EstadoDoGrafo = { pagina: number; abertas: number[]; fechadas: number[]; filtro: FiltroDoGrafo }

export const ESTADO_DO_GRAFO: EstadoDoGrafo = { pagina: 0, abertas: [], fechadas: [], filtro: 'todos' }

export type Contagem = { ativos: number; concluidos: number; erros: number }

export type LinhaDoGrafo =
  | { tipo: 'onda'; numero: number; total: number; tipos: string[]; cont: Contagem; ini: number; fim: number | null; aberta: boolean; marcas: number[]; emParalelo: boolean }
  | {
      tipo: 'no'
      sub: SubagenteDoPainel
      nivel: number
      /** O trilho à esquerda, de quem disparou quem: "├", "│ ╰", com o recuo da onda no agrupado. */
      trilho: string
      /** Os de baixo do último nível com linha: quantos e em que estado. */
      mais: Contagem | null
    }

export type Grafo = {
  linhas: LinhaDoGrafo[]
  agrupado: boolean
  total: number
  cont: Contagem
  /** Quantos começaram enquanto outro ainda rodava. */
  paralelos: number
}

const ativo = (s: SubagenteDoPainel) => s.status === 'working' || s.status === 'waiting'
const t = (iso: string) => Date.parse(iso)
const fimDe = (s: SubagenteDoPainel) => (s.ate ? t(s.ate) : null)

export function contar(itens: readonly SubagenteDoPainel[]): Contagem {
  return {
    ativos: itens.filter(ativo).length,
    concluidos: itens.filter((s) => s.status === 'completed').length,
    erros: itens.filter((s) => s.status === 'error').length,
  }
}

/** Quantos começaram com outro ainda rodando: o paralelismo, visto nas barras sobrepostas. */
export function paralelos(itens: readonly SubagenteDoPainel[], agora: number): number {
  const ord = [...itens].sort((a, b) => t(a.desde) - t(b.desde))
  let n = 0
  ord.forEach((s, i) => {
    if (ord.slice(0, i).some((o) => (fimDe(o) ?? agora) > t(s.desde))) n++
  })
  return n
}

/** O pai dentro do conjunto; fora dele (ou sem pai), a sessão. */
function paiNoConjunto(s: SubagenteDoPainel, ids: Set<string>) {
  return s.pai && ids.has(s.pai) ? s.pai : null
}

/** O de cima da cadeia, com um limite contra um ciclo nos dados. */
function raizDe(s: SubagenteDoPainel, porId: Map<string, SubagenteDoPainel>, ids: Set<string>) {
  let r = s
  for (let i = 0; i < 32; i++) {
    const p = paiNoConjunto(r, ids)
    if (!p) break
    r = porId.get(p)!
  }
  return r
}

/**
 * A chave da onda de cada subagente. Com a onda do núcleo em todos, ela; sem, a sobreposição no
 * tempo: os de cima, na ordem do início, ficam na mesma onda enquanto um começa antes de a anterior
 * acabar. O aninhado vai com o de cima.
 */
export function ondasDe(itens: readonly SubagenteDoPainel[], agora: number): Map<string, number> {
  const ids = new Set(itens.map((s) => s.id))
  const porId = new Map(itens.map((s) => [s.id, s]))
  const raizes = itens.filter((s) => !paiNoConjunto(s, ids)).sort((a, b) => t(a.desde) - t(b.desde))
  const daRaiz = new Map<string, number>()
  if (raizes.every((s) => typeof s.onda === 'number')) {
    for (const r of raizes) daRaiz.set(r.id, r.onda!)
  } else {
    let k = 0
    let ate = -Infinity
    for (const r of raizes) {
      if (t(r.desde) >= ate) k++
      ate = Math.max(ate, fimDe(r) ?? agora)
      daRaiz.set(r.id, k)
    }
  }
  return new Map(itens.map((s) => [s.id, daRaiz.get(raizDe(s, porId, ids).id)!]))
}

/**
 * A árvore de um conjunto: cada um depois de quem o disparou, irmãos pela ordem do início. Até o
 * NIVEL_MAXIMO, linha própria; abaixo, a contagem entra no "+N" da linha de cima.
 */
function arvore(itens: readonly SubagenteDoPainel[], recuo: string): Extract<LinhaDoGrafo, { tipo: 'no' }>[] {
  const ids = new Set(itens.map((s) => s.id))
  const filhos = new Map<string | null, SubagenteDoPainel[]>()
  for (const s of itens) {
    const p = paiNoConjunto(s, ids)
    filhos.set(p, [...(filhos.get(p) ?? []), s])
  }
  for (const l of filhos.values()) l.sort((a, b) => t(a.desde) - t(b.desde) || a.id.localeCompare(b.id))
  const descendentes = (id: string, vistos = new Set<string>()): SubagenteDoPainel[] =>
    (filhos.get(id) ?? []).filter((f) => !vistos.has(f.id) && vistos.add(f.id)).flatMap((f) => [f, ...descendentes(f.id, vistos)])
  const saida: Extract<LinhaDoGrafo, { tipo: 'no' }>[] = []
  const visitar = (pai: string | null, nivel: number, prefixo: string) => {
    const l = filhos.get(pai) ?? []
    l.forEach((s, i) => {
      const ultimo = i === l.length - 1
      const fundo = nivel >= NIVEL_MAXIMO ? descendentes(s.id) : []
      saida.push({ tipo: 'no', sub: s, nivel, trilho: `${recuo}${prefixo}${ultimo ? '╰' : '├'}`, mais: fundo.length ? contar(fundo) : null })
      if (nivel < NIVEL_MAXIMO) visitar(s.id, nivel + 1, `${prefixo}${ultimo ? '  ' : '│ '}`)
    })
  }
  visitar(null, 1, '')
  return saida
}

/** Com o filtro "Ativos e erros": os ativos e os com erro, e quem os disparou, para o trilho fazer sentido. */
function soAtivosEErros(itens: readonly SubagenteDoPainel[]): SubagenteDoPainel[] {
  const porId = new Map(itens.map((s) => [s.id, s]))
  const ficam = new Set<string>()
  for (const s of itens) {
    if (!ativo(s) && s.status !== 'error') continue
    let x: SubagenteDoPainel | undefined = s
    for (let i = 0; x && i < 32 && !ficam.has(x.id); i++) {
      ficam.add(x.id)
      x = x.pai ? porId.get(x.pai) : undefined
    }
  }
  return itens.filter((s) => ficam.has(s.id))
}

/**
 * O grafo inteiro. Até AGRUPAR_ACIMA subagentes, a árvore direta (P12). Acima, por onda (P13): a onda
 * com algum ativo abre, a só de concluídos recolhe numa linha; a pessoa abre e fecha cada uma. Na
 * onda recolhida, o ativo e o com erro continuam à vista, embaixo dela.
 */
export function montarGrafo(itens: readonly SubagenteDoPainel[], agora: number, estado: EstadoDoGrafo = ESTADO_DO_GRAFO): Grafo {
  const total = itens.length
  const base = { total, cont: contar(itens), paralelos: paralelos(itens, agora) }
  const agrupado = total > AGRUPAR_ACIMA
  const filtrados = agrupado && estado.filtro === 'ativos' ? soAtivosEErros(itens) : [...itens]
  if (!agrupado) return { ...base, agrupado, linhas: arvore(filtrados, '') }

  const chave = ondasDe(itens, agora)
  const grupos = new Map<number, SubagenteDoPainel[]>()
  for (const s of itens) grupos.set(chave.get(s.id)!, [...(grupos.get(chave.get(s.id)!) ?? []), s])
  // Numeradas de 1 em diante, na ordem em que cada onda começou.
  const ordem = [...grupos.entries()].sort(([, a], [, b]) => Math.min(...a.map((s) => t(s.desde))) - Math.min(...b.map((s) => t(s.desde))))
  const linhas: LinhaDoGrafo[] = []
  ordem.forEach(([, doGrupo], i) => {
    const numero = i + 1
    const ids = new Set(doGrupo.map((s) => s.id))
    const visiveis = filtrados.filter((s) => ids.has(s.id))
    if (visiveis.length === 0) return
    const cont = contar(doGrupo)
    const padrao = cont.ativos > 0
    const aberta = estado.filtro === 'ativos' || (estado.abertas.includes(numero) ? true : estado.fechadas.includes(numero) ? false : padrao)
    const ini = Math.min(...doGrupo.map((s) => t(s.desde)))
    const fim = doGrupo.some((s) => !s.ate) ? null : Math.max(...doGrupo.map((s) => fimDe(s)!))
    const tipos = [...new Set(doGrupo.map((s) => s.nome))]
    linhas.push({ tipo: 'onda', numero, total: doGrupo.length, tipos, cont, ini, fim, aberta, marcas: doGrupo.map((s) => t(s.desde)).sort((a, b) => a - b), emParalelo: paralelos(doGrupo, agora) > 0 })
    if (aberta) {
      linhas.push(...arvore(visiveis, '  '))
      return
    }
    // Recolhida: os que não podem sumir (ativo e com erro) ficam soltos embaixo dela.
    const soltos = visiveis.filter((s) => ativo(s) || s.status === 'error').sort((a, b) => t(a.desde) - t(b.desde))
    soltos.forEach((s, j) => linhas.push({ tipo: 'no', sub: s, nivel: 1, trilho: `  ${j === soltos.length - 1 ? '╰' : '├'}`, mais: null }))
  })
  return { ...base, agrupado, linhas }
}

/**
 * As linhas de uma página: `porPagina` linhas, uma delas o "⋯ +N" quando há mais páginas. A página
 * pedida além da última vira a última (o grafo encolheu).
 */
export function paginar<T>(linhas: readonly T[], porPagina: number, pagina: number): { linhas: T[]; pagina: number; paginas: number; depois: number } {
  const cabe = Math.max(1, Math.floor(porPagina))
  if (linhas.length <= cabe) return { linhas: [...linhas], pagina: 0, paginas: 1, depois: 0 }
  const util = Math.max(1, cabe - 1)
  const paginas = Math.ceil(linhas.length / util)
  const p = Math.max(0, Math.min(pagina, paginas - 1))
  const fatia = linhas.slice(p * util, (p + 1) * util)
  return { linhas: fatia, pagina: p, paginas, depois: Math.max(0, linhas.length - (p + 1) * util) }
}

/** O texto curto de uma contagem: "4 ● 1 ✕ 6 ✓", na ordem de importância. */
export function contagemCurta(c: Contagem): { texto: string; st: 'active' | 'error' | 'completed' }[] {
  return [
    c.ativos ? { texto: `${c.ativos} ●`, st: 'active' as const } : null,
    c.erros ? { texto: `${c.erros} ✕`, st: 'error' as const } : null,
    c.concluidos ? { texto: `${c.concluidos} ✓`, st: 'completed' as const } : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null)
}
