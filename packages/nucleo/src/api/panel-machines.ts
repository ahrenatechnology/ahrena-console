// The panel's "precisam de você" across machines (#262, wireframes P15 and P16): `?needYou=<scope>` on
// `GET /api/panel/<session>`. The mod sends it on every tick; the count of the main screen then sums
// every machine, and the list follows the Select's scope.
//
// ## The parameter
//
// - `needYou` takes `family`, `all`, `local` or the id of a remote machine (the ids of `GET /api/machines`).
// - Absent, empty or malformed (fails the server's `PARAM`): the panel goes out as before, byte for
//   byte, and no remote is read for it (`decorate` returns the same object, untouched).
// - A well-formed id that is not a remote machine (removed from machines.json) is answered as `all`, and
//   `needYou.scope` says `all`. Never 400: the mod polls the panel every 5 s.
// - It is never sent to a remote: a remote is read with routes it already has (below), so this works
//   against a núcleo without #262.
//
// ## What it adds to `needYou`
//
// - Every item of `family` and `machine` gains `machine`: `null` for this Mac; for a remote session's
//   panel (#319), whose own lists are that remote's, the remote's `{ id, label }`.
// - `total`, `yourTurn` and `byAccount` cover this Mac and every connected remote, whatever the scope;
//   accounts are merged by label (a remote account's id is `remote:<machine>:<label>`, never shown).
// - `scope`, `items` (the scope's list, `needs` first and then `your-turn`, each oldest `since` first,
//   at most `MAX_ITEMS`), `itemsTotal`, `itemsNeeds` and `itemsYourTurn` (that list's counts before
//   the cap, for the header and the "+N" line), `byMachine` (this Mac first, then each remote in
//   machines.json order; a remote that is down has 0) and `machines` (each remote with its state,
//   `lastReadAt`, #278's connection and the `since` of the P16 line).
// - The session the panel is open on is never in any list, also when it is a remote one.
//
// ## A remote's items
//
// Read through the reader of #243 (api/machine-reader.ts: `GET` only, connected machines only, the 3 s
// budget, the 5 s cache): the remote's `GET /api/attention` (who waits on you, with level, reason,
// account and since; validated by `remoteAttentionItems`) joined by session id with its `GET /api/wall`
// (title, state, reason, urgent, the activity text and the model; validated as `wall-card` rows).
// Neither records anything on the remote (its `/api/panel/<id>` would record the env of the id, so it
// is not used). Only the attention items enter: a wall card only enriches one. A remote that is down,
// slow, or answers without the shape contributes nothing; its `machines` entry says why.

import { AWAITING_REASONS } from '../model.ts';
import { LOCAL_MACHINE_ID } from '../telemetry/model.ts';
import { localMachine, type TelemetryService } from '../telemetry/service.ts';
import { remoteAttentionItems, type ItemDaAtencao } from './attention-route.ts';
import { isObject, remoteRows, type MachineTag } from './machine-items.ts';
import { panelConnection, withDeadline, type MachineReader, type RemoteSessionSource } from './machine-reader.ts';
import type { MontadorDoPainel } from './panel.ts';
import type { NeedsYouItem, PanelAccount, PanelNeedYouMachine } from './types.ts';

export const NEED_YOU_PARAM = 'needYou';
export const NEED_YOU_SCOPES = ['family', 'all', 'local'] as const;
/** At most this many items in `needYou.items`. */
export const MAX_ITEMS = 24;
/** The server's `PARAM` (server.ts; not imported, server.ts imports this module). */
const PARAM = /^[A-Za-z0-9_.\[\]-]{1,64}$/;
export const REMOTE_ATTENTION_PATH = '/api/attention';
export const REMOTE_WALL_PATH = '/api/wall';
const DEADLINE_MARGIN_MS = 250;
const MAX_TITLE = 200;
const MAX_TEXT = 300;
const MAX_MODEL = 100;
/** This Mac's label, as the lists of every machine (#243) give it. */
const LOCAL_LABEL = localMachine().label;

type Item = NeedsYouItem & { machine: MachineTag | null };

export interface PanelMachinesOptions {
  /** The remote machines' reader (#243); without it, only this Mac. */
  reader?: MachineReader | null;
  /** The machines' state and `lastReadAt` (`GET /api/machines`). */
  telemetry?: Pick<TelemetryService, 'machines'> | null;
  /** This Mac's panel builder, for its need-you items. */
  local: Pick<MontadorDoPainel, 'needYouItems'>;
}

/** The scope a `needYou` value asks for; `null` when absent, empty or malformed (the panel of before). */
export function needYouScopeOf(raw: string | null): string | null {
  return raw && PARAM.test(raw) ? raw : null;
}

export class PanelMachines {
  private readonly o: PanelMachinesOptions;

  constructor(options: PanelMachinesOptions) {
    this.o = options;
  }

  /**
   * The panel `body` of `sessionId` with the need-you of every machine when `url` has a well-formed
   * `needYou`; otherwise `body` itself, untouched. `body.machine` tells a remote session's panel (#319).
   * `local`: this Mac's uncapped need-you list when the caller already built it for the same request
   * (`MontadorDoPainel.needYouItemsOf`); without it, it is built here.
   */
  async decorate<T extends object>(body: T, sessionId: string, url: URL, local: readonly NeedsYouItem[] | null = null): Promise<T> {
    const raw = needYouScopeOf(url.searchParams.get(NEED_YOU_PARAM));
    const b = body as Record<string, unknown>;
    if (!raw || !isObject(b.needYou)) return body;
    const needYou = b.needYou;
    const remotes = this.o.reader?.machines() ?? [];
    const scope = (NEED_YOU_SCOPES as readonly string[]).includes(raw) || remotes.some((m) => m.id === raw) ? raw : 'all';
    const owner = isObject(b.machine) && typeof b.machine.id === 'string' && typeof b.machine.label === 'string' ? { id: b.machine.id, label: b.machine.label } : null;

    const [localItems, remoteParts, machines] = await Promise.all([
      this.localItems(sessionId, url, local),
      Promise.all(remotes.map((m) => this.remoteItems(m, sessionId))),
      this.machineEntries(remotes),
    ]);

    // The panel's own lists: this Mac's, or the remote's for a remote session's panel (#319).
    const mark = (list: unknown): unknown => (Array.isArray(list) ? list.map((i) => (isObject(i) ? { ...i, machine: owner } : i)) : list);
    const family = (mark(needYou.family) as unknown[] | unknown) ?? [];
    const familyItems = (Array.isArray(family) ? family : []).filter((i): i is Item => isObject(i) && i.id !== sessionId && typeof i.since === 'string');

    const all = [...localItems, ...remoteParts.flat()];
    const scoped = (): Item[] => {
      if (scope === 'family') return familyItems;
      if (scope === 'local') return localItems;
      if (scope === 'all') return all;
      return remoteParts[remotes.findIndex((m) => m.id === scope)] ?? [];
    };
    const needs = all.filter((i) => i.level === 'needs');
    const needsOf = (list: readonly Item[]) => list.filter((i) => i.level === 'needs').length;
    const inScope = scoped();
    const scopeNeeds = needsOf(inScope);
    return {
      ...body,
      needYou: {
        ...needYou,
        total: needs.length,
        yourTurn: all.length - needs.length,
        byAccount: byAccount(needs),
        family,
        machine: mark(needYou.machine),
        scope,
        items: ordered(inScope).slice(0, MAX_ITEMS),
        itemsTotal: inScope.length,
        itemsNeeds: scopeNeeds,
        itemsYourTurn: inScope.length - scopeNeeds,
        byMachine: [{ id: LOCAL_MACHINE_ID, label: LOCAL_LABEL, n: needsOf(localItems) }, ...remotes.map((m, k) => ({ id: m.id, label: m.label, n: needsOf(remoteParts[k]!) }))],
        machines,
      },
    };
  }

  /** This Mac's items, `machine: null`; for a remote session's panel, this Mac's around it. */
  private async localItems(sessionId: string, url: URL, built: readonly NeedsYouItem[] | null): Promise<Item[]> {
    const items = built ?? (await this.o.local.needYouItems(sessionId, needYouScopeOf(url.searchParams.get('local'))));
    return items.filter((i) => i.id !== sessionId).map((i) => ({ ...i, machine: null }));
  }

  /** A remote's items, bounded by the read budget as a whole; none when it is down, slow or off shape. */
  private async remoteItems(m: RemoteSessionSource, sessionId: string): Promise<Item[]> {
    const reader = this.o.reader;
    if (!reader || m.status().state !== 'connected') return [];
    const tag = { id: m.id, label: m.label };
    const read = async (): Promise<Item[]> => {
      const [attention, wall] = await Promise.all([reader.read(m, REMOTE_ATTENTION_PATH), reader.read(m, REMOTE_WALL_PATH)]);
      const cards = new Map<string, Record<string, unknown>>();
      if (isObject(wall)) for (const c of remoteRows(wall.cards, 'wall-card', tag)) cards.set(c.id as string, c);
      const seen = new Set<string>();
      const out: Item[] = [];
      for (const a of remoteAttentionItems(attention, tag)) {
        if (a.session === sessionId || seen.has(a.session)) continue;
        seen.add(a.session);
        out.push(remoteItem(a, cards.get(a.session) ?? null, tag));
      }
      return out;
    };
    return (await withDeadline(read(), reader.timeoutMs + DEADLINE_MARGIN_MS)) ?? [];
  }

  /** Every remote of machines.json, in its order, with #243's state and #278's connection. */
  private async machineEntries(remotes: readonly RemoteSessionSource[]): Promise<PanelNeedYouMachine[]> {
    const reader = this.o.reader;
    if (!reader || remotes.length === 0) return [];
    // One deadline for both reads: the connections get only what the telemetry read left of it.
    const deadline = Date.now() + reader.timeoutMs;
    const bounded = <V>(p: Promise<V>): Promise<V | null> => withDeadline(p, Math.max(0, deadline - Date.now()));
    const summaries = this.o.telemetry ? await bounded(this.o.telemetry.machines()) : null;
    // A summary that carries #278's connection already asked for it; only the others ask the reader.
    const connections = await Promise.all(
      remotes.map((m) => {
        const s = summaries?.find((x) => x.id === m.id);
        return s && 'connection' in s ? panelConnection(s.connection) : bounded(reader.connection(m));
      }),
    );
    return remotes.map((m, k): PanelNeedYouMachine => {
      const s = summaries?.find((x) => x.id === m.id);
      const status = m.status();
      const connection = connections[k] ?? null;
      const lastReadAt = s?.lastReadAt ?? null;
      return {
        id: m.id,
        label: m.label,
        state: s?.state ?? status.state,
        reason: s ? s.reason : (status.reason ?? null),
        lastReadAt,
        connection,
        since: connection && connection.state !== 'up' ? (connection.since ?? lastReadAt) : lastReadAt,
      };
    });
  }
}

/** A remote's attention item as a panel item, with its wall card's fields when there is one. */
function remoteItem(a: ItemDaAtencao, card: Record<string, unknown> | null, tag: MachineTag): Item {
  const activity = card && isObject(card.activity) && typeof card.activity.text === 'string' ? card.activity.text : null;
  const reason = card && typeof card.reason === 'string' && (AWAITING_REASONS as readonly string[]).includes(card.reason) ? (card.reason as NeedsYouItem['reason']) : null;
  return {
    id: a.session,
    level: a.level,
    why: a.reason,
    local: null,
    title: (card && typeof card.title === 'string' ? card.title : a.title).slice(0, MAX_TITLE),
    state: (card ? card.state === 'error' : a.reason === 'error') ? 'error' : 'waiting',
    reason,
    urgent: card ? card.urgent === true : a.reason === 'error',
    since: a.since,
    text: (activity ?? a.longReason).slice(0, MAX_TEXT),
    model: card && typeof card.model === 'string' ? card.model.slice(0, MAX_MODEL) : null,
    relation: null,
    sameProject: false,
    // The remote sends label and color only; the id only groups, the source is never shown.
    account: a.account ? { id: `remote:${tag.id}:${a.account.label}`, label: a.account.label, color: a.account.color, source: 'profile' } : null,
    machine: { id: tag.id, label: tag.label },
  };
}

/** `needs` first, then `your-turn`; in each, the oldest `since` first; ties keep this Mac first, then by id. */
function ordered(items: readonly Item[]): Item[] {
  const rank = (i: Item) => (i.level === 'needs' ? 0 : 1);
  const at = (i: Item) => {
    const t = Date.parse(i.since);
    return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
  };
  return [...items].sort((a, b) => rank(a) - rank(b) || at(a) - at(b) || Number(a.machine != null) - Number(b.machine != null) || String(a.id).localeCompare(String(b.id)));
}

/** The `needs` count by account across machines, merged by label ("Sem conta" is `null`); the largest first. */
function byAccount(needs: readonly Item[]): { account: PanelAccount | null; n: number }[] {
  const by = new Map<string, { account: PanelAccount | null; n: number }>();
  for (const i of needs) {
    const k = i.account ? `label:${i.account.label}` : '';
    const e = by.get(k);
    if (!e) {
      by.set(k, { account: i.account, n: 1 });
      continue;
    }
    e.n++;
    // This Mac's account stands for the label over a remote's (the remote's id is only made up).
    if (i.machine === null && i.account && e.account?.id.startsWith('remote:')) e.account = i.account;
  }
  return [...by.values()].sort((a, b) => b.n - a.n);
}
