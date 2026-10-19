// A altura do painel (issue #131): tudo cabe na janela, sem rolagem. Função pura: recebe as linhas
// que o corpo do painel tem (`scroll.bodyRows` do Pane) e o que cada card precisa, e devolve
// quantas linhas internas cada card pode usar.
//
// - Cada card tem um resumo de 1 linha (o cabeçalho) e o que precisa para aparecer inteiro.
// - A altura vai aos cards na ordem de prioridade; o que não couber fica no resumo ou, nas
//   listas, vira "+N".
// - Na grade, os cards de uma linha acompanham o mais alto: a sobra da linha vai às listas.
// - Nenhum texto é cortado no meio: o card só recebe as linhas em que o que ele desenha cabe.

/** Borda de cima e de baixo de um card. */
export const BORDA_DO_CARD = 2
/** Linhas internas de um card de resumo "inteiro" (Contexto, Trabalho): as 9 do desenho menos a borda. */
export const LINHAS_DO_CARD = 7

export interface Peca {
  id: string
  /** O mínimo para aparecer além do resumo (1 = só o resumo). */
  minimo: number
  /** O que precisa para aparecer inteiro. */
  inteiro: number
  /** Só o resumo ou inteiro, sem meio-termo (cards de KPIs). */
  tudoOuNada?: boolean
}

/** Linhas que a grade ocupa: por linha da grade, a borda mais o card mais alto; e o espaço entre elas. */
export function alturaDaGrade(linhas: readonly number[], porLinha: number): number {
  let total = 0
  for (let i = 0; i < linhas.length; i += porLinha) total += BORDA_DO_CARD + Math.max(...linhas.slice(i, i + porLinha))
  const fileiras = Math.ceil(linhas.length / porLinha)
  return total + Math.max(0, fileiras - 1)
}

/**
 * Distribui `disponivel` linhas entre as peças da grade (na ordem em que aparecem), dando primeiro
 * às de `prioridade`. Devolve as linhas internas de cada peça, já com a sobra da fileira.
 */
export function distribuir(pecas: readonly Peca[], porLinha: number, disponivel: number, prioridade: readonly string[]): Map<string, number> {
  const linhas = pecas.map(() => 1)
  const cabe = () => alturaDaGrade(linhas, porLinha) <= disponivel
  const ordem = [...prioridade.filter((id) => pecas.some((p) => p.id === id)), ...pecas.map((p) => p.id).filter((id) => !prioridade.includes(id))]
  for (const id of ordem) {
    const i = pecas.findIndex((p) => p.id === id)
    const p = pecas[i]!
    const opcoes = p.tudoOuNada ? [p.inteiro] : Array.from({ length: Math.max(0, p.inteiro - p.minimo + 1) }, (_, k) => p.inteiro - k)
    for (const n of opcoes) {
      if (n <= 1) break
      linhas[i] = n
      if (cabe()) break
      linhas[i] = 1
    }
  }
  // A sobra da fileira: as peças que podem crescer usam a altura do card mais alto da linha.
  for (let i = 0; i < pecas.length; i += porLinha) {
    const fileira = linhas.slice(i, i + porLinha)
    const alto = Math.max(...fileira)
    for (let j = i; j < Math.min(i + porLinha, pecas.length); j++) {
      const p = pecas[j]!
      if (!p.tudoOuNada && linhas[j]! > 1 && linhas[j]! < alto) linhas[j] = Math.min(alto, Math.max(linhas[j]!, p.inteiro))
      // Uma lista que ficou no resumo pode usar a altura da linha, se a linha já é alta.
      if (!p.tudoOuNada && linhas[j] === 1 && alto >= p.minimo) linhas[j] = Math.min(alto, p.inteiro)
    }
  }
  return new Map(pecas.map((p, i) => [p.id, linhas[i]!]))
}

/** Linhas que um texto ocupa numa largura, quebrando por palavra (estimativa conservadora). */
export function linhasDoTexto(texto: string, largura: number): number {
  if (largura <= 0) return 1
  let linhas = 1
  let coluna = 0
  for (const palavra of texto.split(/\s+/).filter(Boolean)) {
    const n = [...palavra].length
    if (coluna === 0) coluna = n
    else if (coluna + 1 + n <= largura) coluna += 1 + n
    else {
      linhas++
      coluna = n
    }
    while (coluna > largura) {
      linhas++
      coluna -= largura
    }
  }
  return linhas
}
