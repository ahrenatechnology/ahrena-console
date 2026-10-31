// The fake GitHub's side of the console's own connection (#241, decision 0011 §9): the OAuth device
// flow (`/login/device/code`, `/login/oauth/access_token`), `GET /user` with `X-OAuth-Scopes`,
// `GET /user/orgs`, `GET /users/<login>/orgs`, `GET /user/memberships/orgs/<org>` and
// `GET /orgs/<org>/repos`. A blocked org behaves as GitHub's does (#336): it is missing from
// `/user/orgs`, its repos still answer 200 (public data) and its membership answers 403 with the
// "OAuth App access restrictions" message. Device codes and tokens here are obviously fake strings. It never goes to
// the network. With `requireToken`, every other request whose bearer is not `token` gets 401.

/** How the fake GitHub answers the connection. Mutable: a test may change the login or token mid-way. */
export interface FakeGithubAuth {
  clientId: string;
  /** The token the device flow hands out, and the only bearer accepted. */
  token: string;
  scopes: string[];
  login: string;
  /** The first N polls answer `authorization_pending`; the next one gets the token. Default 1. */
  approveAfterPolls?: number;
  /** Every poll answers `authorization_pending` (the person never confirms). */
  neverApprove?: boolean;
  /** The first poll answers `access_denied`. */
  deny?: boolean;
  /** Seconds until a device code expires (`expired_token`). Default 900. */
  expiresIn?: number;
  /** Polling interval, in seconds. Default 5. */
  interval?: number;
  /** This poll (1-based) answers `slow_down`, with the interval raised by 5 s. */
  slowDownOnPoll?: number;
  /** Organizations restricted to approved OAuth Apps: absent from `/user/orgs`, membership 403. */
  blockedOrgs?: string[];
  /** The public memberships (`/users/<login>/orgs`). Default: every organization. */
  publicOrgs?: string[];
  /** Data requests whose bearer is not `token` answer 401. */
  requireToken?: boolean;
}

export interface FakeGithubAuthState {
  /** Every device code handed out, in order (tests check none of them leaks). */
  deviceCodes: string[];
  /** Polls per device code. */
  polls: Map<string, number>;
}

export const OAUTH_APP_RESTRICTED_MESSAGE =
  'Although you appear to have the correct authorization credentials, the organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.';

interface Flow {
  userCode: string;
  issuedAt: number;
  interval: number;
  polls: number;
  used: boolean;
}

export interface FakeGithubAuthRoutes {
  state: FakeGithubAuthState;
  /** The answer for an auth route, or `null` when the request is not one of them. */
  answer(url: URL, init: RequestInit | undefined): Response | null;
  /** Whether a data request carries the expected bearer (always true without `requireToken`). */
  authorized(init: RequestInit | undefined): boolean;
}

export function bearerOf(init: RequestInit | undefined): string | null {
  const header = new Headers(init?.headers).get('authorization') ?? '';
  return /^(?:bearer|token) (.+)$/i.exec(header)?.[1] ?? null;
}

export function createFakeGithubAuthRoutes(
  auth: FakeGithubAuth,
  { now, organizations, repoNames, calls }: { now: () => number; organizations: () => string[]; repoNames: (org: string) => string[] | null; calls: string[] },
): FakeGithubAuthRoutes {
  const flows = new Map<string, Flow>();
  const state: FakeGithubAuthState = { deviceCodes: [], polls: new Map() };
  const form = (init: RequestInit | undefined) => new URLSearchParams(typeof init?.body === 'string' ? init.body : String(init?.body ?? ''));
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const pollAnswer = (code: string): Response => {
    const flow = flows.get(code);
    if (!flow || flow.used) return json(200, { error: 'bad_verification_code' });
    flow.polls += 1;
    state.polls.set(code, flow.polls);
    if (now() >= flow.issuedAt + (auth.expiresIn ?? 900) * 1000) return json(200, { error: 'expired_token' });
    if (auth.deny) return json(200, { error: 'access_denied' });
    if (auth.slowDownOnPoll === flow.polls) {
      flow.interval += 5;
      return json(200, { error: 'slow_down', interval: flow.interval });
    }
    if (auth.neverApprove || flow.polls <= (auth.approveAfterPolls ?? 1)) return json(200, { error: 'authorization_pending' });
    flow.used = true;
    return json(200, { access_token: auth.token, token_type: 'bearer', scope: auth.scopes.join(',') });
  };

  return {
    state,
    authorized: (init) => !auth.requireToken || bearerOf(init) === auth.token,
    answer(url, init) {
      const method = init?.method ?? 'GET';
      const path = url.pathname;
      if (method === 'POST' && path === '/login/device/code') {
        calls.push(`POST ${path}`);
        const body = form(init);
        if (body.get('client_id') !== auth.clientId) return json(400, { error: 'incorrect_client_credentials' });
        const n = state.deviceCodes.length + 1;
        const deviceCode = `fake-device-code-${n}-${(now() % 1e6).toString(16)}`;
        const userCode = `FAKE-${String(n).padStart(4, '0')}`;
        flows.set(deviceCode, { userCode, issuedAt: now(), interval: auth.interval ?? 5, polls: 0, used: false });
        state.deviceCodes.push(deviceCode);
        return json(200, {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: 'https://github.com/login/device',
          expires_in: auth.expiresIn ?? 900,
          interval: auth.interval ?? 5,
        });
      }
      if (method === 'POST' && path === '/login/oauth/access_token') {
        calls.push(`POST ${path}`);
        const body = form(init);
        if (body.get('client_id') !== auth.clientId) return json(400, { error: 'incorrect_client_credentials' });
        if (body.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code') return json(200, { error: 'unsupported_grant_type' });
        return pollAnswer(body.get('device_code') ?? '');
      }
      if (method !== 'GET') return null;
      const orgRepos = /^\/orgs\/([^/]+)\/repos$/.exec(path);
      const membership = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(path);
      const userOrgs = /^\/users\/([^/]+)\/orgs$/.exec(path);
      if (path !== '/user' && path !== '/user/orgs' && !orgRepos && !membership && !userOrgs) return null;
      calls.push(`GET ${path}${url.search}`);
      if (bearerOf(init) !== auth.token) return json(401, { message: 'Bad credentials' });
      const scopes = { 'x-oauth-scopes': auth.scopes.join(', ') };
      const blocked = (org: string) => (auth.blockedOrgs ?? []).some((b) => b.toLowerCase() === org.toLowerCase());
      const orgList = (logins: string[]) => logins.map((login, i) => ({ login, id: 100 + i }));
      if (path === '/user') return json(200, { login: auth.login, id: 1, type: 'User' }, scopes);
      if (path === '/user/orgs') return json(200, orgList(organizations().filter((o) => !blocked(o))), scopes);
      if (userOrgs) return json(200, orgList(auth.publicOrgs ?? organizations()), scopes);
      if (membership) {
        const org = decodeURIComponent(membership[1]);
        if (blocked(org)) return json(403, { message: OAUTH_APP_RESTRICTED_MESSAGE }, scopes);
        if (!organizations().some((o) => o.toLowerCase() === org.toLowerCase())) return json(404, { message: 'Not Found' }, scopes);
        return json(200, { state: 'active', role: 'admin', organization: { login: org } }, scopes);
      }
      const org = decodeURIComponent(orgRepos![1]);
      const names = repoNames(org);
      if (!names) return json(404, { message: 'Not Found' }, scopes);
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      return json(200, names.slice(0, perPage).map((name) => ({ name, full_name: `${org}/${name}` })), scopes);
    },
  };
}
