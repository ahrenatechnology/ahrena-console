// The permission request routes (decision 0025, #618, API layer), written against docs/contracts/permission-requests.md.
// The routes and who calls them (#618):
// | Route                                                       | Who        | What (#618) |
// | ----------------------------------------------------------- | ---------- | ---- |
// | `POST /api/sessions/<sid>/permission-requests`              | the hook   | Registers → 201 `{ requestId, expiresAt }` (#618) |
// | `GET …/permission-requests/<rid>/decision?wait=25`          | the hook   | Long poll: 200 once, 204, 409, 410, 404 (#618) |
// | `POST …/permission-requests/<rid>/withdraw`                 | the hook   | The hook gave up (#618) |
// | `GET /api/sessions/<sid>/permission-requests`               | the /ui    | The pending and the recently closed (#618) |
// | `POST …/permission-requests/<rid>/answer`                   | the window | `{ decision, reason? }`, with three proofs (#618) |
//
// The two proofs of the answer (#618) come before any body is read: the same-origin exception of decision 0003 and the in-memory
// window credential (`Ahrena-Window`, compared in constant time). The hook routes refuse a request that carries `Origin` or (#618)
// `Sec-Fetch-Site`, as the mod routes of orders.ts do. Every refusal reaches the caller as `{ error: <code> }`, a closed code, (#618)
// and the audit; no caught error, no request text and no credential goes into a response or the log (decision 0025). (#618)

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChangeCursor } from '../changes/cursor.ts';
import { send, allowedLocalRequest } from '../ingest/hooks/receiver.ts';
import { answerRequest } from '../permissions/answer-request.ts';
import { DigestMismatch, PermissionNotFound } from '../permissions/errors.ts';
import { DECISIONS, type Decision } from '../permissions/model.ts';
import { expireDue } from '../permissions/expire-due.ts';
import { listRequests } from '../permissions/list-requests.ts';
import type { PermissionAuditRecord, PermissionChange, PermissionChangeNotifier, PermissionDeps, Timer } from '../permissions/ports.ts';
import { PermissionRefusal } from '../permissions/refusal.ts';
import { registerRequest } from '../permissions/register-request.ts';
import { settleFromHookEvent, type HookEvent } from '../permissions/settle-from-hook-event.ts';
import { MAX_WAIT_MS, waitForDecision } from '../permissions/wait-for-decision.ts';
import { withdrawRequest } from '../permissions/withdraw-request.ts';
import { fromAnotherSite, fromOwnUi } from './same-origin.ts';

/** What the server hands over to turn the routes on. Absent, the routes do not exist and the two surfaces keep their old shape. (#618) */
export interface PermissionsOptions {
  /** The use cases' ports: the SQLite repository, the audit file, the clock, the notifier. (#618) */
  deps: PermissionDeps;
  /** The switch on the Controle screen: the installation setting `permissions.answerFromConsole`, on when nothing is stored. The capability is on when this and a live window credential hold. (#619) */
  enabled: () => boolean;
  /** Stores the switch (#619). Turning it on takes the window credential, turning it off the owner proof. */
  setEnabled: (value: boolean) => void;
  /** The window credential, in memory only; `null` when this core was not started by the app. Never persisted, never logged. (#618) */
  windowCredential: () => string | null;
  /** How often the expiry sweep runs. Default 30 s. (#618) */
  sweepEveryMs?: number;
}

/** `/api/sessions/<sid>/permission-requests`, `…/<rid>/decision`, `…/<rid>/withdraw` and `…/<rid>/answer`. (#618) */
export const PERMISSION_ROUTE = /^\/api\/sessions\/([^/]+)\/permission-requests(?:\/([^/]+)\/(decision|withdraw|answer))?$/;
/** The raw target of the answer: no query, no dot segment, the same session and request id patterns as the handler. (#618) */
const ANSWER_RAW_PATH = /^\/api\/sessions\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\/permission-requests\/[A-Za-z0-9-]{1,64}\/answer$/;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_REGISTER_BYTES = 64 * 1024;
const MAX_ANSWER_BYTES = 2048;
const DEFAULT_SWEEP_MS = 30_000;
/** A credential shorter than this is no 256-bit credential: the capability reads as off (when in doubt, only the Desktop). (#618) */
const MIN_CREDENTIAL_CHARS = 32;
const WINDOW_HEADER = 'ahrena-window';

/** The /ui window's answer: only `POST` on the exact raw path, `Origin` exactly `http://<Host>`, JSON and a declared length of at most 2048 bytes. (#618) */
export function permissionAnswerFromSameOrigin(req: IncomingMessage, port: number): boolean {
  if (req.method !== 'POST' || !ANSWER_RAW_PATH.test(req.url ?? '') || !fromOwnUi(req, port) || fromAnotherSite(req)) return false;
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return false;
  const length = req.headers['content-length'];
  return typeof length === 'string' && /^\d{1,6}$/.test(length) && Number(length) <= MAX_ANSWER_BYTES;
}

type Operation = 'register' | 'decision' | 'withdraw' | 'list' | 'answer' | 'switch';

/** The Controle switch: `GET` reads `{ enabled, available }`, `PUT { enabled }` sets it (#619). */
export const PERMISSION_SWITCH_ROUTE = '/api/permissions/answer-from-console';
const MAX_SWITCH_BYTES = 256;

/** The /ui window's write of the switch: `PUT` on the exact raw path with `Origin` exactly `http://<Host>`, JSON and a declared length of at most 256 bytes. (#619) */
export function permissionSwitchWriteFromSameOrigin(req: IncomingMessage, port: number): boolean {
  if (req.method !== 'PUT' || req.url !== PERMISSION_SWITCH_ROUTE || !fromOwnUi(req, port) || fromAnotherSite(req)) return false;
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) return false;
  const length = req.headers['content-length'];
  return typeof length === 'string' && /^\d{1,6}$/.test(length) && Number(length) <= MAX_SWITCH_BYTES;
}

interface Parsed {
  operation: Operation | null;
  sessionId: string | null;
  requestId: string | null;
}

const isDecision = (value: string): value is Decision => (DECISIONS as readonly string[]).includes(value);

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function parse(req: IncomingMessage, url: URL): Parsed {
  if (url.pathname === PERMISSION_SWITCH_ROUTE) return { operation: req.method === 'GET' || req.method === 'PUT' ? 'switch' : null, sessionId: null, requestId: null };
  const m = PERMISSION_ROUTE.exec(url.pathname);
  if (!m) return { operation: null, sessionId: null, requestId: null };
  const sessionId = safeDecode(m[1]!);
  const requestId = m[2] === undefined ? null : safeDecode(m[2]);
  const tail = m[3];
  let operation: Operation | null = null;
  if (tail === undefined) operation = req.method === 'POST' ? 'register' : req.method === 'GET' ? 'list' : null;
  else if (tail === 'decision') operation = req.method === 'GET' ? 'decision' : null;
  else if (tail === 'withdraw') operation = req.method === 'POST' ? 'withdraw' : null;
  else operation = req.method === 'POST' ? 'answer' : null;
  return { operation, sessionId, requestId };
}

/** The HTTP status and code a refusal of the use cases maps to; `null` for anything that is not a refusal (a fault). (#618) */
function refusalOf(error: unknown): { status: number; code: string } | null {
  if (error instanceof PermissionNotFound) return { status: 404, code: 'not_found' };
  if (error instanceof DigestMismatch) return { status: 400, code: 'digest_mismatch' };
  if (!(error instanceof PermissionRefusal)) return null;
  switch (error.code) {
    case 'already_answered':
    case 'already_delivered':
    case 'not_answered':
    case 'not_due':
      return { status: 409, code: error.code };
    case 'gone':
      return { status: 410, code: 'gone' };
    case 'terminal_only':
      return { status: 422, code: 'terminal_only' };
    default:
      return { status: 400, code: error.code };
  }
}

/** The window credential matches the one the core holds. Compared as two SHA-256 digests in constant time, so neither the length nor a prefix shows. (#618) */
function windowProven(req: IncomingMessage, credential: string | null): boolean {
  if (credential === null || credential.length < MIN_CREDENTIAL_CHARS) return false;
  const sent = req.headers[WINDOW_HEADER];
  if (typeof sent !== 'string') return false;
  const digest = (text: string) => createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(sent), digest(credential));
}

/** The body up to `limit` bytes as text, or `null` past it. (#618) */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (part: Buffer) => {
      if (over) return;
      size += part.length;
      if (size > limit) {
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

type JsonBody = { ok: true; body: Record<string, unknown> } | { ok: false };

async function jsonBody(req: IncomingMessage, limit: number, refuse: (status: number, code: string) => void): Promise<JsonBody> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    req.resume();
    refuse(415, 'use application/json');
    return { ok: false };
  }
  const declared = Number(req.headers['content-length']);
  if (declared > limit) {
    req.resume();
    refuse(413, 'too_large');
    return { ok: false };
  }
  const raw = await readBody(req, limit);
  if (raw === null) {
    refuse(413, 'too_large');
    return { ok: false };
  }
  try {
    const body = JSON.parse(raw) as unknown;
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) return { ok: true, body: body as Record<string, unknown> };
  } catch {
    // falls through to the generic answer (#618)
  }
  refuse(400, 'invalid_request');
  return { ok: false };
}

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null);

/** The wait of `?wait=` in milliseconds: whole seconds, at most 25; `null` for anything else. (#618) */
function waitOf(url: URL): number | null {
  const raw = url.searchParams.get('wait');
  if (raw === null) return 0;
  if (!/^\d{1,4}$/.test(raw)) return null;
  return Math.min(Number(raw) * 1000, MAX_WAIT_MS);
}

export interface PendingPermission {
  session: string;
  requestId: string;
  tool: string;
  terminalOnly: boolean;
  requestedAt: string;
  expiresAt: string;
}

/** What `GET /api/attention` and the session Detail carry: the ids and flags of the requests still pending, no summary and no folder (both routes are open to the remote proof). (#618) */
export function pendingPermissions(deps: PermissionDeps, sessionId: string | null = null): PendingPermission[] {
  const now = deps.clock.now();
  const open = sessionId === null ? deps.repository.listOpen() : deps.repository.listBySession(sessionId);
  return open
    .filter((r) => r.state === 'pending' && now < r.expiresAt)
    .map((r) => ({ session: r.sessionId, requestId: r.id, tool: r.toolName, terminalOnly: r.terminalOnly, requestedAt: new Date(r.createdAt).toISOString(), expiresAt: new Date(r.expiresAt).toISOString() }));
}

/** The hook event as the use case reads it, from the payload as the hook sent it; `null` for an event that settles nothing or lacks a field. (#618) */
export function hookEventOf(raw: unknown): HookEvent | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const sessionId = typeof p.session_id === 'string' && SESSION_ID.test(p.session_id) ? p.session_id : null;
  if (sessionId === null) return null;
  const name = p.hook_event_name;
  if (name === 'Stop' || name === 'UserPromptSubmit' || name === 'SessionEnd') return { name, sessionId };
  if (name !== 'PreToolUse' && name !== 'PostToolUse' && name !== 'PostToolUseFailure') return null;
  const toolName = text(p.tool_name, 128);
  const toolUseId = text(p.tool_use_id, 128);
  const cwd = text(p.cwd, 1024);
  if (toolName === null || toolUseId === null || cwd === null || p.tool_input === undefined) return null;
  return { name, sessionId, toolName, toolInput: p.tool_input, cwd, toolUseId };
}

export interface Permissions {
  /** `true` for a path of the permission routes, the Controle switch's included (#619). (#618) */
  matches(pathname: string): boolean;
  /** Handles one request of the permission routes, after the owner proof and the same-origin chain. (#618) */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void>;
  /** The refusal of the route's own proofs, with the audit, or `null` when the request may go on. Runs before the same-origin chain. (#618) */
  gate(req: IncomingMessage, url: URL): { status: number; code: string } | null;
  pending(sessionId?: string | null): PendingPermission[];
  /** Settles the requests a hook event closes; never throws. (#618) */
  settle(raw: unknown): Promise<void>;
  /** Starts the expiry sweep; returns what stops it. (#618) */
  startSweep(): () => void;
}

export interface PermissionsContext {
  port: () => number;
  changes?: ChangeCursor;
  /** The account of a session, for the change feed's filters. (#618) */
  accountOf: (sessionId: string) => Promise<string | null>;
  log: (message: string) => void;
}

/** The notifier that also tells the change feed (`permission`) what changed; the inner one still wakes the long polls. (#618) */
function withChangeFeed(inner: PermissionChangeNotifier, ctx: PermissionsContext): PermissionChangeNotifier {
  return {
    subscribe: (requestId, listener) => inner.subscribe(requestId, listener),
    publish(change: PermissionChange) {
      inner.publish(change);
      const changes = ctx.changes;
      if (changes === undefined) return;
      ctx.accountOf(change.sessionId).then(
        (accountId) => changes.record({ type: 'permission', key: change.requestId, sessionId: change.sessionId, accountId }),
        () => changes.record({ type: 'permission', key: change.requestId, sessionId: change.sessionId, accountId: null }),
      );
    },
  };
}

/** A value of a log line as an encoded field: `JSON.stringify` escapes every control character, so a caller's id cannot start a line (#618). */
const field = (value: string): string => JSON.stringify(value).replace(/[\u007f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** The class of a caught value, for the log: its name when it is an Error with a plain one, `non_error` when it is not an Error. Never its message (#618). */
function errorClass(error: unknown): string {
  if (!(error instanceof Error)) return 'non_error';
  const name = error.constructor.name;
  return /^[A-Za-z][A-Za-z0-9_$]{0,63}$/.test(name) ? name : 'unknown';
}

export function createPermissions(options: PermissionsOptions, ctx: PermissionsContext): Permissions {
  const deps: PermissionDeps = { ...options.deps, notifier: withChangeFeed(options.deps.notifier, ctx) };
  const capability = (): boolean => options.enabled() && (options.windowCredential()?.length ?? 0) >= MIN_CREDENTIAL_CHARS;
  const id = (value: string | null, pattern: RegExp): string => (value !== null && pattern.test(value) ? value : '');

  function audit(operation: Operation, parsed: Parsed, code: string): void {
    const record: PermissionAuditRecord = { at: deps.clock.now(), event: 'refused', requestId: id(parsed.requestId, REQUEST_ID), sessionId: id(parsed.sessionId, SESSION_ID), operation, code };
    try {
      deps.audit.append(record);
    } catch (error) {
      ctx.log(`permission audit failed operation=${field(operation)} code=${field(code)} sessionId=${field(record.sessionId || '-')} requestId=${field(record.requestId || '-')} error=${field(errorClass(error))}`);
    }
  }

  /** A fault inside the core is a generic answer; the log names where it happened and the error's class, never its message, as that could carry the call (#618). */
  function fault(res: ServerResponse, parsed: Parsed, error: unknown): void {
    ctx.log(`permission route failed operation=${field(parsed.operation ?? '-')} sessionId=${field(id(parsed.sessionId, SESSION_ID) || '-')} requestId=${field(id(parsed.requestId, REQUEST_ID) || '-')} error=${field(errorClass(error))}`);
    if (!res.headersSent) send(res, 500, { error: 'internal' });
  }

  function gate(req: IncomingMessage, url: URL): { status: number; code: string } | null {
    const parsed = parse(req, url);
    if (parsed.operation === null) return PERMISSION_ROUTE.test(url.pathname) || url.pathname === PERMISSION_SWITCH_ROUTE ? { status: 405, code: 'method_not_allowed' } : null;
    const refuse = (status: number, code: string) => {
      audit(parsed.operation!, parsed, code);
      return { status, code };
    };
    const port = ctx.port();
    if (parsed.operation === 'answer') {
      // The three proofs (#618), and the first two before the body: the bearer was proven by the owner gate, then the origin, then the window.
      if (!permissionAnswerFromSameOrigin(req, port)) return refuse(403, 'forbidden_origin');
      if (!capability() || !windowProven(req, options.windowCredential())) return refuse(403, 'window_only');
      return null;
    }
    if (parsed.operation === 'list' || parsed.operation === 'switch') {
      // (#619) The switch reads and turns off like the list is read: the bearer, or the /ui window. Turning it on takes the window credential too, in the handler.
      const fromUi = req.headers.origin !== undefined && fromOwnUi(req, port);
      if (!(allowedLocalRequest(req, port) || fromUi) || fromAnotherSite(req)) return refuse(403, 'forbidden_origin');
      return null;
    }
    // The hook routes (#618): not a browser, so neither `Origin` nor `Sec-Fetch-Site`, and our Host.
    if (!allowedLocalRequest(req, port) || req.headers['sec-fetch-site'] !== undefined) return refuse(403, 'hook_only');
    return null;
  }

  /** A refusal of the routes themselves once the operation is known: audited, then sent as `{ error: code }` (decision 0025, #618). */
  function refuse(res: ServerResponse, parsed: Parsed, status: number, code: string): void {
    audit(parsed.operation!, parsed, code);
    send(res, status, { error: code });
  }

  function refused(res: ServerResponse, error: unknown, parsed: Parsed): void {
    const mapped = refusalOf(error);
    if (mapped === null) return fault(res, parsed, error);
    send(res, mapped.status, { error: mapped.code });
  }

  async function register(req: IncomingMessage, res: ServerResponse, parsed: Parsed, sessionId: string): Promise<void> {
    if (!capability()) {
      req.resume();
      return send(res, 503, { error: 'off' });
    }
    const read = await jsonBody(req, MAX_REGISTER_BYTES, (status, code) => refuse(res, parsed, status, code));
    if (!read.ok) return;
    const { toolName, toolInput, cwd, permissionMode, digest } = read.body;
    const mode = permissionMode === undefined || permissionMode === null ? null : text(permissionMode, 64);
    if (text(toolName, 128) === null || toolInput === undefined || text(cwd, 1024) === null || (permissionMode !== undefined && permissionMode !== null && mode === null) || typeof digest !== 'string' || !DIGEST.test(digest)) {
      return refuse(res, parsed, 400, 'invalid_request');
    }
    // (#618) Whatever overdue is closed here, where a request enters: no wait for the timer (cheap: one read of the open ones).
    expireDue(deps);
    const registered = await registerRequest(deps, { sessionId, toolName: toolName as string, toolInput, cwd: cwd as string, permissionMode: mode, digest });
    send(res, 201, { requestId: registered.requestId, expiresAt: new Date(registered.expiresAt).toISOString() });
  }

  /** A timer of the clock and a wake on the request's next change, until one of them, or the connection closing. (#618) */
  function waitForChange(requestId: string, ms: number, closed: Promise<void>): Promise<void> {
    const timer: Timer = deps.clock.timer(ms);
    let stop: () => void = () => {};
    const changed = new Promise<void>((resolve) => {
      stop = deps.notifier.subscribe(requestId, resolve);
    });
    return Promise.race([timer.elapsed, changed, closed]).finally(() => {
      timer.cancel();
      stop();
    });
  }

  async function decision(req: IncomingMessage, res: ServerResponse, parsed: Parsed, url: URL, sessionId: string, requestId: string): Promise<void> {
    if (!capability()) return send(res, 503, { error: 'off' });
    const waitMs = waitOf(url);
    if (waitMs === null) return refuse(res, parsed, 400, 'invalid_request');
    // (#618) The hook leaving. While it waits, no read delivers: the delivery is the one synchronous read that finds an answer, and it
    // happens only while the connection is still open, so a hook that disconnected is never handed a decision it cannot apply. (#618)
    let left = false;
    let leave: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      leave = resolve;
    });
    res.once('close', () => {
      left = !res.writableEnded;
      leave();
    });
    const deadline = deps.clock.now() + waitMs;
    for (;;) {
      if (left) return;
      // (#618) Off means off, at each read and right before the read that delivers (when in doubt, only the Desktop): an answered
      // request stays answered, undelivered, and the hook exits without stdout. `capability()` holds the window credential too. (#618)
      if (!capability()) return send(res, 503, { error: 'off' });
      const outcome = await waitForDecision(deps, { sessionId, requestId, waitMs: 0 });
      if (outcome.kind === 'decision') {
        const { requestId: id, digest, decision: answer, reason, answeredBy, channel } = outcome;
        return send(res, 200, { requestId: id, digest, decision: answer, reason, answeredBy, channel });
      }
      const now = deps.clock.now();
      if (now >= deadline) {
        res.writeHead(204);
        return void res.end();
      }
      const request = deps.repository.find(sessionId, requestId);
      const until = Math.min(deadline, request?.expiresAt ?? deadline);
      await waitForChange(requestId, Math.max(until - now, 0), closed);
    }
  }

  async function answer(req: IncomingMessage, res: ServerResponse, parsed: Parsed, sessionId: string, requestId: string): Promise<void> {
    const read = await jsonBody(req, MAX_ANSWER_BYTES, (status, code) => refuse(res, parsed, status, code));
    if (!read.ok) return;
    const { decision: choice, reason, ...rest } = read.body;
    // (#618) Only `decision` and `reason`: an answer that names a session, a request or a digest of its own is refused, the stored ones decide.
    if (Object.keys(rest).length > 0 || (reason !== undefined && typeof reason !== 'string') || typeof choice !== 'string') return refuse(res, parsed, 400, 'invalid_request');
    if (!isDecision(choice)) return refuse(res, parsed, 400, 'invalid_decision');
    answerRequest(deps, { sessionId, requestId, decision: choice, reason, answeredBy: 'owner', channel: 'ui' });
    send(res, 200, { ok: true });
  }

  /** The switch's state: booleans only, `available` being a live window credential (#619). */
  const switchState = (): { enabled: boolean; available: boolean } => ({ enabled: options.enabled(), available: (options.windowCredential()?.length ?? 0) >= MIN_CREDENTIAL_CHARS });

  async function switchRoute(req: IncomingMessage, res: ServerResponse, parsed: Parsed): Promise<void> {
    if (req.method === 'GET') return send(res, 200, switchState());
    const read = await jsonBody(req, MAX_SWITCH_BYTES, (status, code) => refuse(res, parsed, status, code));
    if (!read.ok) return;
    const { enabled, ...rest } = read.body;
    if (Object.keys(rest).length > 0 || typeof enabled !== 'boolean') return refuse(res, parsed, 400, 'invalid_request');
    // (#619) What the person turned off, an agent with only the owner token cannot turn on: on takes the window (when in doubt, only the Desktop).
    if (enabled && !(fromOwnUi(req, ctx.port()) && windowProven(req, options.windowCredential()))) return refuse(res, parsed, 403, 'window_only');
    options.setEnabled(enabled);
    ctx.log(`permission switch set enabled=${enabled}`);
    send(res, 200, switchState());
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parsed = parse(req, url);
    const { operation, sessionId, requestId } = parsed;
    if (operation === null) {
      req.resume();
      return send(res, 405, { error: 'method_not_allowed' });
    }
    if (operation === 'switch') {
      try {
        return await switchRoute(req, res, parsed);
      } catch (error) {
        req.resume();
        return fault(res, parsed, error);
      }
    }
    if (sessionId === null || !SESSION_ID.test(sessionId)) {
      req.resume();
      return refuse(res, parsed, 400, 'invalid_session_id');
    }
    if (operation !== 'register' && operation !== 'list' && (requestId === null || !REQUEST_ID.test(requestId))) {
      req.resume();
      return refuse(res, parsed, 400, 'invalid_request');
    }
    try {
      switch (operation) {
        case 'register':
          return await register(req, res, parsed, sessionId);
        case 'decision':
          return await decision(req, res, parsed, url, sessionId, requestId!);
        case 'withdraw':
          if (!capability()) return send(res, 503, { error: 'off' });
          withdrawRequest(deps, { sessionId, requestId: requestId! });
          return send(res, 200, { ok: true });
        case 'list':
          return send(res, 200, listRequests(deps, { sessionId, unavailableReason: capability() ? null : 'off' }));
        case 'answer':
          return await answer(req, res, parsed, sessionId, requestId!);
        case 'switch':
          return await switchRoute(req, res, parsed);
        default: {
          const unreachable: never = operation;
          void unreachable;
          req.resume();
          return send(res, 405, { error: 'method_not_allowed' });
        }
      }
    } catch (error) {
      req.resume();
      refused(res, error, parsed);
    }
  }

  return {
    matches: (pathname) => PERMISSION_ROUTE.test(pathname) || pathname === PERMISSION_SWITCH_ROUTE,
    handle,
    gate,
    pending: (sessionId = null) => pendingPermissions(deps, sessionId),
    async settle(raw) {
      const event = hookEventOf(raw);
      if (event === null) return;
      try {
        await settleFromHookEvent(deps, event);
      } catch (error) {
        ctx.log(`permission hook event not settled event=${field(event.name)} sessionId=${field(event.sessionId)} error=${field(errorClass(error))}`);
      }
    },
    startSweep() {
      const timer = setInterval(() => {
        try {
          expireDue(deps);
        } catch (error) {
          ctx.log(`permission expiry sweep failed operation=${field('expiry_sweep')} error=${field(errorClass(error))}`);
        }
      }, options.sweepEveryMs ?? DEFAULT_SWEEP_MS);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
