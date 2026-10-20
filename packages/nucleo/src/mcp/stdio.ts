// MCP stdio transport: one JSON-RPC message per line on the input, one answer per line on the
// output. Nothing but JSON goes to the output; the log goes to stderr.
//
// The handler is a function: the `McpServer` itself (tests) or the bridge to the core already
// running on 127.0.0.1 (cli.ts), which is what Claude Desktop uses. So only one process reads the database.

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { RPC_ERRORS, rpcError, type JsonRpcResponse } from './protocol.ts';

export type MessageHandler = (message: unknown) => Promise<JsonRpcResponse | JsonRpcResponse[] | null>;

export interface StdioOptions {
  handle: MessageHandler;
  input?: Readable;
  output?: Writable;
  log?: (message: string) => void;
}

/** Serves until the input closes; resolves after the last answer is written. */
export async function serveStdio({ handle, input = process.stdin, output = process.stdout, log = () => {} }: StdioOptions): Promise<void> {
  const pending = new Set<Promise<void>>();
  const write = (r: unknown) => output.write(`${JSON.stringify(r)}\n`);
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(rpcError(null, RPC_ERRORS.parse, 'JSON inválido'));
      continue;
    }
    const p = handle(message)
      .then((r) => {
        if (r !== null) write(r);
      })
      .catch((e) => log(`error: ${(e as Error).message}`))
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}

/**
 * Bridge to the core's `/mcp`: the same server, over local HTTP. With the core down,
 * `withoutCore` answers in its place (`initialize`, `ping` and `tools/list` work; `tools/call`
 * comes back with `isError` saying how to start the core), so the client does not mark the server
 * as broken just because the core has not started yet. Every request tries HTTP again.
 */
export function httpBridge(url: string, { withoutCore, fetcher = fetch }: { withoutCore: MessageHandler; fetcher?: typeof fetch }): MessageHandler {
  return async (message) => {
    let res: Response;
    try {
      res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(message),
      });
    } catch {
      return withoutCore(message);
    }
    if (res.status === 202) return null;
    const text = await res.text();
    let body: JsonRpcResponse | JsonRpcResponse[];
    try {
      body = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
    } catch {
      return errorWithId(message, `resposta inesperada do núcleo (HTTP ${res.status})`);
    }
    // The HTTP 4xx does not know the id (the body was not even read, or was not JSON-RPC): on stdio,
    // the client matches the answer by id, so it carries the request's.
    if (!Array.isArray(body) && body.id === null && body.error) return errorWithId(message, body.error.message, body.error.code);
    return body;
  };
}

function errorWithId(message: unknown, reason: string, code: number = RPC_ERRORS.internal): JsonRpcResponse | JsonRpcResponse[] | null {
  const one = (m: unknown): JsonRpcResponse | null => {
    const id = (m as { id?: unknown } | null)?.id;
    return typeof id === 'string' || typeof id === 'number' ? rpcError(id, code, reason) : null;
  };
  if (Array.isArray(message)) {
    const r = message.map(one).filter((x): x is JsonRpcResponse => x !== null);
    return r.length > 0 ? r : null;
  }
  return one(message);
}
