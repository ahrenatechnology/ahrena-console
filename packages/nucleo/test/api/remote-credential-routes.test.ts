// The closed list of routes a remote credential is valid for (decision 0020 section 5, #388): the list must hold
// against the canonical path the router dispatches on, and it must accept exactly what the Mac sends.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { authorizeRequest, openedByRemote, remoteRouteFor } from '../../src/api/owner-auth.ts';
import { panelPath } from '../../src/api/machine-panel.ts';
import { remoteDetailPath } from '../../src/api/machine-sessions.ts';
import { REMOTE_CREDENTIALS_ROUTE, respondIssue, type RemoteVerifier } from '../../src/api/remote-auth.ts';
import { RemoteCredentialStore } from '../../src/api/remote-credentials.ts';
import { call } from './remote-credential-fixture.ts';

describe('AC1 · the closed list against the canonical path', () => {
  test('AC1 dot segments, empty segments and encoded separators never reach a route outside the list', () => {
    const targets: Array<[string, string]> = [
      ['GET', '/api/sessions/..'],
      ['GET', '/api/sessions/../decisions'],
      ['GET', '/api/sessions/../agents'],
      ['GET', '/api/sessions/../workflow'],
      ['GET', '/api/sessions/../conversation'],
      ['GET', '/api/sessions/.'],
      ['GET', '/api/sessions/./events'],
      ['GET', '/api/sessions//events'],
      ['GET', '/api/sessions/%2e%2e'],
      ['GET', '/api/sessions/%2e%2e/decisions'],
      ['GET', '/api/sessions/a%2fb'],
      ['GET', '/api/sessions/a%2Fb/events'],
      ['GET', '/api/panel/..'],
      ['GET', '/api/panel/.'],
      ['GET', '/api/panel/%2e%2e'],
      ['GET', '/api/panel//'],
      ['GET', '/api/panel/a%2fb'],
      ['POST', '/api/connectors/aws/sessions/../login'],
      ['POST', '/api/connectors/aws/sessions/./login'],
      ['DELETE', '/api/connectors/aws/sessions/../login'],
      ['POST', '/api/connectors/aws/sessions/%2e%2e/login'],
      ['POST', '/api/connectors/aws/sessions/a%2fb/login'],
      ['GET', '/api//telemetry'],
      ['GET', '/api/./telemetry'],
    ];
    for (const [method, target] of targets) assert.equal(remoteRouteFor(method, target), null, `${method} ${target}`);
  });

  test('AC1 a listed target stays accepted, and ids that merely contain dots are ids', () => {
    for (const [method, target] of [['GET', '/api/telemetry'], ['GET', '/api/sessions/abc.def'], ['GET', '/api/sessions/..a/events'], ['GET', '/api/panel/a..b'], ['POST', '/api/connectors/aws/sessions/a.b/login']] as const) {
      assert.ok(remoteRouteFor(method, target), `${method} ${target}`);
    }
  });
});

describe('AC1 · the list accepts exactly what the Mac sends', () => {
  const ids = ['abc', '0b7f4f0e-1a2b-4c3d-8e9f-a1b2c3d4e5f6', 'agent_1', 'a.b-c', 'sess:agent', 'a:b:c', '::', 'x'.repeat(128)];

  test('AC1 every Detail tab path the Mac builds is in the list, colons included (%3A)', () => {
    for (const id of ids) {
      for (const tab of [null, 'agents', 'conversation', 'events', 'workflow', 'decisions']) {
        for (const query of ['', 'limit=5&after=x']) {
          const path = remoteDetailPath(id, tab, query);
          assert.ok(remoteRouteFor('GET', path), path);
        }
      }
    }
    assert.equal(remoteDetailPath('s:a', 'events', ''), '/api/sessions/s%3Aa/events');
  });

  test('AC1 the agent view path the Mac builds is in the list, GET only (#529, decision 0020)', () => {
    for (const id of ids) {
      for (const agentId of ['main', 'a1', 'agent_1', 'a.b-c', 'sess:agent', 'x'.repeat(128)]) {
        for (const query of ['', 'limit=5']) {
          const path = remoteDetailPath(id, null, query, agentId);
          assert.ok(remoteRouteFor('GET', path), path);
          assert.equal(remoteRouteFor('POST', path), null, `POST ${path}`);
          assert.equal(remoteRouteFor('DELETE', path), null, `DELETE ${path}`);
        }
      }
    }
    assert.equal(remoteDetailPath('s', null, '', 'a:1'), '/api/sessions/s/agents/a%3A1');
    for (const target of ['/api/sessions/s/agents/..', '/api/sessions/s/agents/.', '/api/sessions/s/agents/a%2Fb', '/api/sessions/s/agents/a/b', '/api/sessions/s/agents/', `/api/sessions/s/agents/${'x'.repeat(129)}`, '/api/sessions/../agents/a1', '/api/sessions/s/agents/a1/events']) {
      assert.equal(remoteRouteFor('GET', target), null, target);
    }
  });

  test('AC1 every panel path the Mac builds is in the list', () => {
    for (const id of ids) {
      for (const params of [new URLSearchParams(), new URLSearchParams('local=1&account=a&org=o&model=m&cwd=%2Ftmp')]) {
        const path = panelPath(id, params);
        assert.ok(remoteRouteFor('GET', path), path);
      }
    }
  });
});

describe('AC1 · the issue route only opens for the local bearer', () => {
  test('AC1 a request whose gate was tried with a remote proof is refused by respondIssue, a bearer one is not', async () => {
    const store = new RemoteCredentialStore({ machineIdentity: 'b'.repeat(64) });
    const token = 'a'.repeat(64);
    const verifier = { authorize: async () => true, store } as unknown as RemoteVerifier;
    const marks: boolean[] = [];
    const server = createServer(async (req, res) => {
      const port = (server.address() as AddressInfo).port;
      if (!(await authorizeRequest(req, res, port, () => token, verifier))) return;
      marks.push(openedByRemote(req));
      await respondIssue(req, res, port, store);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const body = JSON.stringify({ version: 1, nonce: 'c'.repeat(32) });
      const sig = `AhrenaRemote id=${'1'.repeat(32)}, ts=1, nonce=${'2'.repeat(32)}, sig=${'3'.repeat(64)}`;
      assert.equal((await call(url, REMOTE_CREDENTIALS_ROUTE, 'POST', { authorization: sig }, body)).status, 403);
      assert.equal(store.liveCount(), 0);
      assert.equal((await call(url, REMOTE_CREDENTIALS_ROUTE, 'POST', { authorization: `Bearer ${token}` }, body)).status, 200);
      assert.deepEqual(marks, [true, false]);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});
