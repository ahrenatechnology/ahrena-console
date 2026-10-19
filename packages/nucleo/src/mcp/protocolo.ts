// O protocolo MCP do núcleo, sem transporte: recebe uma mensagem JSON-RPC e devolve a resposta.
// O HTTP (http.ts) e o stdio (stdio.ts) só levam e trazem as mensagens.
//
// Feito à mão, sem o SDK oficial: o servidor só lista e chama ferramentas de leitura, e isso é
// `initialize`, `ping`, `tools/list` e `tools/call`. O SDK traria o zod e um transporte com
// sessão que, no modo stateless, é criado e jogado fora a cada pedido (era assim no spike).
//
// Versões: responde às duas em circulação (2025-03-26 e 2025-06-18), à de 2025-11-25 e à antiga
// 2024-11-05. Quem pede uma que conhecemos recebe a mesma; quem pede outra recebe a mais nova,
// como manda a spec. `structuredContent` e `outputSchema` são de 2025-06-18 em diante; o cliente
// mais velho os ignora e lê o texto.

export const VERSOES_DO_PROTOCOLO = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export type VersaoDoProtocolo = (typeof VERSOES_DO_PROTOCOLO)[number];
export const VERSAO_MAIS_NOVA: VersaoDoProtocolo = VERSOES_DO_PROTOCOLO[0];

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type ObjetoJson = { [k: string]: Json };

/** JSON Schema da entrada ou da saída de uma ferramenta (o subconjunto que usamos). */
export type Esquema = ObjetoJson & { type: 'object' };

export interface ContextoDaChamada {
  /** Aborta quando o cliente desiste (a conexão HTTP fechou). Ferramenta longa deve ouvir. */
  sinal: AbortSignal;
  /** A versão negociada, quando o transporte a conhece (cabeçalho `MCP-Protocol-Version`). */
  versao: string | null;
}

/** O que a ferramenta devolve: um texto curto para o modelo e o mesmo dado estruturado. */
export interface ResultadoDaFerramenta {
  texto: string;
  dados: ObjetoJson;
}

/**
 * Uma ferramenta do servidor. Só de leitura (proposta 0.0.1): `annotations.readOnlyHint` sai
 * sempre `true`. Para acrescentar uma, veja src/mcp/README.md.
 */
export interface Ferramenta {
  nome: string;
  titulo: string;
  descricao: string;
  entrada: Esquema;
  saida?: Esquema;
  /** Chamada só depois que `entrada` passou por `lerArgumentos` (validacao.ts) dentro dela. */
  executar(args: ObjetoJson, ctx: ContextoDaChamada): Promise<ResultadoDaFerramenta>;
}

/** Erro que a ferramenta quer mostrar ao modelo: volta como resultado com `isError`, não como erro de protocolo. */
export class ErroDaFerramenta extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErroDaFerramenta';
  }
}

/** Erro de argumento: volta com `isError`, para o modelo corrigir e tentar de novo. */
export class ErroDeArgumento extends ErroDaFerramenta {
  constructor(message: string) {
    super(message);
    this.name = 'ErroDeArgumento';
  }
}

export const ERROS = {
  parse: -32700,
  pedidoInvalido: -32600,
  metodoDesconhecido: -32601,
  parametrosInvalidos: -32602,
  interno: -32603,
} as const;

type Id = string | number | null;
export interface RespostaJsonRpc {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** No máximo 10 ferramentas (proposta 0.0.1, feature 9). */
export const MAXIMO_DE_FERRAMENTAS = 10;
const NOME = /^[a-z][a-z0-9_]{0,63}$/;

export interface OpcoesDoServidorMcp {
  nome?: string;
  versao: string;
  /** Texto para o modelo no `initialize`: o que o servidor responde e como ler. */
  instrucoes?: string;
  log?: (mensagem: string) => void;
}

export class ServidorMcp {
  private readonly ferramentas = new Map<string, Ferramenta>();
  private readonly nome: string;
  private readonly versao: string;
  private readonly instrucoes: string | undefined;
  private readonly log: (mensagem: string) => void;

  constructor({ nome = 'ahrena-console', versao, instrucoes, log = () => {} }: OpcoesDoServidorMcp) {
    this.nome = nome;
    this.versao = versao;
    this.instrucoes = instrucoes;
    this.log = log;
  }

  /** Acrescenta uma ferramenta. Nome repetido, fora do padrão ou além do limite é erro de quem registra. */
  registrar(f: Ferramenta): this {
    if (!NOME.test(f.nome)) throw new Error(`nome de ferramenta inválido: ${f.nome}`);
    if (this.ferramentas.has(f.nome)) throw new Error(`ferramenta já registrada: ${f.nome}`);
    if (this.ferramentas.size >= MAXIMO_DE_FERRAMENTAS) throw new Error(`no máximo ${MAXIMO_DE_FERRAMENTAS} ferramentas`);
    this.ferramentas.set(f.nome, f);
    return this;
  }

  get nomes(): string[] {
    return [...this.ferramentas.keys()];
  }

  /**
   * Atende uma mensagem ou um lote (2025-03-26 aceita lote; as outras versões, não, mas aceitar
   * não quebra ninguém). Devolve `null` quando não há o que responder (só notificações e respostas).
   */
  async atender(mensagem: unknown, ctx: Partial<ContextoDaChamada> = {}): Promise<RespostaJsonRpc | RespostaJsonRpc[] | null> {
    const c: ContextoDaChamada = { sinal: ctx.sinal ?? new AbortController().signal, versao: ctx.versao ?? null };
    if (Array.isArray(mensagem)) {
      if (mensagem.length === 0) return erro(null, ERROS.pedidoInvalido, 'lote vazio');
      const respostas = (await Promise.all(mensagem.map((m) => this.uma(m, c)))).filter((r): r is RespostaJsonRpc => r !== null);
      return respostas.length > 0 ? respostas : null;
    }
    return this.uma(mensagem, c);
  }

  private async uma(m: unknown, ctx: ContextoDaChamada): Promise<RespostaJsonRpc | null> {
    if (!m || typeof m !== 'object' || (m as { jsonrpc?: unknown }).jsonrpc !== '2.0') return erro(null, ERROS.pedidoInvalido, 'não é JSON-RPC 2.0');
    const { id, method, params } = m as { id?: unknown; method?: unknown; params?: unknown };
    const temId = id !== undefined;
    if (temId && id !== null && typeof id !== 'string' && typeof id !== 'number') return erro(null, ERROS.pedidoInvalido, 'id inválido');
    // Resposta do cliente (não pedimos nada) ou notificação: nada a responder.
    if (typeof method !== 'string') return temId && ('result' in m || 'error' in m) ? null : erro((id as Id) ?? null, ERROS.pedidoInvalido, 'sem method');
    if (!temId) return null;
    const rid = id as Id;
    try {
      switch (method) {
        case 'initialize':
          return ok(rid, this.inicializar(params));
        case 'ping':
          return ok(rid, {});
        case 'tools/list':
          return ok(rid, { tools: [...this.ferramentas.values()].map(descrever) });
        case 'tools/call':
          return ok(rid, await this.chamar(params, ctx));
        default:
          return erro(rid, ERROS.metodoDesconhecido, `método desconhecido: ${method}`);
      }
    } catch (e) {
      if (e instanceof ErroDeProtocolo) return erro(rid, e.codigo, e.message);
      this.log(`erro em ${method}: ${(e as Error).message}`);
      return erro(rid, ERROS.interno, 'erro interno');
    }
  }

  private inicializar(params: unknown) {
    const pedida = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
    const versao = typeof pedida === 'string' && (VERSOES_DO_PROTOCOLO as readonly string[]).includes(pedida) ? pedida : VERSAO_MAIS_NOVA;
    return {
      protocolVersion: versao,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.nome, title: 'Ahrena Console', version: this.versao },
      ...(this.instrucoes ? { instructions: this.instrucoes } : {}),
    };
  }

  private async chamar(params: unknown, ctx: ContextoDaChamada) {
    const p = params as { name?: unknown; arguments?: unknown } | null;
    const f = typeof p?.name === 'string' ? this.ferramentas.get(p.name) : undefined;
    if (!f) throw new ErroDeProtocolo(ERROS.parametrosInvalidos, `ferramenta desconhecida: ${String(p?.name)}`);
    const args = p?.arguments ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return { content: [{ type: 'text', text: 'arguments precisa ser um objeto' }], isError: true };
    }
    try {
      const r = await f.executar(args as ObjetoJson, ctx);
      return { content: [{ type: 'text', text: r.texto }], structuredContent: r.dados, isError: false };
    } catch (e) {
      if (e instanceof ErroDaFerramenta) return { content: [{ type: 'text', text: e.message }], isError: true };
      throw e;
    }
  }
}

class ErroDeProtocolo extends Error {
  readonly codigo: number;
  constructor(codigo: number, message: string) {
    super(message);
    this.codigo = codigo;
  }
}

function descrever(f: Ferramenta) {
  return {
    name: f.nome,
    title: f.titulo,
    description: f.descricao,
    inputSchema: f.entrada,
    ...(f.saida ? { outputSchema: f.saida } : {}),
    annotations: { title: f.titulo, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

const ok = (id: Id, result: unknown): RespostaJsonRpc => ({ jsonrpc: '2.0', id, result });
export const erro = (id: Id, code: number, message: string): RespostaJsonRpc => ({ jsonrpc: '2.0', id, error: { code, message } });
