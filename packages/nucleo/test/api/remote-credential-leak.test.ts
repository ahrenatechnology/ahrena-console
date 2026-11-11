// AC3 (remote side): with a sentinel key and token, the core's logs and every refusal body never carry them, nor
// the signed header's pieces, in hex, base64 or base64url (decision 0020 section 7, #388).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DOCKER_ACTIONS } from '../../src/docker/catalog.ts';
import { call, remoteFixture, signHeader } from './remote-credential-fixture.ts';

const forms = (s: string) => [s, Buffer.from(s).toString('hex'), Buffer.from(s).toString('base64'), Buffer.from(s).toString('base64url')];

test('AC3 logs and error bodies of the issue route and the verifier never carry the token, the key or the proof', async () => {
  const token = 'f00dfeed'.repeat(8);
  const logs: string[] = [];
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  const f = await remoteFixture({ token, store: { random: (n) => Buffer.alloc(n, 0x37) }, api: { log: (m) => logs.push(m) } });
  try {
    const key = Buffer.alloc(32, 0x37).toString('base64url');
    const id = Buffer.alloc(16, 0x37).toString('hex');
    const bodies: string[] = [];
    const issue = await call(f.url, '/api/owner/remote-credentials', 'POST', { authorization: `Bearer ${token}` }, JSON.stringify({ version: 1, nonce: '1'.repeat(32) }));
    assert.equal(issue.status, 200);
    assert.ok(issue.text.includes(key), 'the issue answer is where the key travels, once');
    const c = JSON.parse(issue.text);
    // Every kind of refusal, with the body kept.
    bodies.push((await call(f.url, '/api/wall', 'GET', {})).text);
    bodies.push((await f.signed(c, 'GET', '/api/changes')).text);
    bodies.push((await f.signed(c, 'GET', '/api/wall?x=1')).text);
    bodies.push((await f.signed(c, 'GET', '/api/wall', { ts: f.clock.now + 99_999 })).text);
    bodies.push((await f.signed(c, 'POST', `/api/docker/actions/${DOCKER_ACTIONS[0]}`, { body: '{}' })).text);
    const header = signHeader(c, { method: 'GET', target: '/api/wall', host: f.host, ts: f.clock.now, nonce: '2'.repeat(32), key: 'wrong' });
    const wrong = await call(f.url, '/api/wall', 'GET', { authorization: header });
    bodies.push(wrong.text);
    bodies.push((await call(f.url, '/api/wall', 'GET', { authorization: header, origin: `http://${f.host}` })).text);
    bodies.push((await call(f.url, '/api/owner/remote-credentials', 'POST', { authorization: `Bearer ${token}`, origin: 'http://x' }, '{}')).text);
    const same = await f.signed(c, 'GET', '/api/wall', { nonce: '3'.repeat(32) });
    assert.equal(same.status, 200);
    bodies.push((await f.signed(c, 'GET', '/api/wall', { nonce: '3'.repeat(32) })).text);
    f.store.restart();
    bodies.push((await f.signed(c, 'GET', '/api/wall')).text);

    const everything = [...logs, ...errors, ...bodies].join('\n');
    for (const secret of [token, key, id, '2'.repeat(32), '3'.repeat(32), header.split('sig=')[1]!]) for (const form of forms(secret)) assert.ok(!everything.includes(form), `leaked ${form.slice(0, 8)}…`);
    assert.ok(!everything.includes('AhrenaRemote'));
    for (const b of bodies) if (b) assert.ok(typeof JSON.parse(b).error === 'string', 'a refusal is a fixed error text');
  } finally {
    console.error = original;
    await f.close();
  }
});
