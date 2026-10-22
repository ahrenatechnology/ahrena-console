// The cloud connectors of a remote machine (#277, decision 0013 section 2a), read and driven by this
// Mac's núcleo through the local port the user's tunnel forwards, like the telemetry (src/telemetry/remote.ts).
//
// - Reading: `GET /api/connectors` of the remote núcleo, through the same bounded loopback GET
//   (`RemoteGet`), and its answer re-projected field by field (`sanitizeConnectors`): known enums
//   only, texts capped, lists capped, a device code only when its URI is https on an AWS host and the
//   code has the AWS shape. Whatever else the remote sends is dropped.
// - Writing: `POST` / `DELETE /api/connectors/aws/sessions/<name>/login` on the remote núcleo
//   (`loopbackWrite`): always 127.0.0.1, `Host: 127.0.0.1:4720` (the remote's own), no Origin, so the
//   remote takes it as a local request; the body is the fixed `{"mode":"device-code"}`. Only the
//   session name travels, and it has matched `SAFE_CLI_NAME` here; the remote looks it up in its
//   own ~/.aws/config.

import { request } from 'node:http';
import { REMOTE_HOST_HEADER, REMOTE_TIMEOUT_MS } from '../telemetry/adapters/loopback-http.ts';
import type { RemoteGetResult } from '../telemetry/ports.ts';
import { SAFE_CLI_NAME } from './aws-config.ts';
import { CONNECTOR_STATES, SESSION_STATES } from './aws-connector.ts';
import { acceptVerificationUri, LOGIN_MODES, USER_CODE } from './aws-login.ts';

export const REMOTE_CONNECTORS_PATH = '/api/connectors';
export const MAX_REMOTE_SESSIONS = 100;
export const MAX_REMOTE_PROFILES = 100;
const MAX_WRITE_BODY_BYTES = 64 * 1024;

const LOGIN_STATES = ['idle', 'running', 'succeeded', 'failed', 'timed-out', 'canceled'] as const;
const FILE_STATUSES = ['ok', 'missing', 'error'] as const;
const OUT_OF_SCOPE_REASONS = ['no-sso', 'missing-sso-session'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
const iso = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const name = (v: unknown): string | null => (typeof v === 'string' && SAFE_CLI_NAME.test(v) ? v : null);
const label = (v: unknown): string | null => text(v, 128);

function sanitizeLogin(v: unknown): Record<string, unknown> | null {
  if (!isObject(v)) return null;
  const state = oneOf(v.state, LOGIN_STATES);
  if (!state) return null;
  let deviceCode: Record<string, string> | null = null;
  if (isObject(v.deviceCode) && state === 'running') {
    const uri = typeof v.deviceCode.verificationUri === 'string' ? acceptVerificationUri(v.deviceCode.verificationUri) : null;
    const code = typeof v.deviceCode.userCode === 'string' && USER_CODE.test(v.deviceCode.userCode) ? v.deviceCode.userCode : null;
    const expiresAt = iso(v.deviceCode.expiresAt);
    if (uri && code && expiresAt) deviceCode = { verificationUri: uri, userCode: code, expiresAt };
  }
  const timeout = int(v.timeoutSeconds);
  return {
    state,
    mode: oneOf(v.mode, LOGIN_MODES),
    startedAt: iso(v.startedAt),
    endedAt: iso(v.endedAt),
    timeoutSeconds: timeout !== null && timeout > 0 && timeout <= 3600 ? timeout : null,
    exitCode: int(v.exitCode),
    startedBy: oneOf(v.startedBy, ['ui', 'local'] as const),
    logFile: text(v.logFile, 512),
    deviceCode,
  };
}

function sanitizeAws(v: Record<string, unknown>): Record<string, unknown> | null {
  const state = oneOf(v.state, CONNECTOR_STATES);
  if (!state) return null;
  const cli = isObject(v.cli) ? v.cli : {};
  const version = int(cli.version);
  const file = isObject(v.configFile) ? v.configFile : {};
  const fileStatus = oneOf(file.status, FILE_STATUSES) ?? 'ok';
  const fileError = fileStatus === 'error' && isObject(file.error) ? { line: int(file.error.line) ?? 0, message: text(file.error.message, 200) ?? '' } : null;
  const sessions = (Array.isArray(v.sessions) ? v.sessions.slice(0, MAX_REMOTE_SESSIONS) : []).flatMap((s) => {
    if (!isObject(s)) return [];
    const sessionName = label(s.name);
    const sessionState = oneOf(s.state, SESSION_STATES);
    const kind = oneOf(s.kind, ['sso-session', 'legacy'] as const);
    if (!sessionName || !sessionState || !kind) return [];
    const profiles = (Array.isArray(s.profiles) ? s.profiles.slice(0, MAX_REMOTE_PROFILES) : []).flatMap((p) =>
      isObject(p) && label(p.name) ? [{ name: label(p.name), accountId: text(p.accountId, 32), roleName: text(p.roleName, 128), region: text(p.region, 64) }] : [],
    );
    return [
      {
        name: sessionName,
        kind,
        startUrlHost: text(s.startUrlHost, 253),
        region: text(s.region, 64),
        // Entrar over there only for a name that can go on a command line.
        loginSupported: s.loginSupported === true && name(s.name) !== null,
        state: sessionState,
        expiresAt: iso(s.expiresAt),
        checkedAt: iso(s.checkedAt),
        profiles,
        login: sanitizeLogin(s.login),
      },
    ];
  });
  const outOfScope = (Array.isArray(v.outOfScope) ? v.outOfScope.slice(0, MAX_REMOTE_PROFILES) : []).flatMap((p) =>
    isObject(p) && label(p.name) ? [{ name: label(p.name), reason: oneOf(p.reason, OUT_OF_SCOPE_REASONS) ?? 'no-sso' }] : [],
  );
  return {
    kind: 'aws',
    state,
    cli: { found: cli.found === true, version: version !== null && version > 0 && version < 100 ? version : null, deviceCodeSupported: cli.deviceCodeSupported === true },
    configFile: fileError ? { status: fileStatus, error: fileError } : { status: fileStatus },
    sessions,
    outOfScope,
  };
}

/** A remote `GET /api/connectors` answer, re-projected; `null` when it is not one. */
export function sanitizeConnectors(body: unknown): Record<string, unknown>[] | null {
  if (!isObject(body) || !Array.isArray(body.connectors)) return null;
  const out: Record<string, unknown>[] = [];
  for (const c of body.connectors.slice(0, 10)) {
    if (!isObject(c)) continue;
    if (c.kind === 'aws') {
      const aws = sanitizeAws(c);
      if (aws && !out.some((o) => o.kind === 'aws')) out.push(aws);
    } else if ((c.kind === 'gcp' || c.kind === 'azure') && c.state === 'soon' && !out.some((o) => o.kind === c.kind)) {
      out.push({ kind: c.kind, state: 'soon' });
    }
  }
  return out;
}

/** A remote login answer (`{ login }` or `{ error }`), re-projected. */
export function sanitizeLoginAnswer(body: unknown): { login: Record<string, unknown> } | { error: string } | null {
  if (!isObject(body)) return null;
  const login = sanitizeLogin(body.login);
  if (login) return { login };
  const error = text(body.error, 200);
  return error ? { error } : null;
}

/** `POST` or `DELETE` on the remote núcleo through the tunnel port; never rejects. */
export type RemoteWrite = (port: number, method: 'POST' | 'DELETE', path: string, body: string | null) => Promise<RemoteGetResult>;

export function loopbackWrite({ timeoutMs = REMOTE_TIMEOUT_MS, maxBodyBytes = MAX_WRITE_BODY_BYTES }: { timeoutMs?: number; maxBodyBytes?: number } = {}): RemoteWrite {
  return (port, method, path, body) =>
    new Promise<RemoteGetResult>((resolve) => {
      let settled = false;
      const finish = (result: RemoteGetResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        req.destroy();
        resolve(result);
      };
      const noResponse = () => finish({ kind: 'unreachable', reason: 'no-response' });
      const headers: Record<string, string | number> = { host: REMOTE_HOST_HEADER, accept: 'application/json' };
      if (body !== null) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(body);
      }
      const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBodyBytes) return noResponse();
          chunks.push(chunk);
        });
        res.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            parsed = undefined;
          }
          finish({ kind: 'response', status: res.statusCode ?? 0, body: parsed });
        });
        res.on('error', noResponse);
        res.on('aborted', noResponse);
      });
      const deadline = setTimeout(noResponse, timeoutMs);
      deadline.unref?.();
      req.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNREFUSED' ? finish({ kind: 'unreachable', reason: 'port-closed' }) : noResponse()));
      req.end(body ?? undefined);
    });
}
