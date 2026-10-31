// The app update notice's routes (#330, wireframes C77 to C80), behind the server's Origin and Host
// defenses (decision 0003):
//
// - `GET /api/app-update`: the state (src/app-update/state.ts). The /ui reads it, and the app too.
// - `PUT /api/app-update/state`: the app reports what it found and how it is going. Only a local
//   request without `Origin` (the app); the /ui cannot report, so a page cannot invent a version.
// - `POST /api/app-update/actions/<check|install|dismiss|ack>`: the person's clicks. From the /ui
//   itself (`Origin` exactly `http://<Host>`, the exact raw path) or the app (no `Origin`). `dismiss`
//   may carry `{ "version": "<x>" }`. 404 `no-app` when no app reported to this núcleo; the
//   artifact in claude.ai only reads (MCP does not write).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { APP_UPDATE_ACTIONS, APP_UPDATE_ERRORS, APP_UPDATE_MODES, APP_UPDATE_PHASES, type AppUpdateAction, type AppUpdateReport, type AppUpdateState } from '../app-update/state.ts';
import { fromOwnUi } from './same-origin.ts';

export const APP_UPDATE_ROUTE = '/api/app-update';
const STATE_ROUTE = `${APP_UPDATE_ROUTE}/state`;
const ACTION_ROUTE = /^\/api\/app-update\/actions\/(check|install|dismiss|ack)$/;
const MAX_BODY = 4096;

export const isAppUpdateRoute = (pathname: string): boolean => pathname === APP_UPDATE_ROUTE || pathname.startsWith(`${APP_UPDATE_ROUTE}/`);

/** The /ui's Atualizar, Depois and Buscar agora: `POST` on the exact raw action path, from the same origin. */
export function appUpdateWriteFromSameOrigin(req: IncomingMessage, port: number): boolean {
  return req.method === 'POST' && ACTION_ROUTE.test(req.url ?? '') && fromOwnUi(req, port);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_BODY) tooLarge = true;
    });
    req.on('end', () => resolve(tooLarge ? null : body));
    req.on('error', reject);
  });
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max && !/[\0\r\n]/.test(v) ? v : null);
const epoch = (v: unknown): number | null | undefined => (v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** The app's report, or the reason it is not one. */
export function parseReport(raw: unknown): AppUpdateReport | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'o corpo precisa ser um objeto';
  const o = raw as Record<string, unknown>;
  const appVersion = text(o.appVersion, 64);
  if (!appVersion) return 'appVersion';
  if (!(APP_UPDATE_MODES as readonly unknown[]).includes(o.mode)) return 'mode: dev ou stable';
  if (!(APP_UPDATE_PHASES as readonly unknown[]).includes(o.phase)) return 'phase';
  if (o.error !== null && !(APP_UPDATE_ERRORS as readonly unknown[]).includes(o.error)) return 'error';
  let available: AppUpdateReport['available'] = null;
  if (o.available !== null) {
    const a = o.available as Record<string, unknown> | undefined;
    const version = text(a?.version, 64);
    if (!version) return 'available.version';
    available = { version, notes: a?.notes == null ? null : text(a.notes, 300), publishedAt: a?.publishedAt == null ? null : text(a.publishedAt, 40) };
  }
  let progress: AppUpdateReport['progress'] = null;
  if (o.progress !== null && o.progress !== undefined) {
    const p = o.progress as Record<string, unknown>;
    const done = epoch(p.done);
    const total = epoch(p.total ?? null);
    if (typeof done !== 'number' || total === undefined) return 'progress';
    progress = { done, total };
  }
  const lastCheckAt = epoch(o.lastCheckAt ?? null);
  const nextCheckAt = epoch(o.nextCheckAt ?? null);
  if (lastCheckAt === undefined || nextCheckAt === undefined) return 'lastCheckAt e nextCheckAt: milissegundos ou null';
  return {
    appVersion,
    mode: o.mode as AppUpdateReport['mode'],
    available,
    phase: o.phase as AppUpdateReport['phase'],
    progress,
    error: (o.error ?? null) as AppUpdateReport['error'],
    lastCheckAt,
    nextCheckAt,
    updatedFrom: o.updatedFrom == null ? null : text(o.updatedFrom, 64),
    updatedNotes: o.updatedNotes == null ? null : text(o.updatedNotes, 300),
  };
}

export type AppUpdateRoute = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

export function createAppUpdateRoute(state: AppUpdateState): AppUpdateRoute {
  return async (req, res, url) => {
    const path = url.pathname;
    if (path === APP_UPDATE_ROUTE) {
      req.resume();
      if (req.method !== 'GET') return send(res, 405, { error: 'use GET' });
      return send(res, 200, state.view());
    }
    const isJson = /^application\/json\b/i.test(req.headers['content-type'] ?? '');
    if (path === STATE_ROUTE) {
      if (req.method !== 'PUT') {
        req.resume();
        return send(res, 405, { error: 'use PUT' });
      }
      // The report is the app's: a request from a page (with `Origin`) never gets here, but say it.
      if (req.headers.origin) {
        req.resume();
        return send(res, 403, { error: 'só o app informa o estado' });
      }
      if (!isJson) {
        req.resume();
        return send(res, 415, { error: 'use application/json' });
      }
      const body = await readBody(req);
      if (body === null) return send(res, 413, { error: 'corpo grande demais' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(res, 400, { error: 'JSON inválido' });
      }
      const report = parseReport(parsed);
      if (typeof report === 'string') return send(res, 400, { error: `relatório inválido: ${report}` });
      state.report(report);
      return send(res, 200, state.view());
    }
    const action = ACTION_ROUTE.exec(path);
    if (action) {
      if (req.method !== 'POST') {
        req.resume();
        return send(res, 405, { error: 'use POST' });
      }
      let version: string | undefined;
      const body = await readBody(req);
      if (body === null) return send(res, 413, { error: 'corpo grande demais' });
      if (body.trim() !== '') {
        if (!isJson) return send(res, 415, { error: 'use application/json' });
        try {
          const v = (JSON.parse(body) as { version?: unknown } | null)?.version;
          if (typeof v === 'string') version = text(v, 64) ?? undefined;
        } catch {
          return send(res, 400, { error: 'JSON inválido' });
        }
      }
      if (!state.act(action[1] as AppUpdateAction, version)) return send(res, 404, { error: 'no-app' });
      return send(res, 200, state.view());
    }
    req.resume();
    send(res, 404, { error: 'não encontrado' });
  };
}

export { APP_UPDATE_ACTIONS };
