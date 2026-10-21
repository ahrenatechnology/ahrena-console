// The OAuth device-flow client (#241, decision 0011 §1-2) against the fake GitHub: the code request,
// each poll answer, `/user` with its scopes, the orgs and the org access check. Never github.com.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GITHUB_OAUTH_CLIENT_ID,
  GITHUB_SCOPES,
  GithubAuthError,
  GithubDeviceFlowClient,
  resolveGithubClientId,
} from '../../../src/github/connection/index.ts';
import { createFakeGithub, DEMO_GITHUB_DATA, type FakeGithubAuth } from '../../../src/simulator/fake-github.ts';

const TOKEN = 'gho_FAKEdeviceflow0000000000000000000000';
const OAUTH = 'http://fake-github.test';
const API = 'http://fake-api.test';

function setup(extra: Partial<FakeGithubAuth> = {}) {
  let t = Date.parse('2026-10-21T12:00:00.000Z');
  const auth: FakeGithubAuth = { clientId: 'test-client-id', token: TOKEN, scopes: ['repo', 'read:org', 'project'], login: 'dev-sintetico', ...extra };
  const gh = createFakeGithub(DEMO_GITHUB_DATA, { now: () => t, auth });
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return gh.fetch(input, init);
  }) as typeof globalThis.fetch;
  const client = new GithubDeviceFlowClient({ clientId: 'test-client-id', fetch, oauthUrl: OAUTH, apiUrl: API });
  return { gh, auth, client, requests, advance: (ms: number) => (t += ms) };
}

describe('#241/AC-6 client id and scopes', () => {
  test('the published client id is empty until the OAuth App exists; the env var replaces it', () => {
    assert.equal(GITHUB_OAUTH_CLIENT_ID, '');
    assert.equal(resolveGithubClientId({}), null);
    assert.equal(resolveGithubClientId({ AHRENA_CONSOLE_GITHUB_CLIENT_ID: '  ' }), null);
    assert.equal(resolveGithubClientId({ AHRENA_CONSOLE_GITHUB_CLIENT_ID: 'test-client-id' }), 'test-client-id');
    assert.deepEqual([...GITHUB_SCOPES], ['repo', 'read:org', 'project']);
  });

  test('the default URLs are github.com and api.github.com (never called in tests)', () => {
    const c = new GithubDeviceFlowClient({ clientId: 'x', fetch: (() => assert.fail('no request')) as never });
    assert.equal(c.oauthUrl, 'https://github.com');
    assert.equal(c.apiUrl, 'https://api.github.com');
  });
});

describe('#241/AC-2 device flow client', () => {
  test('requestCode posts the client id and the scopes as a form, asking for JSON', async () => {
    const { client, requests } = setup({ interval: 7, expiresIn: 600 });
    const code = await client.requestCode();
    assert.match(code.deviceCode, /^fake-device-code-/);
    assert.equal(code.userCode, 'FAKE-0001');
    assert.equal(code.verificationUri, 'https://github.com/login/device');
    assert.equal(code.expiresIn, 600);
    assert.equal(code.interval, 7);
    const [r] = requests;
    assert.equal(r.url, `${OAUTH}/login/device/code`);
    assert.equal(r.init?.method, 'POST');
    const headers = new Headers(r.init?.headers);
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded');
    assert.equal(String(r.init?.body), 'client_id=test-client-id&scope=repo+read%3Aorg+project');
  });

  test('review L3: a verification address off GitHub or an odd user code is refused (invalid-response)', async () => {
    const answer = (body: Record<string, unknown>) =>
      new GithubDeviceFlowClient({
        clientId: 'test-client-id',
        oauthUrl: OAUTH,
        apiUrl: API,
        fetch: (async () => Response.json({ device_code: 'fake-device-code-x', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5, ...body })) as never,
      });
    assert.equal((await answer({}).requestCode()).userCode, 'ABCD-1234');
    assert.equal((await answer({ verification_uri: 'https://fake-github.test/login/device' }).requestCode()).verificationUri, 'https://fake-github.test/login/device', 'the configured host is fine');
    for (const bad of [
      { verification_uri: 'http://github.com/login/device' },
      { verification_uri: 'https://evil.example/login/device' },
      { verification_uri: 'javascript:alert(1)' },
      { user_code: '<script>' },
      { user_code: 'A'.repeat(40) },
    ]) {
      await assert.rejects(answer(bad).requestCode(), (e: GithubAuthError) => e.code === 'invalid-response', JSON.stringify(bad));
    }
  });

  test('a wrong client id rejects with GitHub\'s error code', async () => {
    const { gh } = setup();
    const client = new GithubDeviceFlowClient({ clientId: 'not-the-app', fetch: gh.fetch, oauthUrl: OAUTH, apiUrl: API });
    await assert.rejects(client.requestCode(), (err: GithubAuthError) => err instanceof GithubAuthError && err.code === 'incorrect_client_credentials');
  });

  test('pollToken: pending, then the token with its scopes', async () => {
    const { client, requests } = setup({ approveAfterPolls: 1, scopes: ['repo', 'read:org'] });
    const { deviceCode } = await client.requestCode();
    assert.deepEqual(await client.pollToken(deviceCode), { kind: 'pending' });
    assert.deepEqual(await client.pollToken(deviceCode), { kind: 'token', token: TOKEN, scopes: ['repo', 'read:org'] });
    const poll = requests.at(-1)!;
    assert.equal(poll.url, `${OAUTH}/login/oauth/access_token`);
    const form = new URLSearchParams(String(poll.init?.body));
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
    assert.equal(form.get('client_id'), 'test-client-id');
  });

  test('pollToken: slow_down carries the new interval; denied and expired', async () => {
    const slow = setup({ slowDownOnPoll: 1, interval: 5 });
    const a = await slow.client.requestCode();
    assert.deepEqual(await slow.client.pollToken(a.deviceCode), { kind: 'slow-down', interval: 10 });

    const denied = setup({ deny: true });
    const b = await denied.client.requestCode();
    assert.deepEqual(await denied.client.pollToken(b.deviceCode), { kind: 'denied' });

    const late = setup({ expiresIn: 10, neverApprove: true });
    const c = await late.client.requestCode();
    late.advance(11_000);
    assert.deepEqual(await late.client.pollToken(c.deviceCode), { kind: 'expired' });

    assert.deepEqual(await late.client.pollToken('unknown-code'), { kind: 'error', code: 'bad_verification_code' });
  });

  test('user reads the login and the X-OAuth-Scopes header; a bad token is unauthorized', async () => {
    const { client, requests } = setup({ scopes: ['repo', 'admin:org', 'project'] });
    assert.deepEqual(await client.user(TOKEN), { login: 'dev-sintetico', scopes: ['repo', 'admin:org', 'project'] });
    assert.equal(requests.at(-1)!.url, `${API}/user`);
    assert.equal(new Headers(requests.at(-1)!.init?.headers).get('authorization'), `bearer ${TOKEN}`);
    await assert.rejects(client.user('gho_wrong'), (err: GithubAuthError) => err.status === 401 && err.code === 'unauthorized');
  });

  test('orgs lists the logins; orgAccess says blocked only for the OAuth App restriction', async () => {
    const { client, requests } = setup({ blockedOrgs: ['estudio-ficticio'] });
    assert.deepEqual(await client.orgs(TOKEN), ['exemplo-labs', 'estudio-ficticio']);
    assert.equal(requests.at(-1)!.url, `${API}/user/orgs?per_page=100`);
    assert.equal(await client.orgAccess(TOKEN, 'exemplo-labs'), 'ok');
    assert.equal(requests.at(-1)!.url, `${API}/orgs/exemplo-labs/repos?per_page=1`);
    assert.equal(await client.orgAccess(TOKEN, 'estudio-ficticio'), 'blocked');
    assert.equal(await client.orgAccess(TOKEN, 'nobody-here'), 'unknown');
    const failing = new GithubDeviceFlowClient({ clientId: 'x', fetch: (async () => new Response('{}', { status: 500 })) as never, apiUrl: API });
    assert.equal(await failing.orgAccess(TOKEN, 'exemplo-labs'), 'unknown');
    const forbidden = new GithubDeviceFlowClient({ clientId: 'x', fetch: (async () => Response.json({ message: 'Resource not accessible' }, { status: 403 })) as never, apiUrl: API });
    assert.equal(await forbidden.orgAccess(TOKEN, 'exemplo-labs'), 'unknown');
  });

  test('#241/AC-3 errors never carry the token or the device code', async () => {
    const leaky = (async (_url: unknown, init?: RequestInit) => {
      throw new Error(`socket hang up ${String(init?.body)} ${new Headers(init?.headers).get('authorization')}`);
    }) as never;
    const client = new GithubDeviceFlowClient({ clientId: 'test-client-id', fetch: leaky, oauthUrl: OAUTH, apiUrl: API });
    const check = (err: Error) => !err.message.includes(TOKEN) && !err.message.includes('fake-device-code-secret') && !String(err.cause ?? '').includes(TOKEN);
    await assert.rejects(client.pollToken('fake-device-code-secret'), check);
    await assert.rejects(client.user(TOKEN), check);
    await assert.rejects(client.orgs(TOKEN), check);
    const echo = new GithubDeviceFlowClient({
      clientId: 'test-client-id',
      fetch: (async () => Response.json({ message: `bad ${TOKEN}`, error: 'weird', error_description: `code fake-device-code-secret` }, { status: 400 })) as never,
      oauthUrl: OAUTH,
      apiUrl: API,
    });
    await assert.rejects(echo.requestCode(), (err: GithubAuthError) => check(err) && err.code === 'weird');
    await assert.rejects(echo.user(TOKEN), (err: GithubAuthError) => check(err) && err.status === 400);
  });
});
