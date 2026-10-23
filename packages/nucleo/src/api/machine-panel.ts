// The panel of a session that runs on a remote machine (#319, wireframe P14). A Desktop session that
// runs over SSH on the Workstation has its hooks, and so its data, in the Workstation's núcleo: the
// mod asks THIS Mac's núcleo for `GET /api/panel/<id>`, and this Mac does not know the id. This
// module answers it from the remote that does, through the reader of #243 (api/machine-reader.ts:
// `GET` only, connected machines only, the 3 s answer budget, the short cache).
//
// - Reached only for an id this Mac's storage does not know, or knows only from a transcript import
//   (api/machine-sessions.ts asks first; the Mac can import a copy of a remote session's transcript,
//   without its hooks, so its state is not the live one): a session of this Mac's hooks gets the panel
//   of before, byte for byte, and no remote is asked. For an imported one no remote knows, and for one
//   whose remote is down with no panel read yet, the panel of before too.
// - Each connected remote is asked for its `/api/panel/<id>`, with the query the mod sends
//   (`PANEL_QUERY`), in parallel; the first in machines.json order that knows the id wins. A remote
//   knows the id when its panel has the session with that id and a `cost`: the panel builder
//   (api/panel.ts `montar`) leaves `cost` null exactly when its storage has no such session (the "Sessão
//   nova" panel of P6, which every núcleo answers for any id).
// - The remote's panel is rebuilt with the caps of api/machine-items.ts (`boundedJson`) and at most
//   `MAX_REMOTE_PANEL_BYTES`; one without the panel's shape, or that already carries a `machine` (a
//   remote of the remote), is dropped, never repaired.
// - It gains `machine: { id, label, lastReadAt, connection }`, the shape the mod's P14 band reads
//   (plugins/ahrena-console/types, #278). `lastReadAt` is when the panel shown was read.
// - Read only (AC-3): nothing in it opens or decides anything here. `api.opensSession` is false, every
//   Desktop `local_…` id is null (no "Ir para a sessão", no "Desarquivar"), and the decisions to
//   confirm are left out (no Confirmar or Descartar; their `undo` is null). The mod's writes go to
//   this Mac's núcleo only, which never sends them to a remote.
// - Remote down (AC-1): which remote each session belongs to is remembered (`RemoteSessionMap`), from
//   the panels read and from the session ids of the #243 list reads, with a TTL of hours and a bound.
//   For a session known to be remote whose remote does not answer, the answer is its last good panel
//   (if any) with that remote's `machine`, so the mod shows "<Máquina> sem conexão · <motivo>";
//   without a last panel, the minimal panel (`minimalPanel`) the mod draws the band on. Never 5xx.
// - An id that no remote knows, and that is not remembered, is left to this Mac's panel builder (the
//   "Sessão nova" panel of before).

import { boundedJson, isObject, remoteAccountColor, REMOTE_ID } from './machine-items.ts';
import { withDeadline, type MachineReader, type PanelConnection, type RemoteSessionSource } from './machine-reader.ts';

/** `GET /api/panel/<session>` (server.ts `PANEL_ROUTE`; not imported, server.ts imports this module). */
export const PANEL_PATH = /^\/api\/panel\/([^/]+)$/;
const PANEL_BASE = '/api/panel';
/** The only links a remote's panel may carry: GitHub's (the PRs and issues of the work card). */
const GITHUB_URL = /^https:\/\/github\.com\/[^\s]{1,500}$/;

/** The query parameters the mod sends with the panel (server.ts `panelRequestOf`), passed on as they are. */
export const PANEL_QUERY = ['local', 'account', 'org', 'model', 'cwd', 'decisions'] as const;
const MAX_QUERY_VALUE = 1024;
/** A remote's panel never goes out larger than this, serialized. */
export const MAX_REMOTE_PANEL_BYTES = 2 * 1024 * 1024;
/** How long a session stays known as a remote one, and its last panel kept. */
export const REMOTE_SESSION_TTL_MS = 12 * 3_600_000;
/** At most this many remote session ids remembered; the oldest go first. */
export const MAX_REMOTE_SESSIONS = 5_000;
/** At most this many last panels kept (a panel is tens of KB); the oldest go first. */
export const MAX_REMOTE_PANELS = 50;
const DEADLINE_MARGIN_MS = 250;

/** The `machine` of a remote session's panel (the mod's `PanelMachine`). */
export interface PanelMachine {
  id: string;
  label: string;
  lastReadAt: string | null;
  connection: PanelConnection | null;
}

export interface RemoteSessionMapOptions {
  now?: () => number;
  ttlMs?: number;
  maxSessions?: number;
  maxPanels?: number;
}

/** Which remote each session id belongs to, and the last good panel of the ones read (bounded, with a TTL). */
export class RemoteSessionMap {
  private readonly o: RemoteSessionMapOptions;
  private readonly owners = new Map<string, { machineId: string; at: number }>();
  private readonly panels = new Map<string, { machineId: string; body: Record<string, unknown>; readAt: number }>();

  constructor(options: RemoteSessionMapOptions = {}) {
    this.o = options;
  }

  now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** The session ids a remote just listed (#243 list reads). */
  noteSessions(machineId: string, ids: readonly unknown[]): void {
    const at = this.now();
    for (const id of ids) if (typeof id === 'string' && REMOTE_ID.test(id)) this.own(id, machineId, at);
    this.prune(at);
  }

  /** A good panel the remote just answered. */
  notePanel(machineId: string, sessionId: string, body: Record<string, unknown>, readAt: number): void {
    this.own(sessionId, machineId, readAt);
    this.panels.delete(sessionId);
    this.panels.set(sessionId, { machineId, body, readAt });
    this.prune(readAt);
  }

  /** The remote a session belongs to, while remembered. */
  ownerOf(sessionId: string): string | null {
    const o = this.owners.get(sessionId);
    if (!o || this.now() - o.at >= this.ttl) return null;
    return o.machineId;
  }

  /** The session's last good panel from `machineId`, while remembered. */
  lastPanel(machineId: string, sessionId: string): { body: Record<string, unknown>; readAt: number } | null {
    const p = this.panels.get(sessionId);
    if (!p || p.machineId !== machineId || this.now() - p.readAt >= this.ttl) return null;
    return p;
  }

  /** The remote said it does not know the session (gone, or the map was wrong). */
  forget(sessionId: string): void {
    this.owners.delete(sessionId);
    this.panels.delete(sessionId);
  }

  get size(): { sessions: number; panels: number } {
    return { sessions: this.owners.size, panels: this.panels.size };
  }

  private get ttl(): number {
    return this.o.ttlMs ?? REMOTE_SESSION_TTL_MS;
  }

  private own(sessionId: string, machineId: string, at: number): void {
    this.owners.delete(sessionId);
    this.owners.set(sessionId, { machineId, at });
  }

  private prune(now: number): void {
    for (const [id, o] of this.owners) if (now - o.at >= this.ttl) this.owners.delete(id);
    for (const [id, p] of this.panels) if (now - p.readAt >= this.ttl) this.panels.delete(id);
    trim(this.owners, this.o.maxSessions ?? MAX_REMOTE_SESSIONS);
    trim(this.panels, this.o.maxPanels ?? MAX_REMOTE_PANELS);
  }
}

/** Drops the oldest entries (insertion order) past `max`. */
function trim(map: Map<string, unknown>, max: number): void {
  for (const key of map.keys()) {
    if (map.size <= max) return;
    map.delete(key);
  }
}

export interface RemotePanelsOptions {
  reader: MachineReader;
  sessions: RemoteSessionMap;
  /** A remote's `lastReadAt` of `GET /api/machines`, for the minimal panel. */
  lastReadAt?: (machineId: string) => Promise<string | null>;
}

/** The panel of a session of a remote machine (see the module comment). */
export class RemotePanels {
  private readonly o: RemotePanelsOptions;

  constructor(options: RemotePanelsOptions) {
    this.o = options;
  }

  /**
   * The panel for an id this Mac does not know (or has only a `localCopy` of, from a transcript
   * import); `null` to leave it to this Mac's panel builder.
   */
  async panel(sessionId: string, params: URLSearchParams, { localCopy = false }: { localCopy?: boolean } = {}): Promise<Record<string, unknown> | null> {
    const { reader, sessions } = this.o;
    if (!REMOTE_ID.test(sessionId)) return null;
    const machines = reader.machines();
    if (machines.length === 0) return null;
    const path = panelPath(sessionId, params);
    const asked = machines.filter((m) => m.status().state === 'connected');
    const answers = await Promise.all(asked.map((m) => withDeadline(reader.answer(m, path), reader.timeoutMs + DEADLINE_MARGIN_MS)));
    const readAt = sessions.now();
    const owner = sessions.ownerOf(sessionId);
    let ownerSaidUnknown = false;
    for (let i = 0; i < asked.length; i++) {
      const m = asked[i]!;
      const a = answers[i];
      if (!a || a.status !== 200) continue;
      const verdict = remotePanel(a.body, sessionId);
      if (verdict === 'unknown') {
        if (m.id === owner) ownerSaidUnknown = true;
        continue;
      }
      if (!verdict) continue;
      sessions.notePanel(m.id, sessionId, verdict, readAt);
      return this.withMachine(verdict, m, new Date(readAt).toISOString());
    }
    if (!owner) return null;
    const source = reader.find(owner);
    if (!source || ownerSaidUnknown) {
      sessions.forget(sessionId);
      return null;
    }
    // The remote of a session it knew does not answer now: its last panel, or the minimal one.
    const last = sessions.lastPanel(owner, sessionId);
    if (last) return this.withMachine(last.body, source, new Date(last.readAt).toISOString());
    // With a local copy and no remote panel yet, the copy says more than the empty panel.
    if (localCopy) return null;
    return this.withMachine(minimalPanel(readAt), source, (await this.o.lastReadAt?.(owner)) ?? null);
  }

  private async withMachine(body: Record<string, unknown>, source: RemoteSessionSource, lastReadAt: string | null): Promise<Record<string, unknown>> {
    const machine: PanelMachine = { id: source.id, label: source.label, lastReadAt, connection: await this.o.reader.connection(source) };
    return { ...body, machine };
  }
}

/** `/api/panel/<id>` with the mod's own parameters, nothing else. */
function panelPath(sessionId: string, params: URLSearchParams): string {
  const q = new URLSearchParams();
  for (const name of PANEL_QUERY) {
    const v = params.get(name);
    if (v && v.length <= MAX_QUERY_VALUE && !/[\0-\x1f]/.test(v)) q.set(name, v);
  }
  const query = q.toString();
  return `${PANEL_BASE}/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`;
}

/**
 * A remote's panel for `sessionId`, rebuilt and read-only; `'unknown'` when the remote answered the
 * "Sessão nova" panel (it does not know the id); `null` when it lacks the shape, is too large, or
 * carries a `machine` of its own.
 */
export function remotePanel(v: unknown, sessionId: string): Record<string, unknown> | 'unknown' | null {
  if (!isObject(v) || v.version !== 1 || (v.machine !== undefined && v.machine !== null)) return null;
  const p = boundedJson(v) as Record<string, unknown>;
  const s = p.session;
  if (!isObject(s) || s.id !== sessionId || typeof s.title !== 'string' || typeof p.generatedAt !== 'string') return null;
  if (!isObject(p.needYou) || !isObject(p.subagents) || !isObject(p.background) || !Array.isArray(p.children)) return null;
  if (p.cost === null) return 'unknown';
  if (!isObject(p.cost)) return null;
  readOnly(p);
  return Buffer.byteLength(JSON.stringify(p)) <= MAX_REMOTE_PANEL_BYTES ? p : null;
}

/**
 * Nothing in a remote's panel opens or decides anything on this Mac (AC-3), its links are GitHub's
 * only, and an account goes out with a `#rrggbb` color (the mod puts it in a style).
 */
function readOnly(p: Record<string, unknown>): void {
  p.api = { ...(isObject(p.api) ? p.api : {}), opensSession: false };
  const items = (list: unknown): Record<string, unknown>[] => (Array.isArray(list) ? list.filter(isObject) : []);
  const account = (x: Record<string, unknown>) => {
    if (isObject(x.account)) x.account.color = remoteAccountColor(x.account.color);
  };
  const s = p.session as Record<string, unknown>;
  account(s);
  for (const c of items(p.children)) c.local = null;
  const n = p.needYou as Record<string, unknown>;
  for (const i of [...items(n.machine), ...items(n.family)]) {
    i.local = null;
    account(i);
  }
  for (const b of items(n.byAccount)) account(b);
  if (isObject(p.work) && isObject(p.work.pr) && !(typeof p.work.pr.url === 'string' && GITHUB_URL.test(p.work.pr.url))) p.work.pr = null;
  if (isObject(p.prs) && Array.isArray(p.prs.items)) {
    p.prs.items = items(p.prs.items).filter((pr) => typeof pr.url === 'string' && GITHUB_URL.test(pr.url));
    for (const pr of p.prs.items as Record<string, unknown>[]) if (isObject(pr.session)) pr.session.local = null;
    p.prs.total = (p.prs.items as unknown[]).length;
  }
  if (isObject(p.decisions)) {
    p.decisions.toConfirm = 0;
    const list = p.decisions.list;
    if (isObject(list)) {
      list.toConfirm = 0;
      if (Array.isArray(list.items)) list.items = list.items.filter((d) => isObject(d) && d.state !== 'to_confirm').map((d) => ({ ...(d as object), undo: null }));
    }
  }
}

/**
 * The panel of a remote session with nothing read yet, its remote down: the shape the mod accepts
 * (`version: 1`, no session) so that it draws the P14 band and the empty cards.
 */
export function minimalPanel(now: number): Record<string, unknown> {
  return {
    version: 1,
    api: { opensSession: false },
    generatedAt: new Date(now).toISOString(),
    session: null,
    context: null,
    cost: null,
    tokens: null,
    background: { total: 0, first: null },
    plan: null,
    plans: [],
    subagents: { active: 0, items: [] },
    children: [],
    work: null,
    needYou: { total: 0, yourTurn: 0, byAccount: [], family: [], machine: [] },
    prs: { total: 0, items: [] },
    decisions: null,
  };
}
