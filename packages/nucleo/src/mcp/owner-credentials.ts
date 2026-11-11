// Credentials stay in the owner's protected lock, never in discovery results or logs.
import { listInstances } from '../owner/registry.ts';
import { readOwnerToken } from '../owner/lock-token.ts';

export { readOwnerToken };

/** Reload for each request: a core restart invalidates its old credential. */
export function ownerTokenForPort(port: number, ownDir: string): string | null {
  const own = readOwnerToken(ownDir, port);
  if (own) return own;
  for (const instance of listInstances({ clean: false })) {
    if (instance.port !== port) continue;
    const token = readOwnerToken(instance.dataDir, port, instance.pid);
    if (token) return token;
  }
  return null;
}
