// Leitura de uma linha do transcript JSONL do Claude Code. Função pura: recebe a linha já
// decodificada e devolve o que importa para o núcleo (evento, título, cwd, modelo).
// O formato não é documentado; tudo é lido de forma defensiva e o que não se reconhece é ignorado.

import type { TokenCounts } from '../../model.ts';

/** Tamanho máximo do resumo de um evento. O transcript completo continua no arquivo. */
export const SUMMARY_MAX = 200;
/** Tamanho máximo da tarefa de um subagente (o primeiro prompt). */
export const TASK_MAX = 2000;

/** Uso de tokens de uma mensagem do assistente, já com as dimensões de preço. */
export interface MessageUsage {
  /** Chave de deduplicação: o streaming grava a mesma mensagem várias vezes, uma por bloco. */
  messageId: string | null;
  requestId: string | null;
  model: string;
  speed: string;
  inferenceGeo: string;
  serviceTier: string;
  contextSize: string;
  tokens: TokenCounts;
  webSearchRequests: number;
  webFetchRequests: number;
  codeExecutionRequests: number;
}

export interface ParsedEvent {
  /** `uuid` da linha; vira o id estável do evento. */
  uuid: string;
  type: string;
  toolName: string | null;
  summary: string | null;
  createdAt: string;
  data: EventData;
}

export interface EventData {
  parentUuid: string | null;
  /** Presente quando a linha veio de um subagente (campo `agentId` do transcript). */
  transcriptAgentId: string | null;
  toolUseId?: string;
  isError?: boolean;
  subtype?: string;
  usage?: MessageUsage;
  /** Entrada da ferramenta, só para as de `INPUT_KEPT`. */
  tool_input?: unknown;
  /** Id da tarefa criada, no resultado do TaskCreate (plano da sessão, item 1.9). */
  taskId?: string;
}

export interface ParsedLine {
  sessionId: string | null;
  transcriptAgentId: string | null;
  cwd: string | null;
  timestamp: string | null;
  /** Título vindo de `custom-title`, `ai-title`, `agent-name` ou `summary`. */
  title: { kind: string; value: string } | null;
  model: string | null;
  /** Texto do prompt do usuário, quando a linha é um prompt (para a tarefa do subagente). */
  promptText: string | null;
  events: ParsedEvent[];
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const count = (v: unknown): number => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : 0);

export function truncate(text: string | null, max: number): string | null {
  if (text === null) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Normaliza para ISO 8601 em UTC com milissegundos; `null` se não for data. */
export function isoTimestamp(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => (b as Json).text as string);
  return parts.length > 0 ? parts.join('\n') : null;
}

/** Resumo de uma chamada de ferramenta: o campo de entrada mais legível. */
function toolSummary(input: unknown): string | null {
  if (!isObj(input)) return null;
  for (const k of ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'subject']) {
    const v = str(input[k]);
    if (v) return truncate(v, SUMMARY_MAX);
  }
  return null;
}

export function parseUsage(message: Json, requestId: string | null): MessageUsage | null {
  const model = str(message.model);
  const u = message.usage;
  // `<synthetic>` são mensagens geradas pelo próprio Claude Code (erro de API, interrupção): sem custo.
  if (!model || model === '<synthetic>' || !isObj(u)) return null;

  const cacheCreation = isObj(u.cache_creation) ? u.cache_creation : null;
  const write1h = cacheCreation ? count(cacheCreation.ephemeral_1h_input_tokens) : 0;
  // Sem o detalhe por TTL, toda escrita de cache é de 5 minutos (o TTL padrão).
  const write5m = cacheCreation ? count(cacheCreation.ephemeral_5m_input_tokens) : count(u.cache_creation_input_tokens);
  const server = isObj(u.server_tool_use) ? u.server_tool_use : {};
  const geo = str(u.inference_geo);

  return {
    messageId: str(message.id),
    requestId,
    model,
    speed: str(u.speed) ?? 'standard',
    inferenceGeo: geo && geo !== 'not_available' ? geo : '',
    serviceTier: str(u.service_tier) ?? 'standard',
    contextSize: '',
    tokens: {
      input: count(u.input_tokens),
      output: count(u.output_tokens),
      cacheRead: count(u.cache_read_input_tokens),
      cacheWrite5m: write5m,
      cacheWrite1h: write1h,
    },
    webSearchRequests: count(server.web_search_requests),
    webFetchRequests: count(server.web_fetch_requests),
    codeExecutionRequests: count(server.code_execution_requests),
  };
}

/** Ferramentas cuja entrada fica no evento: a pergunta (AskUserQuestion) e as do plano da sessão (item 1.9). */
const INPUT_KEPT = new Set(['AskUserQuestion', 'TodoWrite', 'TaskCreate', 'TaskUpdate']);
const keepsInput = (name: string) => INPUT_KEPT.has(name) || /(^|__)update_plan$/.test(name);
const INPUT_STRING_MAX = 500;

function keepInput(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > INPUT_STRING_MAX ? `${v.slice(0, INPUT_STRING_MAX - 1)}…` : v;
  if (v === null || typeof v !== 'object' || depth > 4) return typeof v === 'object' ? null : v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => keepInput(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keepInput(x, depth + 1)]));
}

/** `toolUseResult.task.id` do TaskCreate. */
function createdTaskId(o: Json): string | null {
  const r = isObj(o.toolUseResult) ? o.toolUseResult : null;
  const id = r && isObj(r.task) ? r.task.id : null;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

const TITLE_KINDS: Record<string, string> = {
  'custom-title': 'customTitle',
  'ai-title': 'aiTitle',
  'agent-name': 'agentName',
  summary: 'summary',
};

/**
 * Lê uma linha. Devolve `null` se não for JSON de objeto. `toolNames` é o mapa
 * `tool_use_id → nome` do arquivo, para dar nome ao resultado de uma ferramenta.
 */
export function parseLine(raw: string, toolNames: Map<string, string>): ParsedLine | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(o)) return null;

  const type = str(o.type);
  const uuid = str(o.uuid);
  const timestamp = isoTimestamp(o.timestamp);
  // Só as linhas de subagente (`isSidechain`) trazem `agentId`.
  const transcriptAgentId = str(o.agentId);
  const out: ParsedLine = {
    sessionId: str(o.sessionId),
    transcriptAgentId,
    cwd: str(o.cwd),
    timestamp,
    title: null,
    model: null,
    promptText: null,
    events: [],
  };

  if (type && type in TITLE_KINDS) {
    const value = str(o.customTitle) ?? str(o.aiTitle) ?? str(o.agentName) ?? str(o.summary) ?? str(o.title);
    if (value) out.title = { kind: TITLE_KINDS[type], value };
    return out;
  }

  // Sem uuid ou sem data não há como dar id estável nem ordenar: não vira evento.
  if (!uuid || !timestamp) return out;
  const base = { parentUuid: str(o.parentUuid), transcriptAgentId };
  const message = isObj(o.message) ? o.message : null;

  if (type === 'user' && message) {
    const content = message.content;
    const results = Array.isArray(content) ? content.filter((b) => isObj(b) && b.type === 'tool_result') : [];
    if (results.length > 0) {
      results.forEach((b, i) => {
        const r = b as Json;
        const toolUseId = str(r.tool_use_id);
        const toolName = toolUseId ? (toolNames.get(toolUseId) ?? null) : null;
        const taskId = toolName === 'TaskCreate' && results.length === 1 ? createdTaskId(o) : null;
        out.events.push({
          uuid: results.length > 1 ? `${uuid}#${i}` : uuid,
          type: 'ToolResult',
          toolName,
          summary: truncate(textOf(r.content), SUMMARY_MAX),
          createdAt: timestamp,
          data: { ...base, ...(toolUseId ? { toolUseId } : {}), isError: r.is_error === true, ...(taskId ? { taskId } : {}) },
        });
      });
    } else if (o.isMeta !== true) {
      const text = textOf(content);
      out.promptText = text;
      out.events.push({ uuid, type: 'UserPrompt', toolName: null, summary: truncate(text, SUMMARY_MAX), createdAt: timestamp, data: base });
    }
    return out;
  }

  if (type === 'assistant' && message) {
    out.model = str(message.model) === '<synthetic>' ? null : str(message.model);
    const usage = parseUsage(message, str(o.requestId));
    const data: EventData = usage ? { ...base, usage } : { ...base };
    if (o.isApiErrorMessage === true) {
      out.events.push({ uuid, type: 'APIError', toolName: null, summary: truncate(textOf(message.content), SUMMARY_MAX), createdAt: timestamp, data });
      return out;
    }
    const blocks = Array.isArray(message.content) ? message.content.filter(isObj) : [];
    const toolUse = blocks.find((b) => b.type === 'tool_use');
    if (toolUse) {
      const name = str(toolUse.name);
      const toolUseId = str(toolUse.id);
      if (name && toolUseId) toolNames.set(toolUseId, name);
      // O plano e a pergunta vivem na entrada da ferramenta: guardada só para estas, curta.
      const input = name && keepsInput(name) && isObj(toolUse.input) ? { tool_input: keepInput(toolUse.input) } : {};
      out.events.push({
        uuid,
        type: 'ToolUse',
        toolName: name,
        summary: toolSummary(toolUse.input),
        createdAt: timestamp,
        data: toolUseId ? { ...data, ...input, toolUseId } : { ...data, ...input },
      });
    } else {
      out.events.push({ uuid, type: 'AssistantMessage', toolName: null, summary: truncate(textOf(blocks), SUMMARY_MAX), createdAt: timestamp, data });
    }
    return out;
  }

  if (type === 'system') {
    const subtype = str(o.subtype);
    const kind = subtype === 'compact_boundary' ? 'Compaction' : subtype === 'api_error' ? 'APIError' : subtype === 'turn_duration' ? 'TurnDuration' : null;
    if (kind && subtype) {
      out.events.push({ uuid, type: kind, toolName: null, summary: truncate(str(o.content), SUMMARY_MAX), createdAt: timestamp, data: { ...base, subtype } });
    }
  }
  return out;
}
