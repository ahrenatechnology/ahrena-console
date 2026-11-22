/*
 * The stdio JSON-RPC (MCP) client of `ai-memory mcp-bridge --no-session-id` (#734). What it guarantees:
 * - The binary is the embedded one, by absolute path, never a PATH lookup; with none (null) it reports
 *   `unavailable` and spawns nothing. The argv is a constant, plus a `--data-dir` only when a test injects one; absent, ai-memory uses its default folder (#734/AC-1, #735).
 * - `spawn(path, args, { shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })`: its own process group,
 *   and the child environment is the embedded binary's allowlist (`embeddedAiMemoryEnv`): no AI_MEMORY_* variable
 *   and no credential reaches it. The bridge authenticates by itself; the core never reads or passes the token
 *   (#719/AC-10, #734/AC-4).
 * - One call is one closed lifecycle: initialize, notifications/initialized, tools/call, then stdin ends and the
 *   child exits. Calls run one at a time, in order. The timeout, SIGTERM to the group and SIGKILL after the grace,
 *   is the runner's, and so is the close() refusal (#734/AC-1).
 * - stdout is newline-delimited JSON-RPC, bounded; a line that is not JSON, or whose id is not the one asked, is a
 *   failed read. Stderr is drained and dropped: never read, logged or returned (#719/AC-11).
 * - A JSON-RPC error never leaves with its message: only its code, and whether the message is the one the caller
 *   expected. The log line names the tool and the result kind, never a payload, an error's text or a path (#734).
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { embeddedAiMemoryEnv } from '../tools/embedded-ai-memory.ts';
import { defaultKillGroup, MEMORY_KILL_GRACE_MS, MEMORY_MAX_STDOUT_BYTES, MEMORY_TIMEOUT_MS, type MemoryRunnerOptions } from './runner.ts';

/** How one bridge call ended; nothing in it carries stderr, an error's text or a path (#734). */
export type MemoryBridgeResult =
  | { kind: 'unavailable' }
  | { kind: 'ok'; text: string }
  | { kind: 'rpc-error'; code: number; expected: boolean }
  | { kind: 'timeout' }
  | { kind: 'failed'; reason: 'spawn' | 'exit' | 'protocol' | 'output-too-large' | 'tool-error' | 'closed' };

/** What a caller may ask of one call (#734). */
export interface MemoryBridgeCallOptions {
  /** The exact message of the JSON-RPC error that means "expected"; the error's message itself is never returned (#734/AC-3). */
  expectedErrorMessage?: string;
  /** Drop the text of a successful result: the caller only needs to know it succeeded (#734/AC-3). */
  discardResult?: boolean;
}

/** The bridge as the memory module uses it (#734). */
export interface MemoryBridge {
  /** False when there is no embedded binary (#734). */
  readonly available: boolean;
  call(tool: string, args: Record<string, unknown>, options?: MemoryBridgeCallOptions): Promise<MemoryBridgeResult>;
  /** Refuses queued and future calls and ends the running group; resolves when the queue is empty (#734). */
  close(): Promise<void>;
}

// The optional `--data-dir` (tests only, #735) comes first, then the bridge command, in the session-less mode (#734).
const BRIDGE_ARGS = ['mcp-bridge', '--no-session-id'] as const;
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'ahrena-console', version: '0' };
const CLOSED: MemoryBridgeResult = { kind: 'failed', reason: 'closed' };
const PROTOCOL: MemoryBridgeResult = { kind: 'failed', reason: 'protocol' };

type Message = Record<string, unknown>;

const isRecord = (value: unknown): value is Message => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The text blocks of a tool result, joined; nothing else of the result is read (#734). */
function textOf(result: Message): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks.flatMap((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n');
}

export function createMemoryBridge(options: MemoryRunnerOptions): MemoryBridge {
  const { binaryPath, dataDir } = options;
  if (dataDir !== undefined && !isAbsolute(dataDir)) throw new TypeError('memory data dir must be absolute');
  if (binaryPath !== null && !isAbsolute(binaryPath)) throw new TypeError('memory binary path must be absolute');
  const spawn = options.spawn ?? nodeSpawn;
  const killGroup = options.killGroup ?? defaultKillGroup;
  const timeoutMs = options.timeoutMs ?? MEMORY_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? MEMORY_KILL_GRACE_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? MEMORY_MAX_STDOUT_BYTES;
  const log = options.log;
  const childEnv = embeddedAiMemoryEnv(options.env);
  let tail: Promise<unknown> = Promise.resolve();
  let closing = false;
  let stopRunning: (() => void) | null = null;

  function execute(binary: string, tool: string, args: Record<string, unknown>, callOptions: MemoryBridgeCallOptions): Promise<MemoryBridgeResult> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(binary, [...(dataDir === undefined ? [] : ['--data-dir', dataDir]), ...BRIDGE_ARGS], { shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv, windowsHide: true });
      } catch {
        log?.(`memory: bridge ${tool} failed spawn`);
        return resolve({ kind: 'failed', reason: 'spawn' });
      }
      const decoder = new StringDecoder('utf8');
      let buffer = '';
      let size = 0;
      let awaiting: 1 | 2 = 1;
      let decided: MemoryBridgeResult | null = null;
      let terminating = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let grace: ReturnType<typeof setTimeout> | null = null;
      let killer: ReturnType<typeof setTimeout> | null = null;

      // After a terminate the killer stays armed, so SIGKILL reaches the group even when the leader closes first (#734).
      const settle = (result: MemoryBridgeResult, keepKiller = false): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (grace) clearTimeout(grace);
        if (killer && !keepKiller) clearTimeout(killer);
        if (result.kind === 'timeout') log?.(`memory: bridge ${tool} timeout`);
        if (result.kind === 'failed') log?.(`memory: bridge ${tool} failed ${result.reason}`);
        if (result.kind === 'rpc-error') log?.(`memory: bridge ${tool} rpc-error ${result.code}`);
        stopRunning = null;
        resolve(result);
      };
      const terminate = (): void => {
        if (terminating) return;
        terminating = true;
        if (grace) clearTimeout(grace);
        if (child.pid !== undefined) killGroup(child.pid, 'SIGTERM');
        killer = setTimeout(() => {
          if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
          settle(decided ?? CLOSED);
        }, killGraceMs);
      };
      // A failure ends the group at once; a clean answer ends stdin and waits for the child to exit by itself, up to the grace (#734/AC-1).
      const fail = (why: MemoryBridgeResult): void => {
        if (decided) return;
        decided = why;
        if (timer) clearTimeout(timer);
        terminate();
      };
      const answer = (result: MemoryBridgeResult): void => {
        if (decided) return;
        decided = result;
        if (timer) clearTimeout(timer);
        child.stdin?.end();
        grace = setTimeout(terminate, killGraceMs);
      };
      const send = (message: Message): void => {
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      };

      const onResult = (message: Message): void => {
        if (awaiting === 1) {
          if (!isRecord(message.result)) return fail(PROTOCOL);
          awaiting = 2;
          send({ method: 'notifications/initialized' });
          return send({ id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
        }
        if (!isRecord(message.result)) return fail(PROTOCOL);
        if (message.result.isError === true) return answer({ kind: 'failed', reason: 'tool-error' });
        answer({ kind: 'ok', text: callOptions.discardResult ? '' : textOf(message.result) });
      };
      const onLine = (line: string): void => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return fail(PROTOCOL);
        }
        if (!isRecord(message)) return fail(PROTOCOL);
        if (message.id === undefined && typeof message.method === 'string') return;
        if (message.id !== awaiting) return fail(PROTOCOL);
        if (!('error' in message)) return onResult(message);
        const error = message.error;
        if (awaiting === 1 || !isRecord(error) || typeof error.code !== 'number') return fail(PROTOCOL);
        answer({ kind: 'rpc-error', code: error.code, expected: callOptions.expectedErrorMessage !== undefined && error.message === callOptions.expectedErrorMessage });
      };

      timer = setTimeout(() => fail({ kind: 'timeout' }), timeoutMs);
      stopRunning = () => fail(CLOSED);
      child.stdin?.on('error', () => {
        // The child closed its stdin first; its exit is what decides the call (#734).
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (decided) return;
        size += chunk.length;
        if (size > maxStdoutBytes) return fail({ kind: 'failed', reason: 'output-too-large' });
        buffer += decoder.write(chunk);
        for (let end = buffer.indexOf('\n'); end >= 0 && !decided; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (line) onLine(line);
        }
      });
      // Stderr is drained so the child never blocks on it, and never read (#719/AC-11, #734).
      child.stderr?.on('data', () => {});
      child.on('error', () => settle(decided ?? { kind: 'failed', reason: 'spawn' }, terminating));
      child.on('close', () => settle(decided ?? { kind: 'failed', reason: 'exit' }, terminating));
      send({ id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } });
    });
  }

  return {
    available: binaryPath !== null,
    call(tool, args, callOptions = {}) {
      if (binaryPath === null) return Promise.resolve({ kind: 'unavailable' });
      if (closing) return Promise.resolve(CLOSED);
      const result = tail.then((): Promise<MemoryBridgeResult> => (closing ? Promise.resolve(CLOSED) : execute(binaryPath, tool, args, callOptions)));
      tail = result.catch(() => undefined);
      return result;
    },
    async close() {
      closing = true;
      stopRunning?.();
      await tail;
    },
  };
}
