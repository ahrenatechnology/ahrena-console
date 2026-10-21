// `Inbox` over the session's Unix socket (#61). Claude Code's cross-session inbox takes one line of
// stream-json per message: `{"type":"user","message":{"role":"user","content":"<text>"}}\n`. The
// socket is documented, this line format is not (measured on CLI 2.1.302): the contract test in
// test/messaging/contract-cli.test.ts checks it against the real CLI.
//
// The socket writes nothing back, not even for an invalid line: "written" only means the line left
// for the kernel and the connection ended. No auth line is sent (optional outside Windows): the
// core never reads the `.key` file. A failure carries a reason code, never the text.

import { connect as netConnect, type Socket } from 'node:net';
import type { DeliveryFailure } from '../model.ts';
import type { DeliveryResult, Inbox } from '../ports.ts';

/** The one line the inbox reads for a user message. `JSON.stringify` escapes the newlines of the text. */
export function inboxLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

export interface SocketInboxOptions {
  /** Connect and flush must finish in this time. Default 2 s. */
  timeoutMs?: number;
  /** For the tests: opens the connection. */
  connect?: (path: string) => Socket;
}

function failureOf(err: NodeJS.ErrnoException): DeliveryFailure {
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return 'socket_gone';
  if (err.code === 'ECONNREFUSED') return 'connection_refused';
  return 'socket_error';
}

export class SocketInbox implements Inbox {
  private readonly timeoutMs: number;
  private readonly connect: (path: string) => Socket;

  constructor({ timeoutMs = 2000, connect = (path) => netConnect(path) }: SocketInboxOptions = {}) {
    this.timeoutMs = timeoutMs;
    this.connect = connect;
  }

  deliver(socketPath: string, text: string): Promise<DeliveryResult> {
    return new Promise((resolve) => {
      let done = false;
      let socket: Socket;
      const finish = (r: DeliveryResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket?.destroy();
        resolve(r);
      };
      let written = false;
      // Past the timeout, a line already flushed counts as written: the session may just be slow to close.
      const timer = setTimeout(() => finish(written ? { ok: true } : { ok: false, reason: 'timeout' }), this.timeoutMs);
      try {
        socket = this.connect(socketPath);
      } catch (e) {
        return finish({ ok: false, reason: failureOf(e as NodeJS.ErrnoException) });
      }
      socket.on('error', (e: NodeJS.ErrnoException) => finish(written ? { ok: true } : { ok: false, reason: failureOf(e) }));
      socket.once('connect', () => {
        // `end` with the data: the callback runs once the line is flushed and the write side ends.
        socket.end(inboxLine(text), () => {
          written = true;
        });
      });
      // Wait for the session to close its side instead of dropping the connection at once: Claude
      // Code reads the writer's pid from the connection (LOCAL_PEERPID / SO_PEERCRED, the
      // `verifiedPeerPid` the confirmation matches), which a connection already gone does not give.
      socket.once('close', () => finish(written ? { ok: true } : { ok: false, reason: 'socket_error' }));
    });
  }
}
