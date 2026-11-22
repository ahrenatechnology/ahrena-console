// (#740) A job whose steps run differently from how they are shown (a per-step env, an in-process step, a quiet output), on the Tools
// executor's queue, with a fake spawn and a fake host: nothing real runs. (#740)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { ToolsExecutor, type JobSpec, type ToolsHost } from './executor.ts';
import { fakeOverview, fakeSpawn, type SpawnCall } from '../../test/tools/doubles.ts';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-executor-step-runs-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

const host = (): ToolsHost => ({
  overview: async () => fakeOverview(),
  check: async () => null,
  actionPlan: async () => ({ kind: 'unknown' }),
  verify: async () => null,
  invalidate: () => {},
  processEnv: async () => ({ PATH: '/usr/bin', HOST_ONLY: '1' }),
  resolveExecutable: async (name) => ({ path: name.startsWith('/') ? name : `/usr/bin/${name}`, realPath: name.startsWith('/') ? name : `/usr/bin/${name}` }),
});

function boot(script: (call: SpawnCall) => void) {
  const sp = fakeSpawn(script);
  const logFile = join(dir, `tools-${++n}.log`);
  const executor = new ToolsExecutor({ service: host(), logFile, spawn: sp.spawn, killGroup: sp.killGroup, cwd: '/Users/exemplo', killGraceMs: 10, log: () => {} });
  return { executor, sp, logFile };
}

const spec = (over: Partial<JobSpec>): JobSpec => ({ toolId: 'ai-memory', actionId: 'activate', label: 'Ativar a memória', steps: [], timeoutSeconds: 60, targetVersion: null, ...over });

describe('#740 a job whose steps run differently from how they are shown', () => {
  test('#740/AC-7 Given a step with its own argv and env, When it runs, Then that argv and that whole env are spawned and the job shows only the display', async () => {
    const { executor, sp } = boot((call) => call.child.exit(0));
    const env = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/Users/exemplo/.claude' };
    executor.enqueue('local', spec({ steps: [['ai-memory', 'setup', '--yes']], runs: [{ argv: ['/Applications/App/ai-memory', 'setup', '--yes'], env }] }));
    await executor.idle('local');
    assert.equal(sp.calls[0]!.command, '/Applications/App/ai-memory');
    assert.deepEqual(sp.calls[0]!.args, ['setup', '--yes']);
    assert.deepEqual(sp.calls[0]!.options.env, env);
    const job = executor.jobs('local').recent[0]!;
    assert.deepEqual(job.steps, [['ai-memory', 'setup', '--yes']]);
    assert.equal(JSON.stringify(job).includes('/Applications/App'), false, 'the real path is not in the job');
    assert.equal(job.state, 'succeeded');
  });

  test('#740/AC-2 Given an in-process step between two commands, When the job runs, Then it runs in its place, spawns nothing and the order holds', async () => {
    const order: string[] = [];
    const { executor, sp } = boot((call) => {
      order.push(`spawn ${call.args[0]}`);
      call.child.exit(0);
    });
    executor.enqueue(
      'local',
      spec({
        steps: [['ai-memory', 'one'], ['core', 'write'], ['ai-memory', 'three']],
        runs: [null, { inline: async () => (order.push('inline'), 0) }, null],
      }),
    );
    await executor.idle('local');
    assert.deepEqual(order, ['spawn one', 'inline', 'spawn three']);
    assert.equal(sp.calls.length, 2);
    assert.equal(executor.jobs('local').recent[0]!.state, 'succeeded');
  });

  test('#740/AC-3 Given a step that fails, When the job runs, Then the sequence stops, the later steps never run and the job names the step and the exit code', async () => {
    const { executor, sp } = boot((call) => call.child.exit(call.args[0] === 'two' ? 7 : 0));
    executor.enqueue('local', spec({ steps: [['ai-memory', 'one'], ['ai-memory', 'two'], ['ai-memory', 'three']], quiet: true }));
    await executor.idle('local');
    assert.equal(sp.calls.length, 2, 'step three never ran');
    const job = executor.jobs('local').recent[0]!;
    assert.equal(job.state, 'failed');
    assert.equal(job.exitCode, 7);
    assert.equal(job.step, 1);
    assert.ok(job.output.includes('Falhou no passo 2 de 3 (saída 7).'), job.output.join('|'));
  });

  test('#740/AC-3 Given a failing step that carries an account name, When the job runs, Then the failure line names the account, the step and the exit code', async () => {
    const { executor } = boot((call) => call.child.exit(call.args[0] === 'two' ? 7 : 0));
    executor.enqueue('local', spec({ steps: [['ai-memory', 'one'], ['ai-memory', 'two']], runs: [null, { account: 'conta Trabalho' }], quiet: true }));
    await executor.idle('local');
    const job = executor.jobs('local').recent[0]!;
    assert.ok(job.output.includes('Falhou no passo 2 de 2 (conta Trabalho, saída 7).'), job.output.join('|'));
  });

  test('#740/AC-2 Given an in-process step that fails, Then the job fails there and the next step does not run', async () => {
    const { executor, sp } = boot((call) => call.child.exit(0));
    executor.enqueue('local', spec({ steps: [['core', 'write'], ['ai-memory', 'next']], runs: [{ inline: async (line) => (line('Não deu para gravar'), 1) }, null], quiet: true }));
    await executor.idle('local');
    assert.equal(sp.calls.length, 0);
    const job = executor.jobs('local').recent[0]!;
    assert.equal(job.state, 'failed');
    assert.equal(job.exitCode, 1);
    assert.ok(job.output.includes('Não deu para gravar'), `the failing step's own reason is kept: ${job.output.join('|')}`);
  });

  test('#740/AC-5 Given a quiet job, When a process prints a path or a secret, Then neither the job nor tools.log keeps the output', async () => {
    const { executor, logFile } = boot((call) => {
      call.child.out('wrote /Users/exemplo/.local/share/ai-memory/config.toml token=fake-token-0000-not-real\n');
      call.child.err('stderr /Users/exemplo/secret\n');
      call.child.exit(0);
    });
    executor.enqueue('local', spec({ steps: [['ai-memory', 'setup']], quiet: true }));
    await executor.idle('local');
    const job = executor.jobs('local').recent[0]!;
    assert.deepEqual(job.output, ['$ ai-memory setup']);
    const log = readFileSync(logFile, 'utf8');
    assert.equal(log.includes('/Users/exemplo'), false);
    assert.equal(log.includes('fake-token'), false);
  });

  test('#740/AC-3 Given a step that exceeds its timeout, Then the job is timed-out and the later steps never run', async () => {
    const { executor, sp } = boot(() => {});
    executor.enqueue('local', spec({ steps: [['ai-memory', 'slow'], ['ai-memory', 'after']], timeoutSeconds: 0.05, quiet: true }));
    await executor.idle('local');
    const job = executor.jobs('local').recent[0]!;
    assert.equal(job.state, 'timed-out');
    assert.equal(sp.calls.length, 1);
    assert.ok(job.output.some((l) => l.startsWith('Passou do tempo limite')), `the executor's timeout line is kept: ${job.output.join('|')}`);
  });

  test('#740/AC-4 Given a step with sudo as its real argv, When the job runs, Then it is refused before anything is spawned', async () => {
    const { executor, sp } = boot((call) => call.child.exit(0));
    executor.enqueue('local', spec({ steps: [['ai-memory', 'ok']], runs: [{ argv: ['/usr/bin/sudo', 'ai-memory'] }] }));
    await executor.idle('local');
    assert.equal(sp.calls.length, 0);
    assert.equal(executor.jobs('local').recent[0]!.state, 'failed');
  });
});
