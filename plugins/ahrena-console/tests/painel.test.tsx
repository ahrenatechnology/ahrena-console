import { expect, mock, test } from 'claude-code/testing'

import type { Painel } from '../types'
import { AGORA, CENARIOS } from './cenarios'

type Cenario = keyof typeof CENARIOS
type Pedido = { method: string; url: string }

const PANE = {
  component: 'Pane',
  requestId: 'ahrena-console-sessao',
  props: { title: 'Ahrena Console', isFocused: true, bodyColumns: 38, placement: 'dock', scroll: { offset: 0, bodyRows: 80 } },
} as const
const LARGO = { ...PANE, props: { ...PANE.props, bodyColumns: 121 } }
const CONSOLE = { command: 'console', args: '', origin: { kind: 'user' }, presentation: 'text' } as any

// Núcleo e engine falsos: o núcleo responde o cenário pedido (ou cai, com `fora`); o engine tem
// a lista de painéis abertos, o /console que abre e o ambiente da sessão, como o Claude Desktop.
function falsos(on: any, opts: { cenario?: Cenario; fora?: boolean; env?: Record<string, string>; semLugar?: string } = {}) {
  const pedidos: Pedido[] = []
  const estado: { cenario: Cenario; fora: boolean; painel?: Painel } = { cenario: opts.cenario ?? 'p1', fora: opts.fora ?? false }
  on('http.fetch', async (_$: unknown, e: { url: string; init?: { method?: string } }) => {
    pedidos.push({ method: e.init?.method ?? 'GET', url: e.url })
    if (estado.fora) throw new Error('connect ECONNREFUSED 127.0.0.1:4720')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(estado.painel ?? CENARIOS[estado.cenario]) } }
  })
  const relogio = mock.clock(on, { now: AGORA })
  mock.env(on, opts.env ?? {})
  const pane = { open: false, shown: true }
  const status: (string | undefined)[] = []
  on('ui.status', async (_$: unknown, e: { text?: string }) => {
    status.push(e?.text)
    return { value: undefined }
  })
  on('session.id', async () => ({ value: 'sessao-teste' }))
  on('session.model', async () => ({ value: 'claude-sonnet-5-5' }))
  on('session.cwd', async () => ({ value: '/simulacao/cli-de-notas' }))
  on('ui.panes', async () => ({
    value: pane.open ? [{ id: 'ahrena-console-sessao', title: 'Ahrena Console', isShown: pane.shown, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.open', async () => {
    if (opts.semLugar) return { value: { isPlaced: false, reason: opts.semLugar } }
    pane.open = true
    return { value: { isPlaced: true } }
  })
  on('command.register', async () => ({ value: undefined }))
  on('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return { pedidos, relogio, pane, estado, status }
}

async function abrir($: any, on: any, opts: Parameters<typeof falsos>[1] = {}) {
  const f = falsos(on, opts)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await $.command.run(CONSOLE)
  return f
}

const CARDS = ['card-sessao', 'card-contexto', 'card-trabalho', 'card-plano', 'card-subagentes', 'card-filhas']

test('fechado não consulta: só com o painel aberto, um pedido a cada 5 s, só desta sessão', async ($, on) => {
  const f = falsos(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await f.relogio.advance(60_000)
  expect(f.pedidos).toHaveLength(0)

  await $.command.run(CONSOLE)
  await f.relogio.advance(30_000)
  expect(f.pedidos.length).toBeGreaterThanOrEqual(6)
  expect(f.pedidos.length).toBeLessThanOrEqual(8)
  expect(f.pedidos.every((p) => p.method === 'GET' && p.url.startsWith('http://127.0.0.1:4720/api/painel/sessao-teste'))).toBe(true)

  // Fechou: no máximo o tick em curso, e mais nenhum pedido.
  f.pane.open = false
  await f.relogio.advance(5_000)
  const fechado = f.pedidos.length
  await f.relogio.advance(60_000)
  expect(f.pedidos).toHaveLength(fechado)
})

test('atrás de outra aba não consulta; à vista de novo, volta', async ($, on) => {
  const f = await abrir($, on)
  f.pane.shown = false
  await f.relogio.advance(5_000)
  const escondido = f.pedidos.length
  await f.relogio.advance(60_000)
  expect(f.pedidos).toHaveLength(escondido)
  f.pane.shown = true
  await f.relogio.advance(5_000)
  expect(f.pedidos.length).toBeGreaterThan(escondido)
})

test('manda o que lê do ambiente: conta, org, sessão do Desktop, modelo e pasta (decisão 0006)', async ($, on) => {
  const f = await abrir($, on, {
    env: {
      CLAUDE_CODE_ACCOUNT_UUID: '00000000-0000-4000-8000-00000000000a',
      CLAUDE_CODE_ORGANIZATION_UUID: '00000000-0000-4000-8000-0000000000aa',
      CLAUDE_CODE_HOST_SESSION_ID: 'local_00000000-0000-4000-8000-000000000001',
    },
  })
  await f.relogio.advance(5_000)
  const url = new URL(f.pedidos[0]!.url)
  expect(url.searchParams.get('conta')).toBe('00000000-0000-4000-8000-00000000000a')
  expect(url.searchParams.get('org')).toBe('00000000-0000-4000-8000-0000000000aa')
  expect(url.searchParams.get('local')).toBe('local_00000000-0000-4000-8000-000000000001')
  expect(url.searchParams.get('modelo')).toBe('claude-sonnet-5-5')
  expect(url.searchParams.get('cwd')).toBe('/simulacao/cli-de-notas')
})

test('P1 no estreito e no largo: os seis cards, do mesmo tamanho, e "2 precisam de você"', async ($, on) => {
  const f = await abrir($, on)
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    for (const key of CARDS) expect(await ui.find({ key })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Kanban de sessões no artefato/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /rodando Bash · npm test/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5 · 12 min · turno 18/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~US\$ 1,8/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#42/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 precisam de você/ })).toBeDefined()
    expect(await ui.find({ key: 'ver-precisam' })).toBeDefined()
    expect(await ui.find({ key: 'faixa' })).toBeUndefined()
    await ui.unmount()
  }
  expect(f.status.at(-1)).toBe('ahrena-console ● Ativa · 2 precisam de você')
})

test('P2 e P3: a faixa traz a pergunta ou a permissão; P5: o erro', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p2' })
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  expect(await ui.find({ key: 'faixa' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sigo com SQLite em memória ou subo um Postgres no Docker\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3 opções · responda na conversa ao lado/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ninguém mais precisa de você/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sem PR · branch sem push/ })).toBeDefined()
  await ui.unmount()

  f.estado.cenario = 'p3'
  await f.relogio.advance(5_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  expect(await ui.find({ type: 'Text', text: /Bash quer rodar npm run migrate em \/simulacao\/motor-de-regras/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /permitir ou negar na conversa ao lado/ })).toBeDefined()
  await ui.unmount()

  f.estado.cenario = 'p5'
  await f.relogio.advance(5_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /API 529 · overloaded_error/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /mande uma mensagem na conversa para retomar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /CI ✕ falhou/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ajustes pedidos/ })).toBeDefined()
  await ui.unmount()
  expect(f.status.at(-1)).toBe('ahrena-console ✕ Com erro · 2 precisam de você')
})

test('P4: subagentes em paralelo e as sessões filhas', async ($, on) => {
  await abrir($, on, { cenario: 'p4' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /esperando 3 subagentes/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3 ativos/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /code-reviewer/ })).toBeDefined()
  // O card de lista cresce: os quatro aparecem, sem "+N".
  expect(await ui.find({ type: 'Text', text: /Plan/ })).toBeDefined()
  expect(await ui.find({ key: 'ver-subagentes' })).toBeUndefined()
  for (const filha of ['fila-de-tarefas', 'catalogo-exemplo', 'blog-estatico']) expect(await ui.find({ type: 'Text', text: new RegExp(filha) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /CI … rodando/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /aprovado/ })).toBeDefined()
  await ui.unmount()
})

test('P6: sessão nova, cards vazios no lugar', async ($, on) => {
  await abrir($, on, { cenario: 'p6' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  for (const key of CARDS) expect(await ui.find({ key })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /esperando o primeiro prompt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sem plano nesta sessão/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /nenhum nesta sessão/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sem issue ligada a este branch/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3 precisam de você/ })).toBeDefined()
  await ui.unmount()
})

test('P7: "Ver" abre quem precisa de você; família no estreito, máquina inteira no Select', async ($, on) => {
  await abrir($, on, { cenario: 'p7' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'ver-precisam' })
  expect(await ui.find({ key: 'card-sessao' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /PRECISAM DE VOCÊ · 2/ })).toBeDefined()
  expect(await ui.find({ key: 'precisa-sim-painel-motor-de-regras' })).toBeDefined()
  expect(await ui.find({ key: 'precisa-sim-painel-fila-de-tarefas' })).toBeDefined()
  expect(await ui.find({ key: 'precisa-sim-painel-painel-de-metricas' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /mãe desta · Opus 5\.5/ })).toBeDefined()
  await ui.select({ key: 'escopo', value: 'maquina' })
  expect(await ui.find({ type: 'Text', text: /PRECISAM DE VOCÊ · 3/ })).toBeDefined()
  expect(await ui.find({ key: 'precisa-sim-painel-painel-de-metricas' })).toBeDefined()
  await ui.press({ key: 'ir-sim-painel-motor-de-regras' })
  await ui.press({ key: 'fechar-precisam' })
  expect(await ui.find({ key: 'card-sessao' })).toBeDefined()
  await ui.unmount()
})

test('P8: sem o núcleo, o painel diz e tenta de novo sozinho', async ($, on) => {
  const f = await abrir($, on, { fora: true })
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    expect(await ui.find({ key: 'offline' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Sem conexão com o núcleo/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /nova tentativa em \d s/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /sem dados de outras sessões/ })).toBeDefined()
    await ui.unmount()
  }
  expect(f.status.at(-1)).toBe('ahrena-console ○ offline')
  // O núcleo volta: o próximo tick já desenha a sessão.
  f.estado.fora = false
  await f.relogio.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  expect(await ui.find({ key: 'offline' })).toBeUndefined()
  expect(await ui.find({ key: 'card-sessao' })).toBeDefined()
  await ui.unmount()
})

test('no terminal, o painel cai para o resumo em texto', async ($, on) => {
  await abrir($, on, { cenario: 'p1' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Kanban de sessões no artefato · Opus 5\.5 · turno 18/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 precisam de você/ })).toBeDefined()
  await ui.unmount()
})

test('sem lugar para o painel, o /console diz o motivo que o engine deu', async ($, on) => {
  const f = falsos(on, { semLugar: 'no-surface' })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const r = (await $.command.run(CONSOLE)) as { text?: string }
  expect(r?.text).toMatch(/no-surface/)
  expect(f.pedidos).toHaveLength(0)
})

test('#131 no largo: o plano atual com a barra e o passo em andamento, e os anteriores com ✓ e ◐', async ($, on) => {
  await abrir($, on, { cenario: 'p1' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  expect(await ui.find({ type: 'Svg', alt: /plano 50% feito, 3 de 6/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Rodar a bateria/ })).toBeDefined()
  expect(await ui.find({ key: 'plano-2' })).toBeDefined()
  expect(await ui.find({ key: 'plano-1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Prototipar o arrastar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/4 · 3 min/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Ler o wireframe do kanban/ })).toBeDefined()
  expect(await ui.find({ key: 'ver-planos' })).toBeUndefined()
  await ui.unmount()
})

test('#131 no estreito: só o atual e "+N planos anteriores", que abre a lista', async ($, on) => {
  await abrir($, on, { cenario: 'p1' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Rodar a bateria/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Abrir o PR/ })).toBeDefined()
  expect(await ui.find({ key: 'plano-2' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /\+2 planos anteriores/ })).toBeDefined()
  await ui.press({ key: 'ver-planos' })
  expect(await ui.find({ key: 'card-plano' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /PLANOS DA SESSÃO · 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 ✓ · 1 ◐/ })).toBeDefined()
  for (const n of [3, 2, 1]) expect(await ui.find({ key: `plano-${n}` })).toBeDefined()
  await ui.press({ key: 'fechar-planos' })
  expect(await ui.find({ key: 'card-plano' })).toBeDefined()
  await ui.unmount()
})

test('#131 com mais planos do que cabem no largo, "+N" abre o resto', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p4' })
  const p4 = CENARIOS.p4
  const anteriores = (p4.planos ?? []).filter((x) => x.resultado !== 'atual')
  expect(anteriores).toHaveLength(3)
  const extra = { ...anteriores[2]!, numero: 0, resumo: 'Plano sintético mais antigo' }
  f.estado.painel = { ...p4, planos: [...(p4.planos ?? []), extra] }
  await f.relogio.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  expect(await ui.find({ key: 'plano-3' })).toBeDefined()
  expect(await ui.find({ key: 'plano-2' })).toBeDefined()
  expect(await ui.find({ key: 'plano-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /\+2 planos anteriores/ })).toBeDefined()
  await ui.press({ key: 'ver-planos' })
  expect(await ui.find({ type: 'Text', text: /PLANOS DA SESSÃO · 5/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Plano sintético mais antigo/ })).toBeDefined()
  await ui.unmount()
})

test('#131 depois do /clear: sem plano em andamento, os anteriores continuam', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  const p1 = CENARIOS.p1
  f.estado.painel = { ...p1, plano: null, planos: (p1.planos ?? []).map((x) => (x.resultado === 'atual' ? { ...x, resultado: 'abandonado' as const, atual: null, fim: x.inicio } : x)) }
  await f.relogio.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  expect(await ui.find({ type: 'Text', text: /nenhum plano em andamento/ })).toBeDefined()
  for (const n of [3, 2, 1]) expect(await ui.find({ key: `plano-${n}` })).toBeDefined()
  await ui.unmount()
})

test('#131 núcleo sem o histórico: o card mostra só o plano, como antes', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  const { planos: _, ...semHistorico } = CENARIOS.p1
  f.estado.painel = semHistorico as Painel
  await f.relogio.advance(5_000)
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    expect(await ui.find({ type: 'Text', text: /Rodar a bateria/ })).toBeDefined()
    expect(await ui.find({ key: 'ver-planos' })).toBeUndefined()
    await ui.unmount()
  }
})

test('rodapé: a versão do plugin e a da API, discretas, nas duas larguras e sem o núcleo', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  f.estado.painel = { ...CENARIOS.p1, api: { versao: '0.0.1', commit: 'abc1234' } }
  await f.relogio.advance(5_000)
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    expect(await ui.find({ type: 'Text', text: /plugin \d+\.\d+\.\d+ · api 0\.0\.1 · abc1234/ })).toBeDefined()
    await ui.unmount()
  }
  // Núcleo de antes do rodapé, sem `api`: a versão do plugin aparece mesmo assim.
  const { api: _, ...semApi } = CENARIOS.p1
  f.estado.painel = semApi as Painel
  await f.relogio.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /plugin \d+\.\d+\.\d+ · api —/ })).toBeDefined()
  await ui.unmount()
})

test('"← voltar" no topo de toda tela que toma o lugar da sessão, e o "fechar" de baixo continua', async ($, on) => {
  await abrir($, on, { cenario: 'p1' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ key: 'voltar-sessao' })).toBeUndefined()
  for (const abrirTela of ['ver-precisam', 'ver-planos']) {
    await ui.press({ key: abrirTela })
    expect(await ui.find({ key: 'card-sessao' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /← voltar/ })).toBeDefined()
    await ui.press({ key: 'voltar-sessao' })
    expect(await ui.find({ key: 'card-sessao' })).toBeDefined()
  }
  await ui.press({ key: 'ver-precisam' })
  expect(await ui.find({ key: 'fechar-precisam' })).toBeDefined()
  await ui.unmount()
})

test('"← voltar" também na tela das decisões', async ($, on) => {
  await abrir($, on, { cenario: 'p9' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  await ui.press({ key: 'ver-decisoes' })
  expect(await ui.find({ key: 'card-sessao' })).toBeUndefined()
  await ui.press({ key: 'voltar-sessao' })
  expect(await ui.find({ key: 'card-sessao' })).toBeDefined()
  await ui.unmount()
})

test('#131: Subagentes e Sessões filhas crescem para baixo, sem cortar o nome; "+N" abre a lista com "← voltar"', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p4' })
  const p4 = CENARIOS.p4
  const sub = p4.subagentes.itens[3]!
  const muitos = Array.from({ length: 11 }, (_, i) => ({ ...sub, id: `sim-sub-${i}`, nome: `revisor-sintetico-com-nome-longo-${i}`, tarefa: 'uma tarefa sintética de descrição longa' }))
  f.estado.painel = { ...p4, subagentes: { ativos: p4.subagentes.ativos, itens: [...p4.subagentes.itens, ...muitos] } }
  await f.relogio.advance(5_000)
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    const card = await ui.find({ key: 'card-subagentes' })
    expect(card?.props.width).toBe(34)
    expect(card?.props.height).toBeUndefined()
    expect(card?.props.minHeight).toBe(9)
    // Os cards de resumo continuam com a altura mínima padrão.
    expect((await ui.find({ key: 'card-contexto' }))?.props.minHeight).toBe(9)
    const linhas = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('sub-'))
    expect(linhas).toHaveLength(8)
    expect((await ui.findAll({ type: 'Text' })).some((t) => t.props.wrap === 'wrap' && /revisor-sintetico-com-nome-longo-0/.test(t.text ?? ''))).toBe(true)
    expect(await ui.find({ type: 'Text', text: /\+7 subagentes/ })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'ver-subagentes' })
  expect(await ui.find({ key: 'card-subagentes' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /SUBAGENTES · 15/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('sub-'))).toHaveLength(15)
  await ui.press({ key: 'voltar-sessao' })
  expect(await ui.find({ key: 'card-subagentes' })).toBeDefined()
  await ui.unmount()
})

test('#131: a sessão no índice do Desktop vira um link (pelo núcleo, para claude://) nas filhas e em "precisam de você"; só de terminal, não', async ($, on) => {
  const LOCAL = 'local_00000000-0000-4000-8000-0000000000f1'
  const f = await abrir($, on, { cenario: 'p4' })
  const p4 = CENARIOS.p4
  f.estado.painel = { ...p4, filhas: p4.filhas.map((x, i) => (i === 0 ? { ...x, local: LOCAL } : x)) }
  await f.relogio.advance(5_000)
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  const links = (await ui.findAll({ type: 'Link' })).filter((l) => /\/abrir\//.test(l.props.href))
  const link = links[0]
  expect(link?.props.href).toBe(`http://localhost:4720/abrir/${LOCAL}`)
  expect(link?.props.label).toBe('fila-de-tarefas')
  expect(links).toHaveLength(1)
  await ui.unmount()

  const p7 = CENARIOS.p7
  f.estado.painel = { ...p7, precisam: { ...p7.precisam, maquina: p7.precisam.maquina.map((x, i) => (i === 0 ? { ...x, local: LOCAL } : x)) } }
  await f.relogio.advance(5_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  await ui.press({ key: 'ver-precisam' })
  await ui.select({ key: 'escopo', value: 'maquina' })
  const primeiro = p7.precisam.maquina[0]!
  // O nome e o "Ir para a sessão" do card dela.
  const abrem = (await ui.findAll({ type: 'Link' })).filter((l) => l.props.href === `http://localhost:4720/abrir/${LOCAL}`)
  expect(abrem.map((l) => l.props.label)).toEqual([primeiro.titulo, 'Ir para a sessão'])
  expect(await ui.find({ key: `ir-${primeiro.id}` })).toBeUndefined()
  // Sem `local` (só de terminal): o botão de antes, que copia o nome.
  expect((await ui.find({ key: `ir-${p7.precisam.maquina[1]!.id}` }))?.type).toBe('Button')
  await ui.unmount()
})

test('#131: nenhum texto do card "Esta sessão" é cortado na vertical, nas duas larguras e com textos longos', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  const p1 = CENARIOS.p1
  const titulo = 'Uma sessão sintética com um título bem comprido que não cabe numa linha só do card'
  const mensagem = `"Mandei os dois pedidos para a sessão filha, ${'e depois conferi tudo de novo com calma '.repeat(5)}fim"`
  f.estado.painel = {
    ...p1,
    sessao: { ...p1.sessao!, titulo, estado: 'waiting', status: 'waiting', motivo: 'stop', turno: 212, atividade: { tipo: 'sua-vez', texto: mensagem } },
  }
  await f.relogio.advance(5_000)
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    // Nenhum card tem altura fixa: crescem até caber, com 9 linhas no mínimo.
    for (const key of CARDS) {
      const card = await ui.find({ key })
      expect(card?.props.height).toBeUndefined()
      expect(card?.props.minHeight).toBe(9)
    }
    const t = await ui.find({ type: 'Text', text: titulo })
    expect(t?.props.wrap).toBe('wrap')
    const linha = await ui.find({ type: 'Text', text: /turno 212/ })
    expect(linha?.props.wrap).toBe('wrap')
    // A última mensagem: duas linhas no máximo (60 colunas úteis), com reticências.
    const atividade = (await ui.findAll({ type: 'Text' })).find((x) => (x.text ?? '').startsWith('"Mandei os dois pedidos'))!
    expect(atividade.text!.length).toBeLessThanOrEqual(56)
    expect(atividade.text!.endsWith('…')).toBe(true)
    await ui.unmount()
  }
})
