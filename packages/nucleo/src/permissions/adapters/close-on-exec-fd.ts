/* The window channel's descriptor, made unreachable by anything the process spawns afterwards. Node and libuv never set FD_CLOEXEC on a
   descriptor a process inherits, so every child (git, ps, a terminal launcher, the tools runner) would hold the core's end of the
   socket and could read the next credential line or keep the channel open. (#619, review finding SEC-2) */
import { closeSync, openSync } from 'node:fs';

/**
 * Reopens `fd` as a new descriptor and closes the original. libuv opens `/dev/fd/<n>` with O_CLOEXEC, and on macOS that is a duplicate
 * of the very same socket, so the new descriptor is the channel and no descendant inherits it (#619). Returns `null` when it cannot be
 * reopened (a platform where `/dev/fd` of a socket fails, or no such descriptor): the original is closed too, so the channel is absent
 * and the capability unavailable rather than left open to every child.
 */
export function reopenCloseOnExec(fd: number): number | null {
  let replacement: number | null = null;
  try {
    replacement = openSync(`/dev/fd/${fd}`, 'r+');
  } catch {
    /* The cause's text stays out of everything: the caller logs a closed code (#619). */
  }
  try {
    closeSync(fd);
  } catch {
    /* Already closed: nothing to release (#619). */
  }
  return replacement;
}
