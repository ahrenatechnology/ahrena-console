// The digest that binds an answer to its session and its call (decision 0025, #618/AC-1).
// Pure: no disk, no socket, no clock. SHA-256 comes from the standard `crypto.subtle` global, so no module is imported. (#618)
//
// The canonicalisation is one function shared with the plugin hook (#620): keys sorted at every level, no spaces,
// numbers and Unicode as `JSON.stringify` writes them, undefined keys dropped. The vectors in (#618)
// `test/permissions/digest-vectors.json` are the contract between the two sides. (#618)

/** What a digest binds: exactly these four fields. */
export interface DigestInput {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  cwd: string;
}

/** JSON with the keys in order at every level, so the digest does not depend on the order they arrived in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** SHA-256 hex of the canonical JSON of the session, the tool, its input and the folder. */
export async function digestOf({ sessionId, toolName, toolInput, cwd }: DigestInput): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ sessionId, toolName, toolInput, cwd }));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
