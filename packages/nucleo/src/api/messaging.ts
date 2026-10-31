// Sending a message from the /ui to a live Claude Code session on this machine (#61, first slice),
// through Claude Code's cross-session inbox (src/messaging). Only local: the hub never reaches the
// machine (decision 0002), and no MCP tool sends.
//
// | Route                                          | What                                                      |
// | ---------------------------------------------- | --------------------------------------------------------- |
// | `GET /api/sessions/<id>/messaging`             | Whether the box can send: `available` or `reason`, `entrypoint`, `remoteControl`, `configDir` (name), `account`, `processes`, `inFlight`, `blockedOnPerson` (`?machine=<id>` of a session of another machine gives `other_machine`) |
// | `POST /api/sessions/<id>/messages`             | `{ "text": "<what the person typed>" }` → 202 `{ messageId, state, … }` |
// | `GET /api/sessions/<id>/messages/<messageId>`  | The message's state (the /ui polls it while `sending`)    |
//
// The POST is a same-origin exception of decision 0003 (`messagesWriteFromSameOrigin`, called in
// server.ts `handle`): only `POST`, the exact raw path (no query, no encoding), `Origin` exactly
// `http://<Host>` with our Host, `Content-Type: application/json`, body up to `MAX_MESSAGE_BODY` (96 KiB and 64 bytes: room for
// the `{"text":…}` envelope and the worst JSON escaping, 6 bytes per byte), and the decoded text up
// to 16 KiB of UTF-8 (`MAX_TEXT_BYTES`, checked after parsing: `invalid_text`). Stricter than
// the other writes: a request WITHOUT `Origin` is refused too (`ui_only`), since only text a person
// typed in the /ui may go; nothing batched, nothing generated. `Origin` stops browsers, not local
// processes: server.ts also requires the owner bearer before dispatch (#302).
//
// The text is never logged, never in an error, never in the store: only its SHA-256 in the audit.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { MAX_TEXT_BYTES, type MessageView, type UnavailableReason } from '../messaging/model.ts';
import type { Messaging } from '../messaging/service.ts';
import type { Session } from '../model.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID } from '../telemetry/model.ts';

/** `/api/sessions/<id>/messaging`, `/api/sessions/<id>/messages` and `/api/sessions/<id>/messages/<messageId>`. */
export const MESSAGING_ROUTE = /^\/api\/sessions\/([^/]+)\/(messaging|messages)(?:\/([^/]+))?$/;
/** The exact raw path the same-origin exception accepts. */
const MESSAGES_RAW_PATH = /^\/api\/sessions\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/messages$/;
/**
 * The POST body limit (decision 0003, #61), still bounded before parsing. The text limit is on the
 * decoded text (`MAX_TEXT_BYTES`, 16 KiB of UTF-8); the body has headroom for the `{"text":…}`
 * envelope and for JSON escaping at its worst (`\u00XX`, 6 bytes for 1), so a text within 16 KiB is
 * never refused by the body cap, however many newlines or quotes it has.
 */
export const MAX_MESSAGE_BODY = 6 * MAX_TEXT_BYTES + 64;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MESSAGE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The /ui's Send (#61): only `POST` on the exact path, `Origin` equal to `http://<Host>`, our Host. */
export function messagesWriteFromSameOrigin(req: IncomingMessage, port: number): boolean {
  if (req.method !== 'POST') return false;
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (!MESSAGES_RAW_PATH.test(req.url ?? '')) return false;
  return origin === `http://${host}`;
}

export interface MessagingRouteOptions {
  messaging: Messaging;
  sessions: { getSession(id: string): Promise<Session | null> };
  /** The label and color of the live process's account (api/accounts.ts); without it, `account` is `null`. */
  accounts?: { ofId(id: string): Promise<{ id: string; label: string; color: string }> } | null;
  log?: (message: string) => void;
}

/** The account logged in to the configuration folder of the live process: label and color, as the rest of the /ui shows it. */
export interface MessagingAccount {
  id: string;
  label: string;
  color: string;
}

export type MessagingRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

/** The GET availability answer. */
export interface MessagingAvailabilityBody {
  version: 1;
  sessionId: string;
  available: boolean;
  reason: UnavailableReason | null;
  entrypoint: string | null;
  remoteControl: boolean;
  /** The name (never the path) of the configuration folder whose `sessions/` listed the live process: `.claude`, `.claude-team`. */
  configDir: string | null;
  /** The account logged in to that folder; `null` when unknown or not available. */
  account: MessagingAccount | null;
  processes: number;
  inFlight: string | null;
  /** The session is blocked on a person (a permission, a question or a plan): a message does not answer it. */
  blockedOnPerson: boolean;
}

const ERRORS = {
  invalid_text: 'Escreva um texto de até 16 KiB.',
  in_flight: 'Ainda há uma mensagem a caminho desta sessão. Espere a confirmação.',
  rate_limited: 'Muitas mensagens em pouco tempo. Espere um pouco e tente de novo.',
  ui_only: 'Mensagens só saem da tela do console.',
  closing: 'O núcleo está fechando. Tente de novo quando ele voltar.',
} as const;

/** The body, or `null` as soon as it exceeds `max` (the rest is not kept). */
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) return resolve(null);
    const parts: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (part: Buffer) => {
      if (over) return;
      size += part.length;
      if (size > max) {
        over = true;
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

/** How long the 413 waits for the rest of an oversized body before dropping the request. */
const BODY_CUTOFF_MS = 1000;

/** 413 without keeping the rest of the body, which is discarded for at most `BODY_CUTOFF_MS` (as in agent-config.ts). */
function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  const cutoff = setTimeout(() => req.destroy(), BODY_CUTOFF_MS);
  cutoff.unref();
  req.once('end', () => clearTimeout(cutoff));
  req.once('close', () => clearTimeout(cutoff));
  req.resume();
  res.setHeader('connection', 'close');
  send(res, 413, { error: 'Pedido grande demais: o texto vai até 16 KiB.' });
}

export function createMessagingRoute({ messaging, sessions, accounts = null, log = () => {} }: MessagingRouteOptions): MessagingRoute {
  const accountOf = async (id: string | null): Promise<MessagingAccount | null> => {
    if (id === null || !accounts) return null;
    try {
      const { label, color } = await accounts.ofId(id);
      return { id, label, color };
    } catch (e) {
      log(`messaging: cannot read the account label (${(e as Error)?.name ?? 'error'})`);
      return null;
    }
  };
  return async (req, res, url) => {
    const m = MESSAGING_ROUTE.exec(url.pathname)!;
    const sessionId = safeDecode(m[1]);
    const kind = m[2];
    const messageId = m[3] === undefined ? null : safeDecode(m[3]);
    if (kind === 'messaging' && messageId !== null) return send(res, 404, { error: 'não encontrado' });
    const isPost = kind === 'messages' && messageId === null;
    if (isPost ? req.method !== 'POST' : req.method !== 'GET') {
      req.resume();
      return send(res, 405, { error: isPost ? 'use POST' : 'use GET' });
    }
    if (sessionId === null || !ID.test(sessionId)) return send(res, 400, { error: 'id de sessão inválido' });

    if (isPost) {
      // The server let a no-Origin loopback request through, like every write; this one is the /ui's only.
      if (typeof req.headers.origin !== 'string') {
        req.resume();
        return send(res, 403, { error: ERRORS.ui_only, reason: 'ui_only' });
      }
      if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
        req.resume();
        return send(res, 415, { error: 'use application/json' });
      }
      const raw = await readBody(req, MAX_MESSAGE_BODY);
      if (raw === null) return tooLarge(req, res);
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'JSON inválido', reason: 'invalid_text' });
      }
      if (!(await sessions.getSession(sessionId))) return send(res, 404, { error: 'o núcleo não conhece esta sessão' });
      const text = body && typeof body === 'object' && !Array.isArray(body) ? (body as { text?: unknown }).text : undefined;
      const r = await messaging.send(sessionId, text);
      if (r.kind === 'accepted') return send(res, 202, r.message);
      if (r.refusal === 'in_flight') return send(res, 409, { error: ERRORS.in_flight, reason: r.refusal, messageId: r.messageId ?? null });
      if (r.refusal === 'rate_limited') {
        res.setHeader('retry-after', String(Math.max(1, Math.ceil((r.retryAfterMs ?? 0) / 1000))));
        return send(res, 429, { error: ERRORS.rate_limited, reason: r.refusal, retryAfterMs: r.retryAfterMs ?? null });
      }
      if (r.refusal === 'closing') return send(res, 503, { error: ERRORS.closing, reason: r.refusal });
      return send(res, 400, { error: ERRORS[r.refusal], reason: r.refusal });
    }

    if (kind === 'messages') {
      const view: MessageView | null = messageId !== null && MESSAGE_ID.test(messageId) ? messaging.message(sessionId, messageId) : null;
      return view ? send(res, 200, view) : send(res, 404, { error: 'mensagem desconhecida: o núcleo pode ter reiniciado' });
    }

    const machine = url.searchParams.get('machine');
    if (machine !== null && !MACHINE_ID.test(machine)) return send(res, 400, { error: 'machine inválida: letras minúsculas, números e hífen' });
    const session = await sessions.getSession(sessionId);
    const otherMachine = machine !== null && machine !== LOCAL_MACHINE_ID;
    // A session of another machine is not in this core's store (#243): its id comes with `?machine=`.
    if (!session && !otherMachine) return send(res, 404, { error: 'o núcleo não conhece esta sessão' });
    const { accountId, ...a } = await messaging.availability(sessionId, { otherMachine });
    const answer: MessagingAvailabilityBody = {
      version: 1,
      sessionId,
      available: a.available,
      reason: a.reason,
      entrypoint: a.entrypoint,
      remoteControl: a.remoteControl,
      configDir: a.configDir,
      account: await accountOf(accountId),
      processes: a.processes,
      inFlight: a.inFlight,
      blockedOnPerson: session?.awaitingReason === 'notification',
    };
    send(res, 200, answer);
  };
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
