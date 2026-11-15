// LOG-1 (#661): the observer masks before it exports. An attribute whose key names a secret or a personal datum
// leaves as `[redacted]`; the keys the code writes are named fields, so this is the second lock, not the first.

export const REDACTED = '[redacted]';

const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|cookie|api[_.-]?key|credential|email|session[_.-]?key|private[_.-]?key)/i;

export type AttributeValue = string | number | boolean;

export function maskAttributes(attributes: Readonly<Record<string, AttributeValue>>): Record<string, AttributeValue> {
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : value]));
}
