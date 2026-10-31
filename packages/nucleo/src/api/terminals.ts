// The terminal sessions' action route (#350, decisions 0013 and 0014 section 4).
//
// - `POST /api/terminals/<id>/actions/<action>` `{ pid, machine?, confirm? }`: `<id>` is `pts-0` or
//   `ttys003`; `<action>` is `interrupt`, `terminate`, `kill`, `hangup` or `end`
//   (src/telemetry/terminal-actions.ts); `pid` is the process the screen showed (the foreground group
//   leader for the first three, the connection's `sshd` or the shell for the last two); `machine`
//   defaults to `local`; `kill` needs `confirm: true`, the screen's second confirmation.
//   200 `{ result: 'sent', action, signal, pid, target }`; 404 unknown machine or terminal; 403
//   `{ error, reason }` for a process that is never signaled (`tunnel`, `core`, `other-user`); 409
//   `{ error, reason }` when the pid is no longer that terminal's (`changed`), the read failed
//   (`unreadable`) or `kill` came without `confirm`; 502 when the remote does not answer.
// - Reading needs no route: the sessions are in the machine's telemetry reading (`terminals`).
//
// Like the Tools writes, the gate is stricter than the server's usual one: `Origin` exactly
// `http://<Host>`, Host loopback, the exact raw path; a request with NO `Origin` is 403 unless
// `--accept-remote-actions` is on (the tunnel from the Mac). JSON only, capped.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../ingest/hooks/receiver.ts';
import { MACHINE_ID } from '../telemetry/model.ts';
import { isTerminalAction, type TerminalControl } from '../telemetry/terminal-actions.ts';
import { TERMINAL_ID } from '../telemetry/terminals.ts';

const WRITE_RAW_PATH = /^\/api\/terminals\/(?:pts-\d{1,6}|ttys\d{1,4})\/actions\/(?:interrupt|terminate|kill|hangup|end)$/;
const ACTION_ROUTE = /^\/api\/terminals\/([^/]+)\/actions\/([^/]+)$/;
const MAX_BODY = 1024;

export function isTerminalsRoute(pathname: string): boolean {
  return pathname === '/api/terminals' || pathname.startsWith('/api/terminals/');
}

/** Same-origin gate of the writes; no Origin passes only when `acceptNoOrigin`. */
export function terminalsWriteAllowed(req: IncomingMessage, port: number, acceptNoOrigin = false): boolean {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  if (req.method !== 'POST' || !WRITE_RAW_PATH.test(req.url ?? '')) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return acceptNoOrigin;
  return origin === `http://${host}`;
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      if (tooLarge) return;
      body += c;
      if (body.length > MAX_BODY) tooLarge = true;
    });
    req.on('end', () => resolve(tooLarge ? null : body));
    req.on('error', () => resolve(null));
  });
}

const NO_TERMINALS = { error: 'o núcleo subiu sem a telemetria' };

/** Reached only after `terminalsWriteAllowed`. */
export async function respondTerminalsWrite(req: IncomingMessage, res: ServerResponse, url: URL, control: TerminalControl | null | undefined): Promise<void> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    req.resume();
    return send(res, 415, { error: 'use application/json' });
  }
  const text = await readBody(req);
  if (text === null) return send(res, 413, { error: 'corpo grande demais' });
  if (!control) return send(res, 404, NO_TERMINALS);
  const m = ACTION_ROUTE.exec(url.pathname);
  if (!m || !TERMINAL_ID.test(m[1]!) || !isTerminalAction(m[2]!)) return send(res, 404, { error: 'ação desconhecida' });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return send(res, 400, { error: 'JSON inválido: envie um objeto' });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return send(res, 400, { error: 'JSON inválido: envie um objeto' });
  const { pid, machine = 'local', confirm = false, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return send(res, 400, { error: 'o corpo só aceita pid, machine e confirm' });
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || pid >= 2 ** 31) return send(res, 400, { error: 'pid: o número do processo mostrado na tela' });
  if (typeof machine !== 'string' || !MACHINE_ID.test(machine)) return send(res, 400, { error: 'machine inválida: letras minúsculas, números e hífen' });
  if (typeof confirm !== 'boolean') return send(res, 400, { error: 'confirm: true ou false' });

  const r = await control.act(machine, m[1]!, m[2] as never, pid, confirm);
  switch (r.kind) {
    case 'sent':
      return send(res, 200, { result: 'sent', action: r.action, signal: r.signal, pid: r.pid, target: r.target });
    case 'unknown-machine':
      return send(res, 404, { error: `máquina desconhecida: ${machine}` });
    case 'unknown-session':
      return send(res, 404, { error: 'esse terminal não existe mais', reason: 'unknown-session' });
    case 'unreadable':
      return send(res, 409, { error: 'não deu para ler os terminais; nada foi enviado', reason: 'unreadable' });
    case 'changed':
      return send(res, 409, { error: 'o processo não é mais o mesmo nesse terminal; nada foi enviado', reason: 'changed' });
    case 'confirm-required':
      return send(res, 409, { error: 'matar à força pede a segunda confirmação', reason: 'confirm-required' });
    case 'refused':
      return send(res, 403, { error: REFUSALS[r.reason], reason: r.reason });
    case 'unreachable':
      return send(res, 502, { error: 'a máquina não respondeu', reason: 'unreachable' });
    case 'relayed':
      return send(res, r.status, r.body);
  }
}

const REFUSALS = {
  tunnel: 'essa conexão leva o túnel do console; encerrá-la derrubaria a máquina',
  core: 'é o núcleo do console (ou o que o roda); pare-o pela bandeja',
  'other-user': 'é de outro usuário; o console só age nos processos do seu',
} as const;
