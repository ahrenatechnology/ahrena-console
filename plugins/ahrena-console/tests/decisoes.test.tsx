// As decisões da sessão no painel (#102, wireframes P9 e P10), nas duas larguras. O núcleo falso
// responde o cenário P9 do simulador (tests/cenarios.ts) e, com `?decisoes=<escopo>`, a lista
// gravada daquele escopo; o Confirmar e o Descartar mudam a resposta como o núcleo mudaria.
import { expect, mock, test } from 'claude-code/testing'

import type { DecisaoDoPainel, EscopoDasDecisoes, ListaDeDecisoes, Painel } from '../types'
import { AGORA, CENARIOS, LISTAS_DO_P9 } from './cenarios'

type Pedido = { method: string; url: string; headers?: Record<string, string>; body?: string }

const PANE = {
  component: 'Pane',
  requestId: 'ahrena-console-sessao',
  props: { title: 'Ahrena Console', isFocused: true, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } },
} as const
const LARGO = { ...PANE, props: { ...PANE.props, bodyColumns: 121 } }
const CONSOLE = { command: 'console', args: '', origin: { kind: 'user' }, presentation: 'text' } as any

const copia = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

function falsos(on: any, base: Painel = CENARIOS.p9, conversa: 'inteira' | 'compactada' = 'inteira') {
  const pedidos: Pedido[] = []
  const toasts: string[] = []
  const rolagens: unknown[] = []
  const status: (string | undefined)[] = []
  const painel = copia(base)
  const listas = copia(LISTAS_DO_P9) as Record<EscopoDasDecisoes, ListaDeDecisoes>
  const fora = new Map<string, DecisaoDoPainel>()
  on('http.fetch', async (_$: unknown, e: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }) => {
    pedidos.push({ method: e.init?.method ?? 'GET', url: e.url, headers: e.init?.headers, body: e.init?.body })
    const url = new URL(e.url)
    const acao = /^\/api\/decisoes\/([^/]+)\/(confirmar|descartar|ajustar|desfazer)$/.exec(url.pathname)
    if (acao) {
      const id = decodeURIComponent(acao[1]!)
      let resposta: DecisaoDoPainel | null = null
      for (const l of Object.values(listas)) {
        const d = l.itens.find((i) => i.id === id) ?? fora.get(id)
        if (!d) continue
        if (acao[2] === 'confirmar') {
          l.aConfirmar--
          d.estado = 'vigente'
          d.confirmadaEm = new Date(AGORA).toISOString()
          d.desfazer = 'confirmar'
          l.vigentes++
        } else if (acao[2] === 'descartar') {
          l.aConfirmar--
          d.estado = 'descartada'
          d.desfazer = 'descartar'
          fora.set(id, d)
          l.itens = l.itens.filter((i) => i.id !== id)
        } else if (acao[2] === 'ajustar') {
          d.estado = 'substituida'
          d.desfazer = 'ajustar'
        } else {
          d.estado = 'a_confirmar'
          d.desfazer = null
          if (!l.itens.includes(d)) l.itens.unshift(d)
        }
        resposta = copia(d)
      }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ decisao: resposta }) } }
    }
    const escopo = url.searchParams.get('decisoes') as EscopoDasDecisoes | null
    const corpo = painel.decisoes ? { ...painel, decisoes: { ...painel.decisoes, lista: escopo ? listas[escopo] : null } } : painel
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(corpo) } }
  })
  const relogio = mock.clock(on, { now: AGORA })
  mock.env(on, {})
  on('ui.status', async (_$: unknown, e: { text?: string }) => {
    status.push(e?.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$: unknown, e: { text?: string } | string) => {
    toasts.push(typeof e === 'string' ? e : (e?.text ?? ''))
    return { value: undefined }
  })
  on('ui.scroll', async (_$: unknown, e: unknown) => {
    rolagens.push(e)
    return { value: {} }
  })
  // A conversa como o engine a tem: inteira (as mensagens das decisões estão nela) ou compactada (não estão).
  const ids = Object.values(LISTAS_DO_P9).flatMap((l) => l.itens.map((d) => d.toolUseId)).filter((x): x is string => !!x)
  on('session.messages', async () => ({
    value: conversa === 'inteira' ? [{ role: 'assistant', text: '', toolUses: ids.map((tool_use_id) => ({ tool_use_id, tool: 'AskUserQuestion', input: {} })) }] : [{ role: 'user', text: 'resumo da compactação', toolUses: [] }],
  }))
  on('session.id', async () => ({ value: 'sessao-teste' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.cwd', async () => ({ value: '/simulacao/ahrena-demo' }))
  on('ui.panes', async () => ({ value: [{ id: 'ahrena-console-sessao', title: 'Ahrena Console', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return { pedidos, toasts, rolagens, status, relogio, painel }
}

async function abrir($: any, on: any, base?: Painel, conversa: 'inteira' | 'compactada' = 'inteira') {
  const f = falsos(on, base, conversa)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.command.run(CONSOLE)
  await f.relogio.advance(5_000)
  return f
}

const porRotulo = (escopo: EscopoDasDecisoes, rotulo: string) => LISTAS_DO_P9[escopo].itens.find((i) => i.rotulo === rotulo) as DecisaoDoPainel
const card = (d: DecisaoDoPainel) => `decisao-${d.id}`

test('a linha "N decisões registradas", neutra, com as a confirmar, nas duas larguras e na linha de status', async ($, on) => {
  const f = await abrir($, on)
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    expect(await ui.find({ key: 'card-sessao' })).toBeDefined()
    expect(await ui.find({ key: 'decisoes' })).toBeDefined()
    // pnDec do P1: "⊸ N decisões registradas · M a confirmar" e "Ver", numa linha que quebra.
    expect((await ui.find({ key: 'decisoes' }))?.text).toMatch(alvo === LARGO ? /4 decisões registradas nesta sessão · 1 a confirmar/ : /4 decisões registradas · 1 a confirmar/)
    expect(await ui.find({ type: 'Text', text: /4 decisões registradas/ })).toBeDefined()
    // Registro, não pendência: sem cara de ação.
    expect((await ui.find({ key: 'decisoes' }))?.text).not.toMatch(/vigentes/)
    expect(await ui.find({ key: 'ver-decisoes' })).toBeDefined()
    expect(await ui.find({ key: 'retomada' })).toBeUndefined()
    await ui.unmount()
  }
  expect(f.status.at(-1)).toBe('ahrena-console ● Ativa · 4 decisões · 1 precisa de você')
})

test('sem decisões, a linha diz que não há', async ($, on) => {
  await abrir($, on, CENARIOS.p1)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /nenhuma decisão registrada/ })).toBeDefined()
  await ui.unmount()
})

test('núcleo de antes das decisões, sem o campo: o painel não desenha a linha', async ($, on) => {
  const antigo = copia(CENARIOS.p1)
  delete antigo.decisoes
  await abrir($, on, antigo)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ key: 'card-sessao' })).toBeDefined()
  expect(await ui.find({ key: 'decisoes' })).toBeUndefined()
  await ui.unmount()
})

test('P9 no estreito: Sessão, 3 cards 34 × 6 e "+2 · troque o escopo"', async ($, on) => {
  const f = await abrir($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'ver-decisoes' })
  expect(f.pedidos.at(-1)!.url).toMatch(/[?&]decisoes=sessao\b/)
  expect(await ui.find({ key: 'card-sessao' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /DECISÕES · 3 VIGENTES/ })).toBeDefined()
  expect((await ui.find({ key: 'escopo-decisoes' }))?.props.value).toBe('sessao')

  const cards = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('decisao-'))
  expect(cards).toHaveLength(3)
  for (const c of cards) {
    expect(c.props.width).toBe(34)
    // Todo card do P1 tem a mesma altura fixa: a borda e 7 linhas.
    expect(c.props.height).toBe(9)
    expect(c.props.overflow).toBe('hidden')
  }

  // A sugerida: origem, há quanto tempo, título, "não: …", pílula, quem, os dois botões e a borda.
  const sugerida = porRotulo('sessao', 'D6')
  const s = await ui.find({ key: card(sugerida) })
  expect(s?.props.borderColor).not.toBe(cards[1]!.props.borderColor)
  expect(s?.text).toMatch(/✲ SUGERIDA/)
  expect(s?.text).toMatch(/há 6 min/)
  expect(s?.text).toMatch(/10 cards por coluna, com "mostrar mais"/)
  expect(s?.text).toMatch(/não: 20 por coluna; rolagem infinita/)
  expect(s?.text).toMatch(/A confirmar/)
  expect(s?.text).toMatch(/agente propôs/)
  expect(await ui.find({ key: `confirmar-${sugerida.id}` })).toBeDefined()
  expect(await ui.find({ key: `descartar-${sugerida.id}` })).toBeDefined()

  const correcao = await ui.find({ key: card(porRotulo('sessao', 'D4')) })
  expect(correcao?.text).toMatch(/↳ CORREÇÃO SUA/)
  expect(correcao?.text).toMatch(/há 14 min/)
  expect(correcao?.text).toMatch(/não: Postgres no Docker/)
  expect(correcao?.text).toMatch(/Vigente/)
  expect(correcao?.text).toMatch(/você corrigiu/)
  expect(correcao?.text).toMatch(/ver na conversa/)
  const permissao = await ui.find({ key: card(porRotulo('sessao', 'D5')) })
  expect(permissao?.text).toMatch(/⛉ PERMISSÃO/)
  expect(permissao?.text).toMatch(/Permitir npm test sem perguntar/)

  expect(await ui.find({ type: 'Text', text: /\+2 · troque o escopo/ })).toBeDefined()
  await ui.press({ key: 'fechar-decisoes' })
  expect(await ui.find({ key: 'card-sessao' })).toBeDefined()
  await ui.unmount()
})

test('P9 no largo: Família, os 6 cards, a substituída riscada apontando D4 e o rodapé de escopo', async ($, on) => {
  const f = await abrir($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  await ui.press({ key: 'ver-decisoes' })
  expect(f.pedidos.at(-1)!.url).toMatch(/[?&]decisoes=familia\b/)
  expect(await ui.find({ type: 'Text', text: /DECISÕES · 4 VIGENTES/ })).toBeDefined()
  expect((await ui.find({ key: 'escopo-decisoes' }))?.props.value).toBe('familia')
  const cards = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('decisao-'))
  expect(cards).toHaveLength(6)
  expect(cards.every((c) => c.props.width === 34 && c.props.height === 9)).toBe(true)

  const velha = await ui.find({ key: card(porRotulo('familia', 'D3')) })
  expect(velha?.text).toMatch(/Substituída/)
  expect(velha?.text).toMatch(/substituída por D4/)
  expect(velha?.text).not.toMatch(/ver na conversa/)
  const titulo = await ui.find({ type: 'Text', text: 'Postgres no Docker nos testes' })
  expect(titulo?.props.strikethrough).toBe(true)

  expect((await ui.find({ key: card(porRotulo('familia', 'D2')) }))?.text).toMatch(/☰ PLANO.*há 40 min/s)
  expect((await ui.find({ key: card(porRotulo('familia', 'D2')) }))?.text).toMatch(/você aprovou/)
  const mae = await ui.find({ key: card(porRotulo('familia', 'D1')) })
  expect(mae?.text).toMatch(/\? PERGUNTA/)
  expect(mae?.text).toMatch(/ontem/)
  expect(mae?.text).toMatch(/você · sessão mãe/)
  expect(await ui.find({ type: 'Text', text: /escopo: Sessão · Família · Branch · mais recentes primeiro/ })).toBeDefined()

  // O Select troca o escopo e já pede a lista dele.
  await ui.select({ key: 'escopo-decisoes', value: 'branch' })
  expect(f.pedidos.at(-1)!.url).toMatch(/[?&]decisoes=branch\b/)
  expect((await ui.find({ key: 'escopo-decisoes' }))?.props.value).toBe('branch')
  await ui.unmount()
})

test('Confirmar e Descartar: um POST em JSON com a sessão, e a lista lida de novo', async ($, on) => {
  const f = await abrir($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'ver-decisoes' })
  const sugerida = porRotulo('sessao', 'D6')
  await ui.press({ key: `confirmar-${sugerida.id}` })
  const post = f.pedidos.find((p) => p.method === 'POST')!
  expect(post.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:4720/api/decisoes/${encodeURIComponent(sugerida.id)}/confirmar`))
  expect(post.headers?.['content-type']).toBe('application/json')
  expect(JSON.parse(post.body!)).toEqual({ sessao: 'sessao-teste' })
  expect(f.pedidos.at(-1)!.method).toBe('GET')
  expect(f.toasts.at(-1)).toMatch(/D6 confirmada/)
  const confirmada = await ui.find({ key: card(sugerida) })
  expect(confirmada?.text).toMatch(/Vigente/)
  expect(confirmada?.text).toMatch(/você confirmou/)
  expect(await ui.find({ key: `confirmar-${sugerida.id}` })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /DECISÕES · 4 VIGENTES/ })).toBeDefined()
  await ui.unmount()
})

test('Descartar tira a sugerida da lista', async ($, on) => {
  const f = await abrir($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  await ui.press({ key: 'ver-decisoes' })
  const sugerida = porRotulo('familia', 'D6')
  await ui.press({ key: `descartar-${sugerida.id}` })
  expect(f.pedidos.some((p) => p.method === 'POST' && p.url.includes('/descartar'))).toBe(true)
  expect(f.toasts.at(-1)).toMatch(/D6 descartada/)
  expect(await ui.find({ key: card(sugerida) })).toBeUndefined()
  await ui.unmount()
})

test('"ver na conversa" pede a rolagem até a mensagem desta sessão; a da sessão mãe mostra o trecho', async ($, on) => {
  const f = await abrir($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  await ui.press({ key: 'ver-decisoes' })
  await ui.press({ key: `ver-${porRotulo('familia', 'D4').id}` })
  // O kit de testes não tem a conversa: o pedido de rolagem é recusado e o painel diz isso.
  expect(f.rolagens.length ? JSON.stringify(f.rolagens.at(-1)) : f.toasts.at(-1)).toMatch(/sim-toolu-p9-4|D4 não está à vista/)
  // A da sessão mãe não está nesta conversa: sem "ver na conversa", o trecho original no detalhe.
  const d1 = porRotulo('familia', 'D1')
  expect(await ui.find({ key: `ver-${d1.id}` })).toBeUndefined()
  await ui.press({ key: `detalhe-${d1.id}` })
  expect((await ui.find({ key: 'detalhe-decisao' }))?.text).toMatch(/TRECHO ORIGINAL.*na sessão mãe:/s)
  await ui.unmount()
})

test('P10: a faixa da retomada só aparece quando o núcleo manda, nas duas larguras', async ($, on) => {
  const retomada = copia(CENARIOS.p6)
  retomada.decisoes = { vigentes: 4, aConfirmar: 0, retomada: { n: 4, tokens: 620, de: 'Kanban de sessões' }, lista: null }
  const f = await abrir($, on, retomada)
  const largo = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  expect(await largo.find({ key: 'retomada' })).toBeDefined()
  expect(await largo.find({ type: 'Text', text: /4 decisões da sessão anterior continuam valendo/ })).toBeDefined()
  expect(await largo.find({ type: 'Text', text: /~620 tokens/ })).toBeDefined()
  expect(await largo.find({ type: 'Text', text: /4 decisões registradas/ })).toBeDefined()
  await largo.unmount()
  const estreito = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await estreito.find({ type: 'Text', text: /4 decisões da sessão anterior$/ })).toBeDefined()
  await estreito.press({ key: 'ver-retomada' })
  expect(await estreito.find({ key: 'escopo-decisoes' })).toBeDefined()
  await estreito.unmount()
  expect(f.status.at(-1)).toBe('ahrena-console ◐ No prompt · 4 decisões herdadas · 2 precisam de você')
})

test('#131: clicar no título abre a decisão inteira, com "← voltar" para a lista', async ($, on) => {
  await abrir($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'ver-decisoes' })
  const d = porRotulo('sessao', 'D4')
  await ui.press({ key: `abrir-${d.id}` })
  expect(await ui.find({ key: 'detalhe-decisao' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /DECISÃO D4/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^DECIDIDO$/ })).toBeDefined()
  expect((await ui.find({ key: 'detalhe-decisao' }))?.text).toMatch(/NÃO.*Postgres no Docker/s)
  expect(await ui.find({ key: `conversa-${d.id}` })).toBeDefined()
  expect(await ui.find({ key: `ajustar-${d.id}` })).toBeDefined()
  await ui.press({ key: 'voltar-decisoes' })
  expect(await ui.find({ key: 'detalhe-decisao' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /DECISÕES · 3 VIGENTES/ })).toBeDefined()
  await ui.unmount()
})

test('#131: depois de Descartar, "Desfazer" fica à vista por alguns segundos e volta a sugerida', async ($, on) => {
  const f = await abrir($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'ver-decisoes' })
  const sugerida = porRotulo('sessao', 'D6')
  await ui.press({ key: `descartar-${sugerida.id}` })
  expect(await ui.find({ key: card(sugerida) })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /D6 descartada/ })).toBeDefined()
  await ui.press({ key: 'desfazer-ultima' })
  expect(f.pedidos.find((p) => p.method === 'POST' && /\/desfazer\b/.test(p.url))).toBeDefined()
  expect(await ui.find({ key: card(sugerida) })).toBeDefined()
  expect(await ui.find({ key: 'barra-desfazer' })).toBeUndefined()

  // Passados os segundos, a barra some.
  await ui.press({ key: `confirmar-${sugerida.id}` })
  expect(await ui.find({ key: 'barra-desfazer' })).toBeDefined()
  await f.relogio.advance(15_000)
  expect(await ui.find({ key: 'barra-desfazer' })).toBeUndefined()
  await ui.unmount()
})

test('#131: Ajustar abre um campo; o texto da pessoa vai ao núcleo e o detalhe oferece desfazer o ajuste', async ($, on) => {
  const f = await abrir($, on)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  await ui.press({ key: 'ver-decisoes' })
  const sugerida = porRotulo('familia', 'D6')
  await ui.press({ key: `abrir-${sugerida.id}` })
  expect(await ui.find({ key: 'ajuste-texto' })).toBeUndefined()
  await ui.press({ key: `ajustar-${sugerida.id}` })
  expect(await ui.find({ key: 'ajuste-texto' })).toBeDefined()
  await ui.input({ key: 'ajuste-texto', text: 'Sim, mas com 15 cards por coluna' })
  const post = f.pedidos.find((p) => p.method === 'POST' && /\/ajustar\b/.test(p.url))!
  expect(JSON.parse(post.body!)).toEqual({ sessao: 'sessao-teste', texto: 'Sim, mas com 15 cards por coluna' })
  expect(await ui.find({ key: 'ajuste-texto' })).toBeUndefined()
  expect(await ui.find({ key: `desfazer-${sugerida.id}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /D6 ajustada/ })).toBeDefined()
  await ui.unmount()
})

test('0.0.13: decisão de antes da compactação não tem "ver na conversa"; o detalhe mostra o trecho original, sem erro', async ($, on) => {
  await abrir($, on, undefined, 'compactada')
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'ver-decisoes' })
  const d = porRotulo('sessao', 'D4')
  expect(await ui.find({ key: `ver-${d.id}` })).toBeUndefined()
  expect((await ui.find({ key: card(d) }))?.text).toMatch(/ver o trecho/)
  await ui.press({ key: `detalhe-${d.id}` })
  const detalhe = await ui.find({ key: 'detalhe-decisao' })
  expect(detalhe?.text).toMatch(/TRECHO ORIGINAL/)
  expect(detalhe?.text).toMatch(/você, \d\d\/\d\d \d\d:\d\d, nesta sessão, antes de uma compactação:/)
  expect(detalhe?.text).toMatch(/SQLite em memória nos testes/)
  expect(detalhe?.text).not.toMatch(/não está à vista|não está visível/)
  expect(await ui.find({ key: `conversa-${d.id}` })).toBeUndefined()
  await ui.unmount()
})
