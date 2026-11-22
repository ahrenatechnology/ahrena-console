// The probe of the embedded ai-memory (#726, decision 0014): absolute bundle path, no shell, 5 s, no login PATH.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catalogEntry } from './catalog.ts';
import { probeTool, type ProbeContext } from './probe.ts';
import { PROBE_TIMEOUT_MS, type RunResult, type ToolRunner } from './runner.ts';

const EMBEDDED = '/Applications/Ahrena Console.app/Contents/Resources/ai-memory/ai-memory';
const entry = catalogEntry('ai-memory')!;

function recordingRunner(answer: () => Promise<RunResult>) {
  const calls: { argv: readonly string[]; timeoutMs: number | undefined }[] = [];
  const run = (async (argv: readonly string[], opts?: { timeoutMs?: number }) => {
    calls.push({ argv: [...argv], timeoutMs: opts?.timeoutMs });
    return answer();
  }) as ToolRunner;
  return { run, calls };
}

const ok = (stdout: string): (() => Promise<RunResult>) => async () => ({ code: 0, stdout, stderr: '', error: null });

function context(run: ToolRunner, embeddedPath: string | null, lookups: string[] = []): ProbeContext {
  return {
    platform: 'darwin',
    arch: 'arm64',
    home: '/Users/example',
    path: '/opt/homebrew/bin:/usr/bin',
    run,
    embeddedPath: () => embeddedPath,
    isExecutable: async (p) => {
      lookups.push(p);
      return true;
    },
    realpath: async (p) => {
      lookups.push(p);
      return p;
    },
  };
}

describe('#719/AC-1 embedded ai-memory probe', () => {
  test('#719/AC-1 #726/AC-1 reads 3.5.1 from "ai-memory 3.5.1" and reports the embedded source', async () => {
    const { run } = recordingRunner(ok('ai-memory 3.5.1\n'));
    const d = await probeTool(entry, context(run, EMBEDDED));
    assert.equal(d.installed, '3.5.1');
    assert.equal(d.sourceId, 'embedded');
    assert.equal(d.binaryPath, EMBEDDED);
    assert.equal(d.probeError, null);
  });

  test('#719/AC-1 #726/AC-2 spawns the absolute path with the fixed argv and the 5 s timeout, and never consults the PATH', async () => {
    const lookups: string[] = [];
    const { run, calls } = recordingRunner(ok('ai-memory 3.5.1'));
    await probeTool(entry, context(run, EMBEDDED, lookups));
    assert.deepEqual(calls, [{ argv: [EMBEDDED, '--version'], timeoutMs: PROBE_TIMEOUT_MS }]);
    assert.equal(PROBE_TIMEOUT_MS, 5000);
    assert.deepEqual(lookups, [], 'no which, no realpath on the PATH');
  });

  test('#719/AC-1 #726/AC-2 a missing embedded binary is a failed probe, not a missing tool, and nothing runs', async () => {
    const { run, calls } = recordingRunner(ok('ai-memory 3.5.1'));
    const d = await probeTool(entry, context(run, null));
    assert.equal(d.installed, null);
    assert.equal(d.probeError, 'probe-failed');
    assert.equal(d.sourceId, 'embedded');
    assert.equal(calls.length, 0);
  });

  test('#719/AC-1 #726/AC-2 a run that fails or times out is a failed probe', async () => {
    const failing = recordingRunner(async () => ({ code: null, stdout: '', stderr: '', error: 'ETIMEDOUT' }));
    assert.equal((await probeTool(entry, context(failing.run, EMBEDDED))).probeError, 'probe-failed');
    const throwing = recordingRunner(async () => {
      throw new Error('spawn failed');
    });
    assert.equal((await probeTool(entry, context(throwing.run, EMBEDDED))).probeError, 'probe-failed');
  });

  test('#719/AC-1 #726/AC-2 a probe built without an embedded path is a failed probe', async () => {
    const { run } = recordingRunner(ok('ai-memory 3.5.1'));
    const { embeddedPath: _unused, ...withoutPath } = context(run, EMBEDDED);
    assert.equal((await probeTool(entry, withoutPath)).probeError, 'probe-failed');
  });

  test('#719/AC-1 #726/AC-2 an embedded path lookup that throws is a failed probe, not a rejection', async () => {
    const { run, calls } = recordingRunner(ok('ai-memory 3.5.1'));
    const throwing: ProbeContext = {
      ...context(run, EMBEDDED),
      embeddedPath: () => {
        throw Object.assign(new Error('too many symbolic links'), { code: 'ELOOP' });
      },
    };
    const d = await probeTool(entry, throwing);
    assert.equal(d.probeError, 'probe-failed');
    assert.equal(d.installed, null);
    assert.equal(d.sourceId, 'embedded');
    assert.equal(calls.length, 0);
  });

  test('#719/AC-1 #726/AC-2 a failed embedded path lookup logs the errno code only, never the path or the message', async () => {
    const { run } = recordingRunner(ok('ai-memory 3.5.1'));
    const lines: string[] = [];
    const throwing: ProbeContext = {
      ...context(run, EMBEDDED),
      log: (m) => lines.push(m),
      embeddedPath: () => {
        throw Object.assign(new Error('too many symbolic links: /Users/example/secret/bundle'), { code: 'ELOOP' });
      },
    };
    await probeTool(entry, throwing);
    assert.deepEqual(lines, ['tools: embedded ai-memory path not read (ELOOP)']);
  });

  test('#719/AC-1 #726/AC-2 a failed embedded path lookup without an errno code logs the code error', async () => {
    const { run } = recordingRunner(ok('ai-memory 3.5.1'));
    const lines: string[] = [];
    const throwing: ProbeContext = {
      ...context(run, EMBEDDED),
      log: (m) => lines.push(m),
      embeddedPath: () => {
        throw new Error('boom /Users/example/x');
      },
    };
    await probeTool(entry, throwing);
    assert.deepEqual(lines, ['tools: embedded ai-memory path not read (error)']);
  });
});
