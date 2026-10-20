// The projects the Agent Config screen can open: the `cwd` of the sessions the core has already
// seen, most recent first, without repeats. Only absolute paths that exist as folders on this
// machine get in (an SSH session has the remote machine's cwd). The route's `?project=` only
// accepts one of these: a request never picks an arbitrary folder on disk.

import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { StoragePort } from '../storage-port.ts';

export const MAX_PROJECTS = 50;
/** At most how many sessions are looked at to build the list (pages of 500). */
const MAX_SESSIONS_SCANNED = 5000;

export async function knownProjects(storage: Pick<StoragePort, 'listSessions'>, limit = MAX_PROJECTS): Promise<string[]> {
  const seen = new Set<string>();
  const projects: string[] = [];
  let cursor: string | null = null;
  let scanned = 0;
  do {
    const page = await storage.listSessions({ limit: 500, cursor });
    for (const s of page.items) {
      const cwd = s.cwd;
      if (!cwd || seen.has(cwd)) continue;
      seen.add(cwd);
      if (!isAbsolute(cwd) || /[\0\n]/.test(cwd)) continue;
      if (!(await stat(cwd).catch(() => null))?.isDirectory()) continue;
      projects.push(cwd);
      if (projects.length >= limit) return projects;
    }
    scanned += page.items.length;
    cursor = page.nextCursor;
  } while (cursor && scanned < MAX_SESSIONS_SCANNED);
  return projects;
}
