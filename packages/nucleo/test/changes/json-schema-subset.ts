// A small, dependency-free validator for the JSON Schema subset the event contracts use
// (docs/contracts/events/): type (one or a list, with null), const, enum, required, properties,
// additionalProperties false, pattern, minLength and format date-time. Anything else in a schema is
// refused loudly, so a contract cannot silently use a keyword this helper does not check.

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = { [k: string]: Json };

const KNOWN = new Set(['$schema', '$id', 'title', 'description', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties', 'pattern', 'minLength', 'format']);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeOf(value) === 'object';
}

/** Returns the list of violations, empty when `value` satisfies `schema`. */
export function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) errors.push(`${path}: schema keyword not supported by the test validator: ${key}`);
  if (errors.length > 0) return errors;

  if (schema.type !== undefined) {
    const allowed = ([] as Json[]).concat(schema.type);
    const actual = typeOf(value);
    const ok = allowed.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) return [`${path}: expected type ${allowed.join('|')}, got ${actual}`];
  }
  if ('const' in schema && schema.const !== value) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as Json)) errors.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) errors.push(`${path}: not a date-time`);
  }
  if (isObject(value)) errors.push(...validateObject(schema, value, path));
  return errors;
}

function validateObject(schema: Schema, value: Record<string, unknown>, path: string): string[] {
  const errors: string[] = [];
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  for (const name of (schema.required ?? []) as string[]) if (!(name in value)) errors.push(`${path}.${name}: required`);
  for (const [name, child] of Object.entries(value)) {
    const sub = properties[name];
    if (sub) errors.push(...validate(sub, child, `${path}.${name}`));
    else if (schema.additionalProperties === false) errors.push(`${path}.${name}: not allowed`);
  }
  return errors;
}
