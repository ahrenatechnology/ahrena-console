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

export interface RouteParity {
  servedNotDeclared: string[];
  declaredNotServed: string[];
}

/** The two directions of the parity: a route served and not declared, and one declared and not served. */
export function compareRoutes(served: readonly string[], declared: readonly string[]): RouteParity {
  const s = new Set(served);
  const d = new Set(declared);
  return { servedNotDeclared: served.filter((r) => !d.has(r)).sort(), declaredNotServed: declared.filter((r) => !s.has(r)).sort() };
}

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

const COMMENTS = /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/[^\n]*/g;
const ROUTE_STRING = /(['"`])(\/(?:api|open|mcp|ui)(?:\/[A-Za-z0-9_.:-]+)*)\1/g;
const ROUTE_REGEXP = /\/(\^\\\/(?:api|open|mcp|ui)(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])*)\/([a-z]*)/g;

export interface RouteLiterals {
  /** Path strings such as `'/api/wall'`, without a template hole. */
  strings: string[];
  /** Regular expression literals that start with an anchored route, such as `/^\/api\/panel\/([^/]+)$/`. */
  patterns: RegExp[];
}

/** The routes a TypeScript source names: its path strings and its anchored route patterns. */
export function routeLiteralsOf(source: string): RouteLiterals {
  const code = source.replace(COMMENTS, '');
  const strings = [...code.matchAll(ROUTE_STRING)].map((m) => m[2]!);
  const patterns = [...code.matchAll(ROUTE_REGEXP)].map((m) => new RegExp(m[1]!, m[2]));
  return { strings: [...new Set(strings)].sort(), patterns };
}

/** The route-serving sources of the core: the API folder (the CLI aside) and the three modules the server mounts. */
export function routeSources(): { file: string; source: string }[] {
  const api = readdirSync(SRC_API_URL).filter((f) => f.endsWith('.ts') && f !== 'cli.ts' && f !== 'served-routes.ts');
  const files = [...api.map((f) => new URL(f, SRC_API_URL)), new URL('../changes/http.ts', SRC_API_URL), new URL('../changes/stream.ts', SRC_API_URL), new URL('../ingest/hooks/receiver.ts', SRC_API_URL), new URL('../mcp/http.ts', SRC_API_URL)];
  return files.map((f) => ({ file: f.pathname.split('/packages/nucleo/')[1]!, source: readFileSync(f, 'utf8') }));
}

/**
 * The routes the code names that no declared template covers: a string that is no declared path and
 * the start of none, and a pattern no declared path (with its parameters filled) matches.
 */
export function undeclaredInCode(found: RouteLiterals, declaredPaths: readonly string[]): string[] {
  const samples = declaredPaths.map(sampleOf);
  const missingStrings = found.strings.filter((s) => !declaredPaths.some((p) => p === s || p.startsWith(`${s}/`)));
  const missingPatterns = found.patterns.filter((re) => !samples.some((p) => re.test(p))).map((re) => re.source);
  return [...missingStrings, ...missingPatterns];
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
