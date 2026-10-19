// Normaliza o payload de um hook do Claude Code num `SessionEvent` do núcleo.
// Os campos seguem o que o Claude Code manda no stdin do hook (comuns: session_id, transcript_path,
// cwd, permission_mode, hook_event_name). Só normaliza: as transições de estado ficam para a
// máquina de estados (item 1.5).

import { createHash, randomUUID } from 'node:crypto';
import type { SessionEvent } from '../../model.ts';

export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'Notification',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

export interface NormalizeOptions {
  /** Quando o hook disparou (o encaminhador manda); se faltar, vale `receivedAt`. */
  firedAt?: string | null;
  receivedAt: string;
  /** Id da entrega gerado pelo encaminhador; repetir a entrega não duplica o evento. */
  deliveryId?: string | null;
}

/** O que o hook diz sobre a sessão, para completar o registro mínimo dela. */
export interface SessionHints {
  cwd: string | null;
  model: string | null;
  source: string | null;
  transcriptPath: string | null;
  permissionMode: string | null;
}

export interface NormalizedHook {
  event: SessionEvent;
  hints: SessionHints;
  /** `false` para eventos que o Claude Code venha a criar e que ainda não conhecemos. */
  known: boolean;
}

export class InvalidHookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHookError';
  }
}

/** Strings acima disso são cortadas em `data` (ex.: o conteúdo de um arquivo lido em `tool_response`). */
export const MAX_STRING_IN_DATA = 4_000;
const MAX_SUMMARY = 200;
const MAX_DEPTH = 8;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Corta strings longas e profundidade excessiva, para o evento não carregar arquivos inteiros. */
export function compactData(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_IN_DATA
      ? `${value.slice(0, MAX_STRING_IN_DATA)}… [+${value.length - MAX_STRING_IN_DATA} caracteres]`
      : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.map((v) => compactData(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = compactData(v, depth + 1);
  return out;
}

/** Resumo de uma linha da entrada de ferramenta: o campo que diz o que ela faz. */
function toolSummary(toolName: string | null, input: unknown): string | null {
  if (!input || typeof input !== 'object') return toolName;
  const i = input as Record<string, unknown>;
  const pick =
    str(i.command) ??
    str(i.file_path) ??
    str(i.notebook_path) ??
    str(i.pattern) ??
    str(i.url) ??
    str(i.query) ??
    str(i.description) ??
    str(i.prompt) ??
    str(i.path);
  return pick ? clip(pick, MAX_SUMMARY) : toolName;
}

function summarize(type: string, p: Record<string, unknown>): string | null {
  const toolName = str(p.tool_name);
  switch (type) {
    case 'SessionStart':
      return str(p.source);
    case 'SessionEnd':
      return str(p.reason);
    case 'UserPromptSubmit': {
      const prompt = str(p.prompt);
      return prompt ? clip(prompt, MAX_SUMMARY) : null;
    }
    case 'PreToolUse':
      return toolSummary(toolName, p.tool_input);
    case 'PostToolUse': {
      const base = toolSummary(toolName, p.tool_input);
      const r = p.tool_response as Record<string, unknown> | null | undefined;
      const failed = r && typeof r === 'object' && (r.is_error === true || r.success === false);
      return failed ? `erro: ${base ?? toolName ?? ''}`.trim() : base;
    }
    case 'Notification': {
      const message = str(p.message);
      return message ? clip(message, MAX_SUMMARY) : str(p.notification_type);
    }
    case 'SubagentStop':
      return str(p.agent_type) ?? str(p.agent_id);
    default:
      return null;
  }
}

function eventId(type: string, sessionId: string, p: Record<string, unknown>, deliveryId: string | null): string {
  // A chamada de ferramenta tem id próprio: o mesmo Pre/Post chegando duas vezes (plugin instalado em dois
  // escopos, reenvio) vira um evento só.
  const toolUseId = str(p.tool_use_id);
  const key = toolUseId && (type === 'PreToolUse' || type === 'PostToolUse') ? `tool:${toolUseId}` : deliveryId;
  if (!key) return `hook:${randomUUID()}`;
  const digest = createHash('sha256').update(`${sessionId}\0${type}\0${key}`).digest('hex').slice(0, 32);
  return `hook:${digest}`;
}

/** Valida o mínimo e devolve o evento normalizado. Lança `InvalidHookError` se não der para gravar. */
export function normalizeHook(raw: unknown, opts: NormalizeOptions): NormalizedHook {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidHookError('payload precisa ser um objeto JSON');
  const p = raw as Record<string, unknown>;
  const sessionId = str(p.session_id);
  if (!sessionId) throw new InvalidHookError('session_id é obrigatório');
  const type = str(p.hook_event_name);
  if (!type || !EVENT_NAME.test(type)) throw new InvalidHookError('hook_event_name ausente ou inválido');

  const firedAt = opts.firedAt && ISO_UTC.test(opts.firedAt) ? opts.firedAt : null;
  const createdAt = firedAt ?? opts.receivedAt;

  const event: SessionEvent = {
    id: eventId(type, sessionId, p, str(opts.deliveryId)),
    sessionId,
    // Hooks disparados dentro de um subagente trazem agent_id; os do agente principal, não.
    agentId: str(p.agent_id),
    type,
    toolName: str(p.tool_name),
    summary: summarize(type, p),
    data: compactData(p),
    createdAt,
  };

  return {
    event,
    hints: {
      cwd: str(p.cwd),
      model: type === 'SessionStart' ? modelName(p.model) : null,
      source: type === 'SessionStart' ? str(p.source) : null,
      transcriptPath: str(p.transcript_path),
      permissionMode: str(p.permission_mode),
    },
    known: (HOOK_EVENTS as readonly string[]).includes(type),
  };
}

// O SessionStart traz o modelo como texto ou como objeto ({ id, display_name }), conforme a versão.
function modelName(v: unknown): string | null {
  if (typeof v === 'string') return str(v);
  if (v && typeof v === 'object') return str((v as Record<string, unknown>).id);
  return null;
}
