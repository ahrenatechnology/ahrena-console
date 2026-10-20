// The core's MCP protocol, without a transport: takes a JSON-RPC message and returns the answer.
// HTTP (http.ts) and stdio (stdio.ts) only carry the messages back and forth.
//
// Hand-made, without the official SDK: the server only lists and calls read-only tools, and that is
// `initialize`, `ping`, `tools/list` and `tools/call`. The SDK would bring zod and a transport with
// a session that, in stateless mode, is created and thrown away on every request (as in the spike).
//
// Versions: answers the two in circulation (2025-03-26 and 2025-06-18), 2025-11-25 and the old
// 2024-11-05. Whoever asks for one we know gets the same; whoever asks for another gets the newest,
// as the spec says. `structuredContent` and `outputSchema` are from 2025-06-18 on; an older client
// ignores them and reads the text.

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
export const LATEST_PROTOCOL_VERSION: ProtocolVersion = PROTOCOL_VERSIONS[0];

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/** JSON Schema of a tool's input or output (the subset we use). */
export type Schema = JsonObject & { type: 'object' };

export interface CallContext {
  /** Aborts when the client gives up (the HTTP connection closed). A long tool should listen. */
  signal: AbortSignal;
  /** The negotiated version, when the transport knows it (`MCP-Protocol-Version` header). */
  version: string | null;
}

/** What a tool returns: a short text for the model and the same data, structured. */
export interface ToolResult {
  text: string;
  data: JsonObject;
}

/**
 * A server tool. Read-only (proposal 0.0.1): `annotations.readOnlyHint` always goes out `true`.
 * To add one, see src/mcp/README.md.
 */
export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  outputSchema?: Schema;
  /** Called with the raw arguments: the tool validates them itself (`parseCommonArgs`, output.ts). */
  execute(args: JsonObject, ctx: CallContext): Promise<ToolResult>;
}

/** Error the tool wants to show the model: goes back as a result with `isError`, not as a protocol error. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Argument error: goes back with `isError`, so the model can fix it and try again. */
export class ArgumentError extends ToolError {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentError';
  }
}

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

type Id = string | number | null;
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** At most 10 tools (proposal 0.0.1, feature 9). */
export const MAX_TOOLS = 10;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export interface McpServerOptions {
  name?: string;
  version: string;
  /** Text for the model in `initialize`: what the server answers and how to read it. */
  instructions?: string;
  log?: (message: string) => void;
}

export class McpServer {
  private readonly tools = new Map<string, Tool>();
  private readonly name: string;
  private readonly version: string;
  private readonly instructions: string | undefined;
  private readonly log: (message: string) => void;

  constructor({ name = 'ahrena-console', version, instructions, log = () => {} }: McpServerOptions) {
    this.name = name;
    this.version = version;
    this.instructions = instructions;
    this.log = log;
  }

  /** Adds a tool. A repeated name, a name off the pattern or one past the limit is the registrant's error. */
  register(t: Tool): this {
    if (!TOOL_NAME.test(t.name)) throw new Error(`nome de ferramenta inválido: ${t.name}`);
    if (this.tools.has(t.name)) throw new Error(`ferramenta já registrada: ${t.name}`);
    if (this.tools.size >= MAX_TOOLS) throw new Error(`no máximo ${MAX_TOOLS} ferramentas`);
    this.tools.set(t.name, t);
    return this;
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Handles a message or a batch (2025-03-26 accepts batches; the other versions do not, but
   * accepting breaks no one). Returns `null` when there is nothing to answer (only notifications and responses).
   */
  async handle(message: unknown, ctx: Partial<CallContext> = {}): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    const c: CallContext = { signal: ctx.signal ?? new AbortController().signal, version: ctx.version ?? null };
    if (Array.isArray(message)) {
      if (message.length === 0) return rpcError(null, RPC_ERRORS.invalidRequest, 'lote vazio');
      const responses = (await Promise.all(message.map((m) => this.handleOne(m, c)))).filter((r): r is JsonRpcResponse => r !== null);
      return responses.length > 0 ? responses : null;
    }
    return this.handleOne(message, c);
  }

  private async handleOne(m: unknown, ctx: CallContext): Promise<JsonRpcResponse | null> {
    if (!m || typeof m !== 'object' || (m as { jsonrpc?: unknown }).jsonrpc !== '2.0') return rpcError(null, RPC_ERRORS.invalidRequest, 'não é JSON-RPC 2.0');
    const { id, method, params } = m as { id?: unknown; method?: unknown; params?: unknown };
    const hasId = id !== undefined;
    if (hasId && id !== null && typeof id !== 'string' && typeof id !== 'number') return rpcError(null, RPC_ERRORS.invalidRequest, 'id inválido');
    // A response from the client (we ask nothing) or a notification: nothing to answer.
    if (typeof method !== 'string') return hasId && ('result' in m || 'error' in m) ? null : rpcError((id as Id) ?? null, RPC_ERRORS.invalidRequest, 'sem method');
    if (!hasId) return null;
    const rid = id as Id;
    try {
      switch (method) {
        case 'initialize':
          return ok(rid, this.initialize(params));
        case 'ping':
          return ok(rid, {});
        case 'tools/list':
          return ok(rid, { tools: [...this.tools.values()].map(describeTool) });
        case 'tools/call':
          return ok(rid, await this.callTool(params, ctx));
        default:
          return rpcError(rid, RPC_ERRORS.methodNotFound, `método desconhecido: ${method}`);
      }
    } catch (e) {
      if (e instanceof ProtocolError) return rpcError(rid, e.code, e.message);
      this.log(`error in ${method}: ${(e as Error).message}`);
      return rpcError(rid, RPC_ERRORS.internal, 'erro interno');
    }
  }

  private initialize(params: unknown) {
    const requested = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
    const version = typeof requested === 'string' && (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.name, title: 'Ahrena Console', version: this.version },
      ...(this.instructions ? { instructions: this.instructions } : {}),
    };
  }

  private async callTool(params: unknown, ctx: CallContext) {
    const p = params as { name?: unknown; arguments?: unknown } | null;
    const t = typeof p?.name === 'string' ? this.tools.get(p.name) : undefined;
    if (!t) throw new ProtocolError(RPC_ERRORS.invalidParams, `ferramenta desconhecida: ${String(p?.name)}`);
    const args = p?.arguments ?? {};
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return { content: [{ type: 'text', text: 'arguments precisa ser um objeto' }], isError: true };
    }
    try {
      const r = await t.execute(args as JsonObject, ctx);
      return { content: [{ type: 'text', text: r.text }], structuredContent: r.data, isError: false };
    } catch (e) {
      if (e instanceof ToolError) return { content: [{ type: 'text', text: e.message }], isError: true };
      throw e;
    }
  }
}

class ProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function describeTool(t: Tool) {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

const ok = (id: Id, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
export const rpcError = (id: Id, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
