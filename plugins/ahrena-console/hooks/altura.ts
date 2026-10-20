// A altura do painel (issue #131): tudo cabe na janela, sem rolagem. Todo card tem a mesma altura
// fixa (o `.pc` do P1); o desenho decide quais cabem na grade (`scroll.bodyRows` do Pane) e manda
// os outros para o card de resumos. Aqui ficam as medidas e as contas puras.

/** Borda de cima e de baixo de um card. */
export const BORDA_DO_CARD = 2
/** Linhas internas de todo card (o `.pc` do P1): 6 de conteúdo; a altura é fixa e igual em todos. */
export const LINHAS_DO_CARD = 6

/** Linhas que a grade ocupa: por linha da grade, a borda mais o card mais alto; e o espaço entre elas. */
export function alturaDaGrade(linhas: readonly number[], porLinha: number): number {
  let total = 0
  for (let i = 0; i < linhas.length; i += porLinha) total += BORDA_DO_CARD + Math.max(...linhas.slice(i, i + porLinha))
  const fileiras = Math.ceil(linhas.length / porLinha)
  return total + Math.max(0, fileiras - 1)
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
