import { expect, mock, test } from 'claude-code/testing'

import type { Painel } from '../types'
import { paleta } from '../hooks/marca'
import { linhasDaVisao, passosEmDestaque } from '../hooks/desenho'
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
  const toasts: string[] = []
  on('ui.toast', async (_$: unknown, e: { text?: string } | string) => {
    toasts.push(typeof e === 'string' ? e : (e?.text ?? ''))
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
  return { pedidos, relogio, pane, estado, status, toasts }
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

test('P1 no estreito e no largo: os seis cards, do mesmo tamanho, e "1 precisa de você" (#140: a interrompida é só a sua vez)', async ($, on) => {
  const f = await abrir($, on)
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    for (const key of CARDS) expect(await ui.find({ key })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Kanban de sessões no artefato/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /rodando Bash · npm test/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5 · 12 min · turno 18/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~US\$ 1,8/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#42/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 precisa de você/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 na sua vez/ })).toBeDefined()
    expect(await ui.find({ key: 'ver-precisam' })).toBeDefined()
    expect(await ui.find({ key: 'faixa' })).toBeUndefined()
    await ui.unmount()
  }
  expect(f.status.at(-1)).toBe('ahrena-console ● Ativa · 1 precisa de você')
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
  // Alto o bastante para tudo aparecer inteiro: este teste é do conteúdo, não da altura.
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 120 } } })
  expect(await ui.find({ type: 'Text', text: /API 529 · overloaded_error/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /mande uma mensagem na conversa para retomar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /CI ✕ 2 falhas/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ajustes pedidos/ })).toBeDefined()
  await ui.unmount()
  expect(f.status.at(-1)).toBe('ahrena-console ✕ Com erro · 1 precisa de você')
})

test('P4: subagentes em paralelo e as sessões filhas', async ($, on) => {
  await abrir($, on, { cenario: 'p4' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /esperando 3 subagentes/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /3 ativos/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /code-reviewer/ })).toBeDefined()
  // P1: até 3 linhas, os ativos primeiro; o concluído vai para o "+1 concluído", que abre a lista.
  expect((await ui.find({ key: 'ver-subagentes' }))?.props.label).toBe('+1 concluído ›')
  // Filhas (pnFilhas do P1): até 3 linhas, a ativa primeiro; "Sua vez" em âmbar à direita; "ver todas".
  const filhas = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('filha-')).map((b) => b.key)
  expect(filhas).toEqual(['filha-sim-painel-catalogo-exemplo', 'filha-sim-painel-fila-de-tarefas', 'filha-sim-painel-blog-estatico'])
  const suaVez = await ui.find({ type: 'Text', text: 'Sua vez' })
  expect(suaVez?.props.color).toBe(paleta.yellow['500'])
  // Com as 3 à vista, sem "ver todas": o link seria redundante.
  expect(await ui.find({ key: 'ver-filhas' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /CI … 3\/7/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /aprovado/ })).toBeDefined()
  await ui.unmount()
})

test('CI com contagem: "CI ✓ 6/6", "CI ✕ 2 falhas", "CI … 3/7"; sem a contagem, como antes', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p4' })
  const p4 = CENARIOS.p4
  const casos: [NonNullable<NonNullable<Painel['trabalho']>['pr']>['ci'], { total: number; ok: number; falhas: number; rodando: number } | null, RegExp][] = [
    ['ok', { total: 6, ok: 6, falhas: 0, rodando: 0 }, /CI ✓ 6\/6/],
    ['falhou', { total: 7, ok: 5, falhas: 2, rodando: 0 }, /CI ✕ 2 falhas/],
    ['falhou', { total: 3, ok: 2, falhas: 1, rodando: 0 }, /CI ✕ 1 falha $/],
    ['rodando', { total: 7, ok: 3, falhas: 0, rodando: 4 }, /CI … 3\/7/],
    ['ok', null, /^ CI ✓ $/],
  ]
  for (const [ci, checks, re] of casos) {
    f.estado.painel = { ...p4, trabalho: { ...p4.trabalho!, pr: { ...p4.trabalho!.pr!, ci, checks } } }
    // Só o texto da pílula muda: aparece no redesenho seguinte ao intervalo mínimo.
    await f.relogio.advance(15_000)
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
    expect(await ui.find({ type: 'Text', text: re })).toBeDefined()
    await ui.unmount()
  }
})

test('0.0.14: nada cortado nem em markdown cru; o e-mail da org nunca aparece', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  const p1 = CENARIOS.p1
  const conta = { ...(p1.sessao!.conta ?? { id: 'c', cor: '#1baf7a', fonte: 'config' as const }), rotulo: "pessoa@exemplo.test's Organization" }
  f.estado.painel = {
    ...p1,
    sessao: { ...p1.sessao!, conta, estado: 'waiting', status: 'waiting', motivo: 'stop', atividade: { tipo: 'sua-vez', texto: '"Fechei o [#131](#local_00000000-0000-4000-8000-000000000001) com **tudo** verde e o `npm test` ok"' } },
    precisam: { ...p1.precisam, total: 0, suaVez: 2, porConta: [{ conta, n: 1 }] },
    prs: { total: 1, itens: [{ numero: 7, titulo: 'pr sintético', url: 'https://example.invalid/pr/7', repo: 'exemplo/sintetico', sessao: { id: 's', titulo: 'sessão sintética', local: null } }] },
    trabalho: { branch: 'feat/podium-replay-com-um-nome-sintetico-bem-comprido', repo: 'exemplo/sintetico', issue: null, pr: null, semPush: false, erro: null },
  }
  await f.relogio.advance(5_000)
  for (const [base, linhas] of [[PANE, 45], [PANE, 120], [LARGO, 120]] as const) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(base, linhas) })
    const textos = (await ui.findAll({ type: 'Text' })).map((t) => t.text ?? '')
    // O e-mail não aparece em lugar nenhum; a org pessoal é "conta pessoal".
    expect(textos.some((t) => t.includes('@'))).toBe(false)
    expect(textos.some((t) => /conta pessoal/.test(t))).toBe(true)
    // A última mensagem sem o markdown cru.
    expect(textos.some((t) => t.includes('Fechei o #131 com tudo verde e o npm test ok'))).toBe(true)
    expect(textos.some((t) => /\]\(|\*\*|`/.test(t))).toBe(false)
    // As faixas de uma linha quebram em vez de cortar.
    const precisam = await ui.find({ key: 'precisam' })
    expect(precisam?.text).toMatch(/○ ninguém mais precisa de você · 2 na sua vez/)
    expect((await ui.findAll({ type: 'Text' })).find((t) => /ninguém mais precisa de você/.test(t.text ?? ''))?.props.wrap).toBe('wrap')
    expect((await ui.find({ key: 'prs' }))?.text).toMatch(base === PANE ? /⇄ 1 PR p\/ aprovar/ : /⇄ 1 PR aguardando sua aprovação/)
    // O branch inteiro, no card ou no resumo.
    expect(textos.some((t) => t.includes('feat/podium-replay-com-um-nome-sintetico-bem-comprido'))).toBe(true)
    expect(textos.some((t) => /feat\/podium-rep[^l]*…/.test(t))).toBe(false)
    await ui.unmount()
  }
})

test('0.0.15: o nome da conta nunca corta ao lado de "ESTA SESSÃO"; no estreito o chip encurta para "5 s" ou sai', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  const p1 = CENARIOS.p1
  const comConta = (rotulo: string): Painel => ({ ...p1, sessao: { ...p1.sessao!, conta: { id: 'c', rotulo, cor: '#1baf7a', fonte: 'config' } } })
  const casos: [string, string | null][] = [['conta pessoal', '5 s'], ['cliente sintético longo!', null]]
  for (const [rotulo, chip] of casos) {
    f.estado.painel = comConta(rotulo)
    await f.relogio.advance(15_000)
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
    const secao = await ui.find({ key: 'secao-ESTA SESSÃO' })
    expect(secao?.text).toMatch(new RegExp(`◆ ${rotulo}`))
    if (chip) expect(secao?.text).toMatch(/5 s$/)
    else expect(secao?.text).not.toMatch(/5 s/)
    await ui.unmount()
  }
  // No largo, o chip inteiro.
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  expect((await ui.find({ key: 'secao-ESTA SESSÃO' }))?.text).toMatch(/auto · 5 s/)
  await ui.unmount()
})

test('0.0.20: todo Svg do painel tem largura e altura explícitas e limitadas (o Desktop estica o que não tem)', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  const LIMITE: Record<string, number> = { 'Ahrena Console': 28, 'sem conexão': 24 }
  for (const painel of [CENARIOS.p1, CENARIOS.p4, CENARIOS.p6, carregado()]) {
    f.estado.painel = painel
    await f.relogio.advance(15_000)
    for (const base of [PANE, LARGO]) {
      const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(base, 120) })
      const svgs = await ui.findAll({ type: 'Svg' })
      expect(svgs.length).toBeGreaterThan(0)
      for (const svg of svgs) {
        const { width, height, alt } = svg.props as { width?: number; height?: number; alt: string }
        expect([alt, typeof width, typeof height]).toEqual([alt, 'number', 'number'])
        // As barras e a linha do custo são finas; o anel do plano e o logo, quadrados pequenos.
        const max = LIMITE[alt] ?? (/^plano /.test(alt) ? 50 : 10)
        expect([alt, height! <= max]).toEqual([alt, true])
        expect([alt, width! <= 240]).toEqual([alt, true])
      }
      await ui.unmount()
    }
  }
})

test('0.0.20: Subagentes com 20 e 0 ativos: a barra fina, 3 linhas e "+17 concluídos ›"', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p4' })
  const p4 = CENARIOS.p4
  const base = p4.subagentes.itens.find((i) => i.status === 'completed')!
  const itens = Array.from({ length: 20 }, (_, i) => ({ ...base, id: `sim-sub-${i}`, nome: 'general-purpose', tarefa: `Revisar a parte ${i}`, ate: new Date(AGORA - i * 60_000).toISOString() }))
  f.estado.painel = { ...p4, subagentes: { ativos: 0, itens } }
  await f.relogio.advance(15_000)
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    const card = await ui.find({ key: 'card-subagentes' })
    expect(card?.text).toMatch(/SUBAGENTES\s*0 ativos/)
    const barra = (await ui.findAll({ type: 'Svg' })).find((x) => x.props.alt === '0 ativos de 20')
    expect([barra?.props.width, barra?.props.height]).toEqual([236, 5])
    const linhas = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('sub-'))
    expect(linhas.map((b) => b.key)).toEqual(['sub-sim-sub-0', 'sub-sim-sub-1', 'sub-sim-sub-2'])
    expect((await ui.find({ key: 'ver-subagentes' }))?.props.label).toBe('+17 concluídos ›')
    await ui.unmount()
  }
})

test('P6: sessão nova, cards vazios no lugar', async ($, on) => {
  await abrir($, on, { cenario: 'p6' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  for (const key of CARDS) expect(await ui.find({ key })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /esperando o primeiro prompt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sem plano nesta sessão/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /nenhum nesta sessão/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sem issue ligada a este branch/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 precisam de você/ })).toBeDefined()
  await ui.unmount()
})

test('P7: "Ver" abre quem precisa de você; família no estreito, máquina inteira no Select', async ($, on) => {
  await abrir($, on, { cenario: 'p7' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  await ui.press({ key: 'ver-precisam' })
  expect(await ui.find({ key: 'card-sessao' })).toBeUndefined()
  // Na família: a mãe pede permissão (precisa); a filha só está na sua vez, num grupo à parte.
  expect(await ui.find({ type: 'Text', text: /PRECISAM DE VOCÊ · 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /SUA VEZ · 1/ })).toBeDefined()
  expect(await ui.find({ key: 'precisa-sim-painel-motor-de-regras' })).toBeDefined()
  expect(await ui.find({ key: 'precisa-sim-painel-fila-de-tarefas' })).toBeDefined()
  expect(await ui.find({ key: 'precisa-sim-painel-painel-de-metricas' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /mãe desta · Opus 5\.5/ })).toBeDefined()
  await ui.select({ key: 'escopo', value: 'maquina' })
  expect(await ui.find({ type: 'Text', text: /PRECISAM DE VOCÊ · 2/ })).toBeDefined()
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
    expect(await ui.find({ type: 'Text', text: /nova tentativa a cada 5 s/ })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /1 precisa de você/ })).toBeDefined()
  await ui.unmount()
})

test('sem lugar para o painel, o /console diz o motivo que o engine deu', async ($, on) => {
  const f = falsos(on, { semLugar: 'no-surface' })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const r = (await $.command.run(CONSOLE)) as { text?: string }
  expect(r?.text).toMatch(/no-surface/)
  expect(f.pedidos).toHaveLength(0)
})

test('Plano: o anel com o % e três passos em destaque em volta do atual; o resto abre no detalhe', async ($, on) => {
  await abrir($, on, { cenario: 'p1' })
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    const card = await ui.find({ key: 'card-plano' })
    expect(card?.props.height).toBe(9)
    const anel = (await ui.findAll({ type: 'Svg' })).find((x) => /plano 50% feito, 3 de 6/.test(String(x.props.alt)))
    expect([anel?.props.width, anel?.props.height]).toEqual([50, 50])
    expect(card?.text).toMatch(/PLANO\s*3\/6/)
    // O último feito, o atual (em negrito) e o próximo.
    expect(card?.text).toMatch(/✓ Ligar ao núcleo● Rodando a bateria|✓ Ligar ao núcleo● Rodar a bateria/)
    expect(card?.text).toMatch(/○ Abrir o PR/)
    expect(card?.text).not.toMatch(/Ler o artefato|Pedir review/)
    // O resto dos passos e os planos anteriores, numa linha própria que abre o detalhe.
    expect((await ui.find({ key: 'ver-planos' }))?.props.label).toBe('+3 passos · 2 planos anteriores ›')
    expect(await ui.find({ key: 'plano-2' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Plano: os passos em destaque', () => {
  const passo = (id: string, estado: 'pending' | 'in_progress' | 'completed') => ({ id, texto: id, textoAtivo: null, estado, dono: { tipo: 'principal' as const, nome: null, agenteId: null } })
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id)
  expect(ids(passosEmDestaque([passo('a', 'completed'), passo('b', 'completed'), passo('c', 'in_progress'), passo('d', 'pending'), passo('e', 'pending')]))).toEqual(['b', 'c', 'd'])
  expect(ids(passosEmDestaque([passo('a', 'in_progress'), passo('b', 'pending'), passo('c', 'pending'), passo('d', 'pending')]))).toEqual(['a', 'b', 'c'])
  expect(ids(passosEmDestaque([passo('a', 'completed'), passo('b', 'completed'), passo('c', 'completed'), passo('d', 'completed')]))).toEqual(['b', 'c', 'd'])
  expect(ids(passosEmDestaque([passo('a', 'completed'), passo('b', 'pending')]))).toEqual(['a', 'b'])
})

test('#131: o "N/M ›" do Plano abre o detalhe: os passos do plano atual e os planos anteriores', async ($, on) => {
  await abrir($, on, { cenario: 'p1' })
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  await ui.press({ key: 'ver-planos' })
  expect(await ui.find({ key: 'card-plano' })).toBeUndefined()
  const passos = await ui.find({ key: 'passos-do-plano' })
  expect(passos?.text).toMatch(/✓ Ler o artefato/)
  expect(passos?.text).toMatch(/● Rodando a bateria|● Rodar a bateria/)
  expect(await ui.find({ type: 'Text', text: /PLANOS DA SESSÃO · 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 ✓ · 1 ◐/ })).toBeDefined()
  for (const n of [3, 2, 1]) expect(await ui.find({ key: `plano-${n}` })).toBeDefined()
  expect((await ui.find({ key: 'plano-2' }))?.text).toMatch(/Prototipar o arrastar · 1\/4.*3 min/s)
  await ui.press({ key: 'fechar-planos' })
  expect(await ui.find({ key: 'card-plano' })).toBeDefined()
  await ui.unmount()
})

test('#131 depois do /clear: sem plano em andamento, os anteriores abrem pelo card', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  const p1 = CENARIOS.p1
  f.estado.painel = { ...p1, plano: null, planos: (p1.planos ?? []).map((x) => (x.resultado === 'atual' ? { ...x, resultado: 'abandonado' as const, atual: null, fim: x.inicio } : x)) }
  await f.relogio.advance(15_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...LARGO })
  expect(await ui.find({ type: 'Text', text: /nenhum plano em andamento/ })).toBeDefined()
  expect((await ui.find({ key: 'ver-planos' }))?.props.label).toBe('+3 planos anteriores ›')
  await ui.press({ key: 'ver-planos' })
  for (const n of [3, 2, 1]) expect(await ui.find({ key: `plano-${n}` })).toBeDefined()
  await ui.unmount()
})

test('#131 núcleo sem o histórico: o card mostra o plano, e o detalhe só os passos', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  const { planos: _, ...semHistorico } = CENARIOS.p1
  f.estado.painel = semHistorico as Painel
  await f.relogio.advance(15_000)
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    expect(await ui.find({ type: 'Text', text: /Rodar a bateria/ })).toBeDefined()
    await ui.press({ key: 'ver-planos' })
    expect(await ui.find({ key: 'passos-do-plano' })).toBeDefined()
    expect(await ui.find({ key: 'plano-1' })).toBeUndefined()
    await ui.press({ key: 'fechar-planos' })
    await ui.unmount()
  }
})

test('rodapé: a versão do plugin e a da API, discretas, nas duas larguras e sem o núcleo', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  f.estado.painel = { ...CENARIOS.p1, api: { versao: '0.0.1', commit: 'abc1234', pasta: 'abc1234', abreSessao: false } }
  await f.relogio.advance(5_000)
  for (const alvo of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alvo })
    expect(await ui.find({ type: 'Text', text: /plugin \d+\.\d+\.\d+ · api 0\.0\.1 \(abc1234\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /reinicie a API/ })).toBeUndefined()
    await ui.unmount()
  }
  // A pasta já está em outro commit: a API no ar é a de antes, e o rodapé pede para reiniciar.
  f.estado.painel = { ...CENARIOS.p1, api: { versao: '0.0.1', commit: 'abc1234', pasta: 'def5678', abreSessao: false } }
  // Só o texto do rodapé muda: aparece no redesenho depois do intervalo mínimo.
  await f.relogio.advance(15_000)
  const mudou = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await mudou.find({ type: 'Text', text: /pasta em def5678: reinicie a API/ })).toBeDefined()
  await mudou.unmount()
  // Núcleo de antes do rodapé, sem `api`: a versão do plugin aparece mesmo assim.
  const { api: _, ...semApi } = CENARIOS.p1
  f.estado.painel = semApi as Painel
  await f.relogio.advance(15_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /plugin \d+\.\d+\.\d+ · api —/ })).toBeDefined()
  await ui.unmount()
})

test('"← voltar" no topo e embaixo de toda tela que toma o lugar da sessão; "fechar" não aparece mais', async ($, on) => {
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
  expect((await ui.find({ key: 'fechar-precisam' }))?.text).toBe('← voltar')
  expect((await ui.findAll({ type: 'Text' })).some((t) => /\bfechar\b/.test(t.text ?? ''))).toBe(false)
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
  // No card (P1), o nome em negrito na cor do texto, dentro do link.
  const nome = await ui.find({ type: 'Text', text: 'fila-de-tarefas' })
  expect([nome?.props.weight, nome?.props.color]).toEqual(['bold', undefined])
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


// --- Altura (#131): tudo dentro da janela, sem rolagem ---

const alto = (alvo: typeof PANE | typeof LARGO, linhas: number) => ({ ...alvo, props: { ...alvo.props, scroll: { offset: 0, bodyRows: linhas } } })
const ALTURAS = [32, 45, 60, 90, 200]

/** Um painel carregado: título e mensagem longos, 15 subagentes, 6 filhas e 5 planos anteriores. */
function carregado(): Painel {
  const p4 = CENARIOS.p4
  const sub = p4.subagentes.itens[3]!
  // Os dois primeiros revisores ainda trabalham: os ativos aparecem todos no card, os concluídos no "+N".
  const revisor = (i: number) => ({ ...sub, id: `sim-sub-${i}`, nome: `revisor-sintetico-com-nome-longo-${i}`, tarefa: 'uma tarefa sintética de descrição longa', ...(i < 2 ? { status: 'working' as const, ate: null } : {}) })
  const subagentes = [...Array.from({ length: 2 }, (_, i) => revisor(i)), ...p4.subagentes.itens, ...Array.from({ length: 9 }, (_, i) => revisor(i + 2))]
  const filhas = [...p4.filhas, ...p4.filhas].map((f, i) => ({ ...f, id: `${f.id}-${i}`, titulo: `${f.titulo}-${i}` }))
  const ant = (p4.planos ?? []).filter((x) => x.resultado !== 'atual')
  const planos = [...(p4.planos ?? []), ...ant.slice(0, 2).map((x, i) => ({ ...x, numero: -i, resumo: `Plano sintético ${i}` }))]
  return {
    ...p4,
    sessao: {
      ...p4.sessao!,
      titulo: 'Uma sessão sintética com um título bem comprido que não cabe numa linha só do card',
      estado: 'waiting',
      status: 'waiting',
      motivo: 'stop',
      turno: 212,
      atividade: { tipo: 'sua-vez', texto: `"Mandei os dois pedidos para a sessão filha, ${'e depois conferi tudo de novo com calma '.repeat(5)}fim"` },
    },
    subagentes: { ativos: p4.subagentes.ativos + 2, itens: subagentes },
    filhas,
    planos,
  }
}

test('altura: os seis cards do P1 aparecem sempre, inteiros e do mesmo tamanho, em qualquer altura; sem card de resumos', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p4' })
  f.estado.painel = carregado()
  await f.relogio.advance(5_000)
  for (const base of [PANE, LARGO]) {
    for (const linhas of [30, 60, 400]) {
      const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(base, linhas) })
      for (const key of CARDS) {
        const card = await ui.find({ key })
        expect([card?.props.width, card?.props.height]).toEqual([34, 9])
      }
      expect(await ui.find({ key: 'resumos' })).toBeUndefined()
      // No card de altura fixa, o título corta com reticências, como no P1.
      expect((await ui.find({ type: 'Text', text: /título bem comprido/ }))?.props.wrap).toBe('truncate-end')
      await ui.unmount()
    }
  }
  // A altura que a visão pede (para saber a partir de quantas linhas o pane não rola).
  const painel = carregado()
  for (const cols of [38, 121]) expect(linhasDaVisao({ agora: AGORA, nucleo: '127.0.0.1:4720', cols, acoes: {} } as any, painel)).toBeGreaterThan(0)
})

test('P1: Subagentes e Sessões filhas têm até 3 linhas; o resto num "+N", que abre a lista com "← voltar"', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p4' })
  const painel = carregado()
  f.estado.painel = painel
  await f.relogio.advance(5_000)
  for (const base of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(base, 400) })
    // Os ativos primeiro; o que não cabe nas 3 linhas soma o total no "+N".
    const subs = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('sub-'))
    expect(subs.map((b) => b.key)).toEqual(['sub-sim-sub-0', 'sub-sim-sub-1', `sub-${CENARIOS.p4.subagentes.itens[0]!.id}`])
    expect((await ui.find({ key: 'ver-subagentes' }))?.props.label).toBe('+2 ativos · +10 concluídos ›')
    expect((await ui.find({ key: 'card-subagentes' }))?.text).toMatch(/SUBAGENTES\s*5 ativos/)
    // As filhas: até 3 linhas e "ver todas as N ›".
    expect((await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('filha-'))).toHaveLength(3)
    expect((await ui.find({ key: 'ver-filhas' }))?.props.label).toBe(`ver todas as ${painel.filhas.length} ›`)
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 400) })
  await ui.press({ key: 'ver-subagentes' })
  expect(await ui.find({ type: 'Text', text: /SUBAGENTES · 15/ })).toBeDefined()
  await ui.press({ key: 'voltar-sessao' })
  await ui.press({ key: 'ver-filhas' })
  expect(await ui.find({ type: 'Text', text: new RegExp(`SESSÕES FILHAS · ${painel.filhas.length}`) })).toBeDefined()
  await ui.press({ key: 'voltar-sessao' })
  expect(await ui.find({ key: 'card-subagentes' })).toBeDefined()
  await ui.unmount()
})

test('altura: as telas que tomam o lugar da sessão também cabem, com "+N que não cabem nesta altura"', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p4' })
  const painel = carregado()
  const ant = (painel.planos ?? [])[1]!
  painel.planos = [...(painel.planos ?? []), ...Array.from({ length: 30 }, (_, i) => ({ ...ant, numero: 100 + i, resumo: `Plano sintético ${i}` }))]
  f.estado.painel = painel
  await f.relogio.advance(5_000)
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(PANE, 50) })
  await ui.press({ key: 'ver-planos' })
  const linhas = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('plano-')).length
  expect(linhas).toBeGreaterThan(0)
  expect(await ui.find({ type: 'Text', text: new RegExp(`\\+${painel.planos.length - linhas} que não cabem nesta altura`) })).toBeDefined()
  await ui.press({ key: 'voltar-sessao' })
  await ui.unmount()

  // "Precisam de você": só as fileiras de cards que cabem.
  f.estado.painel = CENARIOS.p7
  await f.relogio.advance(5_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(PANE, 32) })
  await ui.press({ key: 'ver-precisam' })
  await ui.select({ key: 'escopo', value: 'maquina' })
  expect((await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith('precisa-'))).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /\+2 que não cabem nesta altura/ })).toBeDefined()
  await ui.unmount()
})

test('#131: no macOS, o nome da sessão abre a conversa direto pela API, sem o navegador', async ($, on) => {
  const LOCAL = 'local_00000000-0000-4000-8000-0000000000f1'
  const f = await abrir($, on, { cenario: 'p4' })
  const p4 = CENARIOS.p4
  f.estado.painel = { ...p4, api: { versao: '0.0.1', commit: null, pasta: null, abreSessao: true }, filhas: p4.filhas.map((x, i) => (i === 0 ? { ...x, local: LOCAL } : x)) }
  await f.relogio.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  const filha = p4.filhas[0]!
  expect((await ui.findAll({ type: 'Link' })).some((l) => /\/abrir\//.test(l.props.href))).toBe(false)
  await ui.press({ key: `nome-filha-${filha.id}` })
  const pedido = f.pedidos.find((x) => x.method === 'POST' && x.url === `http://127.0.0.1:4720/abrir/${LOCAL}`)
  expect(pedido).toBeDefined()
  expect(f.toasts.at(-1)).toMatch(/Abrindo "fila-de-tarefas" no Claude Desktop/)
  await ui.unmount()
})

test('#131: nas listas dos cards, cada item é uma linha com reticências e o tempo numa coluna fixa; inteiro só na tela da lista', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p4' })
  f.estado.painel = carregado()
  await f.relogio.advance(5_000)
  for (const base of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(base, 120) })
    // Os planos anteriores ficam no detalhe do Plano, nas duas larguras (P1).
    for (const prefixo of ['sub-', 'filha-']) {
      const itens = (await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith(prefixo))
      expect(itens.length).toBeGreaterThan(0)
    }
    // O tipo longo encurta para a descrição aparecer: "revisor-… · uma tarefa…".
    const textos = (await ui.findAll({ type: 'Text' })).filter((t) => /revisor-\S*… · uma tarefa/.test(t.text ?? ''))
    expect((await ui.find({ type: 'Text', text: /revisor-sintetico-com-nome-longo-0/ }))).toBeUndefined()
    expect(textos.some((t) => t.props.wrap === 'truncate-end')).toBe(true)
    expect(textos.some((t) => t.props.wrap === 'wrap')).toBe(false)
    // A coluna de tempo tem largura fixa e não encolhe.
    const colunas = (await ui.findAll({ type: 'Box' })).filter((b) => b.props.width === 7 && b.props.flexShrink === 0)
    expect(colunas.length).toBeGreaterThan(0)
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  await ui.press({ key: 'ver-subagentes' })
  if (await ui.find({ type: 'Text', text: /SUBAGENTES · 15/ })) {
    const inteiros = (await ui.findAll({ type: 'Text' })).filter((t) => /revisor-sintetico-com-nome-longo-0/.test(t.text ?? ''))
    expect(inteiros.some((t) => t.props.wrap === 'wrap')).toBe(true)
  }
  await ui.unmount()
})

test('Plano: sem os passos (núcleo antigo), o resumo do P1: "✓ N feitas", o atual e "○ próximo · +N"', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  const p1 = CENARIOS.p1
  f.estado.painel = { ...p1, plano: { ...p1.plano!, passos: undefined } }
  await f.relogio.advance(15_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  const card = await ui.find({ key: 'card-plano' })
  expect(card?.text).toMatch(/✓ 3 feitas/)
  expect(card?.text).toMatch(/● Rodar a bateria/)
  expect(card?.text).toMatch(/○ Abrir o PR · \+1/)
  expect((await ui.find({ key: 'ver-planos' }))?.props.label).toBe('2 planos anteriores ›')
  await ui.unmount()
})

test('#131 clique duplo: o polling só regrava o atom quando o desenho muda (uso, PRs, a sua vez e a pergunta incluídos)', async ($, on) => {
  // Conta as gravações do atom `leitura`: cada uma redesenha o pane e troca os handles dos botões.
  let gravacoes = 0
  on('state.set', async (_$: unknown, e: { key?: string; ref?: { key?: string } }, next: (e: unknown) => unknown) => {
    if ((e.ref?.key ?? e.key) === 'leitura') gravacoes++
    return next(e)
  })
  // O uso pelo engine, que muda a cada resposta.
  const uso = { tokens: 120_100, percent: 12.01 }
  on('session.usage', async () => ({ value: { startedAt: AGORA, context: { tokens: uso.tokens, window: 1_000_000, percent: uso.percent }, rateLimits: [] } }))
  on('tool.call', async () => ({ result: 'ok' }))
  const f = await abrir($, on, { cenario: 'p4' })
  const p4 = CENARIOS.p4
  // Uma pergunta no painel, um PR aguardando e alguém na sua vez.
  await ($ as any).tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'feito', ask: 'Sigo?', actions: [{ label: 'Sim' }] })
  const pr = { numero: 7, titulo: 'pr sintético', url: 'https://example.invalid/pr/7', repo: 'ahrena/sintetico', sessao: { id: 'sim-s', titulo: 'sessão sintética', local: null } }
  // Os horários do cenário andam com o relógio: os "há N min" ficam parados, e o que mudar no
  // desenho é o que o tick trouxe.
  const anda = (p: Painel, ms: number): Painel =>
    JSON.parse(JSON.stringify(p).replace(/"(\d{4}-\d\d-\d\dT[^"]+Z)"/g, (_, d: string) => JSON.stringify(new Date(Date.parse(d) + ms).toISOString())))
  let t = 0
  const base = (i: number, extra: Partial<Painel> = {}): Painel => ({
    ...anda({ ...p4, prs: { total: 1, itens: [pr] }, ...extra }, t),
    // O que muda a cada tick sem mudar a tela: a hora da resposta e o `desde` de quem está na sua
    // vez (a tela principal só mostra quantos).
    geradoEm: new Date(AGORA + t + i).toISOString(),
    precisam: { ...p4.precisam, familia: p4.precisam.familia.map((x) => ({ ...x, desde: new Date(AGORA - i * 7_000).toISOString() })) },
  })
  const tick = async (ms = 5_000) => {
    t += ms
    await f.relogio.advance(ms)
  }
  f.estado.painel = base(0)
  await tick()
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(PANE, 120) })
  const antes = gravacoes
  expect(antes).toBeGreaterThan(0)
  // Seis ticks: o uso sobe dentro do mesmo arredondamento (120.1k, 12%), e nada visível muda.
  for (let i = 1; i <= 6; i++) {
    uso.tokens = 120_100 + i * 7
    uso.percent = 12.01 + i * 0.01
    // A resposta do próximo tick, com os horários já andados até ele.
    f.estado.painel = anda(base(i), 5_000)
    await tick()
  }
  expect(gravacoes).toBe(antes)
  // O mesmo botão continua lá, com o mesmo desenho: o clique da pessoa chega.
  expect(await ui.find({ key: 'responder-0' })).toBeDefined()
  // Uma mudança visível que não troca os botões espera o intervalo mínimo; depois, grava uma vez.
  uso.percent = 14
  uso.tokens = 140_000
  for (let i = 0; i < 4; i++) {
    f.estado.painel = anda(base(7), 5_000)
    await tick()
  }
  expect(gravacoes).toBe(antes + 1)
  // O que troca os botões grava na hora: mais um PR aguardando muda o cabeçalho do card.
  f.estado.painel = anda(base(8, { prs: { total: 2, itens: [pr, { ...pr, numero: 8 }] } }), 5_000)
  await tick()
  expect(gravacoes).toBe(antes + 2)
  await ui.unmount()
})

test('P1: as filhas que trabalham vêm primeiro, depois as que precisam e as da sua vez; a lista completa diz o que cada uma faz', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p4' })
  const p4 = CENARIOS.p4
  const base = p4.filhas[0]!
  const filha = (i: number, extra: object) => ({ ...base, id: `sim-filha-${i}`, titulo: `filha-sintetica-${i}`, desde: new Date(AGORA - (15 - i) * 60_000).toISOString(), ...extra })
  const filhas = [
    ...Array.from({ length: 9 }, (_, i) => filha(i, { estado: 'completed', motivo: null })),
    filha(9, { estado: 'waiting', motivo: 'stop' }),
    filha(10, { estado: 'waiting', motivo: 'interrupted' }),
    filha(11, { estado: 'waiting', motivo: 'notification' }),
    filha(12, { estado: 'active', motivo: null, fazendo: 'pensando' }),
    filha(13, { estado: 'waiting', motivo: 'stop' }),
    filha(14, { estado: 'active', motivo: null, fazendo: 'rodando Bash' }),
  ]
  f.estado.painel = { ...p4, filhas }
  await f.relogio.advance(5_000)
  for (const b of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(b, 90) })
    // No card (P1): 3 linhas, as que trabalham primeiro (a mais recente antes), depois a que precisa.
    const linhas = (await ui.findAll({ type: 'Box' })).filter((x) => x.key?.startsWith('filha-')).map((x) => x.key)
    expect(linhas).toEqual(['filha-sim-filha-14', 'filha-sim-filha-12', 'filha-sim-filha-11'])
    expect((await ui.find({ key: 'card-filhas' }))?.text).toMatch(/SESSÕES FILHAS\s*15/)
    // À direita, o tempo; ou, em âmbar, o que pede você.
    expect((await ui.find({ type: 'Text', text: 'Precisa' }))?.props.color).toBe(paleta.yellow['500'])
    expect((await ui.find({ key: 'ver-filhas' }))?.props.label).toBe('ver todas as 15 ›')
    // Na lista completa, a ordem inteira e o que cada uma que trabalha está fazendo.
    await ui.press({ key: 'ver-filhas' })
    const todas = (await ui.findAll({ type: 'Box' })).filter((x) => x.key?.startsWith('filha-')).map((x) => x.key)
    expect(todas.slice(0, 6)).toEqual(['filha-sim-filha-14', 'filha-sim-filha-12', 'filha-sim-filha-11', 'filha-sim-filha-13', 'filha-sim-filha-10', 'filha-sim-filha-9'])
    expect(await ui.find({ type: 'Text', text: /· rodando Bash/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /· pensando/ })).toBeDefined()
    // Três na sua vez: duas no fim do turno e uma depois do Esc.
    expect((await ui.findAll({ type: 'Text', text: 'Sua vez' })).length).toBe(3)
    await ui.press({ key: 'voltar-sessao' })
    await ui.unmount()
  }
})

test('Compactar: a partir de 80%, no lugar do tile Background; pede confirmação; compacta só esta sessão e diz o resultado', async ($, on) => {
  let chamadas = 0
  let soltar: (() => void) | null = null
  let recusar: string | null = null
  let vetar: string | null = null
  // O engine falso: a compactação desta sessão (o que o /compact faz), ou a recusa no meio de um turno.
  on('session.compact', async () => {
    chamadas++
    if (vetar) return { skip: vetar }
    if (recusar) throw new Error(recusar)
    await new Promise<void>((r) => (soltar = r))
    return { messages: [{ role: 'user', text: 'resumo sintético da conversa', toolUses: [] }], tokensBefore: 180_000, tokensAfter: 40_000 }
  })
  const f = await abrir($, on, { cenario: 'p1' })
  const p1 = CENARIOS.p1
  // Abaixo de 80% (P1): o card não tem Compactar, e o cabeçalho diz "estimativa".
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  expect(await ui.find({ key: 'compactar' })).toBeUndefined()
  expect(await ui.find({ key: 'kpi-background' })).toBeDefined()
  expect((await ui.find({ key: 'card-contexto' }))?.text).toMatch(/CONTEXTO E CUSTO\s*estimativa/)
  await ui.unmount()

  // A partir de 80%: "Compactar agora", em destaque.
  f.estado.painel = { ...p1, contexto: { usados: 172_000, limite: 200_000, pct: 86 } }
  await f.relogio.advance(5_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  const agora = await ui.find({ key: 'compactar' })
  expect(agora?.props.label).toBe('Compactar agora')
  expect(agora?.props.variant).toBe('primary')
  // No lugar do tile Background: a grade 2×2 fica.
  expect(await ui.find({ key: 'kpi-background' })).toBeUndefined()
  expect(await ui.find({ key: 'kpi-compactar' })).toBeDefined()

  // Cancelar não compacta.
  await ui.press({ key: 'compactar' })
  expect(await ui.find({ type: 'Text', text: 'Compactar a conversa desta sessão?' })).toBeDefined()
  await ui.press({ key: 'compactar-nao' })
  expect(await ui.find({ key: 'confirmar-compactar' })).toBeUndefined()
  expect(chamadas).toBe(0)

  // Confirmar: "compactando…" até o engine terminar; depois, o resultado.
  await ui.press({ key: 'compactar' })
  await ui.press({ key: 'compactar-sim' })
  for (let i = 0; i < 20 && !soltar; i++) await f.relogio.advance(10)
  expect(chamadas).toBe(1)
  expect(await ui.find({ type: 'Text', text: 'compactando…' })).toBeDefined()
  soltar!()
  for (let i = 0; i < 20 && !(f.toasts.at(-1) ?? '').startsWith('Conversa'); i++) await f.relogio.advance(10)
  expect(f.toasts.at(-1)).toBe('Conversa compactada: de 180k para 40k tokens.')
  expect(await ui.find({ type: 'Text', text: 'compactando…' })).toBeUndefined()

  // Um hook vetou: o painel diz o motivo do veto.
  vetar = 'no meio de um turno'
  await ui.press({ key: 'compactar' })
  await ui.press({ key: 'compactar-sim' })
  for (let i = 0; i < 20 && !(f.toasts.at(-1) ?? '').startsWith('A conversa não'); i++) await f.relogio.advance(10)
  expect(f.toasts.at(-1)).toBe('A conversa não foi compactada: no meio de um turno.')

  // O engine recusou (no meio de um turno, ele rejeita a chamada): o painel diz o motivo.
  vetar = null
  recusar = 'a turn is running'
  await ui.press({ key: 'compactar' })
  await ui.press({ key: 'compactar-sim' })
  for (let i = 0; i < 20 && !(f.toasts.at(-1) ?? '').startsWith('Não deu'); i++) await f.relogio.advance(10)
  expect(f.toasts.at(-1)).toMatch(/^Não deu para compactar agora: .+/)
  expect(await ui.find({ key: 'compactar' })).toBeDefined()
  await ui.unmount()
})

// --- #140: precisa de você × sua vez × PRs aguardando ---

test('#140: só a sua vez não ganha destaque nem conta; aparece neutra, e "Ver" separa os grupos', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p7' })
  const p7 = CENARIOS.p7
  const suaVez = p7.precisam.maquina.map((i) => ({ ...i, nivel: 'sua-vez' as const, porque: 'sua-vez' as const, urgente: false }))
  f.estado.painel = { ...p7, precisam: { total: 0, suaVez: suaVez.length, porConta: [], familia: [], maquina: suaVez } }
  await f.relogio.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  const linha = await ui.find({ key: 'precisam' })
  // Sem o amarelo de quem está bloqueada: borda neutra.
  expect(linha?.props.borderColor).not.toBe(paleta.yellow['500'])
  expect(linha?.props.backgroundColor).toBe(paleta.gray['800'])
  expect(linha?.text).toMatch(/ninguém mais precisa de você · 3 na sua vez/)
  expect(await ui.find({ type: 'Text', text: /precisam? de você$/ })).toBeUndefined()
  expect(f.status.at(-1)).toMatch(/ninguém mais$/)
  // P1: com zero, sem o "Ver"; a sua vez fica ao lado, neutra.
  expect(await ui.find({ key: 'ver-precisam' })).toBeUndefined()
  await ui.unmount()
})

test('#140: quem precisa de você fica em destaque, com o motivo; a sua vez soma ao lado, sem destaque', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p7' })
  const p7 = CENARIOS.p7
  const [a, b, c] = p7.precisam.maquina
  const maquina = [
    { ...a!, nivel: 'precisa' as const, porque: 'decisao' as const },
    { ...b!, nivel: 'precisa' as const, porque: 'pergunta' as const },
    { ...c!, nivel: 'sua-vez' as const, porque: 'sua-vez' as const },
  ]
  f.estado.painel = { ...p7, precisam: { ...p7.precisam, total: 2, suaVez: 1, maquina } }
  await f.relogio.advance(5_000)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  expect((await ui.find({ key: 'precisam' }))?.props.borderColor).toBe(paleta.yellow['500'])
  expect((await ui.find({ key: 'precisam' }))?.text).toMatch(/2 precisam de você.*Pede decisão.*Pergunta.*1 na sua vez/s)
  await ui.unmount()
})

test('#140: PRs aguardando aprovação num indicador próprio, com a lista de links', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  const prs = Array.from({ length: 7 }, (_, i) => ({
    numero: 100 + i,
    url: `https://github.com/exemplo/simulacao/pull/${100 + i}`,
    repo: 'exemplo/simulacao',
    titulo: `#${40 + i} Uma issue sintética`,
    sessao: { id: `sim-${i}`, titulo: `sessao-${i}`, local: null },
  }))
  f.estado.painel = { ...CENARIOS.p1, prs: { total: 7, itens: prs } }
  await f.relogio.advance(5_000)
  for (const base of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(base, 120) })
    expect((await ui.find({ key: 'prs' }))?.text).toMatch(base === LARGO ? /7 PRs aguardando sua aprovação/ : /7 PRs p\/ aprovar/)
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  await ui.press({ key: 'ver-prs' })
  expect(await ui.find({ type: 'Text', text: /PRS AGUARDANDO SUA APROVAÇÃO · 7/ })).toBeDefined()
  const links = (await ui.findAll({ type: 'Link' })).filter((l) => /\/pull\/1\d\d$/.test(l.props.href))
  expect(links).toHaveLength(7)
  expect(links[0]!.props.label).toMatch(/^PR #100 · #40 Uma issue sintética/)
  await ui.press({ key: 'fechar-prs' })
  expect(await ui.find({ key: 'card-sessao' })).toBeDefined()
  await ui.unmount()
  // Sem PR aguardando: nenhum indicador.
  f.estado.painel = { ...CENARIOS.p1, prs: { total: 0, itens: [] } }
  await f.relogio.advance(5_000)
  const sem = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...PANE })
  expect(await sem.find({ key: 'prs' })).toBeUndefined()
  await sem.unmount()
})

// --- 0.0.11: o contexto depois de compactar e o "Compactar" sem esmagar a telemetria ---

test('contexto: vale o do engine (o da barra do Claude Code), que já caiu depois do /compact; o do núcleo é a reserva', async ($, on) => {
  let percent: number | null = 17
  on('session.usage', async () => ({ value: { startedAt: AGORA, context: percent === null ? { window: 1_000_000 } : { tokens: percent * 10_000, window: 1_000_000, percent }, rateLimits: [] } }))
  const f = await abrir($, on, { cenario: 'p1' })
  // O núcleo ainda diz 89% (o pico de antes da compactação).
  f.estado.painel = { ...CENARIOS.p1, contexto: { usados: 890_000, limite: 1_000_000, pct: 89 } }
  await f.relogio.advance(5_000)
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  expect(await ui.find({ type: 'Text', text: '17%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '89%' })).toBeUndefined()
  expect((await ui.find({ key: 'compactar' }))?.props.variant).toBeUndefined()
  await ui.unmount()
  // Sem o número do engine: o do núcleo.
  percent = null
  await f.relogio.advance(5_000)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  expect(await ui.find({ type: 'Text', text: '89%' })).toBeDefined()
  await ui.unmount()
})

test('"Compactar agora" não quebra a grade 2×2: toma o lugar do tile Background, nas duas larguras e com pouca altura', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p1' })
  f.estado.painel = { ...CENARIOS.p1, contexto: { usados: 172_000, limite: 200_000, pct: 86 }, custo: { usd: 155.32, serie: [0, 155.32], estimativa: true } }
  await f.relogio.advance(5_000)
  for (const [base, linhas] of [[LARGO, 120], [PANE, 45]] as const) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(base, linhas) })
    for (const kpi of ['kpi-contexto', 'kpi-custo', 'kpi-tokens', 'kpi-compactar']) expect(await ui.find({ key: kpi })).toBeDefined()
    expect((await ui.find({ key: 'compactar' }))?.props.label).toBe('Compactar agora')
    const card = await ui.find({ key: 'card-contexto' })
    expect(card?.props.height).toBe(9)
    // O cabeçalho continua o do P1.
    expect(card?.text).toMatch(/CONTEXTO E CUSTO\s*estimativa/)
    await ui.unmount()
  }
})

// --- #140 (6 e 7): a pergunta com que a sessão terminou o turno, no topo ---

test('#140: a caixa de próximo passo (wrap_up com ask) vai para o topo, inteira; o botão manda a resposta ao chat', async ($, on) => {
  const enviados: { text: string; asUser?: boolean }[] = []
  on('tool.call', async () => ({ result: 'ok' }))
  on('prompt.submit', async (_$: unknown, e: { text: string; origin?: { kind?: string; asUser?: boolean } }) => {
    enviados.push({ text: e.text, asUser: e.origin?.asUser })
    return { text: e.text }
  })
  const f = await abrir($, on, { cenario: 'p1' })
  const ask = 'Faço o merge do #141 agora ou espero o Fernando validar a 0.0.11 no painel dele antes de seguir?'
  await ($ as any).tool.call({
    tool: 'mcp__ccd_turn__wrap_up',
    recap: 'feito',
    ask,
    actions: [
      { label: 'Merge agora', message: 'Pode fazer o merge do #141.' },
      { label: 'Esperar' },
      { action: 'create_pr' },
    ],
  })
  await f.relogio.advance(10)
  for (const base of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(base, 120) })
    const faixa = await ui.find({ key: 'pergunta' })
    expect(faixa).toBeDefined()
    // O texto inteiro, quebrando linha, nunca cortado.
    const t = await ui.find({ type: 'Text', text: ask })
    expect(t?.props.wrap).toBe('wrap')
    expect((await ui.find({ key: 'responder-0' }))?.props.label).toBe('Merge agora')
    expect((await ui.find({ key: 'responder-1' }))?.props.label).toBe('Esperar')
    // A ação do app não tem mensagem: no chat.
    expect(faixa?.text).toMatch(/create_pr: no chat ↓/)
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  await ui.press({ key: 'responder-0' })
  for (let i = 0; i < 20 && !enviados.length; i++) await f.relogio.advance(10)
  expect(enviados).toEqual([{ text: 'Pode fazer o merge do #141.', asUser: true }])
  expect(await ui.find({ key: 'pergunta' })).toBeUndefined()
  await ui.unmount()
})

test('#140: o wrap_up sem pergunta não mostra nada; o da pessoa no chat tira a pergunta', async ($, on) => {
  on('tool.call', async () => ({ result: 'ok' }))
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  const f = await abrir($, on, { cenario: 'p1' })
  await ($ as any).tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'feito' })
  await f.relogio.advance(10)
  let ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  expect(await ui.find({ key: 'pergunta' })).toBeUndefined()
  await ui.unmount()
  await ($ as any).tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'feito', ask: 'Sigo?' })
  await f.relogio.advance(10)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  expect(await ui.find({ key: 'pergunta' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /responder no chat ↓/ })).toBeDefined()
  await ui.unmount()
  // A pessoa respondeu no chat.
  await ($ as any).prompt.submit({ text: 'sim' })
  await f.relogio.advance(10)
  ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  expect(await ui.find({ key: 'pergunta' })).toBeUndefined()
  await ui.unmount()
})

test('#140: a pergunta fica no painel até a pessoa responder; mensagens automáticas não a tiram', async ($, on) => {
  on('tool.call', async () => ({ result: 'ok' }))
  on('prompt.submit', async (_$: unknown, e: { text: string }) => ({ text: e.text }))
  const f = await abrir($, on, { cenario: 'p1' })
  await ($ as any).tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'feito', ask: 'Sigo com o merge?' })
  await f.relogio.advance(10)
  const temPergunta = async () => {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
    const achou = (await ui.find({ key: 'pergunta' })) !== undefined
    await ui.unmount()
    return achou
  }
  expect(await temPergunta()).toBe(true)
  // Outra sessão, uma notificação de tarefa, um gatilho agendado, um plugin falando por si: a pergunta fica.
  for (const origin of [{ kind: 'peer' }, { kind: 'task-notification' }, { kind: 'scheduled-trigger' }, { kind: 'plugin', name: 'outro' }, { kind: 'unclassified' }]) {
    await ($ as any).prompt.submit({ text: 'mensagem automática', origin })
    await f.relogio.advance(10)
    expect(await temPergunta()).toBe(true)
  }
  // Guardada no $.state: um desenho novo (reload do painel) e os ticks seguintes ainda a mostram.
  await f.relogio.advance(60_000)
  expect(await temPergunta()).toBe(true)
  // A pessoa escreveu no Desktop (o host do SDK): sai.
  await ($ as any).prompt.submit({ text: 'pode', origin: { kind: 'sdk' } })
  await f.relogio.advance(10)
  expect(await temPergunta()).toBe(false)
  // Digitada no terminal, também.
  await ($ as any).tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'feito', ask: 'E agora?' })
  await f.relogio.advance(10)
  expect(await temPergunta()).toBe(true)
  await ($ as any).prompt.submit({ text: 'segue', origin: { kind: 'composer' } })
  await f.relogio.advance(10)
  expect(await temPergunta()).toBe(false)
})

test('#140: o AskUserQuestion aparece no topo com as perguntas e as opções inteiras, até a pessoa responder', async ($, on) => {
  let soltar: (() => void) | null = null
  on('tool.call', async () => {
    await new Promise<void>((r) => (soltar = r))
    return { result: { answers: {} } }
  })
  const f = await abrir($, on, { cenario: 'p1' })
  const chamada = ($ as any).tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        header: 'Banco',
        question: 'Nos testes de integração, sigo com SQLite em memória ou subo um Postgres no Docker para chegar mais perto da produção?',
        multiSelect: false,
        options: [
          { label: 'SQLite em memória', description: 'rápido, sem dependência' },
          { label: 'Postgres no Docker', description: 'igual à produção' },
        ],
      },
    ],
  })
  for (let i = 0; i < 20 && !soltar; i++) await f.relogio.advance(10)
  for (const base of [PANE, LARGO]) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(base, 120) })
    const faixa = await ui.find({ key: 'pergunta' })
    expect(faixa?.text).toMatch(/Banco · Nos testes de integração, sigo com SQLite em memória ou subo um Postgres no Docker para chegar mais perto da produção\?/)
    expect(faixa?.text).toMatch(/SQLite em memória · rápido, sem dependência/)
    expect(faixa?.text).toMatch(/Postgres no Docker · igual à produção/)
    expect(faixa?.text).toMatch(/responder no chat ↓/)
    // Sem botões de resposta: o diálogo do engine é que responde.
    expect(await ui.find({ key: 'responder-0' })).toBeUndefined()
    await ui.unmount()
  }
  soltar!()
  await chamada
  await f.relogio.advance(10)
  const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(LARGO, 120) })
  expect(await ui.find({ key: 'pergunta' })).toBeUndefined()
  await ui.unmount()
})


test('P1: o card Contexto e custo tem os quatro tiles nas duas larguras, mesmo com pouca altura', async ($, on) => {
  await abrir($, on, { cenario: 'p1' })
  for (const [base, linhas] of [[PANE, 45], [LARGO, 30]] as const) {
    const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(base, linhas) })
    expect((await ui.find({ key: 'card-contexto' }))?.props.height).toBe(9)
    for (const kpi of ['kpi-contexto', 'kpi-custo', 'kpi-tokens', 'kpi-background']) expect(await ui.find({ key: kpi })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CONTEXTO E CUSTO/ })).toBeDefined()
    await ui.unmount()
  }
})

test('P1: os cards de Subagentes e Sessões filhas nunca aparecem só com o cabeçalho; com pelo menos um item, ou na faixa de resumos', async ($, on) => {
  const f = await abrir($, on, { cenario: 'p4' })
  f.estado.painel = carregado()
  await f.relogio.advance(5_000)
  for (const base of [PANE, LARGO]) {
    for (const linhas of [41, 50, 60, 80, 120]) {
      const ui = await $.ui.mount({ plugin: 'ahrena-console', surface: 'desktop', ...alto(base, linhas) })
      for (const [card, prefixo] of [['card-subagentes', 'sub-'], ['card-filhas', 'filha-']] as const) {
        if (!(await ui.find({ key: card }))) continue
        expect((await ui.findAll({ type: 'Box' })).filter((b) => b.key?.startsWith(prefixo)).length).toBeGreaterThan(0)
      }
      await ui.unmount()
    }
  }
})
