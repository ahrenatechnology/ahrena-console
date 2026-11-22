// PUT /api/cpu-governor (#723, epic #720): turns the CPU governor on or off.
// #723: a strict write (STRICT_WRITE_ROUTES, connections-route.ts), accepted only from the /ui itself; the caller already ran `strictWriteRefusal`.
// #723: turning it off stops it touching new processes and takes `taskpolicy -b` off the pids it set; the nice it raised stays.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import type { CpuGovernor } from '../cpu-governor/governor.ts';
import { CPU_GOVERNOR_ROUTE, readJsonBody } from './connections-route.ts';

export { CPU_GOVERNOR_ROUTE };

export async function respondCpuGovernor(req: IncomingMessage, res: ServerResponse, governor: CpuGovernor | null): Promise<void> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    if (body.error === 'too-large') {
      res.setHeader('connection', 'close');
      res.on('finish', () => req.destroy());
      return send(res, 413, { error: 'too-large' });
    }
    return send(res, 400, { error: 'invalid' });
  }
  const enabled: unknown = typeof body.value === 'object' && body.value !== null && 'enabled' in body.value ? body.value.enabled : undefined;
  if (typeof enabled !== 'boolean') return send(res, 400, { error: 'invalid' });
  if (!governor) return send(res, 503, { error: 'off' });
  await governor.setEnabled(enabled);
  send(res, 200, { cpuGovernor: governor.state() });
}
