// The memory actions on the Tools executor's queue (#740): the plan, the digest, the order of the steps, the refusals. A real
// executor over a fake spawn, a fake memory module and temporary folders: nothing real runs, and no ai-memory, launchctl or brew is (#740)
// ever started. (#740)
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createMemoryActions, MEMORY_ACTIONS, type MemoryActionId, type MemoryActions, type MemoryNotOffered } from './actions.ts';
import { ACCOUNT_A, ACCOUNT_B, BINARY, harness, LABEL, type Harness } from './mocks/actions-harness.ts';
import { createMemoryActionFiles } from '../tools/memory-config-file.ts';

async function planOf(actions: MemoryActions, id: MemoryActionId) {
  const r = await actions.plan(id);
  assert.equal(r.kind, 'plan', JSON.stringify(r));
  return r.kind === 'plan' ? r.plan : (undefined as never);
}

async function confirmed(h: Harness, id: MemoryActionId, acknowledged = false) {
  const plan = await planOf(h.actions, id);
  const r = await h.actions.act(id, plan.planDigest, acknowledged);
  await h.executor.idle('local');
  return { plan, result: r, job: h.executor.jobs('local').recent[0]! };
}

async function refusal(h: Harness, id: MemoryActionId): Promise<MemoryNotOffered> {
  const r = await h.actions.plan(id);
  assert.equal(r.kind, 'not-offered', JSON.stringify(r));
  return r.kind === 'not-offered' ? r.reason : (undefined as never);
}

describe('#740/AC-1 the activate plan', () => {
  test('#740/AC-1 Given two registered account folders and ai-memory not active, When the plan is asked, Then it lists one setup --plan per folder, the service, the steps in order and a planDigest, and nothing is written or run', async () => {
    const h = harness();
    const plan = await planOf(h.actions, 'activate');
    assert.deepEqual(h.planned, [h.a, h.b], 'one setup --plan read per registered folder');
    assert.deepEqual(plan.accounts.map((x) => x.dir), [h.a, h.b]);
    assert.equal(plan.accounts[0]!.setup.agents[0]!.agent, 'claude-code');
    assert.deepEqual(plan.service, { action: 'install', manager: 'launchd' });
    assert.equal(plan.dataDir, h.data);
    assert.deepEqual(
      plan.steps.map((s) => [s.display.join(' '), s.account]),
      [
        ['ai-memory init', null],
        ['core write-config embedding_provider=none', null],
        ['ai-memory auth enable --no-mcp', null],
        ['ai-memory setup --yes --agent claude-code', 0],
        ['ai-memory setup --yes --agent claude-code', 1],
      ],
    );
    assert.match(plan.planDigest, /^[0-9a-f]{16}$/);
    assert.equal(h.sp.calls.length, 0, 'no process was started');
    assert.equal(h.executor.jobs('local').recent.length + (h.executor.jobs('local').current ? 1 : 0), 0, 'nothing was queued');
    assert.equal(JSON.stringify(plan.steps).includes('/Applications'), false, 'the steps carry no path');
  });

  test('#740/AC-1 Given the same state, When the plan is asked twice, Then the digest is the same; Given another account folder, Then it changes', async () => {
    const h = harness();
    const first = await planOf(h.actions, 'activate');
    assert.equal((await planOf(h.actions, 'activate')).planDigest, first.planDigest);
    h.state.folders = [h.a];
    assert.notEqual((await planOf(h.actions, 'activate')).planDigest, first.planDigest);
  });

  test('#740/AC-1 Given a stale planDigest, When the person confirms, Then it is stale with the new plan and nothing runs', async () => {
    const h = harness();
    const r = await h.actions.act('activate', '0123456789abcdef', false);
    assert.equal(r.kind, 'stale');
    if (r.kind === 'stale') assert.equal(r.plan.actionId, 'activate');
    assert.equal(h.sp.calls.length, 0);
    assert.equal(h.executor.jobs('local').current, null);
  });

  test('#740/AC-1 Given the server already running, When the plan is asked, Then activate is not offered', async () => {
    const h = harness({ state: { state: 'running' } });
    assert.equal(await refusal(h, 'activate'), 'already-running');
    assert.deepEqual(h.planned, []);
  });

  test('#740/AC-1 Given an unreadable setup plan of a folder, When the plan is asked, Then it is unreadable with the closed reason and nothing is queued', async () => {
    const h = harness();
    const failing = createMemoryActions({
      memory: { status: async () => ({ state: 'stopped' }), setupPlanWithLocalFor: async () => ({ ok: false, reason: 'timeout' }) },
      queue: h.executor,
      binaryPath: BINARY,
      home: h.home,
      uid: () => 501,
      accountFolders: async () => [{ dir: h.a, name: ACCOUNT_A }],
      files: createMemoryActionFiles(),
      labels: Object.fromEntries(MEMORY_ACTIONS.map((id) => [id, id])) as Record<MemoryActionId, string>,
    });
    assert.deepEqual(await failing.plan('activate'), { kind: 'unreadable', reason: 'timeout' });
  });
});

describe('#740/AC-2 #740/AC-3 the steps of activate, in order', () => {
  test('#740/AC-3 Given a confirmed plan, When the job runs, Then the steps run one at a time, in this order, with fixed argv and no shell', async () => {
    const h = harness({ files: (real, events) => ({ ...real, writeEmbeddingsOff: async () => void events.push('write-config') }) });
    const { result, job } = await confirmed(h, 'activate');
    assert.equal(result.kind, 'queued');
    assert.deepEqual(h.events, [
      'spawn init',
      'write-config',
      'spawn auth enable --no-mcp',
      'spawn setup --yes --agent claude-code',
      'spawn setup --yes --agent claude-code',
    ]);
    assert.equal(job.state, 'succeeded');
    assert.equal(h.sp.maxActive(), 1);
    for (const call of h.sp.calls) {
      assert.equal(call.command, BINARY);
      assert.equal(call.options.shell, false);
      assert.deepEqual(call.args.slice(0, 2), ['--data-dir', h.data]);
    }
  });

  test('#740/AC-7 Given a confirmed plan, When the job runs, Then CLAUDE_CONFIG_DIR is the registered folder on the setup steps only and the env is the allowlist', async () => {
    const h = harness();
    await confirmed(h, 'activate');
    const envs = h.sp.calls.map((c) => c.options.env as NodeJS.ProcessEnv);
    assert.deepEqual(envs.map((e) => e.CLAUDE_CONFIG_DIR), [undefined, undefined, h.a, h.b], 'init and auth enable carry no account');
    for (const env of envs) {
      assert.deepEqual(Object.keys(env).filter((k) => !['PATH', 'HOME', 'CLAUDE_CONFIG_DIR'].includes(k)), []);
      assert.equal(JSON.stringify(env).includes('fake-secret'), false);
    }
  });

  test('#740/AC-2 Given a config.toml with other keys and comments, When activate runs, Then embedding_provider = "none" is set and the rest is intact', async () => {
    const h = harness({ config: '# mine\nllm_provider = "ollama"\nembedding_provider = "openai"\n\n[decay]\nhalf_life_days = 30\n' });
    const { job } = await confirmed(h, 'activate');
    assert.equal(job.state, 'succeeded');
    const text = readFileSync(join(h.data, 'config.toml'), 'utf8');
    assert.equal(text, '# mine\nllm_provider = "ollama"\nembedding_provider = "none"\n\n[decay]\nhalf_life_days = 30\n');
  });

  test('#740/AC-2 Given the config.toml init writes, with embedding_provider only as a commented example, When activate runs, Then the key is a top-level key before the first table and the comment stays', async () => {
    const h = harness();
    await confirmed(h, 'activate');
    assert.equal(readFileSync(join(h.data, 'config.toml'), 'utf8'), '# embedding_provider = "local"\n\nembedding_provider = "none"\n\n[auth]\nenabled = false\n');
  });

  test('#740/AC-2 Given init runs once, When activate has two accounts, Then init is spawned once, with no account folder, and before every setup', async () => {
    const h = harness();
    await confirmed(h, 'activate');
    const inits = h.events.filter((e) => e === 'spawn init');
    assert.equal(inits.length, 1);
    assert.equal(h.events.indexOf('spawn init'), 0);
    assert.equal(h.events.some((e) => e.includes('--no-service')), false, 'no step passes --no-service');
  });

  test('#740/AC-3 Given the activate steps, Then auth enable --no-mcp is among them, after embeddings are off and before the service starts', async () => {
    const h = harness();
    const plan = await planOf(h.actions, 'activate');
    const lines = plan.steps.map((s) => s.display.join(' '));
    const auth = lines.indexOf('ai-memory auth enable --no-mcp');
    assert.ok(lines.indexOf('ai-memory init') < lines.indexOf('core write-config embedding_provider=none'));
    assert.ok(auth > lines.indexOf('core write-config embedding_provider=none'));
    assert.ok(auth < lines.indexOf('ai-memory setup --yes --agent claude-code'), 'the first setup, which starts the service, runs with auth on');
    assert.equal(lines.filter((l) => l.includes('auth enable')).length, 1);
  });

  test('#740/AC-3 Given a step that fails, When activate runs, Then the sequence stops there, the job names the step and the exit code, and nothing is rolled back', async () => {
    const h = harness({ exit: (call) => (call.args.includes('auth') ? 4 : 0) });
    const { job } = await confirmed(h, 'activate');
    assert.equal(job.state, 'failed');
    assert.equal(job.exitCode, 4);
    assert.equal(job.step, 2);
    assert.ok(job.output.includes('Falhou no passo 3 de 5 (saída 4).'), job.output.join('|'));
    assert.equal(h.sp.calls.length, 2, 'no setup ever ran');
    assert.match(readFileSync(join(h.data, 'config.toml'), 'utf8'), /^embedding_provider = "none"$/m, 'the earlier steps stay');
    h.state.current = { state: 'stopped' };
    assert.equal((await h.actions.plan('deactivate')).kind, 'plan', 'deactivate stays available');
  });

  test('#740/AC-3 Given the setup of the second account fails, When activate runs, Then the job stops there and the failing step maps to that account in the plan', async () => {
    const h = harness({ exit: (call) => (call.args.includes('setup') && (call.options.env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR === h.b ? 3 : 0) });
    const { plan, job } = await confirmed(h, 'activate');
    assert.equal(job.state, 'failed');
    assert.equal(job.exitCode, 3);
    assert.equal(job.step, 4);
    assert.equal(plan.steps[job.step]!.account, 1);
    assert.equal(plan.accounts[plan.steps[job.step]!.account!]!.dir, h.b);
    assert.ok(job.output.includes(`Falhou no passo 5 de 5 (conta ${ACCOUNT_B}, saída 3).`), job.output.join('|'));
    assert.equal(h.sp.calls.length, 4, 'init, auth enable and both setups ran; nothing after');
  });

  test('#740/AC-3 Given the setup of the first account fails, When activate runs, Then the failure line names that account by its registry name and no path is in the job', async () => {
    const h = harness({ exit: (call) => (call.args.includes('setup') ? 6 : 0) });
    const { job } = await confirmed(h, 'activate');
    assert.equal(job.step, 3);
    assert.ok(job.output.includes(`Falhou no passo 4 de 5 (conta ${ACCOUNT_A}, saída 6).`), job.output.join('|'));
    const shown = JSON.stringify(job);
    for (const path of [h.a, h.b, h.home]) assert.equal(shown.includes(path), false, 'the job carries no account folder');
  });

  test('#740/AC-3 Given the uninstall of the second account fails, When deactivate runs, Then the failure line names that account', async () => {
    const h = harness({ exit: (call) => (call.args.includes('uninstall') && (call.options.env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR === h.b ? 5 : 0) });
    const { job } = await confirmed(h, 'deactivate');
    assert.equal(job.state, 'failed');
    assert.ok(job.output.includes(`Falhou no passo 2 de 2 (conta ${ACCOUNT_B}, saída 5).`), job.output.join('|'));
  });

  test('#740/AC-3 Given init fails, When activate runs, Then the job fails at step 1 and nothing else runs', async () => {
    const h = harness({ exit: (call) => (call.args.includes('init') ? 2 : 0) });
    const { job } = await confirmed(h, 'activate');
    assert.equal(job.state, 'failed');
    assert.equal(job.step, 0);
    assert.equal(h.sp.calls.length, 1);
    assert.equal(h.events.includes('write-config'), false);
  });

  test('#740/AC-3 Given the config write fails, When activate runs, Then the job fails at that step and auth enable never runs', async () => {
    const h = harness({ files: (real) => ({ ...real, writeEmbeddingsOff: async () => Promise.reject(new Error('EACCES /Users/x/secret')) }) });
    const { job } = await confirmed(h, 'activate');
    assert.equal(job.state, 'failed');
    assert.equal(job.step, 1);
    assert.equal(h.sp.calls.length, 1, 'only init ran');
    assert.equal(JSON.stringify(job).includes('/Users/x/secret'), false, 'the error text does not reach the job');
  });

  test('#740/AC-3 Given a step that exceeds the timeout, When activate runs, Then the job is timed-out at that step and nothing after it runs', async () => {
    const h = harness({ hang: true });
    const { job } = await confirmed(h, 'activate');
    assert.equal(job.state, 'timed-out');
    assert.equal(job.step, 0);
    assert.equal(h.sp.calls.length, 1);
  });
});

describe('#740/AC-7 only a folder from the registry', () => {
  test('#740/AC-7 Given registry entries that are relative, missing or not normalized, When the plan is asked, Then only the valid folder is read and run, and no spawn carries another value', async () => {
    const h = harness({ folders: (a) => [a, 'relative/.claude', join(a, '..', 'nope'), '/Users/evil/.claude'] });
    const plan = await planOf(h.actions, 'activate');
    assert.deepEqual(plan.accounts.map((x) => x.dir), [h.a]);
    await h.actions.act('activate', plan.planDigest, false);
    await h.executor.idle('local');
    const dirs = h.sp.calls.map((c) => (c.options.env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR).filter(Boolean);
    assert.deepEqual([...new Set(dirs)], [h.a]);
  });

  test('#740/AC-7 Given a registry with no valid folder, When the plan is asked, Then activate is not offered and nothing is read', async () => {
    const h = harness({ folders: () => ['relative', '/Users/evil/.claude'] });
    assert.equal(await refusal(h, 'activate'), 'no-accounts');
    assert.deepEqual(h.planned, []);
    assert.equal(h.sp.calls.length, 0);
  });
});

describe('#740/AC-4 stop, start, deactivate and delete-data', () => {
  const SERVICE = `gui/501/${LABEL}`;

  test('#740/AC-4 Given a running server, When stop is confirmed, Then launchctl bootout of the user service runs with a fixed argv', async () => {
    const h = harness({ state: { state: 'running' } });
    const { plan, job } = await confirmed(h, 'stop');
    assert.deepEqual(plan.steps.map((s) => s.display), [['launchctl', 'bootout', SERVICE]]);
    assert.equal(h.sp.calls[0]!.command, '/bin/launchctl');
    assert.deepEqual(h.sp.calls[0]!.args, ['bootout', SERVICE]);
    assert.equal(h.sp.calls[0]!.options.shell, false);
    assert.equal(job.state, 'succeeded');
  });

  test('#740/AC-4 Given a stopped server with the service installed, When start is confirmed, Then launchctl bootstrap of the plist under the home runs', async () => {
    const h = harness({ state: { state: 'stopped' } });
    const plist = join(h.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    mkdirSync(join(h.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plist, '<plist/>');
    const { plan } = await confirmed(h, 'start');
    assert.deepEqual(plan.steps.map((s) => s.display), [['launchctl', 'bootstrap', 'gui/501', '~/Library/LaunchAgents/' + `${LABEL}.plist`]]);
    assert.equal(h.sp.calls[0]!.command, '/bin/launchctl');
    assert.deepEqual(h.sp.calls[0]!.args, ['bootstrap', 'gui/501', plist]);
  });

  test('#740/AC-4 Given the service is not installed, a server that is not in the right state or a platform without launchd, Then stop and start are not offered', async () => {
    assert.equal(await refusal(harness({ state: { state: 'stopped' } }), 'start'), 'not-installed');
    assert.equal(await refusal(harness({ state: { state: 'stopped' } }), 'stop'), 'not-running');
    assert.equal(await refusal(harness({ state: { state: 'running' } }), 'start'), 'already-running');
    assert.equal(await refusal(harness({ state: { state: 'running' }, platform: 'linux' }), 'stop'), 'unsupported-platform');
    assert.equal(await refusal(harness({ state: { state: 'running' }, uid: null }), 'stop'), 'unsupported-platform');
  });

  test('#740/AC-4 Given a registered account, When deactivate is confirmed, Then uninstall --apply --yes runs per account, never --purge-data, and the data folder is not touched', async () => {
    const h = harness({ state: { state: 'running' } });
    const { plan, job } = await confirmed(h, 'deactivate');
    assert.equal(job.state, 'succeeded');
    assert.deepEqual(h.sp.calls.map((c) => c.args.filter((x) => x !== '--data-dir' && x !== h.data)), [['uninstall', '--apply', '--yes'], ['uninstall', '--apply', '--yes']]);
    assert.deepEqual(h.sp.calls.map((c) => (c.options.env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR), [h.a, h.b]);
    assert.equal(JSON.stringify(h.sp.calls.map((c) => c.args)).includes('purge'), false);
    assert.equal(plan.startNeedsActivation, true);
    assert.deepEqual(plan.deletes, []);
  });

  test('#740/AC-4 Given a stopped server, When the plan of delete-data is asked, Then it lists wiki/, db/ and raw/ as deleted, what stays, and asks for an acknowledgment', async () => {
    const h = harness({ state: { state: 'stopped' } });
    const plan = await planOf(h.actions, 'delete-data');
    assert.deepEqual(plan.deletes, ['wiki/', 'db/', 'raw/']);
    assert.deepEqual(plan.keeps, ['config.toml', 'access-credentials', 'logs']);
    assert.equal(plan.needsAcknowledgment, true);
    assert.deepEqual(plan.steps.map((s) => s.display), [['ai-memory', 'reset', '--confirm']]);
    assert.equal(h.sp.calls.length, 0);
  });

  test('#740/AC-4 Given a running server, When delete-data is asked, Then it is refused and nothing runs', async () => {
    const h = harness({ state: { state: 'running' } });
    assert.equal(await refusal(h, 'delete-data'), 'not-stopped');
    const r = await h.actions.act('delete-data', '0123456789abcdef', true);
    assert.deepEqual(r, { kind: 'not-offered', reason: 'not-stopped' });
    assert.equal(h.sp.calls.length, 0);
  });

  test('#740/AC-4 Given a server whose state is unknown or no binary, Then delete-data is refused', async () => {
    assert.equal(await refusal(harness({ state: { state: 'unknown' } }), 'delete-data'), 'state-unknown');
    assert.equal(await refusal(harness({ state: { state: 'unavailable' }, binaryPath: null }), 'delete-data'), 'no-binary');
  });

  test('#740/AC-4 Given delete-data confirmed with the right digest but no acknowledgment, Then it is not queued; with it, reset --confirm runs, and never as part of another action', async () => {
    const h = harness({ state: { state: 'stopped' } });
    const plan = await planOf(h.actions, 'delete-data');
    const without = await h.actions.act('delete-data', plan.planDigest, false);
    assert.equal(without.kind, 'acknowledgment-required');
    assert.equal(h.sp.calls.length, 0);
    const done = await confirmed(h, 'delete-data', true);
    assert.equal(done.job.actionId, 'delete-data');
    assert.deepEqual(h.sp.calls[0]!.args.filter((x) => x !== '--data-dir' && x !== h.data), ['reset', '--confirm']);
    for (const other of ['activate', 'deactivate', 'stop'] as const) {
      const steps = (await h.actions.plan(other)).kind === 'plan' ? (await planOf(h.actions, other)).steps.map((s) => s.display.join(' ')) : [];
      assert.equal(steps.some((s) => s.includes('reset')), false, `${other} has no reset step`);
    }
  });
});

describe('#740 the queue and the job', () => {
  test('#740/AC-6 Given two confirmed actions, When both are queued, Then they run one at a time', async () => {
    const h = harness({ state: { state: 'running' } });
    const stop = await planOf(h.actions, 'stop');
    const deactivate = await planOf(h.actions, 'deactivate');
    await h.actions.act('stop', stop.planDigest, false);
    await h.actions.act('deactivate', deactivate.planDigest, false);
    await h.executor.idle('local');
    assert.equal(h.sp.maxActive(), 1);
    assert.equal(h.executor.jobs('local').recent.length, 2);
  });

  test('#740/AC-5 Given a finished job, Then it carries the label and the display steps, never a path, and the processes\' output is not kept', async () => {
    const h = harness({ state: { state: 'stopped' } });
    const { job } = await confirmed(h, 'activate');
    assert.equal(job.label, 'rótulo activate');
    assert.equal(job.toolId, 'ai-memory');
    const text = JSON.stringify(job);
    for (const path of [h.home, h.data, '/Applications']) assert.equal(text.includes(path), false, `${path} is not in the job`);
    assert.equal(job.logFile.includes('tools.log'), true);
  });

  test('#740/AC-5 Given every spawn and write of an action, Then none names the token files of ai-memory\'s data folder', async () => {
    const written: string[] = [];
    const g = harness({ files: (real) => ({ ...real, writeEmbeddingsOff: async (path) => (written.push(path), real.writeEmbeddingsOff(path)) }) });
    await confirmed(g, 'activate');
    assert.deepEqual(written, [join(g.data, 'config.toml')]);
    const everything = JSON.stringify(g.sp.calls.map((c) => [c.command, c.args, c.options.env]));
    assert.equal(/auth-token|auth-header/i.test(everything), false);
  });
});

describe('#740 the actions on a core with no usable memory', () => {
  test('#740 Given no embedded binary, Then every action is not offered', async () => {
    const h = harness({ binaryPath: null, state: { state: 'unavailable' } });
    for (const id of MEMORY_ACTIONS) assert.equal(await refusal(h, id), 'no-binary');
  });

  test('#740 Given a status that is unknown, Then every action is refused for it', async () => {
    const h = harness({ state: { state: 'unknown' } });
    for (const id of MEMORY_ACTIONS) assert.equal(await refusal(h, id), 'state-unknown');
  });
});
