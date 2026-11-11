// Reads the owner's token from a core's protected lock. It lives in `owner/` (moved from `mcp/`, decision
// 0020, #388) because `core remote-credential` needs it and `mcp/` already imports `owner/registry`: the
// other direction would be an import cycle. Credentials stay in the 0600 lock, never in discovery results.
import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The lock's token if the folder and the file belong to `uid` (default: this process's), have no group
 * or other bits, the file is not a symlink and is at most 64 KiB, and the lock is for `port` (and `pid`).
 */
export function readOwnerToken(dir: string, port: number, pid?: number, uid: number | undefined = process.getuid?.()): string | null {
  let fd: number | undefined;
  try {
    const folder = lstatSync(dir);
    if (!folder.isDirectory() || folder.uid !== uid || (folder.mode & 0o077) !== 0) return null;
    fd = openSync(join(dir, 'nucleo.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== uid || (file.mode & 0o077) !== 0 || file.size > 65536) return null;
    const lock = JSON.parse(readFileSync(fd, 'utf8'));
    return lock.port === port && (pid === undefined || lock.pid === pid) && typeof lock.token === 'string' && /^[a-f0-9]{64}$/.test(lock.token) ? lock.token : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
