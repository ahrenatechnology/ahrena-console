import type { EngineInterface, Register } from 'claude-code'
import { conferir, esperas, montarPedido, sempreLocal, type Pedido, type Resposta, type Tipo } from './protocolo.ts'

// Spike #58: antes de o Claude Code abrir um diálogo (permissão, pergunta,
// plano), a sessão publica o pedido no núcleo e espera um pouco pela resposta
// do console. Sem resposta válida, segue para o diálogo local, como sem o
// plugin. O plugin nunca decide sozinho.

type Config = { nucleo: string; token: string; esperaMs: number }

// Pedidos já respondidos neste carregamento: uma resposta vale uma vez.
const usados = new Set<string>()

async function publicar($: EngineInterface, cfg: Config, pedido: Pedido): Promise<boolean> {
  try {
    const r = await $.http.fetch(`${cfg.nucleo}/api/pedidos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(pedido),
    })
    return r.ok
  } catch {
    return false
  }
}

async function esperar($: EngineInterface, cfg: Config, pedido: Pedido): Promise<Resposta | undefined> {
  for (const ms of esperas(cfg.esperaMs)) {
    let r
    try {
      r = await $.http.fetch(`${cfg.nucleo}/api/pedidos/${pedido.id}/resposta?esperaMs=${ms}`, {
        headers: { authorization: `Bearer ${cfg.token}` },
      })
    } catch {
      return undefined
    }
    if (r.status === 204) continue
    if (!r.ok) return undefined
    let corpo: unknown
    try {
      corpo = JSON.parse(r.text)
    } catch {
      return undefined
    }
    const conferida = conferir(pedido, corpo, new Date(), usados)
    if ('aceita' in conferida) return conferida.aceita
    $.ui.log(`resposta do console recusada: ${conferida.recusa}`, { to: 'debug' })
    return undefined
  }
  return undefined
}

async function encerrar($: EngineInterface, cfg: Config, pedido: Pedido, desfecho: string): Promise<void> {
  try {
    await $.http.fetch(`${cfg.nucleo}/api/pedidos/${pedido.id}/encerrar`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ desfecho }),
    })
  } catch {
    // O núcleo expira o pedido sozinho.
  }
}

/** Publica, espera e encerra. Sem resposta aceita, `undefined`: vale o diálogo local. */
async function consultar(
  $: EngineInterface,
  cfg: Config,
  args: { tipo: Tipo; ferramenta: string; entrada: unknown; chamada: string; soNegar: boolean },
): Promise<Resposta | undefined> {
  if (cfg.esperaMs <= 0 || cfg.token === '') return undefined
  const sessao = await $.session.id()
  const pedido = await montarPedido({ ...args, sessao, esperaMs: cfg.esperaMs, agora: new Date() })
  if (!(await publicar($, cfg, pedido))) return undefined
  const resposta = await esperar($, cfg, pedido)
  await encerrar($, cfg, pedido, resposta ? `respondido pelo ${resposta.canal}` : 'segue no terminal')
  return resposta
}

// Ferramentas cujo diálogo é a própria pessoa: o `tool.check` não as libera.
const DA_PESSOA = new Set(['AskUserQuestion', 'ExitPlanMode'])

export const register: Register = (on, options) => {
  const cfg: Config = {
    nucleo: String(options.nucleo ?? 'http://127.0.0.1:4721'),
    token: String(options.token ?? ''),
    esperaMs: Number(options.esperaMs ?? 0),
  }

  // 9.3 · Permitir ou negar uma ferramenta, uma vez. Só entra quando o
  // veredito do Claude Code já é perguntar à pessoa.
  on('tool.check', async ($, e, next) => {
    const veredito = await next(e)
    if (veredito.decision !== 'ask' || e.tool_use_id === undefined || DA_PESSOA.has(e.tool)) return veredito
    const soNegar = e.ceiling === 'ask' || sempreLocal(e.tool, e.input)
    const r = await consultar($, cfg, {
      tipo: 'permissao',
      ferramenta: e.tool,
      entrada: e.input,
      chamada: e.tool_use_id,
      soNegar,
    })
    if (r === undefined) return veredito
    return r.decisao === 'permitir'
      ? { decision: 'allow', reason: `Permitido uma vez por ${r.quem}, pelo ${r.canal}.` }
      : { decision: 'deny', reason: r.motivo ? `Negado por ${r.quem}: ${r.motivo}` : `Negado por ${r.quem}, pelo ${r.canal}.` }
  }).catch(($, e, next) => next(e))

  // 9.2 · Responder perguntas. Respondida pelo console, a pergunta não abre
  // diálogo: o hook entrega o resultado da ferramenta.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const r = await consultar($, cfg, {
      tipo: 'pergunta',
      ferramenta: e.tool,
      entrada: { questions: e.questions },
      chamada: e.tool_use_id ?? '',
      soNegar: false,
    })
    if (r === undefined) return next(e)
    if (r.decisao === 'negar') return { deny: `${r.quem} preferiu não responder pelo console.` }
    return { result: { questions: e.questions, answers: r.respostas ?? {} } }
  }).catch(($, e, next) => next(e))

  // 9.2 · Aprovar ou recusar um plano. O `tool.check` não libera o
  // ExitPlanMode, e nenhum `$` muda o modo: só o PermissionRequest clássico.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (e.tool_name !== 'ExitPlanMode') return next(e)
    const r = await consultar($, cfg, {
      tipo: 'plano',
      ferramenta: e.tool_name,
      entrada: e.tool_input,
      chamada: '',
      soNegar: false,
    })
    if (r === undefined) return next(e)
    if (r.decisao === 'recusar')
      return { decision: { behavior: 'deny', message: r.motivo ? `Plano recusado por ${r.quem}: ${r.motivo}` : `Plano recusado por ${r.quem}.` } }
    return {
      decision: {
        behavior: 'allow',
        updatedPermissions: [{ type: 'setMode', mode: r.modo === 'acceptEdits' ? 'acceptEdits' : 'default', destination: 'session' }],
      },
    }
  }).catch(($, e, next) => next(e))
}
