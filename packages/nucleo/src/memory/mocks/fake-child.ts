// A fake child process for the memory module's tests: nothing real is spawned (#727).

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';

/** What a test sees of one spawn call (#727). */
export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: FakeChild;
}

/** A child with piped stdout and stderr; the test drives its output and its close (#727). */
export class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  /** What the child reads: the JSON-RPC lines the client writes are captured here (#734). */
  stdin = new PassThrough();
  written = '';
  stdinEnded = false;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.written += chunk.toString('utf8');
    });
    this.stdin.on('finish', () => {
      this.stdinEnded = true;
    });
  }

  /** The JSON-RPC messages written to stdin so far, one per line (#734). */
  sent(): Record<string, unknown>[] {
    return this.written
      .split('\n')
      .filter(Boolean)
      .map((line): Record<string, unknown> => {
        const message: unknown = JSON.parse(line);
        return typeof message === 'object' && message !== null ? Object.fromEntries(Object.entries(message)) : {};
      });
  }

  /** Writes one JSON-RPC line to stdout (#734). */
  say(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  /** Writes a raw line to stdout, for a line that is not JSON (#734). */
  sayRaw(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  /** Writes to stdout and closes the child with `code` (#727). */
  finish(code: number | null, stdout = '', stderr = ''): void {
    if (stdout) this.stdout.write(stdout);
    if (stderr) this.stderr.write(stderr);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, null));
  }
}

/** A spawn double that records each call and hands back a fake child (#727). */
export function fakeSpawn(): { spawn: (command: string, args: readonly string[], options: SpawnOptions) => never; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptions): never => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    return child as never;
  };
  return { spawn, calls };
}

/** Lets the queue and the event loop move one turn (#727). */
export const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
