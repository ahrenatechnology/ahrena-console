// The sessions of every machine (#243, wireframes C45 to C49): `?machine=` on the list routes and
// on the session Detail. This machine's lists come from their own builders, the remote ones through
// api/machine-reader.ts (`GET` only, connected machines only, 3 s, a 5 s cache), and they are merged
// here. The rules for a remote's items are in api/machine-items.ts.
//
// ## The parameter
//
// `machine` takes `all`, `local` or the id of a remote machine (the ids of `GET /api/machines`). An
// unknown or malformed id gives 400 `{ error }`, like the other parameters. Absent (or empty), the
// route answers exactly as before, byte for byte: this module is not even reached.
//
// With `machine`, on every list route:
// - each item (session row, card, event, history row, dashboard agent and activity row) gains
//   `machine: { id, label }`; this machine is `{ id: 'local', label: 'Esta máquina' }`;
// - the body gains `machines: [{ id, label, state, reason, lastReadAt }]`, one per machine asked for,
//   with the state of `GET /api/machines`, and, where the screen shows counts, `byMachine`;
// - a remote that is down, not connected, slow (past the 3 s) or answers something without the shape
//   adds no items. It is never an error: the answer is 200, and its entry in `machines` says why
//   (the neutral notice of C48). A remote is read with its routes as they are, without `machine`, so
//   this works against a núcleo that does not have #243; `machine=all` is never sent to a remote.
//
// ## Each route with `machine=all`
//
// - `GET /api/sessions` (C45): the same parameters and the same page-based pagination. Filters and
//   order apply on each machine; the rows are merged by the order asked for and then paginated, so
//   `total`, `registered`, `counts`, `pages` and `directories` cover every machine asked for.
//   `byMachine: [{ id, registered, total }]` gives the "· 3 na Workstation" of the subtitle. A remote is
//   read with `perPage=100`, the pages it needs in parallel, at most 50 (`MAX_REMOTE_PAGES`); the merge
//   looks at most `MAX_MERGE_ROWS` rows deep, so a page past that comes empty.
// - `GET /api/wall` (C46): the cards of every machine, merged in the wall's order (needs you, the
//   urgent first; then idle; then the rest, by `since`); `count` is recounted over the merged cards
//   and `byMachine: [{ id, count }]` has each machine's.
// - `GET /api/kanban` (C46): column by column, the items merged by the newest activity (ties keep this
//   machine first); `total` adds the machines, `hasMore` follows from it. With `column` and `page`,
//   the pages up to it are read on each machine (at most `MAX_REMOTE_PAGES`).
// - `GET /api/events` (C47, the feed): each machine's page, merged newest first, so a page holds up to
//   `limit` events of EACH machine. `cursor` and `older` become one opaque cursor for all of them
//   (`after` and `before` take it back); a machine that has nothing older is left out of `older`.
//   A `before` page is not globally ordered against the previous page: each machine continues from
//   its own cursor (a machine's cursor cannot resume in the middle of its page), so the /ui inserts
//   the events by `createdAt` rather than appending them. On `after`, a machine with no entry in the
//   cursor (down or slow at load, a machine that joins during live polling) is read from its first
//   page: it contributes its newest page once, merged with the rest, and its `cursor` enters the new
//   one; the /ui places those events by `createdAt` too. An `after` answer carries `options: null`.
//   `options.sessions` carry their machine; types and tools are joined.
// - `GET /api/history` (C47): the days of every machine merged (a day of both has both machines'
//   sessions, newest end first), cut at `days`, with `next` for the following page. A remote's day is
//   the one it computed in its own time zone.
// - `GET /api/dashboard` (C47): the numbers added up (`cost.usd` adds what has a price; `null` only
//   when no machine has one); agents and activity merged by time, activity cut at its length;
//   `byMachine: [{ id, numbers }]` for the "· 1 na Workstation" of each number.
//
// ## The Detail of a remote session (C49)
//
// `GET /api/sessions/<id>?machine=<remote>`, and the same on `/agents`, `/conversation`, `/events`,
// `/workflow` and `/decisions`, read the remote's same path (only those, with the id checked and the
// query passed on parameter by parameter, without `machine`). The JSON is rebuilt with caps and gains
// `machine`; the header also gets `open: { target: 'remote', command: null }`, `local: null` and
// `opensSession: false`, so the /ui shows no "Abrir no Claude Desktop" (C49, the "outra máquina"
// case of C70). The remote's 400 and 404 pass on with their message; with the remote down, 503
// `{ error: 'machine-unreachable', machine: { id, label, state, lastReadAt } }`. `machine=local` is the
// local Detail as before; `machine=all` on a Detail gives 400.
//
// ## The panel of a remote session (#319, P14)
//
// `GET /api/panel/<id>` (no `machine` parameter: the mod does not know where the session runs) for
// an id this Mac's storage does not know, or knows only from a transcript import (a copy of a remote
// session's transcript), is answered by api/machine-panel.ts from the remote that knows it, marked
// with `machine: { id, label, lastReadAt, connection }`. A session this Mac's hooks know, an id no
// remote knows, or no remote machine at all: the server's own panel, as before. The session ids
// of the remote `/api/sessions` and `/api/wall` reads above are remembered for it, so that a remote
// session whose remote went down still gets its last panel (or the minimal one) with the band.

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { parseHistoryRequest, type HistoryRequest } from '../history/model.ts';
import type { SessionHistory } from '../history/reading.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID, type MachineSummary } from '../telemetry/model.ts';
import { localMachine, type TelemetryService } from '../telemetry/service.ts';
import type { RespostaDoDashboard } from './dashboard-route.ts';
import { EVENTS_ROUTE, type FeedDeEventos } from './events.ts';
import { HISTORY_ROUTE } from './history.ts';
import { COLUNAS_DAS_SESSOES, COLUNAS_DOS_AGENTES, ErroDoPedidoDoKanban, KANBAN_ROUTE, pedidoDoKanban, POR_PAGINA as KANBAN_PER_PAGE, type KanbanHttp, type PedidoDoKanban, type QuadroKanban } from './kanban.ts';
import { boundedJson, isCount, isObject, mergeOrdered, newerFirst, remoteCount, remoteRows, REMOTE_ID, withMachine, type MachineTag, type RowKind } from './machine-items.ts';
import { withDeadline, type MachineReader, type RemoteSessionSource } from './machine-reader.ts';
import { PANEL_PATH, RemotePanels, RemoteSessionMap } from './machine-panel.ts';
import type { MontadorDoPainel } from './panel.ts';
import { ErroDoPedido, FILTROS_DE_STATUS, pedidoDeSessoes, SESSIONS_ROUTE, type FiltroDeStatus, type ListaDeSessoes, type PedidoDeSessoes } from './sessions.ts';
import { DASHBOARD_ROUTE } from './dashboard-route.ts';
import { WALL_ROUTE } from './wall.ts';
import type { Wall } from './types.ts';

export const MACHINE_PARAM = 'machine';
export const ALL_MACHINES = 'all';
/** A remote list is read at most this many pages deep. */
export const MAX_REMOTE_PAGES = 50;
/** The page size asked of a remote's `/api/sessions` (its `PER_PAGE_MAX`). */
const REMOTE_PER_PAGE = 100;
/** The merge of `/api/sessions` looks at most this many rows deep on each machine. */
export const MAX_MERGE_ROWS = MAX_REMOTE_PAGES * REMOTE_PER_PAGE;
const MAX_DIRECTORIES = 5_000;
const DEADLINE_MARGIN_MS = 250;
const MAX_OPTIONS = 100;
/** A Detail answer from a remote never goes out larger than this, serialized. */
export const MAX_REMOTE_DETAIL_BYTES = 4 * 1024 * 1024;
/** The Detail paths read from a remote: the header and its tabs. */
export const REMOTE_DETAIL_ROUTE = /^\/api\/sessions\/([^/]+)(?:\/(agents|conversation|events|workflow|decisions))?$/;
/** The query of a Detail tab passed on to the remote: plain names, short values. */
const QUERY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const MAX_QUERY_VALUE = 512;
const MAX_QUERY_PARAMS = 20;

/** A machine in the `machines` of a list answer: the state of `GET /api/machines`. */
export interface MachineState {
  id: string;
  label: string;
  state: MachineSummary['state'];
  reason: MachineSummary['reason'];
  lastReadAt: string | null;
}

/** This machine's screens, as server.ts builds them; one that is missing leaves its route alone. */
export interface LocalScreens {
  sessions?: ListaDeSessoes | null;
  wall?: { montar(): Promise<Wall> } | null;
  kanban?: QuadroKanban | null;
  history?: SessionHistory | null;
  events?: FeedDeEventos | null;
  dashboard?: (() => Promise<RespostaDoDashboard>) | null;
  /** #319: this Mac's panel builder, to know which sessions are its own; without it, the panel is never a remote's. */
  panel?: Pick<MontadorDoPainel, 'knows' | 'api'> | null;
}

export interface MachineSessionsOptions {
  /** The remote machines' reader; without it, only this machine. */
  reader?: MachineReader | null;
  /** For the machines' state and `lastReadAt` (`GET /api/machines`). */
  telemetry?: Pick<TelemetryService, 'machines'> | null;
  local: LocalScreens;
  /** #319: the remote session ids and last panels; a test passes one with its own clock. */
  remoteSessions?: RemoteSessionMap;
}

class RequestError extends Error {}

/** One machine asked for: this one, or a remote with its source (none for the demo's simulated one). */
interface Chosen {
  tag: MachineTag;
  state: MachineState;
  source: RemoteSessionSource | null;
}

const LOCAL_LABEL = localMachine().label;

/**
 * The handler server.ts calls before its own routes: `true` when it answered (a list route or a
 * Detail with `?machine=`), `false` to let the server go on as before.
 */
export function createMachineSessionsRoute(o: MachineSessionsOptions): (res: ServerResponse, url: URL) => Promise<boolean> {
  const route = new MachineSessionsRoute(o);
  return (res, url) => route.respond(res, url);
}

class MachineSessionsRoute {
  private readonly o: MachineSessionsOptions;
  private readonly remoteSessions: RemoteSessionMap;
  private readonly panels: RemotePanels | null;

  constructor(o: MachineSessionsOptions) {
    this.o = o;
    this.remoteSessions = o.remoteSessions ?? new RemoteSessionMap({ now: () => o.reader?.now() ?? Date.now() });
    this.panels = o.reader ? new RemotePanels({ reader: o.reader, sessions: this.remoteSessions, lastReadAt: (id) => this.lastReadAt(id), api: o.local.panel ? () => o.local.panel!.api() : undefined }) : null;
  }

  async respond(res: ServerResponse, url: URL): Promise<boolean> {
    const panel = PANEL_PATH.exec(url.pathname);
    if (panel) return this.panel(res, url, panel[1]!);
    const raw = url.searchParams.get(MACHINE_PARAM);
    if (!raw) return false;
    const { local } = this.o;
    const path = url.pathname;
    const detail = REMOTE_DETAIL_ROUTE.exec(path);
    const handled =
      (path === SESSIONS_ROUTE && local.sessions) ||
      (path === WALL_ROUTE && local.wall) ||
      (path === KANBAN_ROUTE && local.kanban) ||
      (path === HISTORY_ROUTE && local.history) ||
      (path === EVENTS_ROUTE && local.events) ||
      (path === DASHBOARD_ROUTE && local.dashboard) ||
      detail;
    if (!handled) return false;
    try {
      const chosen = await this.choose(raw);
      if (detail) {
        if (raw === LOCAL_MACHINE_ID) return false;
        if (raw === ALL_MACHINES) throw new RequestError('machine: local ou o id de uma máquina remota, no detalhe da sessão');
        await this.detail(res, url, detail, chosen[0]!);
        return true;
      }
      const body = await this.list(path, url, chosen);
      if (body.status !== 200) send(res, body.status, body.body);
      else send(res, 200, { ...(body.body as object), machines: chosen.map((c) => c.state) });
    } catch (e) {
      if (e instanceof RequestError || e instanceof ErroDoPedido || e instanceof ErroDoPedidoDoKanban) send(res, 400, { error: e.message });
      else throw e;
    }
    return true;
  }

  // ---------- The panel of a remote session (#319) ----------

  /** `true` when a remote's panel answered; `false` leaves the server's own panel (this Mac's, as before). */
  private async panel(res: ServerResponse, url: URL, raw: string): Promise<boolean> {
    const local = this.o.local.panel;
    if (!this.panels || !local || !this.o.reader?.machines().length) return false;
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      return false;
    }
    if (!REMOTE_ID.test(id)) return false;
    // A session this Mac's hooks know is its own: the panel of before. One it only imported from a
    // transcript may be a copy of a remote one: the remote that knows it (with its hooks) wins.
    const known = await local.knows(id);
    if (known && !known.imported) return false;
    const body = await this.panels.panel(id, url.searchParams, { localCopy: known !== null });
    if (!body) return false;
    send(res, 200, body);
    return true;
  }

  private async lastReadAt(machineId: string): Promise<string | null> {
    return (await this.o.telemetry?.machines())?.find((m) => m.id === machineId)?.lastReadAt ?? null;
  }

  // ---------- The machines ----------

  private async states(): Promise<MachineState[]> {
    const pick = (m: Pick<MachineSummary, 'id' | 'label' | 'state' | 'reason' | 'lastReadAt'>): MachineState => ({ id: m.id, label: m.label, state: m.state, reason: m.reason, lastReadAt: m.lastReadAt });
    if (this.o.telemetry) return (await this.o.telemetry.machines()).map(pick);
    const remotes = this.o.reader?.machines() ?? [];
    return [
      { id: LOCAL_MACHINE_ID, label: LOCAL_LABEL, state: 'connected', reason: null, lastReadAt: null },
      ...remotes.map((m) => pick({ id: m.id, label: m.label, state: m.status().state, reason: m.status().reason, lastReadAt: null })),
    ];
  }

  private async choose(raw: string): Promise<Chosen[]> {
    if (raw !== ALL_MACHINES && !MACHINE_ID.test(raw)) throw new RequestError('machine: all, local ou o id de uma máquina de /api/machines');
    const states = await this.states();
    if (!states.some((s) => s.id === LOCAL_MACHINE_ID)) states.unshift({ id: LOCAL_MACHINE_ID, label: LOCAL_LABEL, state: 'connected', reason: null, lastReadAt: null });
    const picked = raw === ALL_MACHINES ? states : states.filter((s) => s.id === raw);
    if (picked.length === 0) throw new RequestError(`machine: máquina desconhecida (${raw}); use all, local ou um id de /api/machines`);
    return picked.map((state) => ({
      tag: { id: state.id, label: state.id === LOCAL_MACHINE_ID ? LOCAL_LABEL : state.label },
      state,
      source: state.id === LOCAL_MACHINE_ID ? null : (this.o.reader?.find(state.id) ?? null),
    }));
  }

  /** A remote's contribution, bounded by the read deadline as a whole; `null` when it gave nothing. */
  private remote<T>(c: Chosen, read: (source: RemoteSessionSource, reader: MachineReader) => Promise<T | null>): Promise<T | null> {
    const reader = this.o.reader;
    if (!c.source || !reader) return Promise.resolve(null);
    // The reader answers each read within its deadline (with a recent good answer when it is late);
    // the margin lets that answer through, and still bounds a route that reads more than once.
    return withDeadline(read(c.source, reader), reader.timeoutMs + DEADLINE_MARGIN_MS);
  }

  // ---------- The lists ----------

  private async list(path: string, url: URL, chosen: Chosen[]): Promise<{ status: number; body: unknown }> {
    if (path === SESSIONS_ROUTE) return { status: 200, body: await this.sessions(pedidoDeSessoes(url), chosen) };
    if (path === WALL_ROUTE) {
      const limit = url.searchParams.has('parkedLimit') ? Number(url.searchParams.get('parkedLimit')) : undefined;
      return { status: 200, body: await this.wall(chosen, limit) };
    }
    if (path === KANBAN_ROUTE) return { status: 200, body: await this.kanban(pedidoDoKanban(url), chosen) };
    if (path === HISTORY_ROUTE) {
      const parsed = parseHistoryRequest(url.searchParams);
      if (!parsed.ok) throw new RequestError(parsed.error);
      return { status: 200, body: await this.history(parsed.request, chosen) };
    }
    if (path === EVENTS_ROUTE) return this.events(url.searchParams, chosen);
    return { status: 200, body: await this.dashboard(chosen) };
  }

  // `/api/sessions`
  private async sessions(request: PedidoDeSessoes, chosen: Chosen[]) {
    if (chosen.length === 1 && chosen[0]!.tag.id === LOCAL_MACHINE_ID) {
      const l = await this.o.local.sessions!.listar(request);
      const tag = chosen[0]!.tag;
      return { ...l, items: l.items.map((i) => withMachine(i, tag)), byMachine: [{ id: tag.id, registered: l.registered, total: l.total, ...(l.sources?.codex.error ? { sources: l.sources } : {}) }] };
    }
    const depth = Math.min(request.pagina * request.perPage, MAX_MERGE_ROWS);
    const parts = await Promise.all(
      chosen.map(async (c) => {
        if (!c.source) {
          if (c.tag.id !== LOCAL_MACHINE_ID) return null;
          const l = await this.o.local.sessions!.listar({ ...request, pagina: 1, perPage: depth });
          return { id: c.tag.id, sources: l.sources, items: l.items.map((i) => withMachine(i, c.tag)) as Record<string, unknown>[], total: l.total, registered: l.registered, directories: l.directories, counts: l.counts as Record<string, number> };
        }
        const part = await this.remote(c, (source, reader) => remoteSessions(source, reader, request, depth, c.tag));
        if (part) this.remoteSessions.noteSessions(c.tag.id, part.items.map((i) => i.id));
        return part;
      }),
    );
    const got = parts.filter((p) => p !== null);
    const sign = request.sentido === 'desc' ? 1 : -1;
    const key = (r: Record<string, unknown>): number =>
      request.ordem === 'duration' ? Number(r.durationMs) : request.ordem === 'cost' ? (typeof r.costUsd === 'number' ? r.costUsd : -1) : Date.parse(String(r.lastActivity));
    const merged = mergeOrdered(
      got.map((p) => p.items),
      (a, b) => sign * (key(b) - key(a)) || 0,
    );
    const total = got.reduce((n, p) => n + p.total, 0);
    const pages = Math.max(1, Math.ceil(total / request.perPage));
    const page = Math.min(request.pagina, pages);
    const counts = Object.fromEntries(FILTROS_DE_STATUS.map((f) => [f, got.reduce((n, p) => n + (p.counts[f] ?? 0), 0)])) as Record<FiltroDeStatus, number>;
    return {
      ...mergedSources(got, chosen),
      total,
      registered: got.reduce((n, p) => n + p.registered, 0),
      page,
      perPage: request.perPage,
      pages,
      directories: [...new Set(got.flatMap((p) => p.directories))].sort().slice(0, MAX_DIRECTORIES),
      counts,
      items: merged.slice((page - 1) * request.perPage, page * request.perPage),
      byMachine: got.map((p) => ({ id: p.id, registered: p.registered, total: p.total, ...(p.sources?.codex.error ? { sources: p.sources } : {}) })),
    };
  }

  // `/api/wall`
  private async wall(chosen: Chosen[], parkedLimit?: number) {
    const parts = await Promise.all(
      chosen.map(async (c) => {
        if (!c.source) {
          if (c.tag.id !== LOCAL_MACHINE_ID) return null;
          const w = await this.o.local.wall!.montar({ parkedLimit });
          return {
            id: c.tag.id,
            generatedAt: w.generatedAt,
            sources: w.sources,
            cards: w.cards.map((x) => withMachine(x, c.tag)) as Record<string, unknown>[],
            parked: { total: w.parked.total, items: w.parked.items.map((x) => withMachine(x, c.tag)) as Record<string, unknown>[] },
          };
        }
        const part = await this.remote(c, async (source, reader) => {
          const body = await reader.read(source, parkedLimit === undefined ? WALL_ROUTE : `${WALL_ROUTE}?parkedLimit=${encodeURIComponent(String(parkedLimit))}`);
          if (!isObject(body) || !Array.isArray(body.cards)) return null;
          // An older remote core has no "Paradas": it counts as none.
          const parked = isObject(body.parked) && typeof body.parked.total === 'number' && Array.isArray(body.parked.items) ? { total: body.parked.total, items: remoteRows(body.parked.items, 'wall-card', c.tag) } : { total: 0, items: [] };
          return { id: c.tag.id, generatedAt: null, sources: remoteSources(body.sources), cards: remoteRows(body.cards, 'wall-card', c.tag), parked };
        });
        if (part) this.remoteSessions.noteSessions(c.tag.id, part.cards.map((x) => x.id));
        return part;
      }),
    );
    const got = parts.filter((p) => p !== null);
    const cards = mergeOrdered(
      got.map((p) => p.cards),
      wallOrder,
    );
    return {
      version: 1,
      ...mergedSources(got, chosen),
      generatedAt: got.find((p) => p.generatedAt)?.generatedAt ?? new Date().toISOString(),
      count: wallCount(cards),
      cards,
      parked: {
        total: got.reduce((n, p) => n + p.parked.total, 0),
        items: got
          .flatMap((p) => p.parked.items)
          .sort(newerFirst<Record<string, unknown>>((c) => c.since))
          .slice(0, Math.min(Math.max(Math.trunc(parkedLimit ?? 7) || 7, 1), 100)),
      },
      byMachine: got.map((p) => ({ id: p.id, count: wallCount(p.cards), ...(p.sources?.codex.error ? { sources: p.sources } : {}) })),
    };
  }

  // `/api/kanban`
  private async kanban(request: PedidoDoKanban, chosen: Chosen[]) {
    if (chosen.length === 1 && chosen[0]!.tag.id === LOCAL_MACHINE_ID) {
      const board = await this.o.local.kanban!.montar(request);
      const tag = chosen[0]!.tag;
      return { ...board, columns: board.columns.map((col) => ({ ...col, items: col.items.map((i) => withMachine(i, tag)) })) };
    }
    const pages = request.coluna ? Math.min(request.pagina, MAX_REMOTE_PAGES) : 1;
    const asks = Array.from({ length: pages }, (_, i) => ({ ...request, pagina: i + 1 }));
    const kind: RowKind = request.visao === 'sessions' ? 'kanban-session' : 'kanban-agent';
    const parts = await Promise.all(
      chosen.map(async (c) => {
        if (!c.source) {
          if (c.tag.id !== LOCAL_MACHINE_ID) return null;
          const boards = await Promise.all(asks.map((a) => this.o.local.kanban!.montar(a)));
          return columnsOf(boards, (items) => items.map((x) => withMachine(x, c.tag)) as Record<string, unknown>[]);
        }
        return this.remote(c, async (source, reader) => {
          const boards = await Promise.all(asks.map((a) => reader.read(source, kanbanPath(a))));
          if (!boards.every((b) => isObject(b) && Array.isArray(b.columns))) return null;
          return columnsOf(boards as unknown as KanbanHttp[], (items) => remoteRows(items, kind, c.tag));
        });
      }),
    );
    const got = parts.filter((p) => p !== null);
    const all: readonly { id: string; label: string }[] = request.visao === 'sessions' ? COLUNAS_DAS_SESSOES : COLUNAS_DOS_AGENTES;
    const ids = all.filter((col) => !request.coluna || col.id === request.coluna);
    const page = request.coluna ? request.pagina : 1;
    const columns = ids.map(({ id, label }) => {
      const total = got.reduce((n, p) => n + (p.get(id)?.total ?? 0), 0);
      const merged = mergeOrdered(
        got.map((p) => p.get(id)?.items ?? []),
        newerFirst<Record<string, unknown>>((x) => x.lastActivity),
      );
      const start = (page - 1) * KANBAN_PER_PAGE;
      return { id, label, total, page, hasMore: total > page * KANBAN_PER_PAGE, items: merged.slice(start, start + KANBAN_PER_PAGE) };
    });
    return { view: request.visao, perPage: KANBAN_PER_PAGE, columns };
  }

  // `/api/history`
  private async history(request: HistoryRequest, chosen: Chosen[]) {
    const parts = await Promise.all(
      chosen.map(async (c) => {
        if (!c.source) {
          if (c.tag.id !== LOCAL_MACHINE_ID) return null;
          const h = await this.o.local.history!.page(request);
          return { days: h.days.map((d) => ({ day: d.day, sessions: d.sessions.map((s) => withMachine(s, c.tag)) as Record<string, unknown>[] })), next: h.next };
        }
        return this.remote(c, async (source, reader) => remoteHistory(await reader.read(source, historyPath(request)), c.tag));
      }),
    );
    const got = parts.filter((p) => p !== null);
    const byDay = new Map<string, Record<string, unknown>[][]>();
    for (const p of got) for (const d of p.days) byDay.set(d.day, [...(byDay.get(d.day) ?? []), d.sessions]);
    const all = [...byDay.keys()].sort().reverse();
    const kept = all.slice(0, request.days);
    const more = all.length > kept.length || got.some((p) => p.next !== null);
    return {
      days: kept.map((day) => ({ day, sessions: mergeOrdered(byDay.get(day)!, newerFirst<Record<string, unknown>>((s) => s.end)) })),
      next: more && kept.length > 0 ? kept.at(-1)! : null,
    };
  }

  // `/api/events`
  private async events(params: URLSearchParams, chosen: Chosen[]): Promise<{ status: number; body: unknown }> {
    const all = chosen.length > 1;
    const incoming: { after: Record<string, string | null> | null; before: Record<string, string | null> | null } = { after: null, before: null };
    for (const name of ['after', 'before'] as const) {
      const v = params.get(name);
      if (!v) continue;
      if (!all) continue;
      const decoded = decodeCursor(v);
      if (!decoded) throw new RequestError(`${name}: cursor inválido`);
      incoming[name] = decoded;
    }
    const paramsFor = (id: string): URLSearchParams | null => {
      const p = new URLSearchParams(params);
      p.delete(MACHINE_PARAM);
      for (const name of ['after', 'before'] as const) {
        const map = incoming[name];
        if (!map) continue;
        const c = map[id];
        if (typeof c !== 'string') {
          // A machine with nothing older (or not in the cursor) is out of this `before` page.
          if (name === 'before') return null;
          // On `after`, a machine with no place yet (down at load, back now) is read from its first page.
          p.delete(name);
          continue;
        }
        p.set(name, c);
      }
      return p;
    };
    const errors: { status: number; body: unknown }[] = [];
    const parts = await Promise.all(
      chosen.map(async (c) => {
        const p = paramsFor(c.tag.id);
        if (!p) return null;
        if (!c.source) {
          if (c.tag.id !== LOCAL_MACHINE_ID) return null;
          const r = await this.o.local.events!.responder(p);
          if (r.status !== 200) {
            errors.push({ status: r.status, body: r.corpo });
            return null;
          }
          const body = r.corpo as { events: object[]; cursor: string | null; older: string | null; options: { types: string[]; tools: string[]; sessions: object[] } | null };
          return {
            id: c.tag.id,
            events: body.events.map((e) => withMachine(e, c.tag)) as Record<string, unknown>[],
            cursor: body.cursor,
            older: body.older,
            options: body.options ? { types: body.options.types, tools: body.options.tools, sessions: body.options.sessions.map((s) => withMachine(s, c.tag)) } : null,
          };
        }
        return this.remote(c, async (source, reader) => remoteEvents(await reader.answer(source, `${EVENTS_ROUTE}?${p}`), c.tag, !all));
      }),
    );
    if (errors.length) return errors[0]!;
    const got = parts.filter((x) => x !== null);
    const rejected = got.find((x) => 'error' in x);
    if (rejected && 'error' in rejected) return { status: 400, body: { error: rejected.error } };
    const feeds = got.filter((x) => !('error' in x)) as RemoteFeed[];
    const events = mergeOrdered(
      feeds.map((f) => f.events),
      newerFirst<Record<string, unknown>>((e) => e.createdAt),
    );
    const initial = !params.get('after') && !params.get('before');
    const optionParts = feeds.map((f) => f.options).filter((x) => x !== null);
    const options = initial && optionParts.length
      ? {
          types: [...new Set(optionParts.flatMap((x) => x.types))].slice(0, MAX_OPTIONS),
          tools: [...new Set(optionParts.flatMap((x) => x.tools))].slice(0, MAX_OPTIONS),
          sessions: optionParts.flatMap((x) => x.sessions).slice(0, MAX_OPTIONS * chosen.length),
        }
      : null;
    if (!all) {
      const f = feeds[0];
      return { status: 200, body: { events, cursor: f?.cursor ?? null, older: f?.older ?? null, options: initial ? (options ?? { types: [], tools: [], sessions: [] }) : null } };
    }
    // The cursor keeps each machine's place; a machine that did not answer keeps the one it was given.
    const cursor: Record<string, string | null> = {};
    const older: Record<string, string | null> = {};
    for (const c of chosen) {
      const f = feeds.find((x) => x.id === c.tag.id);
      cursor[c.tag.id] = f ? f.cursor : (incoming.after?.[c.tag.id] ?? null);
      older[c.tag.id] = f ? f.older : (incoming.before?.[c.tag.id] ?? null);
    }
    return { status: 200, body: { events, cursor: encodeCursor(cursor), older: encodeCursor(older), options: initial ? (options ?? { types: [], tools: [], sessions: [] }) : null } };
  }

  // `/api/dashboard`
  private async dashboard(chosen: Chosen[]) {
    const parts = await Promise.all(
      chosen.map(async (c) => {
        if (!c.source) {
          if (c.tag.id !== LOCAL_MACHINE_ID) return null;
          const d = await this.o.local.dashboard!();
          return {
            id: c.tag.id,
            head: { generatedAt: d.generatedAt, day: d.day, timeZone: d.timeZone },
            numbers: d.numbers as unknown as Numbers,
            agents: d.agents.map((a) => withMachine(a, c.tag)) as Record<string, unknown>[],
            activity: d.activity.map((a) => withMachine(a, c.tag)) as Record<string, unknown>[],
          };
        }
        return this.remote(c, async (source, reader) => remoteDashboard(await reader.read(source, DASHBOARD_ROUTE), c.tag));
      }),
    );
    const got = parts.filter((p) => p !== null);
    const head = got.find((p) => p.head)?.head ?? { generatedAt: new Date().toISOString(), day: null, timeZone: null };
    const rows = Math.max(0, ...got.map((p) => p.activity.length));
    return {
      ...head,
      numbers: addNumbers(got.map((p) => p.numbers)),
      agents: mergeOrdered(
        got.map((p) => p.agents),
        newerFirst<Record<string, unknown>>((a) => a.lastActivity),
      ),
      activity: mergeOrdered(
        got.map((p) => p.activity),
        newerFirst<Record<string, unknown>>((a) => a.at),
      ).slice(0, rows),
      byMachine: got.map((p) => ({ id: p.id, numbers: p.numbers })),
    };
  }

  // ---------- The Detail ----------

  private async detail(res: ServerResponse, url: URL, match: RegExpExecArray, c: Chosen): Promise<void> {
    let id: string;
    try {
      id = decodeURIComponent(match[1]!);
    } catch {
      id = '';
    }
    if (!REMOTE_ID.test(id)) throw new RequestError('id de sessão inválido');
    const unreachable = () => send(res, 503, { error: 'machine-unreachable', machine: { id: c.state.id, label: c.tag.label, state: c.state.state, lastReadAt: c.state.lastReadAt } });
    const reader = this.o.reader;
    if (!c.source || !reader || c.source.status().state !== 'connected') return unreachable();
    const query = new URLSearchParams();
    let n = 0;
    for (const [name, value] of url.searchParams) {
      if (name === MACHINE_PARAM) continue;
      if (++n > MAX_QUERY_PARAMS || !QUERY_NAME.test(name) || value.length > MAX_QUERY_VALUE) throw new RequestError(`${name.slice(0, 32)}: parâmetro inválido`);
      query.append(name, value);
    }
    const tab = match[2] ?? null;
    const path = `${SESSIONS_ROUTE}/${encodeURIComponent(id)}${tab ? `/${tab}` : ''}${n ? `?${query}` : ''}`;
    const answer = await reader.answer(c.source, path);
    if (!answer) return unreachable();
    const tag = { id: c.tag.id, label: c.tag.label };
    if (answer.status === 400 || answer.status === 404) {
      const message = isObject(answer.body) && typeof answer.body.error === 'string' ? answer.body.error.slice(0, 300) : 'não encontrado';
      return send(res, answer.status, { error: message, machine: tag });
    }
    const body = answer.status === 200 && isObject(answer.body) ? (boundedJson(answer.body) as Record<string, unknown>) : null;
    if (!body || Buffer.byteLength(JSON.stringify(body)) > MAX_REMOTE_DETAIL_BYTES) return send(res, 502, { error: 'machine-bad-response', machine: tag });
    body.machine = tag;
    if (!tab) Object.assign(body, { local: null, opensSession: false, open: { target: 'remote', command: null } });
    send(res, 200, body);
  }
}

interface DiscoverySources { codex: { error: string | null } }

/** Only source availability crosses the remote boundary; never echo a remote exception or extra metadata. */
function remoteSources(value: unknown): DiscoverySources | undefined {
  if (!isObject(value) || !isObject(value.codex)) return undefined;
  if (value.codex.error === null) return { codex: { error: null } };
  if (typeof value.codex.error === 'string' && value.codex.error) return { codex: { error: 'Índice do Codex indisponível nesta máquina.' } };
  return undefined;
}

/** Keep machine attribution in byMachine, and a visible summary for existing list/wall readers. */
function mergedSources(parts: readonly { id: string; sources?: DiscoverySources }[], chosen: readonly Chosen[]): { sources?: DiscoverySources } {
  const known = parts.filter(p => p.sources);
  if (!known.length) return {};
  const failed = known.filter(p => p.sources!.codex.error);
  const error = failed.map(p => {
    const message = p.sources!.codex.error!;
    return chosen.length === 1 ? message : `${chosen.find(c => c.tag.id === p.id)?.tag.label ?? p.id}: ${message}`;
  }).join(' ');
  return { sources: { codex: { error: error || null } } };
}

// ---------- Reading each route of a remote ----------

interface SessionsPart {
  id: string;
  sources?: DiscoverySources;
  items: Record<string, unknown>[];
  total: number;
  registered: number;
  directories: string[];
  counts: Record<string, number>;
}

function sessionsQuery(request: PedidoDeSessoes, page: number): string {
  const q = new URLSearchParams();
  if (request.provider) q.set('provider', request.provider);
  if (request.profileId) q.set('profileId', request.profileId);
  if (request.status !== 'all') q.set('status', request.status);
  if (request.busca) q.set('search', request.busca);
  if (request.dir) q.set('dir', request.dir);
  if (request.ordem !== 'activity') q.set('order', request.ordem);
  if (request.sentido !== 'desc') q.set('direction', request.sentido);
  q.set('page', String(page));
  q.set('perPage', String(REMOTE_PER_PAGE));
  return `${SESSIONS_ROUTE}?${q}`;
}

/** The remote's filtered rows, as deep as `depth`: page 1, then the pages it still needs, in parallel. */
async function remoteSessions(source: RemoteSessionSource, reader: MachineReader, request: PedidoDeSessoes, depth: number, tag: MachineTag): Promise<SessionsPart | null> {
  const first = await reader.read(source, sessionsQuery(request, 1));
  if (!isObject(first) || !Array.isArray(first.items) || !isCount(first.total) || !isCount(first.registered)) return null;
  // A núcleo from before #279 ignores `perPage` and says how many it gave.
  const perPage = isCount(first.perPage) && first.perPage > 0 ? first.perPage : Math.max(1, first.items.length);
  const pages = isCount(first.pages) && first.pages > 0 ? first.pages : Math.ceil(first.total / perPage);
  const needed = Math.min(Math.ceil(depth / perPage), pages, MAX_REMOTE_PAGES);
  const rest = await Promise.all(Array.from({ length: Math.max(0, needed - 1) }, (_, i) => reader.read(source, sessionsQuery(request, i + 2))));
  const raw = [first, ...rest].flatMap((b) => (isObject(b) && Array.isArray(b.items) ? b.items : []));
  const counts = isObject(first.counts) ? Object.fromEntries(FILTROS_DE_STATUS.map((f) => [f, remoteCount((first.counts as Record<string, unknown>)[f])])) : {};
  const directories = Array.isArray(first.directories) ? first.directories.filter((d): d is string => typeof d === 'string' && d.startsWith('/') && d.length <= 1024).slice(0, MAX_DIRECTORIES) : [];
  return {
    id: tag.id,
    sources: remoteSources(first.sources),
    items: remoteRows(raw, 'session', tag, MAX_MERGE_ROWS).slice(0, depth),
    total: remoteCount(first.total),
    registered: remoteCount(first.registered),
    directories,
    counts,
  };
}

/** The wall's order (api/wall.ts): needs you (urgent first), then idle, then the rest; newest `since` first. */
function wallOrder(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const rank = (c: Record<string, unknown>) => {
    const level = isObject(c.attention) ? c.attention.level : null;
    return level === 'blocked' ? 0 : level === 'idle' ? 1 : 2;
  };
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (rank(a) === 0 && a.urgent !== b.urgent) return a.urgent ? -1 : 1;
  return newerFirst<Record<string, unknown>>((c) => c.since)(a, b);
}

const WAITING_STATES = new Set(['waiting', 'error']);
const ACTIVE_STATES = new Set(['active', 'delegating', 'background']);

function wallCount(cards: readonly Record<string, unknown>[]) {
  const level = (c: Record<string, unknown>) => (isObject(c.attention) ? c.attention.level : null);
  return {
    all: cards.length,
    waiting: cards.filter((c) => WAITING_STATES.has(String(c.state))).length,
    active: cards.filter((c) => ACTIVE_STATES.has(String(c.state))).length,
    blocked: cards.filter((c) => level(c) === 'blocked').length,
    idle: cards.filter((c) => level(c) === 'idle').length,
  };
}

function kanbanPath(p: PedidoDoKanban): string {
  const q = new URLSearchParams({ view: p.visao });
  if (p.coluna) {
    q.set('column', p.coluna);
    q.set('page', String(p.pagina));
  }
  return `${KANBAN_ROUTE}?${q}`;
}

/** Each column's total and its items of every page read, in order. */
function columnsOf(boards: readonly KanbanHttp[], items: (raw: unknown[]) => Record<string, unknown>[]): Map<string, { total: number; items: Record<string, unknown>[] }> {
  const out = new Map<string, { total: number; items: Record<string, unknown>[] }>();
  for (const board of boards) {
    for (const col of Array.isArray(board.columns) ? board.columns : []) {
      if (!isObject(col) || typeof col.id !== 'string' || !Array.isArray(col.items)) continue;
      const entry = out.get(col.id) ?? { total: 0, items: [] };
      entry.total = Math.max(entry.total, remoteCount(col.total));
      entry.items.push(...items(col.items as unknown[]).slice(0, KANBAN_PER_PAGE));
      out.set(col.id, entry);
    }
  }
  return out;
}

function historyPath(r: HistoryRequest): string {
  const q = new URLSearchParams({ days: String(r.days) });
  if (r.before) q.set('before', r.before);
  if (r.search) q.set('search', r.search);
  return `${HISTORY_ROUTE}?${q}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function remoteHistory(body: unknown, tag: MachineTag): { days: { day: string; sessions: Record<string, unknown>[] }[]; next: string | null } | null {
  if (!isObject(body) || !Array.isArray(body.days)) return null;
  const days = body.days
    .slice(0, 31)
    .filter((d): d is Record<string, unknown> => isObject(d) && typeof d.day === 'string' && DAY.test(d.day))
    .map((d) => ({ day: d.day as string, sessions: remoteRows(d.sessions, 'history', tag) }))
    .filter((d) => d.sessions.length > 0);
  return { days, next: typeof body.next === 'string' && DAY.test(body.next) ? body.next : null };
}

interface RemoteFeed {
  id: string;
  events: Record<string, unknown>[];
  cursor: string | null;
  older: string | null;
  options: { types: string[]; tools: string[]; sessions: Record<string, unknown>[] } | null;
}

const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const cursorOf = (v: unknown) => (typeof v === 'string' && CURSOR.test(v) ? v : null);
const names = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= max && !/[\0-\x1f]/.test(x)).slice(0, MAX_OPTIONS) : []);

/** The remote's feed; with `passError`, its 400 comes back as `{ error }` (a single remote, nothing local to validate). */
function remoteEvents(answer: { status: number; body: unknown } | null, tag: MachineTag, passError: boolean): RemoteFeed | { error: string } | null {
  if (!answer) return null;
  if (answer.status === 400 && passError) return { error: isObject(answer.body) && typeof answer.body.error === 'string' ? answer.body.error.slice(0, 300) : 'pedido inválido' };
  const body = answer.body;
  if (answer.status !== 200 || !isObject(body) || !Array.isArray(body.events)) return null;
  const o = isObject(body.options) ? body.options : null;
  return {
    id: tag.id,
    events: remoteRows(body.events, 'event', tag, 200),
    cursor: cursorOf(body.cursor),
    older: cursorOf(body.older),
    options: o
      ? {
          types: names(o.types, 64),
          tools: names(o.tools, 128),
          sessions: (Array.isArray(o.sessions) ? o.sessions : [])
            .slice(0, MAX_OPTIONS)
            .filter((s): s is Record<string, unknown> => isObject(s) && typeof s.id === 'string' && REMOTE_ID.test(s.id) && (s.machine === undefined || s.machine === null))
            .map((s) => ({
              id: s.id,
              title: typeof s.title === 'string' ? s.title.slice(0, 120) : null,
              project: typeof s.project === 'string' ? s.project.slice(0, 120) : null,
              machine: { id: tag.id, label: tag.label },
            })),
        }
      : null,
  };
}

/** One cursor for every machine of `machine=all`: base64url of `{ <machine>: <its cursor> }`; `null` when none has one. */
export function encodeCursor(map: Record<string, string | null>): string | null {
  return Object.values(map).some((v) => v !== null) ? Buffer.from(JSON.stringify(map)).toString('base64url') : null;
}

export function decodeCursor(v: string): Record<string, string | null> | null {
  if (v.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const out: Record<string, string | null> = {};
  for (const [k, c] of Object.entries(parsed)) {
    if (!MACHINE_ID.test(k) || (c !== null && cursorOf(c) === null)) return null;
    out[k] = c as string | null;
  }
  return out;
}

// ---------- The dashboard's numbers ----------

interface Numbers {
  sessions: Record<string, number>;
  agents: Record<string, number>;
  subagents: Record<string, number>;
  events: Record<string, number>;
  cost: { usd: number | null; days: number; unpriced: string[] };
}

const NUMBER_GROUPS = {
  sessions: ['total', 'active', 'waiting', 'withError', 'blocked', 'idle'],
  agents: ['active', 'sessions'],
  subagents: ['active', 'sessions'],
  events: ['today', 'lastHour', 'total'],
} as const;

function remoteNumbers(v: unknown): Numbers | null {
  if (!isObject(v) || !isObject(v.cost)) return null;
  const out: Record<string, unknown> = {};
  for (const [group, keys] of Object.entries(NUMBER_GROUPS)) {
    const g = v[group];
    if (!isObject(g)) return null;
    out[group] = Object.fromEntries(keys.map((k) => [k, remoteCount(g[k])]));
  }
  const usd = typeof v.cost.usd === 'number' && Number.isFinite(v.cost.usd) && v.cost.usd >= 0 ? v.cost.usd : null;
  out.cost = { usd, days: remoteCount(v.cost.days, 366), unpriced: names(v.cost.unpriced, 128) };
  return out as unknown as Numbers;
}

function addNumbers(all: readonly Numbers[]): Numbers {
  const sum = (group: keyof typeof NUMBER_GROUPS) => Object.fromEntries(NUMBER_GROUPS[group].map((k) => [k, all.reduce((n, x) => n + (x[group][k] ?? 0), 0)]));
  const priced = all.map((x) => x.cost.usd).filter((u): u is number => u !== null);
  return {
    sessions: sum('sessions'),
    agents: sum('agents'),
    subagents: sum('subagents'),
    events: sum('events'),
    cost: { usd: priced.length ? priced.reduce((a, b) => a + b, 0) : null, days: all[0]?.cost.days ?? 30, unpriced: [...new Set(all.flatMap((x) => x.cost.unpriced))] },
  };
}

function remoteDashboard(body: unknown, tag: MachineTag) {
  if (!isObject(body)) return null;
  const numbers = remoteNumbers(body.numbers);
  if (!numbers) return null;
  return {
    id: tag.id,
    head: null,
    numbers,
    agents: remoteRows(body.agents, 'dashboard-agent', tag, 50),
    activity: remoteRows(body.activity, 'dashboard-activity', tag, 50),
  };
}
