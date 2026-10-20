// `wait_for_changes`: the same long polling as the HTTP route, as a tool of the MCP server (src/mcp),
// for the artifact (`host:ahrena-console`), whose `watchTool` has a 30 s floor (validation V2). The app
// waits around 130 s for a tool answer; the maximum wait stays at 110 s.
//
// Like the other tools: the account goes out as label and color, never the id (which carries the
// account and org UUIDs); the `account` filter takes a label, an id or "none". No conversation text
// goes out: only the type, the session id and the decision id. The wait listens to `ctx.signal`, which
// aborts when the client closes the connection.
//
// The `repos` type (#104, #105) is for the screen only, through the HTTP route: here it is not in the
// enum and the wait always filters by the MCP types, so that a repository build does not wake up
// whoever waits without a filter or with `account: "none"` (the `repos` changes have no account).

import type { Accounts } from '../api/accounts.ts';
import { matchesAccountFilter } from '../mcp/fleet.ts';
import { ToolError, ArgumentError, type Tool, type JsonObject } from '../mcp/protocol.ts';
import { objectSchema, arrayOf, strictObject, nullable, T } from '../mcp/output.ts';
import {
  TooManyWaitersError,
  MAX_WAIT_MS,
  DEFAULT_WAIT_MS,
  CHANGE_TYPES,
  type ChangeCursor,
  type ChangeFilters,
  type RecordedChange,
  type WaitResult,
  type ChangeType,
} from './cursor.ts';

export const WAIT_FOR_CHANGES = 'wait_for_changes';

/** The types MCP exposes: all but `repos`. */
export const MCP_CHANGE_TYPES = CHANGE_TYPES.filter((t): t is Exclude<ChangeType, 'repos'> => t !== 'repos');
export type McpChangeType = (typeof MCP_CHANGE_TYPES)[number];

/**
 * The Portuguese change types `types` took before #173 phase 2b, still accepted (and mapped to the
 * English ones) until phase 6; the answer always carries the English ones.
 */
export const LEGACY_CHANGE_TYPES: Readonly<Record<string, McpChangeType>> = {
  sessao: 'session',
  estado: 'state',
  'precisa-de-voce': 'needs-you',
  plano: 'plan',
  decisao: 'decision',
  conta: 'account',
};

const ALLOWED_ARGS = ['cursor', 'timeout', 'sessions', 'account', 'types'] as const;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface OutputChange {
  type: McpChangeType;
  sessionId: string | null;
  decisionId: string | null;
  account: { label: string; color: string } | null;
}

export interface WaitForChangesOutput {
  cursor: string;
  reset: boolean;
  timedOut: boolean;
  changes: OutputChange[];
}

const CHANGE_SCHEMA = strictObject({
  type: { type: 'string', enum: [...MCP_CHANGE_TYPES] },
  sessionId: nullable(T.string),
  decisionId: nullable(T.string),
  account: nullable(strictObject({ label: T.string, color: T.string })),
});

export interface WaitForChangesOptions {
  changes: ChangeCursor;
  /** The same `Accounts` as the panel and the other tools: the label is the same on every surface. */
  accounts: Accounts;
}

export function waitForChanges({ changes, accounts }: WaitForChangesOptions): Tool {
  // The account by id, as the panel shows it. The source does not matter here: the id is already decided.
  const accountOf = (accountId: string | null) =>
    accountId === null ? null : accounts.ofSession({ id: '', accountId, accountSource: 'transcript' }, null);

  return {
    name: WAIT_FOR_CHANGES,
    title: 'Esperar mudanças',
    description:
      'Long polling: responde assim que algo muda no Ahrena Console (sessão, estado, precisa de você, plano, decisão, conta, alerta de máquina) ' +
      `ou depois de timeout segundos (padrão ${DEFAULT_WAIT_MS / 1000}, máximo ${MAX_WAIT_MS / 1000}). ` +
      'Chame sem cursor para receber o atual; depois passe sempre o cursor da última resposta. Com reset=true, releia tudo ' +
      '(sessions_needing_attention, fleet_overview) antes de continuar. O cursor devolvido pula as mudanças que os filtros deixaram de fora. ' +
      'Desde a #173, o changes[].type da resposta vem em inglês; os nomes antigos em português ainda valem em types. ' +
      'Não devolve texto das conversas.',
    inputSchema: objectSchema({
      cursor: { type: 'string', description: 'O cursor da última resposta. Sem ele, volta na hora com o atual e reset=true.' },
      timeout: {
        type: 'number',
        minimum: 0,
        maximum: MAX_WAIT_MS / 1000,
        default: DEFAULT_WAIT_MS / 1000,
        description: 'Segundos de espera; 0 não espera.',
      },
      sessions: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Só estas sessões (ids).' },
      account: {
        description: 'Só estas contas do Claude: o rótulo ou o id, um ou vários; "none" pede as sessões "Sem conta".',
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 20 }],
      },
      types: {
        type: 'array',
        items: { type: 'string', enum: [...MCP_CHANGE_TYPES, ...Object.keys(LEGACY_CHANGE_TYPES)] },
        description: `Só estes tipos de mudança: ${MCP_CHANGE_TYPES.join(', ')}. Os nomes antigos (${Object.keys(LEGACY_CHANGE_TYPES).join(', ')}) ainda valem.`,
      },
    }),
    outputSchema: strictObject({
      cursor: T.string,
      reset: T.boolean,
      timedOut: T.boolean,
      changes: arrayOf(CHANGE_SCHEMA),
    }),
    async execute(args, ctx) {
      const { cursor, timeoutMs, filters, requestedAccounts } = parseArgs(args);
      // Labels and colors read from the port and from ~/.ahrena-console/contas.json (at most every 30 s).
      await accounts.refresh();
      if (requestedAccounts) filters.matchesAccount = (accountId) => matchesAccountFilter(accountOf(accountId), requestedAccounts);
      let r: WaitResult;
      try {
        r = await changes.wait(cursor, { filters, timeoutMs, signal: ctx.signal });
      } catch (e) {
        if (e instanceof TooManyWaitersError) throw new ToolError(`${e.message}; tente de novo em alguns segundos`);
        throw e;
      }
      const data: WaitForChangesOutput = {
        cursor: r.cursor,
        reset: r.reset,
        timedOut: r.timedOut,
        changes: r.changes.flatMap((m) => (m.type === 'repos' ? [] : [toOutputChange(m as RecordedChange & { type: McpChangeType }, accountOf(m.accountId))])),
      };
      return { text: summaryText(data), data: data as unknown as JsonObject };
    },
  };
}

function toOutputChange(m: RecordedChange & { type: McpChangeType }, c: { label: string; color: string } | null): OutputChange {
  return {
    type: m.type,
    sessionId: m.sessionId,
    decisionId: m.type === 'decision' ? m.key : null,
    account: c ? { label: c.label, color: c.color } : null,
  };
}

function summaryText(d: WaitForChangesOutput): string {
  if (d.reset) return `Cursor ${d.cursor}. Releia tudo e chame de novo com este cursor.`;
  if (d.changes.length === 0) return `Nada mudou. Cursor ${d.cursor}.`;
  const byType = new Map<string, number>();
  for (const c of d.changes) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  return `${d.changes.length} mudança(s): ${[...byType].map(([t, n]) => `${t} ${n}`).join(', ')}. Cursor ${d.cursor}.`;
}

interface WaitRequest {
  cursor: string | null;
  timeoutMs: number | undefined;
  filters: ChangeFilters;
  requestedAccounts: string[] | null;
}

function parseArgs(args: JsonObject): WaitRequest {
  for (const k of Object.keys(args)) {
    if (!(ALLOWED_ARGS as readonly string[]).includes(k)) throw new ArgumentError(`argumento desconhecido: ${k}. Use ${ALLOWED_ARGS.join(', ')}`);
  }
  const filters: ChangeFilters = {};
  const { cursor, timeout, sessions, account, types } = args;
  if (cursor != null && (typeof cursor !== 'string' || cursor.length > 64)) {
    throw new ArgumentError('cursor precisa ser o texto devolvido na última resposta');
  }
  if (timeout != null && (typeof timeout !== 'number' || !(timeout >= 0))) {
    throw new ArgumentError(`timeout precisa ser um número de 0 a ${MAX_WAIT_MS / 1000}`);
  }
  if (sessions != null) {
    if (!Array.isArray(sessions) || sessions.length > 50 || !sessions.every((s) => typeof s === 'string' && ID.test(s))) {
      throw new ArgumentError('sessions precisa ser uma lista de ids de sessão');
    }
    if (sessions.length) filters.sessionIds = sessions as string[];
  }
  let requestedAccounts: string[] | null = null;
  if (account != null) {
    const l = typeof account === 'string' ? [account] : Array.isArray(account) ? account : null;
    if (!l || l.length === 0 || l.length > 20 || !l.every((x) => typeof x === 'string' && x.trim() && x.length <= 200)) {
      throw new ArgumentError('account precisa ser um texto ou uma lista de textos (rótulo, id ou "none")');
    }
    requestedAccounts = (l as string[]).map((x) => x.trim());
  }
  if (types != null) {
    const normalized = Array.isArray(types) ? types.map((t) => (typeof t === 'string' && Object.hasOwn(LEGACY_CHANGE_TYPES, t) ? LEGACY_CHANGE_TYPES[t] : t)) : null;
    if (!normalized || !normalized.every((t) => typeof t === 'string' && (MCP_CHANGE_TYPES as readonly string[]).includes(t))) {
      throw new ArgumentError(`types: uma lista com ${MCP_CHANGE_TYPES.join(', ')}`);
    }
    if (normalized.length) filters.types = normalized as McpChangeType[];
  }
  // Without `types`, all the MCP ones: a `repos` change does not pass the filter and does not wake the wait.
  filters.types ??= MCP_CHANGE_TYPES;
  return {
    cursor: typeof cursor === 'string' && cursor ? cursor : null,
    timeoutMs: typeof timeout === 'number' ? timeout * 1000 : undefined,
    filters,
    requestedAccounts,
  };
}
