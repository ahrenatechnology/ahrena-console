// Banco em memória, rascunhos e transcripts sintéticos para os testes das decisões.
// Nada aqui vem de conversa real: textos, ids e caminhos são inventados.

import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { SqliteDecisionStore } from '../../src/decisoes/sqlite.ts';
import type { DecisionDraft } from '../../src/decisoes/registro.ts';
import { normalizeHook } from '../../src/ingest/hooks/normalize.ts';
import type { SessionEvent } from '../../src/model.ts';
import { at } from '../fixtures.ts';

export { T0, at } from '../fixtures.ts';

export interface Ctx {
  storage: SqliteStorage;
  decisions: SqliteDecisionStore;
}

export async function openCtx(): Promise<Ctx> {
  const storage = await openSqliteStorage({ path: ':memory:' });
  return { storage, decisions: new SqliteDecisionStore(storage.db) };
}

let n = 0;
export function draft(over: Partial<DecisionDraft> = {}): DecisionDraft {
  return {
    sourceKey: `teste:${n++}`,
    sessionId: 's1',
    agentId: 's1:main',
    repo: '/repo/app',
    branch: 'feat/42-kanban',
    topic: 'pergunta:banco nos testes',
    context: 'Qual banco usar nos testes?',
    choice: 'Postgres no Docker',
    alternatives: ['SQLite em memória'],
    decidedBy: 'usuario',
    origin: 'pergunta',
    inferred: false,
    decidedAt: at(1),
    ...over,
  };
}

// ---------- hooks ----------

const common = {
  session_id: 's1',
  transcript_path: '/home/dev/.claude/projects/-repo-app/s1.jsonl',
  cwd: '/repo/app',
  permission_mode: 'default',
};

let delivery = 0;
/** Payload cru de hook → o evento normalizado que o receptor entrega ao `onEvent`. */
export function hook(minute: number, payload: Record<string, unknown>): SessionEvent {
  return normalizeHook({ ...common, ...payload }, { receivedAt: at(minute), deliveryId: `d${delivery++}` }).event;
}

export const ASK_INPUT = {
  questions: [
    {
      question: 'Qual banco usar nos testes?',
      header: 'Banco',
      multiSelect: false,
      options: [
        { label: 'Postgres no Docker', description: 'igual à produção' },
        { label: 'SQLite em memória', description: 'mais rápido' },
      ],
    },
    {
      question: 'Quais telas entram primeiro?',
      header: 'Telas',
      multiSelect: true,
      options: [{ label: 'Kanban', description: '' }, { label: 'Feed', description: '' }, { label: 'Mural', description: '' }],
    },
  ],
};

export const ASK_ANSWERS = {
  'Qual banco usar nos testes?': 'Postgres no Docker',
  'Quais telas entram primeiro?': 'Kanban, Feed',
};

export const PLAN = '# Kanban só leitura\n\n1. Ler as sessões\n2. Agrupar por status\n3. Desenhar as colunas\n';
export const PLAN_REJECTED = '# Kanban com arrastar\n\n1. Arrastar muda o status\n';

// ---------- transcript ----------

export interface LineOpts {
  uuid: string;
  minute: number;
  sessionId?: string;
  agentId?: string;
  branch?: string;
}

function envelope(type: 'user' | 'assistant', o: LineOpts, message: unknown, extra: Record<string, unknown> = {}) {
  return {
    parentUuid: null,
    isSidechain: false,
    type,
    uuid: o.uuid,
    timestamp: at(o.minute),
    sessionId: o.sessionId ?? 's1',
    ...(o.agentId ? { agentId: o.agentId } : {}),
    cwd: '/repo/app',
    gitBranch: o.branch ?? 'feat/42-kanban',
    userType: 'external',
    version: '2.1.0',
    message,
    ...extra,
  };
}

export const tx = {
  prompt: (o: LineOpts, text: string, extra: Record<string, unknown> = {}) =>
    envelope('user', o, { role: 'user', content: text }, extra),
  say: (o: LineOpts, text: string) =>
    envelope('assistant', o, { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] }),
  toolUse: (o: LineOpts, id: string, name: string, input: unknown) =>
    envelope('assistant', o, {
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }],
    }),
  toolResult: (o: LineOpts, id: string, content: string, opts: { isError?: boolean; toolUseResult?: unknown } = {}) =>
    envelope(
      'user',
      o,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(opts.isError ? { is_error: true } : {}) }] },
      opts.toolUseResult === undefined ? {} : { toolUseResult: opts.toolUseResult, sourceToolAssistantUUID: 'x' },
    ),
};

export const REJECT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
export const rejectWith = (said: string) =>
  `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n${said}`;

export const jsonl = (lines: unknown[]): string[] => lines.map((l) => JSON.stringify(l));
