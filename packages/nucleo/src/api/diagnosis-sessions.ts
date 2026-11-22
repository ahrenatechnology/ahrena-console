/*
 * Where the diagnosis reads the agent sessions of this machine (#722, #720): the live registry, through
 * `LiveClaudeProcesses`, and the title the console knows for a session: the Desktop's when there is one, else the
 * session's own name. A title is shown as the fleet shows it (`safeTitle`: no control characters, 60 characters).
 */

import type { SessionSource } from '../diagnosis/adapters/common.ts';
import { safeTitle } from '../mcp/output.ts';
import type { LiveProcess } from './session-open.ts';

export interface SessionSourceOptions {
  live: { refresh(): Promise<void>; listLive(): LiveProcess[] };
  /** The `name` the console stores for the session; `null` when there is none. (#722) */
  sessionName(sessionId: string): Promise<string | null>;
  /** The title the Claude Desktop index holds; `null` when it holds none. (#722) */
  desktopTitle(sessionId: string): string | null;
}

export function createSessionSource({ live, sessionName, desktopTitle }: SessionSourceOptions): SessionSource {
  return {
    registered: async () => {
      await live.refresh();
      return live.listLive();
    },
    titleOf: async (sessionId) => safeTitle(desktopTitle(sessionId)) ?? safeTitle(await sessionName(sessionId)),
  };
}
