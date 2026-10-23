// Per-session orders: what the /ui asks the session itself to do, one slash command at a time
// (`/compact`, `/clear`, turning Remote Control on; #61, the mod part). No outside process can run a
// slash command in a session, so the order waits here until the panel mod, running inside that session,
// fetches it (decision 0003: the machine asks, nobody calls it), runs it and says how it went.
//
// Like the requests of decision 0003: random id, a deadline, delivered once. Only the local /ui creates
// an order (api/orders.ts), never the hub. In memory: a restart forgets the orders, and a session
// that was waiting for one simply never gets it.

import { randomUUID } from 'node:crypto';

export const ORDER_KINDS = ['compact', 'clear', 'remote-control'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];

/** `queued`: not fetched yet. `running`: the mod has it. The rest are final. */
export type OrderState = 'queued' | 'running' | 'done' | 'failed' | 'expired';

export interface OrderView {
  orderId: string;
  sessionId: string;
  kind: OrderKind;
  state: OrderState;
  /** Why it did not happen: what the mod said (`failed`) or `no_mod` / `no_answer` (`expired`). */
  reason: string | null;
  createdAt: string;
  settledAt: string | null;
}

/** What the mod receives: the id to confirm and the command to run. Nothing else. */
export interface OrderToRun {
  orderId: string;
  kind: OrderKind;
}

/** The mod has this long to fetch an order; then nobody is listening in that session. */
export const QUEUED_TTL_MS = 2 * 60_000;
/** After the fetch, the command waits for the session to be idle: this long, at most, for the answer. */
export const RUNNING_TTL_MS = 10 * 60_000;
/** How long a settled order stays readable, so the /ui can show how it ended. */
const KEEP_SETTLED_MS = 10 * 60_000;
const MAX_ORDERS = 200;
const MAX_REASON = 200;

interface Order extends OrderView {
  expiresAt: number;
}

export type CreateResult = { kind: 'accepted'; order: OrderView } | { kind: 'refused'; refusal: 'invalid_kind' | 'in_flight' | 'too_many'; orderId?: string };

export const isOrderKind = (v: unknown): v is OrderKind => typeof v === 'string' && (ORDER_KINDS as readonly string[]).includes(v);

export class SessionOrders {
  readonly #orders = new Map<string, Order>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  create(sessionId: string, kind: unknown): CreateResult {
    if (!isOrderKind(kind)) return { kind: 'refused', refusal: 'invalid_kind' };
    this.#sweep();
    for (const o of this.#orders.values()) {
      if (o.sessionId === sessionId && (o.state === 'queued' || o.state === 'running')) return { kind: 'refused', refusal: 'in_flight', orderId: o.orderId };
    }
    if (this.#orders.size >= MAX_ORDERS) return { kind: 'refused', refusal: 'too_many' };
    const now = this.#now();
    const order: Order = {
      orderId: randomUUID(),
      sessionId,
      kind,
      state: 'queued',
      reason: null,
      createdAt: new Date(now).toISOString(),
      settledAt: null,
      expiresAt: now + QUEUED_TTL_MS,
    };
    this.#orders.set(order.orderId, order);
    return { kind: 'accepted', order: view(order) };
  }

  /** The queued orders of the session, handed over once: each becomes `running`. */
  claim(sessionId: string): OrderToRun[] {
    this.#sweep();
    const out: OrderToRun[] = [];
    for (const o of this.#orders.values()) {
      if (o.sessionId !== sessionId || o.state !== 'queued') continue;
      o.state = 'running';
      o.expiresAt = this.#now() + RUNNING_TTL_MS;
      out.push({ orderId: o.orderId, kind: o.kind });
    }
    return out;
  }

  /** The mod's answer. `false` if the order is not this session's or is not running (late, repeated, forged). */
  done(sessionId: string, orderId: string, result: { ok: boolean; reason?: string | null }): boolean {
    this.#sweep();
    const o = this.#orders.get(orderId);
    if (!o || o.sessionId !== sessionId || o.state !== 'running') return false;
    o.state = result.ok ? 'done' : 'failed';
    o.reason = result.ok ? null : typeof result.reason === 'string' && result.reason.trim() ? result.reason.trim().slice(0, MAX_REASON) : 'sem motivo';
    o.settledAt = new Date(this.#now()).toISOString();
    return true;
  }

  get(sessionId: string, orderId: string): OrderView | null {
    this.#sweep();
    const o = this.#orders.get(orderId);
    return o && o.sessionId === sessionId ? view(o) : null;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, o] of this.#orders) {
      if ((o.state === 'queued' || o.state === 'running') && now >= o.expiresAt) {
        o.reason = o.state === 'queued' ? 'no_mod' : 'no_answer';
        o.state = 'expired';
        o.settledAt = new Date(now).toISOString();
      } else if (o.settledAt !== null && now - Date.parse(o.settledAt) > KEEP_SETTLED_MS) {
        this.#orders.delete(id);
      }
    }
  }
}

function view(o: Order): OrderView {
  const { expiresAt: _, ...v } = o;
  return v;
}
