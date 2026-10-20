// MCP HTTP transport ("Streamable HTTP" without a session), mounted at `/mcp` on the local API port.
//
// - `POST /mcp` with a JSON-RPC message (or a batch): answer in `application/json`, no SSE.
//   Only notifications → 202 with no body.
// - `GET /mcp` → 405: the server opens no stream to the client (the spec allows it). Whoever wants
//   to wait for a change calls the long-polling tool (2.4), which answers in the POST itself.
// - `DELETE /mcp` → 405: stateless, there is no `Mcp-Session-Id` to end.
// - `MCP-Protocol-Version` (2025-06-18 on) with a version we do not know → 400. Without the
//   header, any goes (it is what the spec says to assume for a 2025-03-26 client).
//
// `Origin` and `Host` are checked before, by the API server (decision 0003): it is the defence
// against DNS rebinding the spec asks for.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, send } from '../ingest/hooks/receiver.ts';
import { RPC_ERRORS, rpcError, PROTOCOL_VERSIONS, type McpServer } from './protocol.ts';

export const MCP_PATH = '/mcp';

export type McpRoute = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createMcpRoute(server: McpServer): McpRoute {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return send(res, 405, rpcError(null, RPC_ERRORS.invalidRequest, 'use POST: este servidor MCP não abre stream nem guarda sessão'));
    }
    const version = header(req, 'mcp-protocol-version');
    if (version && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      return send(res, 400, rpcError(null, RPC_ERRORS.invalidRequest, `MCP-Protocol-Version não suportada: ${version}`));
    }
    const contentType = header(req, 'content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) return send(res, 415, rpcError(null, RPC_ERRORS.invalidRequest, 'use Content-Type: application/json'));

    let body: string;
    try {
      body = await readBody(req);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 400;
      return send(res, status, rpcError(null, RPC_ERRORS.invalidRequest, (e as Error).message));
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return send(res, 400, rpcError(null, RPC_ERRORS.parse, 'JSON inválido'));
    }

    // The long call (long polling) stops when the client closes the connection.
    const gaveUp = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) gaveUp.abort();
    });
    const response = await server.handle(message, { signal: gaveUp.signal, version });
    if (gaveUp.signal.aborted) return;
    if (response === null) {
      res.writeHead(202).end();
      return;
    }
    send(res, 200, response);
  };
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : null;
}
