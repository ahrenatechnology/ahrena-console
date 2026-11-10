// #277, decision 0013 §2a, review of #310: a remote núcleo's device code is shown only when its URL
// is on that session's own portal, or on the SSO device page of the session's region.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceCodeOnSessionPortal } from '../../src/clouds/aws-login.ts';
import { sanitizeConnectors, sanitizeLoginAnswer, type SessionPortals } from '../../src/clouds/remote-connectors.ts';

test('#277 deviceCodeOnSessionPortal: the session portal or its region device page, nothing else', () => {
  assert.equal(deviceCodeOnSessionPortal('https://exemplo.awsapps.com/start/#/device?user_code=ABCD-EFGH', 'exemplo.awsapps.com', 'regiao-exemplo-1'), true);
  assert.equal(deviceCodeOnSessionPortal('https://device.sso.regiao-exemplo-1.amazonaws.com/?user_code=ABCD-EFGH', 'exemplo.awsapps.com', 'regiao-exemplo-1'), true);
  assert.equal(deviceCodeOnSessionPortal('https://outro-portal.awsapps.com/start/#/device', 'exemplo.awsapps.com', 'regiao-exemplo-1'), false);
  assert.equal(deviceCodeOnSessionPortal('https://device.sso.regiao-exemplo-2.amazonaws.com/', 'exemplo.awsapps.com', 'regiao-exemplo-1'), false);
  assert.equal(deviceCodeOnSessionPortal('https://device.sso.regiao-exemplo-1.amazonaws.com/', null, null), false);
  assert.equal(deviceCodeOnSessionPortal('not a url', 'exemplo.awsapps.com', 'regiao-exemplo-1'), false);
});

// #431: AWS moved some regions' device page to `https://<region>.signin.aws/platform/authorize?request_uri=...`.
const SIGNIN_URI = 'https://us-east-2.signin.aws/platform/authorize?request_uri=TEST';

test('#431 AC-1 deviceCodeOnSessionPortal accepts <region>.signin.aws for exactly the region the Mac knows', () => {
  assert.equal(deviceCodeOnSessionPortal(SIGNIN_URI, 'exemplo.awsapps.com', 'us-east-2'), true);
  assert.equal(deviceCodeOnSessionPortal(SIGNIN_URI, null, 'us-east-2'), true, 'no portal known, the region alone is enough');
});

test('#431 AC-2 deviceCodeOnSessionPortal refuses every other signin.aws or *.aws host', () => {
  const refused: [string, string | null][] = [
    ['https://us-east-1.signin.aws/platform/authorize?request_uri=TEST', 'us-east-2'],
    ['https://us-east-2.signin.aws.evil.com/platform/authorize', 'us-east-2'],
    ['https://evil.us-east-2.signin.aws/platform/authorize', 'us-east-2'],
    ['https://evil-us-east-2.signin.aws/platform/authorize', 'us-east-2'],
    ['https://signin.aws/platform/authorize', 'us-east-2'],
    ['https://us-east-2.signin.aws./platform/authorize', 'us-east-2'],
    ['https://us-east-2.signin.aws:8443/platform/authorize', 'us-east-2'],
    ['https://user@us-east-2.signin.aws/platform/authorize', 'us-east-2'],
    ['http://us-east-2.signin.aws/platform/authorize', 'us-east-2'],
    ['https://us-east-2.console.aws/platform/authorize', 'us-east-2'],
    ['https://us-east-2.aws/platform/authorize', 'us-east-2'],
    ['https://anything.aws/platform/authorize', 'us-east-2'],
    [SIGNIN_URI, null],
    [SIGNIN_URI, ''],
    [SIGNIN_URI, 'us-east-2.evil'],
    [SIGNIN_URI, 'US-EAST-2'],
  ];
  for (const [uri, region] of refused) assert.equal(deviceCodeOnSessionPortal(uri, 'exemplo.awsapps.com', region), false, `${uri} / ${region}`);
  // The uppercase host is the same host for the parser: the URL class lowercases it.
  assert.equal(deviceCodeOnSessionPortal('https://US-EAST-2.SIGNIN.AWS/x', null, 'us-east-2'), true);
});

test('#431 AC-3 the two old formats are still accepted', () => {
  assert.equal(deviceCodeOnSessionPortal('https://exemplo.awsapps.com/start/#/device?user_code=ABCD-EFGH', 'exemplo.awsapps.com', 'us-east-2'), true);
  assert.equal(deviceCodeOnSessionPortal('https://device.sso.us-east-2.amazonaws.com/?user_code=ABCD-EFGH', 'exemplo.awsapps.com', 'us-east-2'), true);
});

const remote = (verificationUri: string | null, startUrlHost = 'exemplo.awsapps.com', region = 'regiao-exemplo-1') => ({
  connectors: [
    {
      kind: 'aws',
      state: 'expired',
      cli: { found: true, version: 2, deviceCodeSupported: true },
      configFile: { status: 'ok' },
      sessions: [
        {
          name: 'sessao-exemplo',
          kind: 'sso-session',
          startUrlHost,
          region,
          loginSupported: true,
          state: 'expired',
          profiles: [],
          login: verificationUri
            ? { state: 'running', mode: 'device-code', startedAt: '2026-10-22T09:00:00.000Z', timeoutSeconds: 300, deviceCode: { verificationUri, userCode: 'ABCD-EFGH', expiresAt: '2026-10-22T09:10:00.000Z' } }
            : { state: 'idle' },
        },
      ],
      outOfScope: [],
    },
  ],
});
const codeOf = (body: unknown, portals: SessionPortals) =>
  (sanitizeConnectors(body, portals)![0] as { sessions: { login: { deviceCode: unknown } }[] }).sessions[0]!.login.deviceCode;

test('#277 a remote device code is judged against the portal of an EARLIER code-free answer (trust on first use)', () => {
  const portals: SessionPortals = new Map();
  // No earlier reading: the answer carrying the code cannot vouch for itself.
  assert.equal(codeOf(remote('https://exemplo.awsapps.com/start/#/device'), portals), null);
  codeOf(remote(null), portals);
  assert.deepEqual(codeOf(remote('https://exemplo.awsapps.com/start/#/device'), portals), { verificationUri: 'https://exemplo.awsapps.com/start/#/device', userCode: 'ABCD-EFGH', expiresAt: '2026-10-22T09:10:00.000Z' });
  assert.equal(codeOf(remote('https://outro-portal.awsapps.com/start/#/device'), portals), null);
});

test('#277 an answer that changes the portal along with the code does not pass, and a later code-free answer does not overwrite the memory', () => {
  const portals: SessionPortals = new Map();
  codeOf(remote(null), portals);
  assert.equal(codeOf(remote('https://atacante.awsapps.com/start/#/device', 'atacante.awsapps.com'), portals), null);
  codeOf(remote(null, 'atacante.awsapps.com'), portals);
  assert.equal(codeOf(remote('https://atacante.awsapps.com/start/#/device', 'atacante.awsapps.com'), portals), null);
});

test('#277 the login answer of a remote POST never carries the code (it is shown only from the judged GET)', () => {
  const r = sanitizeLoginAnswer({ login: { state: 'running', mode: 'device-code', deviceCode: { verificationUri: 'https://exemplo.awsapps.com/start/#/device', userCode: 'ABCD-EFGH', expiresAt: '2026-10-22T09:10:00.000Z' } } });
  assert.ok(r && 'login' in r);
  assert.equal(r.login.deviceCode, null);
});

test('#277 a name that starts with "-" or "." never goes on the aws command line (review of #310, INP-2)', async () => {
  const { SAFE_CLI_NAME } = await import('../../src/clouds/aws-config.ts');
  const { SAFE_PROFILE_NAME } = await import('../../src/telemetry/machines-config.ts');
  for (const re of [SAFE_CLI_NAME, SAFE_PROFILE_NAME]) {
    for (const ok of ['sessao-exemplo', 'perfil_dev', '0perfil', '_x']) assert.ok(re.test(ok), ok);
    for (const bad of ['-profile', '--debug', '.hidden', '', 'a b', 'x'.repeat(65)]) assert.ok(!re.test(bad), bad);
  }
});

test('#431 AC-1 AC-2 a remote device code on <region>.signin.aws is shown only for the region remembered from an earlier code-free answer', () => {
  const portals: SessionPortals = new Map();
  const dc = { verificationUri: SIGNIN_URI, userCode: 'ABCD-EFGH', expiresAt: '2026-10-22T09:10:00.000Z' };
  // No earlier reading: the answer cannot vouch for itself.
  assert.equal(codeOf(remote(SIGNIN_URI, 'exemplo.awsapps.com', 'us-east-2'), portals), null);
  codeOf(remote(null, 'exemplo.awsapps.com', 'us-east-2'), portals);
  assert.deepEqual(codeOf(remote(SIGNIN_URI, 'exemplo.awsapps.com', 'us-east-2'), portals), dc);
  // The host of another region is dropped.
  assert.equal(codeOf(remote('https://us-east-1.signin.aws/platform/authorize?request_uri=TEST', 'exemplo.awsapps.com', 'us-east-2'), portals), null);
  // A region taken from the same answer is not the remembered one: the answer claims us-east-1 and its host agrees.
  assert.equal(codeOf(remote('https://us-east-1.signin.aws/platform/authorize?request_uri=TEST', 'exemplo.awsapps.com', 'us-east-1'), portals), null);
  // Look-alikes, port and userinfo never reach the screen.
  for (const bad of ['https://us-east-2.signin.aws.evil.com/x', 'https://signin.aws/x', 'https://us-east-2.signin.aws:8443/x', 'https://user@us-east-2.signin.aws/x', 'https://us-east-2.signin.aws./x'])
    assert.equal(codeOf(remote(bad, 'exemplo.awsapps.com', 'us-east-2'), portals), null, bad);
});

test('#431 AC-3 the old formats still pass end to end for a us-east-2 session', () => {
  const portals: SessionPortals = new Map();
  codeOf(remote(null, 'exemplo.awsapps.com', 'us-east-2'), portals);
  assert.ok(codeOf(remote('https://exemplo.awsapps.com/start/#/device', 'exemplo.awsapps.com', 'us-east-2'), portals));
  assert.ok(codeOf(remote('https://device.sso.us-east-2.amazonaws.com/?user_code=ABCD-EFGH', 'exemplo.awsapps.com', 'us-east-2'), portals));
});
