// As ordens do console para esta sessão (#61): /compact, /clear e ligar o Remote Control. Nenhum
// processo de fora roda um comando de barra numa sessão; o /ui pede ao núcleo, e este mod, que roda
// dentro da sessão, busca o pedido (GET /api/sessions/<id>/commands), roda o comando com
// `$.command.run` (o engine enfileira até a sessão ficar ociosa) e confirma com
// POST /api/sessions/<id>/commands/<orderId>/done { ok, reason }.
//
// Diferente do painel, que só consulta o núcleo com o painel aberto (decisão 0004), isto roda em toda
// sessão com o mod: sem isso a ordem nunca chegaria a uma sessão sem o painel aberto. É um GET barato,
// só desta sessão, a cada ORDERS_EVERY_MS; o núcleo entrega cada ordem uma vez só.
import { ownerHeaders } from './discover'
import type { EngineInterface as Engine } from 'claude-code'

export const ORDERS_EVERY_MS = 4000

let refusedOnce = false

type Kind = 'compact' | 'clear' | 'remote-control'
interface Order {
  orderId: string
  kind: Kind
}

/** Os nomes de comando que servem a cada ordem, na ordem em que se tenta. */
const COMMANDS: Record<Kind, readonly string[]> = {
  compact: ['compact'],
  clear: ['clear'],
  'remote-control': ['remote-control', 'rc'],
}

const MAX_REASON = 160

/** O comando respondeu com um texto que diz que não ligou (plano, organização): o motivo é o texto. */
const REFUSAL = /(not available|isn't available|not enabled|not allowed|is disabled|disabled by|não está disponível)/i

const parseOrders = (text: string | undefined): Order[] => {
  try {
    const body = JSON.parse(text ?? '') as { orders?: unknown }
    if (!Array.isArray(body.orders)) return []
    return body.orders.filter((o): o is Order => !!o && typeof o.orderId === 'string' && ['compact', 'clear', 'remote-control'].includes(o.kind))
  } catch {
    return []
  }
}

async function confirm($: Engine, core: string, sessionId: string, order: Order, ok: boolean, reason?: string) {
  try {
    await $.http.fetch(`http://${core}/api/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(order.orderId)}/done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await ownerHeaders($, core)) },
      body: JSON.stringify(ok ? { ok } : { ok, reason: (reason ?? 'sem motivo').slice(0, MAX_REASON) }),
    })
  } catch {
    // o núcleo some: a ordem vence sozinha do lado dele
  }
}

/** Roda uma ordem e diz ao núcleo como foi. Nunca rejeita. */
export async function runOrder($: Engine, core: string, sessionId: string, order: Order): Promise<void> {
  try {
    const available = new Set((await $.command.list()).map((c) => c.name))
    const command = COMMANDS[order.kind].find((n) => available.has(n))
    if (!command) return confirm($, core, sessionId, order, false, `esta versão do Claude Code não tem o comando /${COMMANDS[order.kind][0]}`)
    const result = await $.command.run({ command })
    if (order.kind === 'remote-control' && result?.text && REFUSAL.test(result.text)) {
      return confirm($, core, sessionId, order, false, result.text.replace(/\s+/g, ' ').trim())
    }
    await confirm($, core, sessionId, order, true)
  } catch (err) {
    await confirm($, core, sessionId, order, false, (err as Error)?.message ?? String(err))
  }
}

/** Uma busca: pede as ordens desta sessão e roda cada uma, sem esperar a sessão ficar ociosa para a próxima busca. */
export async function pollOrders($: Engine, core: string): Promise<void> {
  const sessionId = await $.session.id()
  const res = await $.http.fetch(`http://${core}/api/sessions/${encodeURIComponent(sessionId)}/commands`, { headers: await ownerHeaders($, core) })
  if (res.status === 403 && !refusedOnce) {
    // O núcleo recusou a busca: se o fetch do engine mandar `Sec-Fetch-Site`, nenhuma ordem chega. Avisa uma vez.
    refusedOnce = true
    $.ui.toast('O núcleo recusou a busca de ordens do console (403): /compact, /clear e Remote control pelo console não vão chegar a esta sessão.')
  }
  if (!res.ok) return
  for (const order of parseOrders(res.text)) void runOrder($, core, sessionId, order)
}
