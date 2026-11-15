// The digest that binds an answer to its session and its call (decision 0025, #618/AC-1).
// Pure: no disk, no socket, no clock. SHA-256 comes from the standard `crypto.subtle` global, so no module is imported. (#618)
//
// The canonicalisation is one function shared with the plugin hook (#620): keys sorted at every level, no spaces,
// numbers and Unicode as `JSON.stringify` writes them, undefined keys dropped. The vectors in (#618)
// `test/permissions/digest-vectors.json` are the contract between the two sides. (#618)
import { PermissionRefusal } from './refusal.ts';

/** What a digest binds: exactly these four fields. */
export interface DigestInput {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  cwd: string;
}

/** The most levels of arrays and objects a value may nest; deeper is refused, as the stack is not the limit (#618/AC-1, INP-9). The digest envelope is level 1; the hook (#620) applies the same. */
export const MAX_CANONICAL_DEPTH = 64;

/** Whether a container nests past the ceiling, read with an explicit stack: no recursion, so no stack size decides (#618/AC-1, INP-9). `depth` is the level of `value`; the digest envelope is level 1. */
export function exceedsDepth(value: unknown, depth = 1): boolean {
  const pending: [unknown, number][] = [[value, depth]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [v, d] = next;
    if (v === null || typeof v !== 'object') continue;
    if (d > MAX_CANONICAL_DEPTH) return true;
    for (const child of Object.values(v)) pending.push([child, d + 1]);
  }
  return false;
}

/** Throws `input_too_deep` when the value nests past the ceiling; run before anything else walks a tool input (#618/AC-1). */
export function assertWithinDepth(value: unknown, depth = 1): void {
  if (exceedsDepth(value, depth)) throw new PermissionRefusal('input_too_deep');
}

/** JSON with the keys in order at every level, so the digest does not depend on the order they arrived in. Throws `input_too_deep` past the ceiling, checked before the first level is written (#618/AC-1). */
export function canonicalJson(value: unknown, depth = 1): string {
  assertWithinDepth(value, depth);
  return writeCanonical(value);
}

// Runs only after `assertWithinDepth`, so it recurses at most MAX_CANONICAL_DEPTH levels. (#618/AC-1)
function writeCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => writeCanonical(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${writeCanonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** SHA-256 hex of the canonical JSON of the session, the tool, its input and the folder. */
export async function digestOf({ sessionId, toolName, toolInput, cwd }: DigestInput): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ sessionId, toolName, toolInput, cwd }));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
