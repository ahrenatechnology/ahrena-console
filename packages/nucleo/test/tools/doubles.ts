// Doubles for the Tools tests: a runner that answers from a table (and records every argv), a fake
// file system for `which` and `realpath`, and a fetch that answers from a table. Nothing runs or
// downloads anything.
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
