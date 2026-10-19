// O contrato entre a sessão e o núcleo para responder pelo console, sem `$`:
// montar o pedido, conferir a resposta e a política do que nunca sai do
// terminal. Tudo aqui é puro, para os testes chamarem direto.

export type Tipo = 'permissao' | 'pergunta' | 'plano'

export type Pedido = {
  id: string
  sessao: string
  tipo: Tipo
  ferramenta: string
  entrada: unknown
  digest: string
  expiraEm: string
  // O console só pode negar: a política ou o teto da organização tiram o "permitir".
  soNegar: boolean
}

export type Decisao = 'permitir' | 'negar' | 'responder' | 'aprovar' | 'recusar'

export type Resposta = {
  pedido: string
  digest: string
  decisao: Decisao
  quem: string
  canal: 'painel' | 'artefato' | 'hub'
  motivo?: string
  respostas?: Record<string, string>
  modo?: string
}

const DECISOES: Record<Tipo, readonly Decisao[]> = {
  permissao: ['permitir', 'negar'],
  pergunta: ['responder', 'negar'],
  plano: ['aprovar', 'recusar'],
}

// Modos que uma aprovação de plano pelo console pode ligar. Nunca
// `bypassPermissions`, `dontAsk` nem `auto`: esses só pela pessoa, no terminal.
export const MODOS_DO_PLANO = ['default', 'acceptEdits'] as const

const COMANDO_SEMPRE_LOCAL = [
  /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\b/,
  /\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)/,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/,
  /\bsudo\b/,
  /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/,
]

const ARQUIVO_SEMPRE_LOCAL = [
  /(^|\/)\.claude\/(settings[^/]*\.json|hooks\/)/,
  /(^|\/)\.mcp\.json$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.ssh\//,
  /(^|\/)\.ahrena-console\//,
]

/**
 * Chamadas que o console nunca libera: só a pessoa no terminal libera. O
 * console ainda pode negar, que é o lado seguro.
 */
export function sempreLocal(ferramenta: string, entrada: unknown): boolean {
  const campos = (entrada ?? {}) as Record<string, unknown>
  if (ferramenta === 'Bash' && typeof campos.command === 'string')
    return COMANDO_SEMPRE_LOCAL.some(r => r.test(campos.command as string))
  const caminho = campos.file_path ?? campos.notebook_path
  if (typeof caminho === 'string') return ARQUIVO_SEMPRE_LOCAL.some(r => r.test(caminho))
  return false
}

/** JSON com as chaves em ordem, para o digest não depender da ordem. */
export function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(',')}]`
  if (valor !== null && typeof valor === 'object') {
    const obj = valor as Record<string, unknown>
    const chaves = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
    return `{${chaves.map(k => `${JSON.stringify(k)}:${canonico(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(valor ?? null)
}

/**
 * O digest liga a resposta a exatamente esta chamada: sessão, ferramenta, id
 * da chamada e argumentos. Uma resposta dada para outra coisa não serve aqui.
 */
export async function digestDe(p: Pick<Pedido, 'sessao' | 'tipo' | 'ferramenta' | 'entrada'> & { chamada: string }): Promise<string> {
  const bytes = new TextEncoder().encode(canonico(p))
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function montarPedido(args: {
  sessao: string
  tipo: Tipo
  ferramenta: string
  entrada: unknown
  chamada: string
  esperaMs: number
  agora: Date
  soNegar: boolean
}): Promise<Pedido> {
  const { sessao, tipo, ferramenta, entrada, chamada, esperaMs, agora, soNegar } = args
  return {
    id: crypto.randomUUID(),
    sessao,
    tipo,
    ferramenta,
    entrada,
    digest: await digestDe({ sessao, tipo, ferramenta, entrada, chamada }),
    expiraEm: new Date(agora.getTime() + esperaMs).toISOString(),
    soNegar,
  }
}

/**
 * Confere uma resposta do núcleo: do pedido certo, com o digest certo, dentro
 * do prazo, usada uma vez só, com uma decisão que o tipo aceita, de alguém.
 * Devolve a resposta aceita, ou o motivo da recusa.
 */
export function conferir(
  pedido: Pedido,
  bruta: unknown,
  agora: Date,
  usados: Set<string>,
): { aceita: Resposta } | { recusa: string } {
  const r = bruta as Partial<Resposta> | null
  if (r === null || typeof r !== 'object') return { recusa: 'resposta vazia' }
  if (r.pedido !== pedido.id) return { recusa: 'resposta de outro pedido' }
  if (r.digest !== pedido.digest) return { recusa: 'digest não confere' }
  if (usados.has(pedido.id)) return { recusa: 'resposta já usada' }
  if (agora.getTime() > Date.parse(pedido.expiraEm)) return { recusa: 'pedido expirado' }
  if (typeof r.quem !== 'string' || r.quem.trim() === '') return { recusa: 'resposta sem autor' }
  if (r.canal !== 'painel' && r.canal !== 'artefato' && r.canal !== 'hub') return { recusa: 'canal desconhecido' }
  if (r.decisao === undefined || !DECISOES[pedido.tipo].includes(r.decisao)) return { recusa: 'decisão inválida para o tipo' }
  const libera = r.decisao === 'permitir' || r.decisao === 'aprovar' || r.decisao === 'responder'
  if (libera && pedido.soNegar) return { recusa: 'só a pessoa no terminal libera esta chamada' }
  if (r.decisao === 'aprovar' && !(MODOS_DO_PLANO as readonly string[]).includes(r.modo ?? 'default'))
    return { recusa: `modo ${r.modo} não sai do console` }
  if (r.decisao === 'responder' && !respostasValidas(pedido.entrada, r.respostas))
    return { recusa: 'respostas não batem com as perguntas' }
  usados.add(pedido.id)
  return { aceita: r as Resposta }
}

/** Cada resposta tem de ser de uma pergunta feita, e toda pergunta respondida. */
function respostasValidas(entrada: unknown, respostas: unknown): boolean {
  if (respostas === null || typeof respostas !== 'object') return false
  const perguntas = ((entrada as { questions?: { question: string }[] }).questions ?? []).map(q => q.question)
  const dadas = Object.entries(respostas as Record<string, unknown>)
  return (
    perguntas.length > 0 &&
    dadas.length === perguntas.length &&
    dadas.every(([q, a]) => perguntas.includes(q) && typeof a === 'string' && a.trim() !== '')
  )
}

/** Quantas esperas longas (até 25 s cada) cabem em `esperaMs`. */
export function esperas(esperaMs: number): number[] {
  const fatias: number[] = []
  for (let resta = esperaMs; resta > 0; resta -= 25_000) fatias.push(Math.min(resta, 25_000))
  return fatias
}
