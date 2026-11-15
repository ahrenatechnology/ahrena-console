// #662/AC-1: the routes the core serves and the routes docs/contracts/core-api.openapi.json declares
// are the same set, both ways. The spec is the single source; nothing in src/ lists routes. Proved by:
//   1. declared but not served: the real server (every optional module mounted by its own route
//      factory over off or in-memory dependencies, contract-probe-server.ts) is driven with every
//      operation the spec declares, and none may come back unserved (rule below);
//   2. served but not declared: the source scan (openapi-spec.ts, its header lists what it cannot
//      see) reads every route the API sources name, as a string, a constant, a template, a `+` chain,
//      a `startsWith` prefix or an anchored pattern, and each must be covered by a declared path;
// and each detector is shown to report a planted defect.
//
// What "unserved" means. A handler answers a request it recognises with its own status: a success,
// a validation error (400), a refusal, or a 404 that names a missing resource (the session, the
// message, the machine: a probe with an id that does not exist is served). A request it does not
// recognise gets one of three answers, whichever handler or gate gave it: 405 (the path is served for
// other methods), a 404 whose error is the generic unknown-path text ('não encontrado', 'not-found',
// 'Rota não encontrada.'), or 403 'origem não permitida' / 'forbidden' (the gates list the writes
// they allow; any other method on a path is refused there). A write is asked twice, as a client of
// the owner (no Origin) and as the page (its own Origin): the pages' writes refuse the first, the
// hooks and the MCP endpoint refuse the second. The operation is served if either asks gets an answer
// that is not one of the three.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PROBE_MACHINE, startContractProbeServer, type ContractProbeServer } from './contract-probe-server.ts';
import { declaredOperations, PARAM_SAMPLES, readSpec, routeConstantsOf, routeKey, routeLiteralsOf, routeSources, sampleOf, undeclaredInCode } from './openapi-spec.ts';

const spec = readSpec();
const operations = declaredOperations(spec);

const GENERIC_UNKNOWN_PATH = new Set(['não encontrado', 'not-found', 'Rota não encontrada.']);
const GATE_REFUSALS = new Set(['origem não permitida', 'forbidden']);

/** Whether an answer is what the server gives a request no handler recognises (see the header). */
function isUnrecognised(status: number, body: unknown): boolean {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  if (status === 405) return true;
  if (status === 404) return typeof error === 'string' && GENERIC_UNKNOWN_PATH.has(error);
  if (status === 403) return typeof error === 'string' && GATE_REFUSALS.has(error);
  return false;
}

/** Routes whose answer is a stream or a long wait: they are asked in a way that returns at once. */
const PROBE_QUERY: { [route: string]: string } = { 'GET /api/changes': '?wait=0' };

async function ask(server: ContractProbeServer, method: string, template: string, withOrigin: boolean): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const path = `${sampleOf(template)}${PROBE_QUERY[routeKey(method, template)] ?? ''}`;
    const headers: { [name: string]: string } = { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...(withOrigin ? { origin: server.url } : {}) };
    const r = await server.fetch(path, { method, signal: controller.signal, redirect: 'manual', headers, ...(method === 'GET' ? {} : { body: '{}' }) });
    if ((r.headers.get('content-type') ?? '').startsWith('text/event-stream')) return true;
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // a page or a redirect body: not a handler's JSON refusal, so a route answered it
    }
    return !isUnrecognised(r.status, body);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function isServed(server: ContractProbeServer, method: string, template: string): Promise<boolean> {
  if (await ask(server, method, template, false)) return true;
  return method !== 'GET' && (await ask(server, method, template, true));
}

describe('#662/AC-1 the spec declares each operation once', () => {
  test('#662/AC-1 Given the spec, When its operations are enumerated, Then there are some, each with a unique operationId', () => {
    assert.ok(operations.length > 0, 'the spec declares no operation');
    for (const o of operations) assert.ok(o.operation.operationId, `${routeKey(o.method, o.path)} has no operationId`);
    const ids = operations.map((o) => o.operation.operationId);
    assert.equal(new Set(ids).size, ids.length, 'an operationId is used twice');
  });
});

describe('#662/AC-1 the unrecognised-request rule', () => {
  test('#662/AC-1 a 405 from any handler, the generic unknown-path 404 and the gates\' 403 are unrecognised', () => {
    assert.equal(isUnrecognised(405, { error: 'use POST' }), true);
    assert.equal(isUnrecognised(405, { error: 'use GET' }), true);
    assert.equal(isUnrecognised(404, { error: 'não encontrado' }), true);
    assert.equal(isUnrecognised(404, { error: 'not-found' }), true);
    assert.equal(isUnrecognised(403, { error: 'origem não permitida' }), true);
    assert.equal(isUnrecognised(403, { error: 'forbidden' }), true);
  });

  test('#662/AC-1 a handler\'s own answers are recognised: a success, a validation error, a 404 for a missing resource, a refusal that names its reason', () => {
    assert.equal(isUnrecognised(200, {}), false);
    assert.equal(isUnrecognised(400, { error: 'session_id é obrigatório' }), false);
    assert.equal(isUnrecognised(404, { error: 'o núcleo não conhece esta sessão' }), false);
    assert.equal(isUnrecognised(404, { error: 'máquina desconhecida: workstation' }), false);
    assert.equal(isUnrecognised(403, { error: 'Mensagens só saem da tela do console.', reason: 'ui_only' }), false);
    assert.equal(isUnrecognised(503, { error: 'off' }), false);
    assert.equal(isUnrecognised(404, 'a page'), false);
  });
});

describe('#662/AC-1 the real server serves every declared operation', () => {
  let server: ContractProbeServer;
  before(async () => {
    server = await startContractProbeServer();
  });
  after(async () => {
    await server.close();
  });

  test('#662/AC-1 the sample machine of the contract is the machine the probe server knows', () => {
    assert.equal(PARAM_SAMPLES.machineId, PROBE_MACHINE);
  });

  test('#662/AC-1 Given the server running, When each declared operation is called, Then none gets the answer for a request no handler recognises', async () => {
    const unserved: string[] = [];
    for (const o of operations) if (!(await isServed(server, o.method, o.path))) unserved.push(routeKey(o.method, o.path));
    assert.deepEqual(unserved, []);
  });

  test('#662/AC-1 Given a planted route the server does not serve, When called, Then the probe reports it as unserved (a read and a write)', async () => {
    assert.equal(await isServed(server, 'GET', '/api/sessions/{sessionId}/planted'), false);
    assert.equal(await isServed(server, 'POST', '/api/planted-write'), false);
  });

  test('#662/AC-1 Given a planted path under a prefix a module serves, When called, Then the probe reports it as unserved', async () => {
    for (const path of ['/api/docker/planted', '/api/agent-config/planted', '/api/connectors/planted', '/api/ports/planted', '/api/machines/{machineId}/planted', '/api/runtime/planted']) assert.equal(await isServed(server, 'GET', path), false, `GET ${path}`);
    for (const path of ['/api/app-update/planted', '/api/framework-install/{owner}/{repo}/planted', '/api/docker/planted', '/api/runtime/planted']) assert.equal(await isServed(server, 'POST', path), false, `POST ${path}`);
  });

  test('#662/AC-1 Given a declared path asked with a method the spec does not declare for it, When called, Then the probe reports it as unserved', async () => {
    assert.equal(await isServed(server, 'PUT', '/api/work/issue/steps'), false);
    assert.equal(await isServed(server, 'DELETE', '/api/work/plan'), false);
    assert.equal(await isServed(server, 'POST', '/api/overview'), false);
  });

  test('#662/AC-1 a served route and a missing resource are served: the probe does not confuse them with an unknown path', async () => {
    assert.equal(await isServed(server, 'GET', '/api/overview'), true);
    assert.equal(await isServed(server, 'GET', '/api/sessions/{sessionId}'), true);
    assert.equal(await isServed(server, 'POST', '/api/hooks'), true);
    assert.equal(await isServed(server, 'GET', '/api/runtime'), true);
    assert.equal(await isServed(server, 'POST', '/api/runtime/commands'), true);
  });
});

describe('#662/AC-1 the code names no route the spec does not declare', () => {
  const declaredPaths = [...new Set(declaredOperations(spec).map((o) => o.path))];

  test('#662/AC-1 Given the API sources, When their route strings and route patterns are read, Then every one is covered by a declared route', () => {
    const sources = routeSources();
    const known = routeConstantsOf(sources.map((s) => s.source));
    const found = sources.flatMap(({ file, source }) => {
      const lit = routeLiteralsOf(source, known);
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

  const constants = routeConstantsOf(["export const AGENT_CONFIG_ROUTE = '/api/agent-config';", 'export const SKILL_ROUTE = `${AGENT_CONFIG_ROUTE}/skill`;']);

  test('#662/AC-1 Given a planted template literal built on a route constant from another file, When read, Then the detector reports the whole path', () => {
    const lit = routeLiteralsOf('const x = `${AGENT_CONFIG_ROUTE}/planted/${id}`;', constants);
    assert.deepEqual(undeclaredInCode(lit, declaredPaths), ['/api/agent-config/planted/{param}']);
  });

  test('#662/AC-1 Given a planted concatenation, When read, Then the detector reports the whole path', () => {
    assert.deepEqual(undeclaredInCode(routeLiteralsOf("const x = '/api/docker' + '/planted';"), declaredPaths), ['/api/docker/planted']);
    assert.deepEqual(undeclaredInCode(routeLiteralsOf("const x = AGENT_CONFIG_ROUTE + '/planted';", constants), declaredPaths), ['/api/agent-config/planted']);
  });

  test('#662/AC-1 Given a planted new prefix tested with startsWith and a trailing slash, When read, Then the detector reports it', () => {
    const lit = routeLiteralsOf("if (url.pathname.startsWith('/api/brand-new/')) return handler(req, res);");
    assert.deepEqual(undeclaredInCode(lit, declaredPaths), ['/api/brand-new/']);
    assert.deepEqual(undeclaredInCode(routeLiteralsOf('if (p.startsWith(`${AGENT_CONFIG_ROUTE}/`)) return h();', constants), declaredPaths), []);
  });

  test('#662/AC-1 Given a planted exact route that is only the start of a declared path, When read, Then the detector reports it (a comparison, a case, a set lookup, a constant used whole)', () => {
    assert.deepEqual(undeclaredInCode(routeLiteralsOf("if (p === '/api/panel') return h();"), declaredPaths), ['/api/panel']);
    assert.deepEqual(undeclaredInCode(routeLiteralsOf("switch (p) { case '/api/terminals': return h(); }"), declaredPaths), ['/api/terminals']);
    assert.deepEqual(undeclaredInCode(routeLiteralsOf("const ROUTES = new Set(['/api/panel']); if (ROUTES.has(p)) return h();"), declaredPaths), ['/api/panel']);
    const source = "const PANEL_ROUTE = '/api/panel'; if (url.pathname === PANEL_ROUTE) return h();";
    const panel = routeConstantsOf([source]);
    assert.deepEqual(undeclaredInCode(routeLiteralsOf(source, panel), declaredPaths), ['/api/panel']);
    assert.deepEqual(undeclaredInCode(routeLiteralsOf("import { PANEL_ROUTE } from './server.ts';\nconst t = new Set([PANEL_ROUTE]);", panel), declaredPaths), ['/api/panel']);
  });

  test('#662/AC-1 Given a route used only as the start of a declared path, When read, Then the detector does not report it (startsWith, under, a template, a chain, a RegExp)', () => {
    const panel = routeConstantsOf(["export const PANEL_ROUTE = '/api/panel';"]);
    const uses = [
      "if (p.startsWith('/api/panel')) return h();",
      'if (under(PANEL_ROUTE)) return h();',
      'if (p.startsWith(PANEL_ROUTE)) return h();',
      'if (p.startsWith(`${PANEL_ROUTE}/`)) return h();',
      'const u = `${PANEL_ROUTE}/${id}`;',
      "const u = PANEL_ROUTE + '/' + id;",
      "const u = '/api/panel' + '/' + id;",
      'const re = new RegExp(`^${PANEL_ROUTE}/[a-z]+$`);',
      "import { PANEL_ROUTE } from './server.ts';\nexport { PANEL_ROUTE } from './server.ts';",
    ];
    for (const use of uses) assert.deepEqual(undeclaredInCode(routeLiteralsOf(use, panel), declaredPaths), [], use);
    assert.deepEqual(undeclaredInCode(routeLiteralsOf("if (p.startsWith('/api/brand-new')) return h();"), declaredPaths), ['/api/brand-new']);
  });

  test('#662/AC-1 a declared path built from a constant, a template or a concatenation is not reported', () => {
    const source = 'const a = `${AGENT_CONFIG_ROUTE}/codex`; const b = SKILL_ROUTE; const c = `${AGENT_CONFIG_ROUTE}/${name}`; const d = `/api/panel/${id}`; const e = \'/api/wall\' + \'\';';
    assert.deepEqual(undeclaredInCode(routeLiteralsOf(source, constants), declaredPaths), []);
  });

  test('#662/AC-1 a declared path is not reported, whether it is named as a string or as a pattern', () => {
    const lit = routeLiteralsOf("const A = '/api/wall'; const B = /^\\/api\\/panel\\/([^/]+)$/;");
    assert.deepEqual(undeclaredInCode(lit, declaredPaths), []);
  });
});
