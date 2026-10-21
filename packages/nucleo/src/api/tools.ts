// The Tools route (#280, decision 0014), `GET` only in layer 1, behind the server's Origin and Host
// defenses (decision 0003) like the other reads:
//
// - `GET /api/tools?machine=<id>`: the screen's whole state (src/tools/service.ts, `ToolsOverview`).
//   `machine` defaults to `local`; an invalid id gives 400; a machine this núcleo does not serve, 404
//   (the Workstation through the tunnel is layer 4).
// - Without the service wired in (the --demo núcleo): 404.
//
// The writes (`POST /api/tools/<toolId>/actions/<actionId>`, `DELETE /api/tools/jobs/<jobId>`,
// `POST /api/tools/checks`) are layer 2.

import type { ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID } from '../telemetry/model.ts';
import type { ToolsService } from '../tools/service.ts';

export const TOOLS_ROUTE = '/api/tools';

export function isToolsRoute(pathname: string): boolean {
  return pathname === TOOLS_ROUTE;
}

export async function respondTools(res: ServerResponse, url: URL, tools: Pick<ToolsService, 'overview'> | null | undefined): Promise<void> {
  if (!tools) return send(res, 404, { error: 'o núcleo subiu sem a tela Ferramentas' });
  const machine = url.searchParams.get('machine') || LOCAL_MACHINE_ID;
  if (!MACHINE_ID.test(machine)) return send(res, 400, { error: 'machine inválida: letras minúsculas, números e hífen' });
  const body = await tools.overview(machine);
  if (!body) return send(res, 404, { error: `máquina desconhecida: ${machine}` });
  send(res, 200, body);
}
