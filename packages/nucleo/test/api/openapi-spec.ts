// The authored contract of the core's HTTP API (docs/contracts/core-api.openapi.json, #662) read for
// the tests: the declared operations, the route detectors and the response lookup. The spec is data;
// nothing in src/ is derived from it.
import { readFileSync, readdirSync } from 'node:fs';
import { validate, type Schema, type SchemaDocument } from './json-schema-validator.ts';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
export type Method = (typeof HTTP_METHODS)[number];

export interface ResponseObject {
  description?: string;
  headers?: { [name: string]: unknown };
  content?: { [mediaType: string]: { schema?: Schema } };
}
export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  responses?: { [status: string]: ResponseObject };
  [extension: string]: unknown;
}
export interface Spec extends SchemaDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: { [path: string]: { [method: string]: OperationObject } };
}
export interface DeclaredOperation {
  method: string;
  path: string;
  operation: OperationObject;
}

const ROOT = new URL('../../../../', import.meta.url);
export const SPEC_URL = new URL('docs/contracts/core-api.openapi.json', ROOT);
export const LEGACY_URL = new URL('docs/contracts/core-api.legacy.json', ROOT);
export const SRC_API_URL = new URL('packages/nucleo/src/api/', ROOT);

const isRecord = (v: unknown): v is { [key: string]: unknown } => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A JSON file of the repository, as `unknown`: the caller narrows it. */
export function readJson(url: URL): unknown {
  const value: unknown = JSON.parse(readFileSync(url, 'utf8'));
  return value;
}

export function readSpec(): Spec {
  const value = readJson(SPEC_URL);
  if (!isRecord(value) || typeof value.openapi !== 'string' || !isRecord(value.info) || !isRecord(value.paths)) throw new Error('docs/contracts/core-api.openapi.json is not an OpenAPI document');
  const { info, paths } = value;
  return { ...value, openapi: value.openapi, info: info as Spec['info'], paths: paths as Spec['paths'] };
}

/** The operationIds frozen in docs/contracts/core-api.legacy.json. */
export function readLegacyOperations(): string[] {
  const value = readJson(LEGACY_URL);
  const operations = isRecord(value) ? value.operations : undefined;
  if (!Array.isArray(operations) || !operations.every((o): o is string => typeof o === 'string')) throw new Error('docs/contracts/core-api.legacy.json has no list of operationIds');
  return operations;
}

/** Every method + path the spec declares, methods in capitals. */
export function declaredOperations(spec: Spec): DeclaredOperation[] {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter((m) => item[m] !== undefined).map((m) => ({ method: m.toUpperCase(), path, operation: item[m] as OperationObject })),
  );
}

export const routeKey = (method: string, path: string): string => `${method} ${path}`;

/** A value for each path parameter the spec names, shaped so every route's own pattern accepts it. */
export const PARAM_SAMPLES: { [name: string]: string } = {
  sessionId: '0b0e1d2c-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
  agentId: 'main',
  decisionId: 'dec-1',
  local: 'local_0b0e1d2c-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
  machineId: 'workstation',
  owner: 'acme',
  repo: 'app',
  recordId: '0001',
  orderId: 'ord-1',
  messageId: 'msg-1',
  toolId: 'node',
  toolAction: 'update',
  jobId: 'a1b2c3d4e5f6',
  terminalId: 'pts-1',
  terminalAction: 'interrupt',
  dockerAction: 'clean',
  connectionAction: 'start',
  appUpdateAction: 'check',
  sessionName: 'dev',
  uiFile: 'shell.css',
  uiScreenFile: 'agent-view.js',
};

/** The concrete path of a template: each `{name}` replaced by its sample. */
export function sampleOf(template: string): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => {
    const sample = PARAM_SAMPLES[name];
    if (sample === undefined) throw new Error(`no sample for the path parameter ${name}`);
    return sample;
  });
}

// ---- The served side, read from the code ---------------------------------------------------------
//
// The source scan is the "served but not declared" half of the parity (the real server probe is the
// other half). It reads the TypeScript text of the route-serving sources and reports every route the
// text names that no declared path covers. It sees:
//   - path strings (`'/api/wall'`) and anchored route patterns (`/^\/api\/panel\/([^/]+)$/`);
//   - route constants (`const X_ROUTE = '/api/x'`, also built on another constant), resolved across all
//     the scanned files, so an imported constant means what it is declared as;
//   - template literals and `+` chains headed by a route (`${X_ROUTE}/codex`, `'/api/docker' + '/purge'`),
//     each other hole written as the wildcard `{param}`;
//   - prefixes the code tests a path against (`startsWith('/api/new/')`, `startsWith(`${X_ROUTE}/`)`),
//     which must begin some declared path.
// What it cannot see (the blind spots, held by the real-server probe only where a declared route
// exercises them): a dispatch that compares split path segments (`segments[1] === 'brand-new'`), a
// `new RegExp(...)` built at runtime, a route assembled by a function call or a spread, a constant
// that is not an upper-case `const` literal, and a route kept in a data file or another folder. A new
// route written in one of those shapes is not reported here; write it as a constant or a literal. A
// `/ui/...` path built from a template or a chain is not read either: the interface answers any
// `/ui/<path>` with its shell (client routing), so such a path is a link, not a route.

const COMMENTS = /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/[^\n]*/g;
const ROUTE_STRING = /(['"`])(\/(?:api|open|mcp|ui)(?:\/[A-Za-z0-9_.:-]+)*)\1/g;
const PREFIX_STRING = /(['"`])(\/(?:api|open|mcp)(?:\/[A-Za-z0-9_.:-]+)*\/)\1/g;
const ROUTE_REGEXP = /\/(\^\\\/(?:api|open|mcp|ui)(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])*)\/([a-z]*)/g;
const ROUTE_HEAD = /^\/(?:api|open|mcp|ui)(?:\/|$)/;
/** The server's own routes: `/ui/<anything>` is the shell's client routing (api/ui.ts), so a `/ui/...` link the code builds is no route. */
const SERVER_ROUTE_HEAD = /^\/(?:api|open|mcp)(?:\/|$)/;
const CONSTANT = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*(?:(['"])([^'"\n]*)\2|`((?:[^`\\]|\\.)*)`)\s*(?:as const)?\s*;/g;
const TEMPLATE = /`((?:[^`\\]|\\.)*)`/g;
const PIECE = String.raw`(?:'[^'\n]*'|"[^"\n]*"|` + '`[^`\\n]*`' + String.raw`|[A-Za-z_$][\w$.]*)`;
const CHAIN = new RegExp(String.raw`(?<![\w$.'"` + '`' + String.raw`])${PIECE}(?:\s*\+\s*${PIECE})+`, 'g');
const PARAM = '{param}';

export type RouteConstants = { [name: string]: string[] };

export interface RouteLiterals {
  /** Path strings such as `'/api/wall'`, without a template hole. */
  strings: string[];
  /** Whole paths built from a route constant, a template literal or a `+` chain, each hole written `{param}`. */
  resolved: string[];
  /** Prefixes the code tests a path against, such as `startsWith('/api/brand-new/')`, with their trailing slash. */
  prefixes: string[];
  /** Regular expression literals that start with an anchored route, such as `/^\/api\/panel\/([^/]+)$/`. */
  patterns: RegExp[];
}

const withoutComments = (source: string): string => source.replace(COMMENTS, '');

/** A template body or string piece with each `${NAME}` of a known route constant replaced by its value(s) and any other hole by `{param}`. */
function expand(body: string, constants: RouteConstants): string[] {
  const parts = body.split(/(\$\{[^}]*\})/);
  return parts.reduce<string[]>(
    (acc, part) => {
      const hole = /^\$\{\s*([A-Za-z_$][\w$]*)\s*\}$/.exec(part);
      const values = part.startsWith('${') ? (hole?.[1] !== undefined ? (constants[hole[1]] ?? [PARAM]) : [PARAM]) : [part];
      return acc.flatMap((head) => values.map((v) => head + v));
    },
    [''],
  );
}

/** A path without its query or fragment, and without a hole glued to the last segment (`${ROUTE}${url.search}`): that is a suffix, not a segment. */
const stripQuery = (path: string): string => path.replace(/[?#].*$/, '').replace(/(?<=[^/])\{param\}$/, '');

/** The route constants the sources declare: `const X = '/api/x'`, or a template built on another constant, resolved to a fixed point. */
export function routeConstantsOf(sources: readonly string[]): RouteConstants {
  const found: { name: string; body: string; template: boolean }[] = [];
  for (const source of sources) {
    for (const m of withoutComments(source).matchAll(CONSTANT)) found.push({ name: m[1]!, body: m[3] ?? m[4] ?? '', template: m[4] !== undefined });
  }
  let constants: RouteConstants = {};
  for (let round = 0; round < 5; round += 1) {
    const next: RouteConstants = {};
    for (const { name, body, template } of found) {
      const values = (template ? expand(body, constants) : [body]).map(stripQuery).filter((v) => ROUTE_HEAD.test(v));
      if (values.length > 0) next[name] = [...new Set([...(next[name] ?? []), ...values])];
    }
    constants = next;
  }
  return constants;
}

/** The routes a TypeScript source names: its path strings, resolved paths, prefixes and anchored route patterns. */
export function routeLiteralsOf(source: string, constants: RouteConstants = {}): RouteLiterals {
  const code = withoutComments(source);
  const strings = [...code.matchAll(ROUTE_STRING)].map((m) => m[2]!);
  const patterns = [...code.matchAll(ROUTE_REGEXP)].map((m) => new RegExp(m[1]!, m[2]));
  const prefixes = new Set([...code.matchAll(PREFIX_STRING)].map((m) => m[2]!));
  const resolved = new Set<string>();
  const add = (path: string): void => {
    const clean = stripQuery(path);
    if (!SERVER_ROUTE_HEAD.test(clean)) return;
    if (clean.endsWith('/')) prefixes.add(clean);
    else resolved.add(clean);
  };
  for (const m of code.matchAll(TEMPLATE)) if (m[1]!.includes('${')) for (const path of expand(m[1]!, constants)) add(path);
  for (const m of code.matchAll(CHAIN)) {
    const pieces = m[0].split(/\s*\+\s*/).map((piece) => (/^['"`]/.test(piece) ? expand(piece.slice(1, -1), constants) : (constants[piece] ?? [PARAM])));
    for (const path of pieces.reduce<string[]>((acc, values) => acc.flatMap((head) => values.map((v) => head + v)), [''])) add(path);
  }
  for (const [name, values] of Object.entries(constants)) {
    if (new RegExp(String.raw`(?<![\w$.])${name}(?![\w$])`).test(code)) strings.push(...values.map(stripQuery).filter((v) => !v.includes(PARAM) && !v.endsWith('/')));
  }
  return { strings: [...new Set(strings)].sort(), resolved: [...resolved].sort(), prefixes: [...prefixes].sort(), patterns };
}

/** The route-serving sources of the core: the API folder (the CLI aside) and the three modules the server mounts. */
export function routeSources(): { file: string; source: string }[] {
  const api = readdirSync(SRC_API_URL).filter((f) => f.endsWith('.ts') && f !== 'cli.ts');
  const files = [...api.map((f) => new URL(f, SRC_API_URL)), new URL('../changes/http.ts', SRC_API_URL), new URL('../changes/stream.ts', SRC_API_URL), new URL('../ingest/hooks/receiver.ts', SRC_API_URL), new URL('../mcp/http.ts', SRC_API_URL)];
  return files.map((f) => ({ file: f.pathname.split('/packages/nucleo/')[1]!, source: readFileSync(f, 'utf8') }));
}

const segmentsOf = (path: string): string[] => path.split('/').filter((s) => s !== '');
const isHole = (segment: string): boolean => segment === PARAM || /^\{[A-Za-z]+\}$/.test(segment);

/** Whether `found` names `declared`, segment by segment; a hole on either side stands for any segment. With `prefix`, `found` may stop early. */
function covers(found: string, declared: string, prefix: boolean): boolean {
  const f = segmentsOf(found);
  const d = segmentsOf(declared);
  if (prefix ? f.length > d.length : f.length !== d.length) return false;
  return f.every((segment, i) => segment === d[i] || isHole(segment) || isHole(d[i]!));
}

/**
 * The routes the code names that no declared template covers: a string that is no declared path and
 * the start of none, a resolved path (template, constant or `+` chain) no declared path equals, a prefix
 * no declared path begins with, and a pattern no declared path (with its parameters filled) matches.
 */
export function undeclaredInCode(found: RouteLiterals, declaredPaths: readonly string[]): string[] {
  const samples = declaredPaths.map(sampleOf);
  const missingStrings = found.strings.filter((s) => !declaredPaths.some((p) => p === s || p.startsWith(`${s}/`)));
  const missingResolved = found.resolved.filter((r) => !declaredPaths.some((p) => covers(r, p, false)));
  const missingPrefixes = found.prefixes.filter((r) => !declaredPaths.some((p) => covers(r, p, true) && segmentsOf(p).length > segmentsOf(r).length));
  const missingPatterns = found.patterns.filter((re) => !samples.some((p) => re.test(p))).map((re) => re.source);
  return [...missingStrings, ...missingResolved, ...missingPrefixes, ...missingPatterns];
}

// ---- The responses -------------------------------------------------------------------------------

/** The schema the spec declares for `status` of an operation, as JSON, or `undefined` when none. */
export function responseSchema(spec: Spec, method: string, path: string, status: number): Schema | undefined {
  const op = spec.paths[path]?.[method.toLowerCase()];
  const response = op?.responses?.[String(status)];
  return response?.content?.['application/json']?.schema;
}

/** The problems of an actual JSON answer against what the spec declares for its method, path template and status. */
export function responseProblems(spec: Spec, method: string, path: string, status: number, body: unknown): string[] {
  const declaredStatuses = Object.keys(spec.paths[path]?.[method.toLowerCase()]?.responses ?? {});
  if (!declaredStatuses.includes(String(status))) return [`${method} ${path}: status ${status} is not declared (declared: ${declaredStatuses.join(', ') || 'none'})`];
  const schema = responseSchema(spec, method, path, status);
  if (!schema) return [`${method} ${path}: status ${status} declares no JSON schema`];
  return validate(schema, body, spec).map((p) => `${method} ${path} ${status} ${p}`);
}

// ---- The ratchet ---------------------------------------------------------------------------------

const SUCCESS = /^[23]\d\d$/;
const PLACEHOLDER_KEYS = new Set(['type', 'description']);

/** A bare `{ type: object }` (or `{}`): valid, and says nothing about the shape. */
const isPlaceholder = (schema: Schema | undefined): boolean => schema === undefined || (Object.keys(schema).every((k) => PLACEHOLDER_KEYS.has(k)) && (schema.type === undefined || schema.type === 'object'));

/**
 * Whether an operation declares a real response: a 2xx or 3xx answer with a JSON schema that says more than
 * `object`, a text answer typed as a string (the interface's files, an event stream), or a redirect that names
 * its `Location`.
 */
export function hasRealResponseSchema(operation: OperationObject): boolean {
  return Object.entries(operation.responses ?? {})
    .filter(([status]) => SUCCESS.test(status))
    .some(([status, response]) => {
      if (status.startsWith('3') && response.headers?.Location !== undefined) return true;
      return Object.entries(response.content ?? {}).some(([media, body]) => (media === 'application/json' ? !isPlaceholder(body.schema) : body.schema?.type === 'string'));
    });
}

/** Fails the calling test when an actual JSON answer does not conform to what the spec declares for it. */
export function assertAnswersTheSpec(method: string, path: string, status: number, body: unknown, spec: Spec = readSpec()): void {
  const problems = responseProblems(spec, method, path, status, body);
  if (problems.length > 0) throw new Error(`the answer does not conform to docs/contracts/core-api.openapi.json:\n${problems.join('\n')}`);
}
