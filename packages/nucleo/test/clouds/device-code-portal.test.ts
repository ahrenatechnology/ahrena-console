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

const remote = (verificationUri: string | null, startUrlHost = 'exemplo.awsapps.com') => ({
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
          region: 'regiao-exemplo-1',
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
