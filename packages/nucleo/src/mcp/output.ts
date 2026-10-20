// What every tool does the same way: read the arguments, paginate by size and clean the text that
// comes from the sessions.
//
// Pagination by size (proposal 0.0.1, feature 9): a page stops at `limit` items or when the
// items' JSON goes past `BYTES_PER_PAGE`, whichever comes first, and returns `nextCursor`. The
// cursor is opaque to the client.
//
// A transcript is untrusted content (proposal, feature 11; 2.5): the tools return no conversation
// text (prompts, answers, questions, commands). What comes out of the sessions is the title, short
// and without control characters, and tool names that pass a strict pattern.

import { ArgumentError, type Schema, type Json, type JsonObject } from './protocol.ts';

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;
/** Ceiling of the JSON of a page's items. About 3 thousand tokens. */
export const BYTES_PER_PAGE = 12_000;
const MAX_TITLE_LENGTH = 60;

/** The common arguments in JSON Schema: `account`, `limit`, `cursor`. */
export const COMMON_ARGS: JsonObject = {
  account: {
    description:
      'Filtra por conta do Claude: o rótulo (ex.: "equipe") ou o id, um ou vários; "none" pede as sessões "Sem conta". Sem isto, todas as contas.',
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 20 }],
  },
  limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT, description: 'Itens por página.' },
  cursor: { type: 'string', description: 'O `nextCursor` da página anterior.' },
};

export function objectSchema(properties: JsonObject): Schema {
  return { type: 'object', properties, additionalProperties: false };
}

/**
 * Output object: every field required and none extra. The official client validates
 * `structuredContent` against `outputSchema`; a field that goes out without being here fails the call.
 */
export function strictObject(properties: JsonObject): Schema {
  return { ...objectSchema(properties), required: Object.keys(properties) };
}

export const arrayOf = (items: Json): JsonObject => ({ type: 'array', items });
/** The same schema, also accepting `null`. */
export const nullable = (s: JsonObject): JsonObject => ({ anyOf: [s, { type: 'null' }] });
export const T = { string: { type: 'string' }, integer: { type: 'integer', minimum: 0 }, number: { type: 'number' }, boolean: { type: 'boolean' } } satisfies Record<string, JsonObject>;

/** The account as it goes out (tools/common.ts), or `null` for "Sem conta". */
export const ACCOUNT_SCHEMA = nullable(strictObject({ label: T.string, color: T.string, source: T.string }));

export interface CommonArgs {
  accounts: string[] | null;
  limit: number;
  /** Where the page starts. */
  start: number;
}

export function parseCommonArgs(args: JsonObject, allowed: readonly string[]): CommonArgs {
  for (const k of Object.keys(args)) {
    if (!allowed.includes(k)) throw new ArgumentError(`argumento desconhecido: ${k}. Use ${allowed.join(', ')}`);
  }
  return { accounts: parseAccounts(args.account), limit: parseLimit(args.limit), start: parseCursor(args.cursor) };
}

function parseAccounts(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : null;
  if (!list || list.length === 0 || list.length > 20 || list.some((x) => typeof x !== 'string' || !x.trim() || x.length > 200)) {
    throw new ArgumentError('account precisa ser um texto ou uma lista de textos (rótulo, id ou "none")');
  }
  return list.map((x) => (x as string).trim());
}

function parseLimit(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_LIMIT;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_LIMIT) throw new ArgumentError(`limit precisa ser inteiro de 1 a ${MAX_LIMIT}`);
  return v as number;
}

function parseCursor(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as { i?: unknown };
      if (Number.isInteger(o?.i) && (o.i as number) >= 0) return o.i as number;
    } catch {
      // falls through to the error below
    }
  }
  throw new ArgumentError('cursor inválido: use o nextCursor da página anterior, ou nada para a primeira');
}

const cursorFor = (i: number) => Buffer.from(JSON.stringify({ i })).toString('base64url');

/** Cuts the list into a page: up to `limit` items and up to `BYTES_PER_PAGE` of JSON (at least one item). */
export function paginate<T>(items: readonly T[], { start, limit }: Pick<CommonArgs, 'start' | 'limit'>, bytes = BYTES_PER_PAGE): { page: T[]; nextCursor: string | null } {
  const page: T[] = [];
  let used = 0;
  let i = start;
  for (; i < items.length && page.length < limit; i++) {
    const n = Buffer.byteLength(JSON.stringify(items[i]));
    if (page.length > 0 && used + n > bytes) break;
    page.push(items[i]);
    used += n;
  }
  return { page, nextCursor: i < items.length ? cursorFor(i) : null };
}

/** Title to show: no control characters or line breaks, spaces collapsed, up to 60 characters. */
export function safeTitle(t: string | null | undefined): string | null {
  if (!t) return null;
  // eslint-disable-next-line no-control-regex
  const clean = t.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > MAX_TITLE_LENGTH ? `${clean.slice(0, MAX_TITLE_LENGTH - 1)}…` : clean;
}

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/** A tool name (`Bash`, `mcp__x__y`) only if it looks like a name; otherwise nothing. */
export function safeToolName(n: string | null | undefined): string | null {
  return n && TOOL_NAME_PATTERN.test(n) ? n : null;
}

/** "agora", "há 5 min", "há 2 h", "há 3 d". */
export function timeAgo(minutes: number): string {
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  if (minutes < 48 * 60) return `há ${Math.round(minutes / 60)} h`;
  return `há ${Math.round(minutes / 1440)} d`;
}
