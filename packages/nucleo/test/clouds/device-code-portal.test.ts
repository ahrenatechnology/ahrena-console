// #277, decision 0013 §2a, review of #310: a remote núcleo's device code is shown only when its URL
// is on that session's own portal, or on the SSO device page of the session's region.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceCodeOnSessionPortal } from '../../src/clouds/aws-login.ts';
import { sanitizeConnectors } from '../../src/clouds/remote-connectors.ts';

test('#277 deviceCodeOnSessionPortal: the session portal or its region device page, nothing else', () => {
  assert.equal(deviceCodeOnSessionPortal('https://exemplo.awsapps.com/start/#/device?user_code=ABCD-EFGH', 'exemplo.awsapps.com', 'regiao-exemplo-1'), true);
  assert.equal(deviceCodeOnSessionPortal('https://device.sso.regiao-exemplo-1.amazonaws.com/?user_code=ABCD-EFGH', 'exemplo.awsapps.com', 'regiao-exemplo-1'), true);
  assert.equal(deviceCodeOnSessionPortal('https://outro-portal.awsapps.com/start/#/device', 'exemplo.awsapps.com', 'regiao-exemplo-1'), false);
  assert.equal(deviceCodeOnSessionPortal('https://device.sso.regiao-exemplo-2.amazonaws.com/', 'exemplo.awsapps.com', 'regiao-exemplo-1'), false);
  assert.equal(deviceCodeOnSessionPortal('https://device.sso.regiao-exemplo-1.amazonaws.com/', null, null), false);
  assert.equal(deviceCodeOnSessionPortal('not a url', 'exemplo.awsapps.com', 'regiao-exemplo-1'), false);
});

const remote = (verificationUri: string) => ({
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
          startUrlHost: 'exemplo.awsapps.com',
          region: 'regiao-exemplo-1',
          loginSupported: true,
          state: 'expired',
          profiles: [],
          login: { state: 'running', mode: 'device-code', startedAt: '2026-10-22T09:00:00.000Z', timeoutSeconds: 300, deviceCode: { verificationUri, userCode: 'ABCD-EFGH', expiresAt: '2026-10-22T09:10:00.000Z' } },
        },
      ],
      outOfScope: [],
    },
  ],
});
const codeOf = (body: unknown) => ((sanitizeConnectors(body)![0] as { sessions: { login: { deviceCode: unknown } }[] }).sessions[0]!.login.deviceCode);

test('#277 the Mac keeps a remote device code on the session portal and drops one from another AWS portal', () => {
  assert.deepEqual(codeOf(remote('https://exemplo.awsapps.com/start/#/device')), { verificationUri: 'https://exemplo.awsapps.com/start/#/device', userCode: 'ABCD-EFGH', expiresAt: '2026-10-22T09:10:00.000Z' });
  assert.equal(codeOf(remote('https://outro-portal.awsapps.com/start/#/device')), null);
});
