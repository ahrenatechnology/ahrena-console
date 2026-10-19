import { expect, mock, test } from 'claude-code/testing'

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
  const estado = { cenario: opts.cenario ?? 'p1', fora: opts.fora ?? false }
  on('http.fetch', async (_$: unknown, e: { url: string; init?: { method?: string } }) => {
    pedidos.push({ method: e.init?.method ?? 'GET', url: e.url })
    if (estado.fora) throw new Error('connect ECONNREFUSED 127.0.0.1:4720')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(CENARIOS[estado.cenario]) } }
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
  expect(await ui.find({ type: 'Text', text: /\+1 concluído/ })).toBeDefined()
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
