import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { readJsonBody, strictWriteRefusal } from './connections-route.ts';
import { RUNTIME_OPERATIONS, RuntimeError, type RuntimeCommand, type RuntimeOperation } from '../runtime/contracts.ts';
import { ManagedRuntime, RuntimeBlockedError } from '../runtime/service.ts';

export function isRuntimeRoute(path: string): boolean { return path === '/api/runtime' || path.startsWith('/api/runtime/'); }
function parseCommand(value: unknown): { sessionId: string; runId: string | null; command: RuntimeCommand } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError('invalid_command');
  const body = value as Record<string, unknown>;
  const operation = body.operation as RuntimeOperation;
  const allowed = ['sessionId', 'operation', ...(operation === 'start' ? [] : ['runId']),
    ...(operation === 'send' ? ['message'] : operation === 'respond' ? ['requestId', 'response'] : [])];
  if (Object.keys(body).some(key => !allowed.includes(key)) || !RUNTIME_OPERATIONS.includes(operation) ||
      typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 256 ||
      (operation !== 'start' && (typeof body.runId !== 'string' || !body.runId || body.runId.length > 256))) throw new RuntimeError('invalid_command');
  let command: RuntimeCommand;
  if (operation === 'send') {
    if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 4096) throw new RuntimeError('invalid_command');
    command = { operation, message: body.message };
  } else if (operation === 'respond') {
    const response = body.response as Record<string, unknown> | null;
    if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 256 || !response || typeof response !== 'object' || Array.isArray(response)) throw new RuntimeError('invalid_command');
    if (response.kind === 'approval' && Object.keys(response).length === 2 && ['approve', 'deny'].includes(response.decision as string)) {
      command = { operation, requestId: body.requestId, response: { kind: 'approval', decision: response.decision as 'approve' | 'deny' } };
    } else if (response.kind === 'question' && Object.keys(response).length === 2 && typeof response.answer === 'string' && response.answer.trim() && response.answer.length <= 4096) {
      command = { operation, requestId: body.requestId, response: { kind: 'question', answer: response.answer } };
    } else throw new RuntimeError('invalid_command');
  } else command = { operation };
  return { sessionId: body.sessionId, runId: operation === 'start' ? null : body.runId as string, command };
}
/** Called only after #302's owner guard. Owner lease is checked again after asynchronous work. */
export async function respondRuntime(req: IncomingMessage, res: ServerResponse, url: URL, port: number,
  runtime: ManagedRuntime | undefined, ownerValid: () => boolean): Promise<void> {
  try {
    if (!runtime) { req.resume(); return send(res, 503, { error: 'Runtime indisponível.' }); }
    if (req.method === 'GET' && url.pathname === '/api/runtime') {
      const id = url.searchParams.get('sessionId');
      if (!id || id.length > 256) return send(res, 400, { error: 'Sessão inválida.' });
      return send(res, 200, await runtime.discover(id));
    }
    if (url.pathname !== '/api/runtime/commands') { req.resume(); return send(res, 404, { error: 'Rota não encontrada.' }); }
    const refusal = strictWriteRefusal(req, port, url.pathname);
    if (refusal) { req.resume(); return send(res, refusal.status, refusal.body); }
    const body = await readJsonBody(req);
    if (!body.ok) return send(res, body.error === 'too-large' ? 413 : 400, { error: 'Comando inválido.' });
    const { sessionId, runId, command } = parseCommand(body.value);
    await runtime.execute(sessionId, command, runId, ownerValid);
  } catch (error) {
    if (error instanceof RuntimeBlockedError) return send(res, 409, { error: error.message, code: 'billing_refused', runId: error.runId, admission: error.admission });
    if (error instanceof RuntimeError) return send(res, error.code === 'owner_required' ? 403 : error.code === 'invalid_command' ? 400 : 409, { error: error.message, code: error.code });
    throw error;
  }
}
