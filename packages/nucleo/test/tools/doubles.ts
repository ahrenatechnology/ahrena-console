// Doubles for the Tools tests: a runner that answers from a table (and records every argv), a fake
// file system for `which` and `realpath`, and a fetch that answers from a table. Nothing runs or
// downloads anything.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { FetchText, RunResult, ToolRunner } from '../../src/tools/runner.ts';

export const HOME = '/Users/exemplo';

export type Answer = string | Partial<RunResult> | ((argv: readonly string[]) => Partial<RunResult> | string);

/** Keys are the argv joined by a space; a missing key answers ENOENT. */
export function fakeRunner(table: Record<string, Answer>): ToolRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (argv: readonly string[]) => {
    calls.push([...argv]);
    const a = table[argv.join(' ')];
    if (a === undefined) return { code: null, stdout: '', stderr: '', error: 'ENOENT' };
    const v = typeof a === 'function' ? a(argv) : a;
    if (typeof v === 'string') return { code: 0, stdout: v, stderr: '', error: null };
    return { code: 0, stdout: '', stderr: '', error: null, ...v };
  }) as ToolRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

/** `links`: path on the PATH → its realpath. Every key is an executable. */
export function fakeFs(links: Record<string, string>) {
  return {
    isExecutable: async (p: string) => p in links,
    realpath: async (p: string) => {
      if (!(p in links)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return links[p]!;
    },
  };
}

export function fakeFetch(table: Record<string, string | Error>): FetchText & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const v = table[url];
    if (v === undefined) throw new Error('ENOTFOUND');
    if (v instanceof Error) throw v;
    return v;
  }) as FetchText & { calls: string[] };
  f.calls = calls;
  return f;
}

// A fake `spawn` for the executor: nothing runs. Each call gets a `FakeChild` the test drives (write
// lines, exit) or that a `script` drives on its own; `kills` records the group signals.

export class FakeChild extends EventEmitter {
  static nextPid = 900_000;
  readonly pid = FakeChild.nextPid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exited = false;
  out(text: string): void {
    this.stdout.write(text);
  }
  err(text: string): void {
    this.stderr.write(text);
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    setImmediate(() => this.emit('close', code, signal));
  }
  kill(): boolean {
    return true;
  }
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
  child: FakeChild;
}

export function fakeSpawn(script?: (call: SpawnCall) => void) {
  const calls: SpawnCall[] = [];
  const kills: { pid: number; signal: NodeJS.Signals }[] = [];
  let active = 0;
  let maxActive = 0;
  const spawn = (command: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild();
    const call = { command, args: [...args], options, child };
    calls.push(call);
    active++;
    maxActive = Math.max(maxActive, active);
    child.once('exit', () => active--);
    if (script) setImmediate(() => script(call));
    return child as unknown as ChildProcess;
  };
  const killGroup = (pid: number, signal: NodeJS.Signals) => {
    kills.push({ pid, signal });
    const call = calls.find((c) => c.child.pid === pid);
    if (signal === 'SIGKILL') call?.child.exit(null, 'SIGKILL');
  };
  return { spawn, killGroup, calls, kills, maxActive: () => maxActive };
}
