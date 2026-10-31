// Credentials stay in the owner's protected lock, never in discovery results or logs.
import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { listInstances } from '../owner/registry.ts';

export function readOwnerToken(dir: string, port: number, pid?: number): string | null {
  let fd: number | undefined;
  try {
    const folder = lstatSync(dir);
    if (!folder.isDirectory() || folder.uid !== process.getuid?.() || (folder.mode & 0o077) !== 0) return null;
    fd = openSync(join(dir, 'nucleo.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0 || file.size > 65536) return null;
    const lock = JSON.parse(readFileSync(fd, 'utf8'));
    return lock.port === port && (pid === undefined || lock.pid === pid) && typeof lock.token === 'string' && /^[a-f0-9]{64}$/.test(lock.token) ? lock.token : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

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
