// Whether an inbox socket path is one only this user could have put there (#61). Run by
// `SessionsDirectory.find` and again by `SocketInbox.deliver` right before `connect`, since the
// path is reopened by name and the file can change in between (TOCTOU):
//
// - the socket's `lstat` is a socket (so not a symlink) owned by our uid;
// - its parent directory's `lstat` is a directory (so not a symlink) owned by our uid that neither
//   the group nor others can write (`mode & 0o022 === 0`): nobody else can replace the socket in it.
//
// The parent directory is the defence; the second `lstat` narrows the window to the time between
// it and `connect`. What stays open, accepted: the ancestors above the parent are not checked, so a
// user who can write one of them could swap the whole parent directory in that window (on macOS
// Claude Code uses `/tmp/cc-socks`, `0700` and ours, under the sticky `/tmp`, where only the owner
// can rename it); and root can always.

import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** `gone`: the socket or its folder is not there; `not_ours`: it is, but someone else could have put it there. */
export type SocketCheck = 'ok' | 'gone' | 'not_ours';

/** The core's uid; `null` on a platform without `getuid` (the owner checks are skipped). */
export const CORE_UID: number | null = typeof process.getuid === 'function' ? process.getuid() : null;

export async function checkSocketPath(socketPath: string, uid: number | null = CORE_UID): Promise<SocketCheck> {
  try {
    const dir = await lstat(dirname(socketPath));
    if (!dir.isDirectory() || (dir.mode & 0o022) !== 0) return 'not_ours';
    if (uid !== null && dir.uid !== uid) return 'not_ours';
    const sock = await lstat(socketPath);
    if (!sock.isSocket()) return 'not_ours';
    if (uid !== null && sock.uid !== uid) return 'not_ours';
    return 'ok';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'not_ours';
  }
}
