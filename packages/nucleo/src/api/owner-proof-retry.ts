// "Tentar agora" on the owner-proof bands (#388, decision 0020, wireframes 388-2 and 388-4):
// `POST /api/machines/<id>/owner-proof/retry` asks this core to request the remote owner's proof now, skipping the
// wait between failed issues once (telemetry/remote-proof.ts `retryNow`), and to read the machine again.
//
// - Local only. It sits behind the server's owner gate (#302: the local bearer) and its Origin and Host defenses
//   (decision 0003): the no-Origin loopback request, or the /ui's own Origin on the exact raw path
//   (`ownerProofRetryFromSameOrigin`). It is not on the remote credential's closed list (owner-auth.ts
//   `REMOTE_ROUTES`), so an `AhrenaRemote` proof gets 403 `credential-route` before this code runs.
// - The body is never read; only the id of the path reaches the core, looked up among the remote machines.
// - The answer is `{ machine: { id, state, reason } }`: never a credential, a key, a command or its output.
//   404 for an id that is not a remote machine.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { LOCAL_MACHINE_ID, MACHINE_ID } from '../telemetry/model.ts';
import type { MachineStatus } from '../telemetry/service.ts';
import { fromOwnUi } from './same-origin.ts';

export const OWNER_PROOF_RETRY_ROUTE = /^\/api\/machines\/([^/]+)\/owner-proof\/retry$/;
/** The exact raw path the same-origin exception accepts: a valid id, no query, no encoding. */
const RAW_PATH = /^\/api\/machines\/[a-z0-9][a-z0-9-]{0,63}\/owner-proof\/retry$/;

export const ownerProofRetryPath = (id: string): string => `/api/machines/${encodeURIComponent(id)}/owner-proof/retry`;

/** Requests the proof now and reads the machine again; `null` for an id that is not a remote machine. */
export type OwnerProofRetry = (machineId: string) => Promise<MachineStatus | null>;

export function isOwnerProofRetryRoute(pathname: string): boolean {
  return OWNER_PROOF_RETRY_ROUTE.test(pathname);
}

/** The /ui's "Tentar agora": `POST` on the exact raw path, `Origin` equal to `http://<Host>`, our Host. */
export function ownerProofRetryFromSameOrigin(req: IncomingMessage, port: number): boolean {
  return req.method === 'POST' && RAW_PATH.test(req.url ?? '') && fromOwnUi(req, port);
}

export async function respondOwnerProofRetry(req: IncomingMessage, res: ServerResponse, url: URL, retry: OwnerProofRetry): Promise<void> {
  // The body is never read; drained so the connection stays usable.
  req.resume();
  if (req.method !== 'POST') return send(res, 405, { error: 'use o método POST' });
  const id = OWNER_PROOF_RETRY_ROUTE.exec(url.pathname)?.[1] ?? '';
  const unknown = { error: 'máquina desconhecida', reason: 'unknown' };
  if (!MACHINE_ID.test(id) || id === LOCAL_MACHINE_ID) return send(res, 404, unknown);
  const status = await retry(id);
  if (!status) return send(res, 404, unknown);
  send(res, 200, { machine: { id, state: status.state, reason: status.reason } });
}
