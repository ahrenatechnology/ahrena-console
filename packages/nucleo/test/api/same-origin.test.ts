// The two request checks every new same-origin rule shares (#241 review 2): the /ui itself (`Origin`
// exactly `http://<Host>`, our Host) and a browser on another site (`Sec-Fetch-Site`).
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, test } from 'node:test';
import { fromAnotherSite, fromOwnUi } from '../../src/api/same-origin.ts';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

describe('#241 same-origin helpers', () => {
  test('fromOwnUi: our Host (127.0.0.1 or localhost, our port) and Origin exactly http://<Host>', () => {
    assert.equal(fromOwnUi(req({ host: '127.0.0.1:4720', origin: 'http://127.0.0.1:4720' }), 4720), true);
    assert.equal(fromOwnUi(req({ host: 'localhost:4720', origin: 'http://localhost:4720' }), 4720), true);
    assert.equal(fromOwnUi(req({ host: '127.0.0.1:4720' }), 4720), false, 'no Origin');
    assert.equal(fromOwnUi(req({ host: '127.0.0.1:4720', origin: 'http://localhost:4720' }), 4720), false);
    assert.equal(fromOwnUi(req({ host: '127.0.0.1:4721', origin: 'http://127.0.0.1:4721' }), 4720), false);
    assert.equal(fromOwnUi(req({ host: 'evil.example:4720', origin: 'http://evil.example:4720' }), 4720), false);
  });

  test('fromAnotherSite: cross-site and same-site, in any case; same-origin, none and absent are not', () => {
    for (const v of ['cross-site', 'same-site', 'Cross-Site']) assert.equal(fromAnotherSite(req({ 'sec-fetch-site': v })), true, v);
    for (const v of ['same-origin', 'none']) assert.equal(fromAnotherSite(req({ 'sec-fetch-site': v })), false, v);
    assert.equal(fromAnotherSite(req({})), false);
  });
});
