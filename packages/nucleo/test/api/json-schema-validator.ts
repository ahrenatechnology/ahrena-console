// A validator for the subset of JSON Schema 2020-12 (the dialect of OpenAPI 3.1) that
// docs/contracts/core-api.openapi.json uses, written for the contract tests (#662).
//
// Why hand-rolled and not a library: the core's package has one development dependency, and an
// OpenAPI-aware validator would bring a dependency tree (and a lockfile change) into a package that is
// built and tested with no network access to anything but its lockfile. The subset is small, and the
// validator FAILS CLOSED: a keyword it does not implement throws, so a schema can never pass because
// part of it was ignored. `test/api/json-schema-validator.test.ts` proves each keyword.

export type Schema = { [keyword: string]: unknown };

export interface SchemaDocument {
  components?: { schemas?: { [name: string]: Schema } };
}

/** Keywords that describe a schema and never constrain a value. */
const ANNOTATIONS = new Set(['description', 'title', 'example', 'examples', 'default', 'deprecated', '$comment', 'summary']);

/** Every keyword the validator implements, besides the annotations. */
export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  '$ref', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', 'oneOf', 'anyOf', 'allOf',
]);
export const isAnnotation = (keyword: string): boolean => ANNOTATIONS.has(keyword);

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  null: (v) => v === null,
  boolean: (v) => typeof v === 'boolean',
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
};

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const REF = /^#\/components\/schemas\/([A-Za-z0-9_.-]+)$/;

export class UnsupportedSchemaError extends Error {}

const isRecord = (v: unknown): v is { [key: string]: unknown } => TYPE_CHECKS.object!(v);

function resolve(ref: string, doc: SchemaDocument): Schema {
  const name = REF.exec(ref)?.[1];
  const target = name === undefined ? undefined : doc.components?.schemas?.[name];
  if (!target) throw new UnsupportedSchemaError(`unresolved $ref ${ref}`);
  return target;
}

/** The problems of `value` against `schema`, each as `<pointer>: <what>`; empty when it conforms. */
export function validate(schema: Schema, value: unknown, doc: SchemaDocument = {}, pointer = '$'): string[] {
  const errors: string[] = [];
  for (const [keyword, rule] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword)) continue;
    if (!SUPPORTED_KEYWORDS.has(keyword)) throw new UnsupportedSchemaError(`keyword ${keyword}`);
    errors.push(...check(keyword, rule, schema, value, doc, pointer));
  }
  return errors;
}

function check(keyword: string, rule: unknown, schema: Schema, value: unknown, doc: SchemaDocument, at: string): string[] {
  switch (keyword) {
    case '$ref':
      return validate(resolve(String(rule), doc), value, doc, at);
    case 'type': {
      const types = Array.isArray(rule) ? (rule as string[]) : [String(rule)];
      for (const t of types) if (!TYPE_CHECKS[t]) throw new UnsupportedSchemaError(`type ${t}`);
      return types.some((t) => TYPE_CHECKS[t]!(value)) ? [] : [`${at}: expected ${types.join(' or ')}`];
    }
    case 'enum':
      return (rule as unknown[]).includes(value) ? [] : [`${at}: not one of the enum`];
    case 'const':
      return value === rule ? [] : [`${at}: not the constant`];
    case 'properties':
      return isRecord(value) ? properties(rule as { [k: string]: Schema }, value, doc, at) : [];
    case 'required':
      return isRecord(value) ? (rule as string[]).filter((k) => !(k in value)).map((k) => `${at}: missing required ${k}`) : [];
    case 'additionalProperties':
      return isRecord(value) ? additional(rule, schema, value, doc, at) : [];
    case 'items':
      return Array.isArray(value) ? value.flatMap((item, i) => validate(rule as Schema, item, doc, `${at}[${i}]`)) : [];
    case 'minItems':
      return Array.isArray(value) && value.length < Number(rule) ? [`${at}: fewer than ${rule} items`] : [];
    case 'maxItems':
      return Array.isArray(value) && value.length > Number(rule) ? [`${at}: more than ${rule} items`] : [];
    case 'minimum':
      return typeof value === 'number' && value < Number(rule) ? [`${at}: below ${rule}`] : [];
    case 'maximum':
      return typeof value === 'number' && value > Number(rule) ? [`${at}: above ${rule}`] : [];
    case 'minLength':
      return typeof value === 'string' && value.length < Number(rule) ? [`${at}: shorter than ${rule}`] : [];
    case 'maxLength':
      return typeof value === 'string' && value.length > Number(rule) ? [`${at}: longer than ${rule}`] : [];
    case 'pattern':
      return typeof value === 'string' && !new RegExp(String(rule), 'u').test(value) ? [`${at}: does not match the pattern`] : [];
    case 'format':
      if (rule !== 'date-time') throw new UnsupportedSchemaError(`format ${String(rule)}`);
      return typeof value === 'string' && !(DATE_TIME.test(value) && !Number.isNaN(Date.parse(value))) ? [`${at}: not a date-time`] : [];
    case 'oneOf':
      return combine(rule as Schema[], value, doc, at, (n) => n === 1, 'exactly one');
    case 'anyOf':
      return combine(rule as Schema[], value, doc, at, (n) => n >= 1, 'at least one');
    case 'allOf':
      return (rule as Schema[]).flatMap((s) => validate(s, value, doc, at));
    default:
      throw new UnsupportedSchemaError(`keyword ${keyword}`);
  }
}

function properties(rule: { [k: string]: Schema }, value: { [k: string]: unknown }, doc: SchemaDocument, at: string): string[] {
  return Object.entries(rule).flatMap(([name, sub]) => (name in value ? validate(sub, value[name], doc, `${at}.${name}`) : []));
}

function additional(rule: unknown, schema: Schema, value: { [k: string]: unknown }, doc: SchemaDocument, at: string): string[] {
  const declared = new Set(Object.keys((schema.properties as { [k: string]: unknown } | undefined) ?? {}));
  const extra = Object.keys(value).filter((k) => !declared.has(k));
  if (rule === true) return [];
  if (rule === false) return extra.map((k) => `${at}: unexpected property ${k}`);
  return extra.flatMap((k) => validate(rule as Schema, value[k], doc, `${at}.${k}`));
}

function combine(options: Schema[], value: unknown, doc: SchemaDocument, at: string, accept: (matches: number) => boolean, wanted: string): string[] {
  const matches = options.filter((s) => validate(s, value, doc, at).length === 0).length;
  return accept(matches) ? [] : [`${at}: matched ${matches} of the options, wanted ${wanted}`];
}
