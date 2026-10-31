import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { diagnoseBilling, prepareBillingEnvironment, parseClaudeAuthStatus, parseCodexLoginStatus,
  inspectBillingConfig, type BillingScope, type AuthDiagnostic } from '../../src/runtime/auth-probes.ts';
import { BillingAdmissionGate, BillingAdmissionError, evaluateBillingAdmission } from '../../src/runtime/billing-policy.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<BillingScope> {
  const root = await mkdtemp(join(tmpdir(), 'billing-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config')); await mkdir(join(root, 'project'));
  return { provider: 'claude', profileId: 'profile-a', accountId: 'account-a', configDir: join(root, 'config'), cwd: join(root, 'project') };
}
function observation(scope: BillingScope): AuthDiagnostic {
  return { scope: { ...scope }, observedAt: 1000, expiresAt: 31000, revision: 'synthetic', reasons: [],
    auth: { mode: 'subscription', source: 'claude-auth-status' }, source: 'local-read-only' };
}

test('subscription status and checkbox never establish extras disabled', async t => {
  const scope = await fixture(t);
  const diagnostic = await diagnoseBilling(scope, { env: {}, now: () => 1000 });
  assert.deepEqual(diagnostic.reasons, ['effective_config_unverified', 'auth_unverified']);
  const result = evaluateBillingAdmission(scope, { ...observation(scope), ...{ extrasDisabled: true } }, 1001);
  assert.equal(result.state, 'unknown'); assert.equal(result.allowed, false); assert.equal(result.pauseQueue, true);
  assert.ok(result.reasons.includes('extras_unverified'));
});

test('environment allowlist strips overrides and never reports values', async t => {
  const scope = await fixture(t);
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY',
    'CODEX_ACCESS_TOKEN', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS',
    'AZURE_OPENAI_ENDPOINT', 'HTTP_PROXY', 'https_proxy', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES']) {
    const prepared = prepareBillingEnvironment(scope, { [key]: 'synthetic-private-value', HOME: '/tmp/home', PATH: '/bin', UNRELATED_SECRET: 'private' });
    assert.deepEqual(prepared.reasons, ['environment_override'], key);
    assert.equal(prepared.env.CLAUDE_CONFIG_DIR, scope.configDir); assert.equal(prepared.env.UNRELATED_SECRET, undefined);
    assert.ok(!JSON.stringify(prepared).includes('synthetic-private-value'));
    const diagnostic = await diagnoseBilling(scope, { env: { [key]: 'synthetic-private-value' } });
    assert.equal(evaluateBillingAdmission(scope, diagnostic).state, 'blocked');
    assert.ok(!JSON.stringify(diagnostic).includes('synthetic-private-value'));
  }
});

test('API helper cloud gateway and Codex settings block with a clean environment', async t => {
  const scope = await fixture(t);
  for (const text of ['{"apiKeyHelper":"never"}', '{"env":{"ANTHROPIC_API_KEY":"synthetic-private-value"}}',
    '{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}', 'model_provider = "gateway"', '[model_providers.custom]',
    'base_url = "https://example.invalid"', 'forced_login_method = "api"']) {
    await writeFile(join(scope.configDir, 'settings.json'), text);
    const diagnostic = await diagnoseBilling(scope, { env: {} });
    assert.ok(diagnostic.reasons.includes('config_override'), text);
    assert.equal(evaluateBillingAdmission(scope, diagnostic).state, 'blocked');
    assert.ok(!JSON.stringify(diagnostic).includes('synthetic-private-value'));
  }
  assert.deepEqual(inspectBillingConfig('{broken'), ['config_ambiguous']);
  assert.deepEqual(inspectBillingConfig('{"hooks":{}}'), ['config_ambiguous']);
  scope.provider = 'codex';
  await writeFile(join(scope.configDir, 'auth.json'), 'never-read');
  await writeFile(join(scope.configDir, 'config.toml'), 'model_provider = "custom"');
  assert.ok((await diagnoseBilling(scope, { env: {} })).reasons.includes('config_override'));
});

test('project settings, symlinks, oversized files and relative paths fail closed', async t => {
  const scope = await fixture(t);
  await mkdir(join(scope.cwd, '.claude'));
  await writeFile(join(scope.cwd, '.claude/settings.local.json'), '{"apiKeyHelper":"never"}');
  assert.ok((await diagnoseBilling(scope, { env: {} })).reasons.includes('config_override'));
  const file = join(scope.configDir, 'settings.json');
  await symlink(join(scope.configDir, 'auth.json'), file);
  assert.ok((await diagnoseBilling(scope, { env: {} })).reasons.includes('config_unreadable'));
  await rm(file); await writeFile(file, ' '.repeat(256 * 1024 + 1));
  assert.ok((await diagnoseBilling(scope, { env: {} })).reasons.includes('config_ambiguous'));
  assert.ok((await diagnoseBilling({ ...scope, configDir: 'relative' }, { env: {} })).reasons.includes('config_ambiguous'));
});

test('official status parsers discard private fields and unknown schemas', () => {
  assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"private"}').mode, 'subscription');
  for (const authMethod of ['api_key', 'api_key_helper', 'third_party']) {
    assert.equal(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod })).mode, 'api');
  }
  assert.equal(parseClaudeAuthStatus('{"loggedIn":false}').mode, 'none');
  for (const text of ['null', '{}', 'not-json', '{"loggedIn":true,"authMethod":"new"}']) assert.equal(parseClaudeAuthStatus(text).mode, 'unknown');
  assert.equal(parseCodexLoginStatus('Logged in using ChatGPT\n').mode, 'subscription');
  assert.equal(parseCodexLoginStatus('Logged in using an API key - synthetic-private-value').mode, 'api');
  assert.equal(parseCodexLoginStatus('Not logged in').mode, 'none');
  assert.equal(parseCodexLoginStatus('prefix Logged in using ChatGPT').mode, 'unknown');
});

test('external OAuth token does not establish API billing or admission', async t => {
  const scope = await fixture(t);
  const diagnostic = observation(scope);
  diagnostic.auth = parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"oauth_token"}');
  assert.equal(diagnostic.auth.mode, 'unknown');
  const admission = evaluateBillingAdmission(scope, diagnostic, 1001);
  assert.equal(admission.state, 'unknown');
  assert.equal(admission.allowed, false);
  assert.ok(admission.reasons.includes('extras_unverified'));
  assert.ok(admission.reasons.includes('auth_unverified'));
  assert.ok(!admission.reasons.includes('api_auth'));
});

test('evidence is scoped and expires; API and unauthenticated modes block', async t => {
  const scope = await fixture(t);
  for (const patch of [{ provider: 'codex' as const }, { profileId: 'profile-b' }, { accountId: 'account-b' }, { configDir: '/other' }, { cwd: '/other' }]) {
    const result = evaluateBillingAdmission({ ...scope, ...patch }, observation(scope), 1001);
    assert.equal(result.state, 'blocked'); assert.ok(result.reasons.includes('scope_mismatch'));
  }
  for (const now of [999, 31000, Infinity, NaN]) assert.ok(evaluateBillingAdmission(scope, observation(scope), now).reasons.includes('evidence_expired'));
  for (const mode of ['api', 'none'] as const) {
    const diagnostic = observation(scope); diagnostic.auth.mode = mode;
    assert.equal(evaluateBillingAdmission(scope, diagnostic, 1001).state, 'blocked');
  }
});

test('every operation rereads files, pauses queue and refuses', async t => {
  const scope = await fixture(t); const gate = new BillingAdmissionGate();
  for (const operation of ['launch', 'resume', 'turn'] as const) {
    let paused = false;
    await assert.rejects(gate.admit(operation, scope, { env: {}, pauseQueue: (op, admission) => {
      assert.equal(op, operation); assert.equal(admission.allowed, false); paused = true;
    } }), BillingAdmissionError);
    assert.equal(paused, true);
  }
  await writeFile(join(scope.configDir, 'settings.json'), '{"apiKeyHelper":"never"}');
  await assert.rejects(gate.admit('turn', scope, { env: {}, pauseQueue: (_, admission) => {
    assert.ok(admission.reasons.includes('config_override'));
  } }), BillingAdmissionError);
});

test('account and environment changes during evaluation are refused', async t => {
  const scope = await fixture(t); let calls = 0; const env: NodeJS.ProcessEnv = {};
  await assert.rejects(new BillingAdmissionGate().admit('launch', scope, { env, now: () => {
    if (++calls === 2) { scope.accountId = 'account-b'; env.OPENAI_API_KEY = 'synthetic'; }
    return 1000;
  }, pauseQueue: (_, admission) => {
    assert.equal(admission.state, 'blocked'); assert.ok(admission.reasons.includes('configuration_changed'));
  } }), BillingAdmissionError);
});

test('probe failures do not leak exception details', async t => {
  const scope = await fixture(t); let calls = 0;
  await assert.rejects(new BillingAdmissionGate().admit('resume', scope, { now: () => {
    if (++calls === 1) throw new Error('synthetic-private-value'); return 1000;
  }, pauseQueue: (_, admission) => {
    assert.ok(admission.reasons.includes('probe_failed')); assert.ok(!JSON.stringify(admission).includes('synthetic-private-value'));
  } }), BillingAdmissionError);
});

test('quota exhaustion is scoped and invalidation never grants admission', async t => {
  const scope = await fixture(t); const gate = new BillingAdmissionGate(); gate.quotaExhausted(scope);
  for (const [profileId, exhausted] of [['profile-a', true], ['profile-b', false]] as const) {
    await assert.rejects(gate.admit('turn', { ...scope, profileId }, { env: {}, pauseQueue: (_, admission) => {
      assert.equal(admission.reasons.includes('quota_exhausted'), exhausted);
    } }), BillingAdmissionError);
  }
  gate.invalidate(scope);
  await assert.rejects(gate.admit('turn', scope, { env: {}, pauseQueue: (_, admission) => {
    assert.equal(admission.allowed, false); assert.ok(admission.reasons.includes('extras_unverified'));
  } }), BillingAdmissionError);
});

test('diagnostic CLI emits safe refusal and a nonzero exit', async t => {
  const scope = await fixture(t);
  const result = spawnSync(process.execPath, [new URL('../../src/runtime/billing-diagnostic-cli.ts', import.meta.url).pathname, 'claude', scope.configDir, scope.cwd], { env: {}, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).allowed, false);
  assert.ok(!result.stdout.includes(scope.configDir));
});


test('settings changed between observations invalidate the diagnostic', async t => {
  const scope = await fixture(t);
  const file = join(scope.configDir, 'settings.json');
  await writeFile(file, '{}');
  let calls = 0;
  await assert.rejects(new BillingAdmissionGate().admit('turn', scope, { env: {}, now: () => {
    if (++calls === 2) writeFileSync(file, '{"apiKeyHelper":"never-execute"}');
    return 1000;
  }, pauseQueue: (_, admission) => {
    assert.ok(admission.reasons.includes('configuration_changed'));
    assert.ok(admission.reasons.includes('config_override'));
  } }), BillingAdmissionError);
});
