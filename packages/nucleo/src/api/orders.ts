// The per-session orders of the /ui (`/compact`, `/clear`, Remote Control; #61, mod part), carried by
// the panel mod running inside the session (src/messaging/orders.ts).
//
// | Route                                                   | Who       | What |
// | ------------------------------------------------------- | --------- | ---- |
// | `POST /api/sessions/<id>/commands` `{ "kind": … }`      | the /ui   | Creates the order → 202 `{ orderId, state, … }` |
// | `GET /api/sessions/<id>/commands/<orderId>`             | the /ui   | The order's state (polled while `queued` or `running`) |
// | `GET /api/sessions/<id>/commands`                       | the mod   | Hands over the session's queued orders, once → `{ orders: [{ orderId, kind }] }` |
// | `POST /api/sessions/<id>/commands/<orderId>/done`       | the mod   | `{ "ok": boolean, "reason"?: string }` |
//
// Creating is a same-origin exception of decision 0003, as the messages' (`ordersWriteFromSameOrigin`):
// `POST`, the exact raw path, `Origin` exactly `http://<Host>` with our Host, `application/json`. The
// two the mod makes carry no `Origin` and no `Sec-Fetch-Site` (a loopback client, not a browser), and a request
// WITH either is refused there: a page, even one that sends no `Origin` (a GET), must not fetch or confirm an order. The hub never creates one.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import type { Messaging } from '../messaging/service.ts';
import { isOrderKind, type SessionOrders } from '../messaging/orders.ts';
import type { Session } from '../model.ts';
import { fromOwnUi } from './same-origin.ts';

/** `/api/sessions/<id>/commands`, `…/commands/<orderId>` and `…/commands/<orderId>/done`. */
export const ORDERS_ROUTE = /^\/api\/sessions\/([^/]+)\/commands(?:\/([^/]+)(?:\/(done))?)?$/;
const CREATE_RAW_PATH = /^\/api\/sessions\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/commands$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ORDER_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_BODY = 2048;

/** The /ui's create: only `POST` on the exact path, `Origin` equal to `http://<Host>`, our Host. */
export function ordersWriteFromSameOrigin(req: IncomingMessage, port: number): boolean {
  return req.method === 'POST' && CREATE_RAW_PATH.test(req.url ?? '') && fromOwnUi(req, port);
}

export interface OrdersRouteOptions {
  orders: SessionOrders;
  messaging: Pick<Messaging, 'availability'>;
  sessions: { getSession(id: string): Promise<Session | null> };
}

export type OrdersRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

const ERRORS = {
  invalid_kind: 'Ordem desconhecida: compact, clear ou remote-control.',
  in_flight: 'Ainda há uma ordem a caminho desta sessão. Espere o resultado.',
  too_many: 'Ordens demais em aberto. Tente de novo em instantes.',
  closing: 'O núcleo está fechando. Tente de novo quando ele voltar.',
} as const;

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (part: Buffer) => {
      if (over) return;
      size += part.length;
      if (size > MAX_BODY) {
        over = true;
        req.resume();
        return resolve(null);
      }
      parts.push(part);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(parts).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

async function jsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    req.resume();
    send(res, 415, { error: 'use application/json' });
    return null;
  }
  const raw = await readBody(req);
  if (raw === null) {
    send(res, 413, { error: 'Pedido grande demais.' });
    return null;
  }
  try {
    const body = JSON.parse(raw) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // falls through
  }
  send(res, 400, { error: 'JSON inválido' });
  return null;
}

export function createOrdersRoute({ orders, messaging, sessions }: OrdersRouteOptions): OrdersRoute {
  return async (req, res, url) => {
    const m = ORDERS_ROUTE.exec(url.pathname)!;
    const sessionId = safeDecode(m[1]!);
    const orderId = m[2] === undefined ? null : safeDecode(m[2]);
    const isDone = m[3] === 'done';
    // A browser always sends `Sec-Fetch-Site` and, on a write, `Origin`; the mod is not a browser and sends neither.
    // A GET has no `Origin` even from a page (same-origin or an `<img>`), so the header is what tells them apart.
    const fromPage = typeof req.headers.origin === 'string' || typeof req.headers['sec-fetch-site'] === 'string';
    const createdByUi = typeof req.headers.origin === 'string';
    if (sessionId === null || !ID.test(sessionId)) {
      req.resume();
      return send(res, 400, { error: 'id de sessão inválido' });
    }
    if (orderId !== null && !ORDER_ID.test(orderId)) {
      req.resume();
      return send(res, 400, { error: 'id de ordem inválido' });
    }

    // POST …/commands: the /ui creates.
    if (orderId === null && req.method === 'POST') {
      if (!createdByUi) {
        req.resume();
        return send(res, 403, { error: 'Ordens só saem da tela do console.', reason: 'ui_only' });
      }
      const body = await jsonBody(req, res);
      if (!body) return;
      if (!isOrderKind(body.kind)) return send(res, 400, { error: ERRORS.invalid_kind, reason: 'invalid_kind' });
      if (!(await sessions.getSession(sessionId))) return send(res, 404, { error: 'o núcleo não conhece esta sessão' });
      const a = await messaging.availability(sessionId, { otherMachine: false });
      if (!a.available) return send(res, 409, { error: 'A sessão não tem um processo vivo nesta máquina para receber a ordem.', reason: a.reason });
      const r = orders.create(sessionId, body.kind);
      if (r.kind === 'accepted') return send(res, 202, r.order);
      return send(res, 409, { error: ERRORS[r.refusal], reason: r.refusal, orderId: r.orderId ?? null });
    }

    // GET …/commands: the mod fetches. The page never does.
    if (orderId === null && req.method === 'GET') {
      if (fromPage) return send(res, 403, { error: 'Só o mod da sessão busca ordens.', reason: 'mod_only' });
      return send(res, 200, { orders: orders.claim(sessionId) });
    }

    // POST …/commands/<id>/done: the mod confirms. The page never does.
    if (orderId !== null && isDone && req.method === 'POST') {
      if (fromPage) {
        req.resume();
        return send(res, 403, { error: 'Só o mod da sessão confirma uma ordem.', reason: 'mod_only' });
      }
      const body = await jsonBody(req, res);
      if (!body) return;
      if (typeof body.ok !== 'boolean') return send(res, 400, { error: 'informe { "ok": true|false }' });
      const reason = typeof body.reason === 'string' ? body.reason : null;
      return orders.done(sessionId, orderId, { ok: body.ok, reason }) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'ordem desconhecida, já confirmada ou de outra sessão' });
    }

    // GET …/commands/<id>: the state.
    if (orderId !== null && !isDone && req.method === 'GET') {
      const v = orders.get(sessionId, orderId);
      return v ? send(res, 200, v) : send(res, 404, { error: 'ordem desconhecida: o núcleo pode ter reiniciado' });
    }

    req.resume();
    return send(res, 405, { error: 'método não permitido' });
  };
}
