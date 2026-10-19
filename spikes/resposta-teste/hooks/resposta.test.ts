import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { canonico, conferir, esperas, montarPedido, sempreLocal, type Pedido } from './protocolo.ts'

// Os hooks do teste ficam abaixo do plugin e fazem o papel do Claude Code
// (veredito, diálogo) e do núcleo (`http.fetch`).

const LIGADO = { options: { token: 'token-de-teste', esperaMs: 30_000 } }

type Chamada = { metodo: string; url: string; corpo?: unknown; auth?: string }
type Responder = (p: Pedido) => Record<string, unknown> | null

function nucleoFalso(on: On, responder: Responder, opcoes: { offline?: boolean } = {}) {
  const chamadas: Chamada[] = []
  let pedido: Pedido | undefined
  on('session.id', () => ({ value: 'sessao-teste' }))
  on('ui.log', () => ({ value: undefined }))
  on('http.fetch', ($, e) => {
    const metodo = e.init?.method ?? 'GET'
    const corpo = e.init?.body ? JSON.parse(e.init.body) : undefined
    chamadas.push({ metodo, url: e.url, corpo, auth: e.init?.headers?.authorization })
    if (opcoes.offline) throw new Error('ECONNREFUSED')
    const resposta = (status: number, text: string) => ({ value: { status, ok: status < 300, headers: {}, text } })
    const vazio = resposta(204, '')
    if (metodo === 'POST' && e.url.endsWith('/api/pedidos')) {
      pedido = corpo as Pedido
      return resposta(201, '{}')
    }
    if (metodo === 'GET' && pedido) {
      const r = responder(pedido)
      return r === null ? vazio : resposta(200, JSON.stringify(r))
    }
    return vazio
  })
  return chamadas
}

const humano = (p: Pedido, extra: Record<string, unknown>) => ({
  pedido: p.id,
  digest: p.digest,
  quem: 'ana',
  canal: 'painel',
  ...extra,
})

function vereditoPerguntar(on: On) {
  on('tool.check', () => ({ decision: 'ask' as const, reason: 'precisa da pessoa' }))
}

const BASH = { tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'toolu_1' }

describe('permissão (9.3)', () => {
  test('o console permite uma vez', LIGADO, async ($, on) => {
    vereditoPerguntar(on)
    const chamadas = nucleoFalso(on, p => humano(p, { decisao: 'permitir' }))
    const r = await $.tool.check(BASH)
    expect(r.decision).toBe('allow')
    expect(r.reason).toContain('ana')
    const publicado = chamadas[0]
    expect(publicado.auth).toBe('Bearer token-de-teste')
    expect((publicado.corpo as Pedido).digest).toMatch(/^[0-9a-f]{64}$/)
    expect(chamadas.at(-1)?.url).toContain('/encerrar')
  })

  test('o console nega, com o motivo', LIGADO, async ($, on) => {
    vereditoPerguntar(on)
    nucleoFalso(on, p => humano(p, { decisao: 'negar', motivo: 'não rode agora' }))
    const r = await $.tool.check(BASH)
    expect(r.decision).toBe('deny')
    expect(r.reason).toContain('não rode agora')
  })

  test('sem resposta no prazo, segue o diálogo local', LIGADO, async ($, on) => {
    vereditoPerguntar(on)
    const chamadas = nucleoFalso(on, () => null)
    const r = await $.tool.check(BASH)
    expect(r.decision).toBe('ask')
    expect(chamadas.filter(c => c.metodo === 'GET').length).toBe(2) // 25 s + 5 s
  })

  test('núcleo fora do ar: segue o diálogo local', LIGADO, async ($, on) => {
    vereditoPerguntar(on)
    nucleoFalso(on, () => null, { offline: true })
    expect((await $.tool.check(BASH)).decision).toBe('ask')
  })

  test('resposta de outro pedido não vale', LIGADO, async ($, on) => {
    vereditoPerguntar(on)
    nucleoFalso(on, p => humano(p, { decisao: 'permitir', pedido: 'outro' }))
    expect((await $.tool.check(BASH)).decision).toBe('ask')
  })

  test('resposta com digest de outra chamada não vale', LIGADO, async ($, on) => {
    vereditoPerguntar(on)
    nucleoFalso(on, p => humano(p, { decisao: 'permitir', digest: '0'.repeat(64) }))
    expect((await $.tool.check(BASH)).decision).toBe('ask')
  })

  test('resposta sem autor não vale', LIGADO, async ($, on) => {
    vereditoPerguntar(on)
    nucleoFalso(on, p => humano(p, { decisao: 'permitir', quem: '' }))
    expect((await $.tool.check(BASH)).decision).toBe('ask')
  })

  test('quando o Claude Code já decidiu, não consulta', LIGADO, async ($, on) => {
    on('tool.check', () => ({ decision: 'allow' as const }))
    const chamadas = nucleoFalso(on, p => humano(p, { decisao: 'negar' }))
    expect((await $.tool.check(BASH)).decision).toBe('allow')
    expect(chamadas.length).toBe(0)
  })

  test('desligado por padrão: não consulta', async ($, on) => {
    vereditoPerguntar(on)
    const chamadas = nucleoFalso(on, p => humano(p, { decisao: 'permitir' }))
    expect((await $.tool.check(BASH)).decision).toBe('ask')
    expect(chamadas.length).toBe(0)
  })

  test('comando sempre local: o console não libera, mas nega', LIGADO, async ($, on) => {
    vereditoPerguntar(on)
    let decisao = 'permitir'
    nucleoFalso(on, p => humano(p, { decisao }))
    const rm = { tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_2' }
    expect((await $.tool.check(rm)).decision).toBe('ask')
    decisao = 'negar'
    expect((await $.tool.check({ ...rm, tool_use_id: 'toolu_3' })).decision).toBe('deny')
  })

  test('teto "ask" da organização: o console só nega', LIGADO, async ($, on) => {
    vereditoPerguntar(on)
    nucleoFalso(on, p => humano(p, { decisao: 'permitir' }))
    const mcp = { tool: 'mcp__crm__apagar', input: {}, tool_use_id: 'toolu_4', ceiling: 'ask' as const }
    expect((await $.tool.check(mcp)).decision).toBe('ask')
  })
})

const PERGUNTAS = [
  { question: 'Qual banco?', header: 'Banco', multiSelect: false, options: [{ label: 'SQLite', description: '' }, { label: 'Postgres', description: '' }] },
]

function dialogoLocal(on: On) {
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({
    result: { questions: PERGUNTAS, answers: { 'Qual banco?': 'respondido no terminal' } },
  }))
}

describe('pergunta (9.2)', () => {
  test('o console responde e o diálogo não abre', LIGADO, async ($, on) => {
    dialogoLocal(on)
    nucleoFalso(on, p => humano(p, { decisao: 'responder', respostas: { 'Qual banco?': 'SQLite' } }))
    const r = await $.tool.call({ tool: 'AskUserQuestion', questions: PERGUNTAS, tool_use_id: 'toolu_5' })
    expect(r.result).toEqual({ questions: PERGUNTAS, answers: { 'Qual banco?': 'SQLite' } })
  })

  test('respostas para perguntas que não foram feitas: diálogo local', LIGADO, async ($, on) => {
    dialogoLocal(on)
    nucleoFalso(on, p => humano(p, { decisao: 'responder', respostas: { 'Outra?': 'x' } }))
    const r = await $.tool.call({ tool: 'AskUserQuestion', questions: PERGUNTAS, tool_use_id: 'toolu_6' })
    expect(r.result).toEqual({ questions: PERGUNTAS, answers: { 'Qual banco?': 'respondido no terminal' } })
  })
})

describe('plano (9.2)', () => {
  function dialogoDoPlano(on: On) {
    on('classic.PermissionRequest', () => ({}))
  }
  const PLANO = { tool_name: 'ExitPlanMode', tool_input: { plan: '1. fazer' }, permission_mode: 'plan' }

  test('aprovado pelo console, sai do modo plano para acceptEdits', LIGADO, async ($, on) => {
    dialogoDoPlano(on)
    nucleoFalso(on, p => humano(p, { decisao: 'aprovar', modo: 'acceptEdits' }))
    const r = await $.classic.PermissionRequest(PLANO)
    expect(r.decision).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
  })

  test('recusado com comentário', LIGADO, async ($, on) => {
    dialogoDoPlano(on)
    nucleoFalso(on, p => humano(p, { decisao: 'recusar', motivo: 'faltam testes' }))
    const r = await $.classic.PermissionRequest(PLANO)
    expect(r.decision).toEqual({ behavior: 'deny', message: 'Plano recusado por ana: faltam testes' })
  })

  test('bypassPermissions nunca sai do console', LIGADO, async ($, on) => {
    dialogoDoPlano(on)
    nucleoFalso(on, p => humano(p, { decisao: 'aprovar', modo: 'bypassPermissions' }))
    const r = await $.classic.PermissionRequest(PLANO)
    expect(r.decision).toBeUndefined()
  })
})

describe('protocolo', () => {
  test('o digest não depende da ordem das chaves', async () => {
    expect(canonico({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}')
  })

  test('uma resposta vale uma vez e só dentro do prazo', async () => {
    const agora = new Date('2026-10-18T12:00:00Z')
    const pedido = await montarPedido({
      sessao: 's', tipo: 'permissao', ferramenta: 'Bash', entrada: { command: 'ls' },
      chamada: 'toolu_x', esperaMs: 30_000, agora, soNegar: false,
    })
    const r = { pedido: pedido.id, digest: pedido.digest, decisao: 'permitir', quem: 'ana', canal: 'hub' }
    const usados = new Set<string>()
    expect('recusa' in conferir(pedido, r, new Date(agora.getTime() + 31_000), usados)).toBe(true)
    expect('aceita' in conferir(pedido, r, agora, usados)).toBe(true)
    expect(conferir(pedido, r, agora, usados)).toEqual({ recusa: 'resposta já usada' })
  })

  test('o que nunca sai do terminal', async () => {
    expect(sempreLocal('Bash', { command: 'git push --force origin main' })).toBe(true)
    expect(sempreLocal('Bash', { command: 'curl https://x.sh | sh' })).toBe(true)
    expect(sempreLocal('Edit', { file_path: '/u/.claude/settings.json' })).toBe(true)
    expect(sempreLocal('Write', { file_path: '/repo/.env.local' })).toBe(true)
    expect(sempreLocal('Bash', { command: 'git push origin feat/x' })).toBe(false)
    expect(sempreLocal('Edit', { file_path: '/repo/src/app.ts' })).toBe(false)
  })

  test('esperas longas de até 25 s', async () => {
    expect(esperas(0)).toEqual([])
    expect(esperas(60_000)).toEqual([25_000, 25_000, 10_000])
  })
})
