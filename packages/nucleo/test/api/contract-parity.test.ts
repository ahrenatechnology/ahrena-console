// #662/AC-1: the routes the core serves and the routes docs/contracts/core-api.openapi.json declares
// are the same set, both ways, proved here by:
//   1. the served table (src/api/served-routes.ts) against the spec;
//   2. the real server, driven with every route of the table: none falls through to the router's
//      unknown-route answer (a route in the table the server does not serve);
//   3. the code itself: every route path and route pattern the API sources name is covered by a
//      declared route (a route the code serves that the spec does not declare);
// and each detector is shown to report a planted defect, in both directions.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SERVED_ROUTES } from '../../src/api/served-routes.ts';
import { startContractProbeServer, type ContractProbeServer } from './contract-probe-server.ts';
import { compareRoutes, declaredOperations, readSpec, routeKey, routeLiteralsOf, routeSources, sampleOf, undeclaredInCode } from './openapi-spec.ts';

const spec = readSpec();
const declared = declaredOperations(spec).map((o) => routeKey(o.method, o.path));
const served = SERVED_ROUTES.map((r) => routeKey(r.method, r.path));

/** What the server answers when a route is not one it serves; a route's own handler answers something else. */
function isFallthrough(method: string, status: number, body: unknown): boolean {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  return (status === 404 && error === 'não encontrado') || (method !== 'GET' && status === 405 && error === 'use GET');
}

/** Routes whose answer is a stream or a long wait: they are asked in a way that returns at once. */
const PROBE_QUERY: { [route: string]: string } = { 'GET /api/changes': '?wait=0' };

async function isServed(server: ContractProbeServer, method: string, template: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const path = `${sampleOf(template)}${PROBE_QUERY[routeKey(method, template)] ?? ''}`;
    const r = await server.fetch(path, { method, signal: controller.signal, redirect: 'manual', ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: '{}' }) });
    if ((r.headers.get('content-type') ?? '').startsWith('text/event-stream')) return true;
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // a page or a redirect body: not the router's JSON answer, so a route answered it
    }
    return !isFallthrough(method, r.status, body);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

describe('#662/AC-1 the served table and the spec are the same set of routes', () => {
  test('#662/AC-1 Given the spec and the served table, When both are enumerated, Then every served method and path is declared and every declared one is served', () => {
    assert.ok(served.length > 0 && declared.length > 0, 'one side is empty');
    assert.deepEqual(compareRoutes(served, declared), { servedNotDeclared: [], declaredNotServed: [] });
  });

  test('#662/AC-1 the table lists a route once, and a spec path names each parameter in braces', () => {
    assert.equal(new Set(served).size, served.length, 'a route is listed twice');
    for (const o of declaredOperations(spec)) assert.ok(o.operation.operationId, `${routeKey(o.method, o.path)} has no operationId`);
    const ids = declaredOperations(spec).map((o) => o.operation.operationId);
    assert.equal(new Set(ids).size, ids.length, 'an operationId is used twice');
  });

  test('#662/AC-1 Given a planted served-but-undeclared route, When compared, Then the detector reports it', () => {
    const planted = compareRoutes([...served, 'GET /api/planted'], declared);
    assert.deepEqual(planted, { servedNotDeclared: ['GET /api/planted'], declaredNotServed: [] });
  });

  test('#662/AC-1 Given a planted declared-but-unserved route, When compared, Then the detector reports it', () => {
    const planted = compareRoutes(served, [...declared, 'POST /api/planted']);
    assert.deepEqual(planted, { servedNotDeclared: [], declaredNotServed: ['POST /api/planted'] });
  });

  test('#662/AC-1 a method difference is a difference: the same path declared with another method is reported both ways', () => {
    const planted = compareRoutes(['GET /api/x'], ['POST /api/x']);
    assert.deepEqual(planted, { servedNotDeclared: ['GET /api/x'], declaredNotServed: ['POST /api/x'] });
  });
});

describe('#662/AC-1 the real server serves every route of the table', () => {
  let server: ContractProbeServer;
  before(async () => {
    server = await startContractProbeServer();
  });
  after(async () => {
    await server.close();
  });

  test('#662/AC-1 Given the server running, When each served route is called, Then none falls through to the unknown-route answer', async () => {
    const unserved: string[] = [];
    for (const r of SERVED_ROUTES) if (!(await isServed(server, r.method, r.path))) unserved.push(routeKey(r.method, r.path));
    assert.deepEqual(unserved, []);
  });

  test('#662/AC-1 Given a planted route the server does not serve, When called, Then the probe reports it as unserved (a read and a write)', async () => {
    assert.equal(await isServed(server, 'GET', '/api/sessions/{sessionId}/planted'), false);
    assert.equal(await isServed(server, 'POST', '/api/planted-write'), false);
    assert.equal(await isServed(server, 'GET', '/api/overview'), true);
  });
});

describe('#662/AC-1 the code names no route the spec does not declare', () => {
  const declaredPaths = [...new Set(declaredOperations(spec).map((o) => o.path))];

  test('#662/AC-1 Given the API sources, When their route strings and route patterns are read, Then every one is covered by a declared route', () => {
    const found = routeSources().flatMap(({ file, source }) => {
      const lit = routeLiteralsOf(source);
      return undeclaredInCode(lit, declaredPaths).map((r) => `${file}: ${r}`);
    });
    assert.deepEqual(found, []);
  });

  test('#662/AC-1 Given a planted served path string, When read, Then the detector reports it', () => {
    const lit = routeLiteralsOf("export const PLANTED_ROUTE = '/api/planted';\n// '/api/in-a-comment'\n");
    assert.deepEqual(lit.strings, ['/api/planted']);
    assert.deepEqual(undeclaredInCode(lit, declaredPaths), ['/api/planted']);
  });

  test('#662/AC-1 Given a planted served route pattern, When read, Then the detector reports it', () => {
    const lit = routeLiteralsOf('const PLANTED = /^\\/api\\/planted\\/([^/]+)$/;');
    assert.equal(lit.patterns.length, 1);
    assert.deepEqual(undeclaredInCode(lit, declaredPaths), ['^\\/api\\/planted\\/([^/]+)$']);
  });

  test('#662/AC-1 a declared path is not reported, whether it is named as a string or as a pattern', () => {
    const lit = routeLiteralsOf("const A = '/api/wall'; const B = /^\\/api\\/panel\\/([^/]+)$/;");
    assert.deepEqual(undeclaredInCode(lit, declaredPaths), []);
  });
});
