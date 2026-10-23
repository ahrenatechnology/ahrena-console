// "Até quando", variant A (decision 0013 section 3, #277): the end of an SSO session, from the AWS
// CLI v2's token cache. The cache file holds the access token itself, so this reader is narrow:
//
// - The file is the one the CLI names for that session: `sha1(<sso-session name>).json` for the
//   new format, `sha1(<start URL>).json` for a legacy profile, in `~/.aws/sso/cache`. No listing of
//   the folder, no other file.
// - It reads at most 64 KiB, parses it, and returns ONLY `expiresAt`, normalised to ISO, or `null`.
//   Everything else (the token, the refresh token, the client secret) is dropped inside this
//   function: it is never returned, stored, logged or put in an error message. Any failure is `null`.

import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_CACHE_BYTES = 64 * 1024;

export interface SsoCacheKey {
  kind: 'sso-session' | 'legacy';
  /** The sso-session's name (new format). */
  name: string;
  /** The profile's start URL (legacy). */
  startUrl: string | null;
}

/** The cache file's name: what the CLI v2 hashes for that session. */
export function ssoCacheFileName(key: SsoCacheKey): string | null {
  const input = key.kind === 'sso-session' ? key.name : key.startUrl;
  if (!input) return null;
  return `${createHash('sha1').update(input, 'utf8').digest('hex')}.json`;
}

/** The session's `expiresAt` (ISO), or `null` when there is no cache file or it has none. */
export async function readSsoExpiresAt(cacheDir: string, key: SsoCacheKey): Promise<string | null> {
  const name = ssoCacheFileName(key);
  if (!name) return null;
  let handle;
  try {
    handle = await open(join(cacheDir, name), 'r');
    const buffer = Buffer.alloc(MAX_CACHE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CACHE_BYTES) return null;
    const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    buffer.fill(0);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const raw = (parsed as { expiresAt?: unknown }).expiresAt;
    if (typeof raw !== 'string') return null;
    // The CLI writes `2026-01-01T00:00:00Z` (sometimes `UTC` instead of `Z`).
    const ms = Date.parse(raw.replace(/UTC$/, 'Z'));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
