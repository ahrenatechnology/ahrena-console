// #146: o grafo da sessão com os subagentes (wireframes P11 a P13). Os cenários P12 e P13 são a
// resposta do núcleo montada dos eventos gravados pelo simulador (packages/nucleo/test/api/gravar-cenarios.ts).
import { expect, mock, test } from 'claude-code/testing'

import type { Painel, SubagenteDoPainel } from '../types'
import { AGRUPAR_ACIMA, ESTADO_DO_GRAFO, montarGrafo, ondasDe, paginar, type LinhaDoGrafo } from '../hooks/grafo'
import { AGORA, CENARIOS } from './cenarios'

const P12 = CENARIOS.p12.subagentes.itens
const P13 = CENARIOS.p13.subagentes.itens

/** Uma linha do grafo em texto curto, para comparar a ordem e o trilho. */
const resumo = (l: LinhaDoGrafo) => (l.tipo === 'onda' ? `${l.aberta ? '▾' : '▸'} Onda ${l.numero}` : `${l.trilho}${l.sub.nome}${l.sub.tarefa ? ` · ${l.sub.tarefa}` : ''}`)

// --- A montagem, sem desenho ---

test('P12: até 10 subagentes, a árvore direta, na ordem do início, sem ondas', () => {
  const g = montarGrafo(P12, AGORA)
  expect(g.agrupado).toBe(false)
  expect(g.linhas.map(resumo)).toEqual(['├Plan · plano da extração', '├Explore · achar usos', '╰test-runner · bateria'])
  // O Explore e o test-runner rodaram juntos: um começou com o outro rodando.
  expect(g.paralelos).toBe(1)
  expect(g.cont).toEqual({ ativos: 1, concluidos: 2, erros: 0 })
})

test('P13: mais de 10, por onda; a onda com ativos abre, as só de concluídos recolhem, o erro fica embaixo da dele', () => {
  const g = montarGrafo(P13, AGORA)
  expect(P13.length).toBeGreaterThan(AGRUPAR_ACIMA)
  expect(g.agrupado).toBe(true)
  expect(g.cont).toEqual({ ativos: 4, concluidos: 20, erros: 1 })
  expect(g.linhas.map(resumo)).toEqual([
    '▸ Onda 1',
    '▸ Onda 2',
    '  ╰test-runner · lint e tipos',
    '▸ Onda 3',
    '▾ Onda 4',
    '  ├general-purpose · migrar a cobrança',
    '  │ ├Explore · rotas de cobrança',
    '  │ ├Explore · webhooks',
    '  │ ├general-purpose · contratos',
    '  │ ╰test-runner · api de cobrança',
    '  ├docs-writer · README do serviço',
    '  ├code-reviewer · diff do serviço',
    '  ╰test-runner · e2e',
    '▸ Onda 5',
  ])
  const ondas = g.linhas.filter((l): l is Extract<LinhaDoGrafo, { tipo: 'onda' }> => l.tipo === 'onda')
  expect(ondas.map((o) => [o.total, o.cont])).toEqual([
    [6, { ativos: 0, concluidos: 6, erros: 0 }],
    [6, { ativos: 0, concluidos: 5, erros: 1 }],
    [1, { ativos: 0, concluidos: 1, erros: 0 }],
    [10, { ativos: 4, concluidos: 6, erros: 0 }],
    [2, { ativos: 0, concluidos: 2, erros: 0 }],
  ])
  expect(ondas[0]!.tipos).toEqual(['Explore'])
  // Do 3º nível para baixo, sem linha própria: o "+2 ✓" na linha do general-purpose de contratos.
  const contratos = g.linhas.find((l) => l.tipo === 'no' && l.sub.tarefa === 'contratos')
  expect(contratos?.tipo === 'no' && contratos.mais).toEqual({ ativos: 0, concluidos: 2, erros: 0 })
  expect(g.linhas.some((l) => l.tipo === 'no' && l.sub.tarefa === 'esquemas')).toBe(false)
})

test('P13: a pessoa abre e fecha a onda; recolhida, o ativo e o com erro continuam à vista', () => {
  const g = montarGrafo(P13, AGORA, { ...ESTADO_DO_GRAFO, abertas: [1], fechadas: [4] })
  const nomes = g.linhas.map(resumo)
  expect(nomes.slice(0, 7)).toEqual(['▾ Onda 1', '  ├Explore · mapear módulos', '  ├Explore · rotas', '  ├Explore · modelos', '  ├Explore · eventos', '  ├Explore · filas', '  ╰Explore · configuração'])
  const i = nomes.indexOf('▸ Onda 4')
  expect(nomes.slice(i, i + 5)).toEqual(['▸ Onda 4', '  ├general-purpose · migrar a cobrança', '  ├code-reviewer · diff do serviço', '  ├test-runner · e2e', '  ╰test-runner · api de cobrança'])
})

test('P13: o filtro "Ativos e erros" deixa os ativos, os com erro e quem os disparou', () => {
  const g = montarGrafo(P13, AGORA, { ...ESTADO_DO_GRAFO, filtro: 'ativos' })
  expect(g.linhas.map(resumo)).toEqual([
    '▾ Onda 2',
    '  ╰test-runner · lint e tipos',
    '▾ Onda 4',
    '  ├general-purpose · migrar a cobrança',
    '  │ ╰test-runner · api de cobrança',
    '  ├code-reviewer · diff do serviço',
    '  ╰test-runner · e2e',
  ])
})

test('sem a onda do núcleo, agrupa pela sobreposição no tempo; o aninhado vai com o de cima', () => {
  const sub = (id: string, ini: number, fim: number | null, pai: string | null = null): SubagenteDoPainel => ({
    id, nome: 'Explore', tarefa: id, status: fim === null ? 'working' : 'completed',
    desde: new Date(AGORA - (60 - ini) * 60_000).toISOString(), ate: fim === null ? null : new Date(AGORA - (60 - fim) * 60_000).toISOString(), pai, onda: null,
  })
  const itens = [sub('a', 0, 5), sub('b', 2, 8), sub('c', 10, 12), sub('d', 11, 20, 'c'), sub('e', 30, null)]
  const ondas = ondasDe(itens, AGORA)
  expect(['a', 'b', 'c', 'd', 'e'].map((id) => ondas.get(id))).toEqual([1, 1, 2, 2, 3])
})

test('paginar: as linhas da página, uma delas o "⋯ +N"; a página além da última vira a última', () => {
  const l = Array.from({ length: 10 }, (_, i) => i)
  expect(paginar(l, 20, 0)).toEqual({ linhas: l, pagina: 0, paginas: 1, depois: 0 })
  expect(paginar(l, 4, 0)).toEqual({ linhas: [0, 1, 2], pagina: 0, paginas: 4, depois: 7 })
  expect(paginar(l, 4, 3)).toEqual({ linhas: [9], pagina: 3, paginas: 4, depois: 0 })
  expect(paginar(l, 4, 9).pagina).toBe(3)
})

// --- No painel ---

const PANE = {
  component: 'Pane',
  requestId: 'ahrena-console-sessao',
  props: { title: 'Ahrena Console', isFocused: true, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } },
} as const
const LARGO = { ...PANE, props: { ...PANE.props, bodyColumns: 121 } }
const alto = (base: typeof PANE | typeof LARGO, linhas: number) => ({ ...base, props: { ...base.props, scroll: { offset: 0, bodyRows: linhas } } })
const CONSOLE = { command: 'console', args: '', origin: { kind: 'user' }, presentation: 'text' } as any

async function abrir($: any, on: any, painel: Painel) {
  on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(painel) } }))
  const relogio = mock.clock(on, { now: AGORA })
  mock.env(on, {})
  const pane = { open: false }
  on('ui.status', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: 'sessao-teste' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', async () => ({ value: '/simulacao/vitrine-demo' }))
  on('ui.panes', async () => ({ value: pane.open ? [{ id: 'ahrena-console-sessao', title: 'Ahrena Console', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.open', async () => {
    pane.open = true
    return { value: { isPlaced: true } }
  })
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.command.run(CONSOLE)
  await relogio.advance(0)
  return { relogio }
}

/** As linhas do grafo na tela, pela key, na ordem. */
async function linhasNaTela(ui: any): Promise<string[]> {
  return (await ui.findAll({ type: 'Box' })).map((b: any) => b.key as string).filter((k: string) => /^grafo-(raiz|onda|no)/.test(k ?? ''))
}

test('P11: o pé do card Subagentes abre o grafo: "ver o grafo ›" com todos no card, "+N · E com erro · grafo ›" com mais', async ($, on) => {
  await abrir($, on, CENARIOS.p12)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect((await ui.find({ key: 'ver-subagentes' }))?.props.label).toBe('ver o grafo ›')
  await ui.unmount()
})

test('P11: com 25, "+22 · 1 com erro · grafo ›", nas duas larguras', async ($, on) => {
  await abrir($, on, CENARIOS.p13)
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    expect((await ui.find({ key: 'ver-subagentes' }))?.props.label).toBe('+22 · 1 com erro · grafo ›')
    await ui.unmount()
  }
})

test('P12: o grafo no lugar dos cards, nas duas larguras: régua, raiz, um nó por subagente e "← voltar"', async ($, on) => {
  await abrir($, on, CENARIOS.p12)
  for (const [alvo, titulo] of [[PANE, /GRAFO · 3$/], [LARGO, /GRAFO · 3 SUBAGENTES/]] as const) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    await ui.press({ key: 'ver-subagentes' })
    expect(await ui.find({ type: 'Text', text: titulo })).toBeDefined()
    expect(await ui.find({ key: 'card-subagentes' })).toBeUndefined()
    const ids = P12.map((s) => s.id).sort((a, b) => Date.parse(P12.find((x) => x.id === a)!.desde) - Date.parse(P12.find((x) => x.id === b)!.desde))
    expect(await linhasNaTela(ui)).toEqual(['grafo-raiz', ...ids.map((id) => `grafo-no-${id}`)])
    // Sem ondas nem filtro até 10 subagentes; sem paginação quando cabe.
    expect(await ui.find({ key: 'grafo-filtro' })).toBeUndefined()
    expect(await ui.find({ key: 'grafo-proxima' })).toBeUndefined()
    // Todo Svg com largura e altura explícitas.
    for (const s of await ui.findAll({ type: 'Svg' })) expect([typeof s.props.width, typeof s.props.height]).toEqual(['number', 'number'])
    // Toda linha numa linha só: nada quebra.
    for (const t of await ui.findAll({ type: 'Text' })) expect(t.props.wrap).not.toBe('wrap')
    if (alvo === LARGO) {
      expect(await ui.find({ type: 'Text', text: /1 em paralelo/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /barras sobrepostas rodaram em paralelo/ })).toBeDefined()
    }
    await ui.press({ key: 'fechar-grafo' })
    expect(await ui.find({ key: 'card-subagentes' })).toBeDefined()
    await ui.unmount()
  }
})

test('P13 no largo: as ondas, a 4 aberta, o erro solto e o filtro; ▸ abre a onda', async ($, on) => {
  await abrir($, on, CENARIOS.p13)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  await ui.press({ key: 'ver-subagentes' })
  expect(await ui.find({ type: 'Text', text: /GRAFO · 25 SUBAGENTES/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 com erro/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /4 ativos/ })).toBeDefined()
  expect((await ui.find({ key: 'onda-1' }))?.props.label).toBe('▸ Onda 1')
  expect((await ui.find({ key: 'onda-4' }))?.props.label).toBe('▾ Onda 4')
  expect(await ui.find({ key: 'grafo-filtro' })).toBeDefined()
  expect(await ui.find({ key: 'grafo-proxima' })).toBeUndefined()
  const antes = (await linhasNaTela(ui)).length
  await ui.press({ key: 'onda-1' })
  expect((await ui.find({ key: 'onda-1' }))?.props.label).toBe('▾ Onda 1')
  expect((await linhasNaTela(ui)).length).toBe(antes + 6)
  await ui.press({ key: 'onda-1' })
  expect((await linhasNaTela(ui)).length).toBe(antes)
  await ui.unmount()
})

test('P13 no estreito: pagina pela altura, ‹ 1/2 ›, sem cortar uma linha; o "⋯ +N" diz o que vem', async ($, on) => {
  await abrir($, on, CENARIOS.p13)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(PANE, 36) })
  await ui.press({ key: 'ver-subagentes' })
  expect(await ui.find({ type: 'Text', text: /GRAFO · 25$/ })).toBeDefined()
  const pagina1 = await linhasNaTela(ui)
  expect(await ui.find({ key: 'grafo-proxima' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1\/\d$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⋯ \+\d+ na pág\. 2/ })).toBeDefined()
  await ui.press({ key: 'grafo-proxima' })
  const pagina2 = await linhasNaTela(ui)
  expect(await ui.find({ type: 'Text', text: /^2\/\d$/ })).toBeDefined()
  // A raiz se repete; as outras linhas não.
  expect(pagina2.filter((k) => k !== 'grafo-raiz' && pagina1.includes(k))).toEqual([])
  await ui.press({ key: 'grafo-anterior' })
  expect(await linhasNaTela(ui)).toEqual(pagina1)
  await ui.unmount()
})

test('P13: o grafo aberto continua aberto, na mesma página, depois de um tick sem mudança', async ($, on) => {
  const { relogio } = await abrir($, on, CENARIOS.p13)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  await ui.press({ key: 'ver-subagentes' })
  await ui.press({ key: 'onda-3' })
  await relogio.advance(5_000)
  expect((await ui.find({ key: 'onda-3' }))?.props.label).toBe('▾ Onda 3')
  await ui.unmount()
})
