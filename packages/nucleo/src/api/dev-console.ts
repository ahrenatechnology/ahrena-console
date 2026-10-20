// `GET /api/dev-console` (#177, decisão 0008 seção 4): o Dev Console, só leitura.
//
// - sem `context`: os contextos e a fila de merge de todos eles;
// - `?context=<id>`: o placar, "depende de você", a fila e os não prontos, o quadro das issues em
//   seis colunas e os mesclados nas últimas 24 h, com `readAt` e `stale` do GitHub.
//
// Só `GET`, atrás das mesmas defesas de Origin e Host das outras rotas (servidor.ts, decisão 0003).

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { CONTEXT_ID } from '../dev-console/contexts.ts';
import type { DevConsole } from '../dev-console/service.ts';

export type { DevConsole };

export const DEV_CONSOLE_ROUTE = '/api/dev-console';

export async function respondDevConsole(res: ServerResponse, url: URL, devConsole: DevConsole): Promise<void> {
  const context = url.searchParams.get('context');
  if (context === null) return send(res, 200, await devConsole.overview());
  if (!CONTEXT_ID.test(context)) return send(res, 400, { error: 'context: um id de ~/.ahrena-console/dev-console.json ou owner/repo' });
  const view = await devConsole.view(context);
  if (!view) return send(res, 404, { error: 'contexto não encontrado' });
  send(res, 200, view);
}
