// The GitHub OAuth device flow and the few REST reads the connection needs (decision 0011 §1-2):
// request a code, poll for the token, `GET /user` (login and `X-OAuth-Scopes`), `GET /user/orgs` and
// the org access check. Only the public client id travels; there is no client secret. The base URLs and
// `fetch` are injectable (tests and the demo use the fake GitHub). Errors carry HTTP statuses and
// GitHub's machine error codes only: never the token, the device code nor a response body.

/** The Ahrena Console OAuth App's public client id. Empty until the app exists (decision 0011 §1). */
export const GITHUB_OAUTH_CLIENT_ID = '';

/** The scopes the console asks for (decision 0011 §2). */
export const GITHUB_SCOPES: readonly string[] = ['repo', 'read:org', 'project'];

export const GITHUB_OAUTH_URL = 'https://github.com';
export const GITHUB_REST_URL = 'https://api.github.com';

/** `AHRENA_CONSOLE_GITHUB_CLIENT_ID` when set, else the published constant; `null` when neither exists. */
export function resolveGithubClientId(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.AHRENA_CONSOLE_GITHUB_CLIENT_ID?.trim();
  if (fromEnv) return fromEnv;
  return GITHUB_OAUTH_CLIENT_ID.trim() || null;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds. */
  expiresIn: number;
  /** Seconds between polls. */
  interval: number;
}

export type PollResult =
  | { kind: 'token'; token: string; scopes: string[] }
  | { kind: 'pending' }
  | { kind: 'slow-down'; interval: number }
  | { kind: 'expired' }
  | { kind: 'denied' }
  | { kind: 'error'; code: string };

export type OrgAccess = 'ok' | 'blocked' | 'unknown';

/** A refused or failed GitHub auth call. `code` is GitHub's machine code or `http-<status>` / `network`. */
export class GithubAuthError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null = null) {
    super(`GitHub auth call failed: ${code}${status !== null ? ` (HTTP ${status})` : ''}`);
    this.name = 'GithubAuthError';
    this.code = code;
    this.status = status;
  }
}

export interface DeviceFlowClient {
  requestCode(): Promise<DeviceCode>;
  pollToken(deviceCode: string): Promise<PollResult>;
  user(token: string): Promise<{ login: string; scopes: string[] }>;
  orgs(token: string): Promise<string[]>;
  orgAccess(token: string, org: string): Promise<OrgAccess>;
}

export interface GithubDeviceFlowClientOptions {
  clientId: string;
  fetch?: typeof fetch;
  oauthUrl?: string;
  apiUrl?: string;
  timeoutMs?: number;
}

/** A GitHub machine code (`authorization_pending`, `incorrect_client_credentials`…), or null for anything else. */
function machineCode(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) ? value : null;
}

/** Scopes as GitHub writes them: comma-separated (token response) or comma-space (header). */
export function parseScopes(value: string | null | undefined): string[] {
  return (value ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

export class GithubDeviceFlowClient implements DeviceFlowClient {
  readonly clientId: string;
  readonly oauthUrl: string;
  readonly apiUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor({ clientId, fetch: fetchFn, oauthUrl = GITHUB_OAUTH_URL, apiUrl = GITHUB_REST_URL, timeoutMs = 15_000 }: GithubDeviceFlowClientOptions) {
    this.clientId = clientId;
    this.fetchFn = fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.oauthUrl = oauthUrl.replace(/\/+$/, '');
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async requestCode(): Promise<DeviceCode> {
    const { status, body } = await this.form('/login/device/code', { client_id: this.clientId, scope: GITHUB_SCOPES.join(' ') });
    const error = machineCode(body?.error);
    if (status !== 200 || error) throw new GithubAuthError(error ?? `http-${status}`, status);
    const { device_code, user_code, verification_uri, expires_in, interval } = body ?? {};
    // The user code and the address go to the screen: a short code, and https on GitHub (or the configured host).
    if (typeof device_code !== 'string' || device_code === '' || !isUserCode(user_code) || !this.isVerificationUri(verification_uri)) {
      throw new GithubAuthError('invalid-response', status);
    }
    return {
      deviceCode: device_code,
      userCode: user_code,
      verificationUri: verification_uri,
      expiresIn: positive(expires_in, 900),
      interval: positive(interval, 5),
    };
  }

  async pollToken(deviceCode: string): Promise<PollResult> {
    const { status, body } = await this.form('/login/oauth/access_token', {
      client_id: this.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const error = machineCode(body?.error);
    if (error === 'authorization_pending') return { kind: 'pending' };
    if (error === 'slow_down') return { kind: 'slow-down', interval: positive(body?.interval, 0) };
    if (error === 'expired_token') return { kind: 'expired' };
    if (error === 'access_denied') return { kind: 'denied' };
    if (error) return { kind: 'error', code: error };
    if (status !== 200 || typeof body?.access_token !== 'string' || body.access_token === '') return { kind: 'error', code: `http-${status}` };
    return { kind: 'token', token: body.access_token, scopes: parseScopes(typeof body.scope === 'string' ? body.scope : '') };
  }

  async user(token: string): Promise<{ login: string; scopes: string[] }> {
    const res = await this.get('/user', token);
    const body = asObject(await readJson(res));
    if (res.status !== 200) throw new GithubAuthError(res.status === 401 ? 'unauthorized' : `http-${res.status}`, res.status);
    if (typeof body?.login !== 'string') throw new GithubAuthError('invalid-response', res.status);
    return { login: body.login, scopes: parseScopes(res.headers.get('x-oauth-scopes')) };
  }

  async orgs(token: string): Promise<string[]> {
    const res = await this.get('/user/orgs?per_page=100', token);
    const body = await readJson(res);
    if (res.status !== 200 || !Array.isArray(body)) throw new GithubAuthError(res.status === 401 ? 'unauthorized' : `http-${res.status}`, res.status);
    return body.map((o) => asObject(o)?.login).filter((l): l is string => typeof l === 'string');
  }

  /** `blocked` only for GitHub's "OAuth App access restrictions" 403; any other failure is `unknown`. */
  async orgAccess(token: string, org: string): Promise<OrgAccess> {
    try {
      const res = await this.get(`/orgs/${encodeURIComponent(org)}/repos?per_page=1`, token);
      if (res.status === 200) return 'ok';
      const body = asObject(await readJson(res));
      if (res.status === 403 && typeof body?.message === 'string' && /OAuth App access restrictions/i.test(body.message)) return 'blocked';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private isVerificationUri(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value);
      const allowed = new Set(['github.com', new URL(this.oauthUrl).host]);
      return url.protocol === 'https:' && allowed.has(url.host);
    } catch {
      return false;
    }
  }

  private async form(path: string, fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const res = await this.send(`${this.oauthUrl}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'ahrena-console' },
      body: new URLSearchParams(fields).toString(),
    });
    return { status: res.status, body: asObject(await readJson(res)) };
  }

  private get(path: string, token: string): Promise<Response> {
    return this.send(`${this.apiUrl}${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ahrena-console',
      },
    });
  }

  /** A network failure becomes `network`, without the original error (it may echo the request). */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new GithubAuthError('network');
    }
  }
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** GitHub's user codes look like `WDJB-MJHT`: letters, digits and a hyphen. */
function isUserCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{4,16}$/.test(value);
}
