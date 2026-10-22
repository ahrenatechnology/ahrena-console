// `GET /api/dev-console` (#177, decision 0008 section 4): the Dev Console, read only.
//
// - without `context`: the contexts and the merge queue of all of them;
// - `?context=<id>`: the scoreboard, depends-on-you, the queue and the not-ready PRs, the issue
//   board in six columns and the PRs merged in the last 24 h, with GitHub's `readAt` and `stale`.
//
// `GET` only, behind the same Origin and Host defenses as the other routes (server.ts, decision 0003).
// Error messages stay pt-BR, like the other routes'.

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { CONTEXT_ID } from '../dev-console/contexts.ts';
import type { DevConsole } from '../dev-console/service.ts';

export type { DevConsole };

export const DEV_CONSOLE_ROUTE = '/api/dev-console';

export async function respondDevConsole(res: ServerResponse, url: URL, devConsole: Pick<DevConsole, 'overview' | 'view'>): Promise<void> {
  const context = url.searchParams.get('context');
  if (context === null) return send(res, 200, await devConsole.overview());
  if (!CONTEXT_ID.test(context)) return send(res, 400, { error: 'context: um id de ~/.ahrena-console/dev-console.json ou owner/repo' });
  const view = await devConsole.view(context);
  if (!view) return send(res, 404, { error: 'contexto não encontrado' });
  send(res, 200, view);
}
