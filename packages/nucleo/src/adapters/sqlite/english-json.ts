// #173 phase 5, migration 11: the JSON the core keeps inside `metadata` and `data` with English keys
// and values (decision 0009). Migration 10 did the tables and columns; this one rewrites the JSON the
// code writes: the state machine's memory, the import cursor, the plan's extraction and history, the
// panel's record on a decision, the synthetic events and what the simulator stores.
//
// Each function maps one column's object, old → new. A key already in English stays; when both the old
// and the new key are there, the new one wins. Frozen: the code that wrote the old shape is gone, so
// these maps never change.

import type { DatabaseSync } from 'node:sqlite';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function renameKeys(o: Json, map: Readonly<Record<string, string>>): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) {
    const to = map[k];
    if (to === undefined) {
      out[k] = v;
    } else if (!(to in o)) {
      out[to] = v;
    }
  }
  return out;
}

/** Applies `fn` to `o[key]` when it is an object. */
function nested(o: Json, key: string, fn: (v: Json) => Json): Json {
  return isObject(o[key]) ? { ...o, [key]: fn(o[key]) } : o;
}

const mapValue = (v: unknown, map: Readonly<Record<string, string>>): unknown => (typeof v === 'string' && v in map ? map[v] : v);

const SESSION_KEYS = { estados: 'states', importacao: 'import', familia: 'family', esforco: 'effort', contexto: 'context', roteiro: 'script', projeto: 'project', simulado: 'simulated' };
const MEMORY_KEYS = { ultimoEvento: 'lastEvent', idsNoUltimoInstante: 'idsAtLastInstant', erroEm: 'errorAt', delegacoes: 'delegations' };
const DELEGATION_KEYS = { desde: 'since', descricao: 'description' };
const BACKGROUND_KEYS = { desde: 'since', comando: 'command' };
const FAMILY_KEYS = { mae: 'parent', filhas: 'children' };
const CONTEXT_KEYS = { usados: 'used', limite: 'limit', estouros: 'overflows' };
const SCRIPTS = { travada: 'stuck', erro: 'error', abandono: 'abandonment', estouro: 'overflow', enxame: 'swarm' };
const AGENT_KEYS = { importacao: 'import', simulado: 'simulated', papel: 'role', ajustes: 'adjustments' };
const WORKFLOW_KEYS = { fase: 'phase', rotulo: 'label', papel: 'role', ajustes: 'adjustments', nome: 'name' };
const PLAN_KEYS = { extracao: 'extraction', historico: 'history' };
const EXTRACTION_KEYS = { aplicadas: 'applied', ultima: 'last', provisorias: 'provisional', proximaTarefa: 'nextTask' };
const LAST_CALL_KEYS = { antes: 'before' };
const HISTORY_KEYS = { aberto: 'open', inicio: 'start', herdados: 'inherited' };
const DECISION_KEYS = { texto: 'text', painel: 'panel', painelDesfeito: 'panelUndone', ruido: 'noise', ajusteDe: 'adjustedFrom', simulado: 'simulated' };
const PANEL_RECORD_KEYS = { acao: 'action', por: 'by', sessao: 'session', conta: 'account', em: 'at', antes: 'before', nova: 'new', desfeitoEm: 'undoneAt' };
const PANEL_ACTIONS = { confirmar: 'confirm', descartar: 'dismiss', ajustar: 'adjust' };
const DECIDERS = { usuario: 'user', agente: 'agent' };
const DECISION_STATES = { vigente: 'current', substituida: 'superseded', revertida: 'reverted', a_confirmar: 'to_confirm', descartada: 'dismissed' };
const ACCOUNT_KEYS = { simulado: 'simulated' };
const EVENT_KEYS = { sintetico: 'synthetic' };
const COMPACTION_KEYS = { contexto: 'context', limite: 'limit' };
const WORKFLOW_INPUT_KEYS = { fases: 'phases', volta: 'loop' };
const SYNTHETIC_REASONS = { processo_encerrado: 'process_ended' };

/** The state machine writes its synthetic events with this id prefix (it was `estado:`). */
export const OLD_SYNTHETIC_PREFIX = 'estado:';
export const SYNTHETIC_PREFIX = 'state:';
const syntheticId = (id: unknown): unknown =>
  typeof id === 'string' && id.startsWith(OLD_SYNTHETIC_PREFIX) ? SYNTHETIC_PREFIX + id.slice(OLD_SYNTHETIC_PREFIX.length) : id;

const mapEntries = (o: Json, fn: (v: Json) => Json): Json =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, isObject(v) ? fn(v) : v]));

function machineMemory(m: Json): Json {
  let out = renameKeys(m, MEMORY_KEYS);
  if (Array.isArray(out.idsAtLastInstant)) out = { ...out, idsAtLastInstant: out.idsAtLastInstant.map(syntheticId) };
  out = nested(out, 'delegations', (d) => mapEntries(d, (v) => renameKeys(v, DELEGATION_KEYS)));
  return nested(out, 'background', (b) => mapEntries(b, (v) => renameKeys(v, BACKGROUND_KEYS)));
}

export function sessionMetadata(m: Json): Json {
  let out = renameKeys(m, SESSION_KEYS);
  out = nested(out, 'states', machineMemory);
  out = nested(out, 'family', (f) => renameKeys(f, FAMILY_KEYS));
  out = nested(out, 'context', (c) => renameKeys(c, CONTEXT_KEYS));
  if ('script' in out) out = { ...out, script: mapValue(out.script, SCRIPTS) };
  return out;
}

export function agentMetadata(m: Json): Json {
  return nested(renameKeys(m, AGENT_KEYS), 'workflow', (w) => renameKeys(w, WORKFLOW_KEYS));
}

export function accountMetadata(m: Json): Json {
  return renameKeys(m, ACCOUNT_KEYS);
}

export function planMetadata(m: Json): Json {
  let out = renameKeys(m, PLAN_KEYS);
  out = nested(out, 'extraction', (e) => nested(renameKeys(e, EXTRACTION_KEYS), 'last', (l) => renameKeys(l, LAST_CALL_KEYS)));
  return nested(out, 'history', (h) => renameKeys(h, HISTORY_KEYS));
}

function panelRecord(r: Json): Json {
  const out = renameKeys(r, PANEL_RECORD_KEYS);
  if ('action' in out) out.action = mapValue(out.action, PANEL_ACTIONS);
  if ('by' in out) out.by = mapValue(out.by, DECIDERS);
  if ('before' in out) out.before = mapValue(out.before, DECISION_STATES);
  return out;
}

export function decisionMetadata(m: Json): Json {
  const out = renameKeys(m, DECISION_KEYS);
  return nested(nested(out, 'panel', panelRecord), 'panelUndone', panelRecord);
}

export function eventData(data: Json, type: string, toolName: string | null): Json {
  let out = renameKeys(data, EVENT_KEYS);
  if (out.synthetic === true && 'reason' in out) out = { ...out, reason: mapValue(out.reason, SYNTHETIC_REASONS) };
  if (type === 'PreCompact') out = renameKeys(out, COMPACTION_KEYS);
  if (toolName === 'Workflow') out = nested(out, 'tool_input', (i) => renameKeys(i, WORKFLOW_INPUT_KEYS));
  return out;
}

/** Rewrites the JSON column of each row whose object changes. Returns how many rows changed. */
function rewrite(db: DatabaseSync, table: string, key: string[], column: string, fn: (v: Json, row: Record<string, unknown>) => Json, where = '1'): number {
  const rows = db.prepare(`SELECT ${[...key, column].join(', ')}${table === 'events' ? ', type, tool_name' : ''} FROM ${table} WHERE ${column} IS NOT NULL AND ${where}`).all() as Record<string, unknown>[];
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key.map((k) => `${k} = ?`).join(' AND ')}`);
  let n = 0;
  for (const row of rows) {
    const before = row[column] as string;
    let parsed: unknown;
    try {
      parsed = JSON.parse(before);
    } catch {
      continue; // not JSON: nothing of ours to rename
    }
    if (!isObject(parsed)) continue;
    const after = JSON.stringify(fn(parsed, row));
    if (after === JSON.stringify(parsed)) continue;
    update.run(after, ...key.map((k) => row[k] as string | number));
    n++;
  }
  return n;
}

/** The SQL filter for rows whose JSON has one of these keys (spares the parse of the rest). */
const hasAnyKey = (column: string, keys: readonly string[]) => `(${keys.map((k) => `instr(${column}, '"${k}"') > 0`).join(' OR ')})`;

const keysOf = (...maps: Readonly<Record<string, string>>[]) => [...new Set(maps.flatMap((m) => Object.keys(m)))];

export function migrateJsonToEnglish(db: DatabaseSync): void {
  const sessionKeys = keysOf(SESSION_KEYS);
  rewrite(db, 'sessions', ['id'], 'metadata', sessionMetadata, hasAnyKey('metadata', sessionKeys));
  rewrite(db, 'agents', ['id'], 'metadata', agentMetadata, hasAnyKey('metadata', keysOf(AGENT_KEYS, { workflow: '' })));
  rewrite(db, 'accounts', ['id'], 'metadata', accountMetadata, hasAnyKey('metadata', keysOf(ACCOUNT_KEYS)));
  rewrite(db, 'session_plans', ['session_id'], 'metadata', planMetadata, hasAnyKey('metadata', keysOf(PLAN_KEYS)));
  rewrite(db, 'session_plan_history', ['session_id', 'seq'], 'metadata', planMetadata, hasAnyKey('metadata', keysOf(PLAN_KEYS)));
  rewrite(db, 'decisions', ['id'], 'metadata', decisionMetadata, hasAnyKey('metadata', keysOf(DECISION_KEYS)));
  rewrite(
    db,
    'events',
    ['id'],
    'data',
    (d, row) => eventData(d, row.type as string, row.tool_name as string | null),
    `(${hasAnyKey('data', keysOf(EVENT_KEYS))} OR (type = 'PreCompact' AND ${hasAnyKey('data', keysOf(COMPACTION_KEYS))}) OR (tool_name = 'Workflow' AND ${hasAnyKey('data', keysOf(WORKFLOW_INPUT_KEYS))}))`,
  );
  db.prepare(`UPDATE events SET id = ? || substr(id, ?) WHERE substr(id, 1, ?) = ?`).run(
    SYNTHETIC_PREFIX,
    OLD_SYNTHETIC_PREFIX.length + 1,
    OLD_SYNTHETIC_PREFIX.length,
    OLD_SYNTHETIC_PREFIX,
  );
}
