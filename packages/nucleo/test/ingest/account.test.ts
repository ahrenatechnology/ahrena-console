// The session's account from the hooks (#110, decision 0006): orders 1 (`env`) and 2 (`config`),
// precedence, SSH and the account's registration. Synthetic accounts only.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  HOOK_CONTEXT_FIELD,
  ingestHook,
  normalizeHook,
  hookConfigDir,
  resolveAccount,
  type HookEnv,
  type HookProfiles,
} from '../../src/ingest/hooks/index.ts';
import type { ClaudeAccount } from '../../src/model.ts';
import { T0, at } from '../fixtures.ts';
import { HOOK_PAYLOADS } from './hook-payloads.ts';

// Synthetic accounts: A in two orgs, B in a third.
const ACCOUNT_A = '00000000-0000-4000-8000-00000000000a';
const ACCOUNT_B = '00000000-0000-4000-8000-00000000000b';
const ORG_1 = '00000000-0000-4000-8000-000000000001';
const ORG_2 = '00000000-0000-4000-8000-000000000002';
const ORG_3 = '00000000-0000-4000-8000-000000000003';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-account-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Synthetic configuration folder with a `.claude.json` logged in to `account/org`. */
function configFolder(name: string, account: string | null, org: string | null, extra: Record<string, unknown> = {}): string {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  const oauthAccount = account && org ? { accountUuid: account, organizationUuid: org, emailAddress: 'pessoa@example.test', organizationName: 'Org sintética' } : undefined;
  writeFileSync(join(p, '.claude.json'), JSON.stringify({ oauthAccount, ...extra }));
  return p;
}

const withEnv = (payload: object, env: Record<string, unknown>) => ({ ...payload, [HOOK_CONTEXT_FIELD]: { env } });
const start = (session: string, env: Record<string, unknown>) => withEnv({ ...HOOK_PAYLOADS.SessionStart, session_id: session }, env);
const hookEvent = (name: keyof typeof HOOK_PAYLOADS, session: string, env: Record<string, unknown>) =>
  withEnv({ ...HOOK_PAYLOADS[name], session_id: session }, env);

describe('forwarder field in the payload', () => {
  test('becomes a hint and stays out of the recorded event', () => {
    const p = start('s-1', { CLAUDE_CONFIG_DIR: '/cfg/a', CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1 });
    const { event, hints } = normalizeHook(p, { receivedAt: T0 });
    assert.deepEqual(hints.env, { configDir: '/cfg/a', accountUuid: ACCOUNT_A, organizationUuid: ORG_1, ssh: false });
    assert.equal((event.data as Record<string, unknown>)[HOOK_CONTEXT_FIELD], undefined);
  });

  test('values out of format are ignored', () => {
    const p = start('s-1', { CLAUDE_CONFIG_DIR: 42, CLAUDE_CODE_ACCOUNT_UUID: 'não é uuid', CLAUDE_CODE_ORGANIZATION_UUID: ORG_1, ssh: 'sim' });
    assert.deepEqual(normalizeHook(p, { receivedAt: T0 }).hints.env, { configDir: null, accountUuid: null, organizationUuid: ORG_1, ssh: false });
    assert.equal(normalizeHook({ ...HOOK_PAYLOADS.Stop, [HOOK_CONTEXT_FIELD]: 'x' }, { receivedAt: T0 }).hints.env, null);
  });
});

describe('hook configuration folder', () => {
  const env = (configDir: string | null): HookEnv => ({ configDir, accountUuid: null, organizationUuid: null, ssh: false });
  test('CLAUDE_CONFIG_DIR first, otherwise the transcript root', () => {
    assert.equal(hookConfigDir(env('/cfg/a/'), '/home/dev/.claude/projects/-x/s.jsonl'), '/cfg/a');
    assert.equal(hookConfigDir(env(null), '/home/dev/projects/.claude-b/projects/-repo/s.jsonl'), '/home/dev/projects/.claude-b');
    assert.equal(hookConfigDir(env('relativa'), null), null);
    assert.equal(hookConfigDir(null, '/sem/transcript.txt'), null);
  });
});

describe('resolution by orders 1 and 2', () => {
  const account = (accountUuid: string, organizationUuid: string): ClaudeAccount => ({
    id: `${accountUuid}/${organizationUuid}`,
    accountUuid,
    organizationUuid,
    organizationName: null,
    organizationType: null,
    label: null,
    color: null,
    configDirs: [],
    firstSeenAt: T0,
    lastSeenAt: T0,
    metadata: {},
  });
  const profiles = (fromFolder: ClaudeAccount | null): HookProfiles => ({
    accountForFolder: async () => fromFolder,
    register: async (c) => account(c.accountUuid, c.organizationUuid),
  });
  const reads = profiles(account(ACCOUNT_B, ORG_3));
  const none = profiles(null);

  test('env beats the folder', async () => {
    const r = await resolveAccount({ configDir: '/cfg', accountUuid: ACCOUNT_A, organizationUuid: ORG_1, ssh: false }, null, reads);
    assert.equal(r.resolved?.source, 'env');
    assert.equal(r.resolved?.account.id, `${ACCOUNT_A}/${ORG_1}`);
    assert.equal(r.desktopScope, null);
  });

  test('without both variables, the folder', async () => {
    const r = await resolveAccount({ configDir: '/cfg', accountUuid: ACCOUNT_A, organizationUuid: null, ssh: false }, null, reads);
    assert.equal(r.resolved?.source, 'config');
    assert.equal(r.resolved?.account.id, `${ACCOUNT_B}/${ORG_3}`);
  });

  test('with nothing, "Sem conta"', async () => {
    assert.equal((await resolveAccount(null, null, reads)).resolved, null);
    assert.equal((await resolveAccount(null, '/home/dev/.claude/projects/-x/s.jsonl', none)).resolved, null);
  });
});

describe('writing the account through the port', () => {
  let store: SqliteStorage;
  beforeEach(() => {
    store = openSqliteStorage({ path: ':memory:' });
  });
  afterEach(() => store.close());

  test("Desktop's SessionStart writes the environment's account and registers the ClaudeAccount", async () => {
    const cfg = configFolder('desktop', ACCOUNT_B, ORG_3);
    await ingestHook(store, start('s-env', { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1 }), { receivedAt: T0 });
    const s = await store.getSession('s-env');
    assert.equal(s?.accountId, `${ACCOUNT_A}/${ORG_1}`);
    assert.equal(s?.accountSource, 'env');
    const account = await store.getAccount(`${ACCOUNT_A}/${ORG_1}`);
    assert.deepEqual(account?.configDirs, [cfg]);
    assert.ok(account?.firstSeenAt);
    assert.equal(await store.getAccount(`${ACCOUNT_B}/${ORG_3}`), null, "the folder's account is not registered when the environment answers");
  });

  test("CLI-only session: the folder's account, with source config", async () => {
    const cfg = configFolder('cli', ACCOUNT_B, ORG_3);
    await ingestHook(store, start('s-cfg', { CLAUDE_CONFIG_DIR: cfg }), { receivedAt: T0 });
    const s = await store.getSession('s-cfg');
    assert.equal(s?.accountId, `${ACCOUNT_B}/${ORG_3}`);
    assert.equal(s?.accountSource, 'config');
  });

  test("the folder's account is written by the profiles, with the org name and a color", async () => {
    const cfg = configFolder('com-nome', ACCOUNT_A, ORG_3);
    await ingestHook(store, start('s-nome', { CLAUDE_CONFIG_DIR: cfg }), { receivedAt: T0 });
    const account = await store.getAccount(`${ACCOUNT_A}/${ORG_3}`);
    assert.equal(account?.organizationName, 'Org sintética');
    assert.ok(account?.color);
    assert.deepEqual(account?.configDirs, [cfg]);
  });

  test('without CLAUDE_CONFIG_DIR, the folder comes from transcript_path', async () => {
    const cfg = configFolder('pelo-transcript', ACCOUNT_A, ORG_2);
    const p = { ...HOOK_PAYLOADS.SessionStart, session_id: 's-tr', transcript_path: join(cfg, 'projects', '-repo', 's-tr.jsonl') };
    await ingestHook(store, withEnv(p, {}), { receivedAt: T0 });
    assert.equal((await store.getSession('s-tr'))?.accountId, `${ACCOUNT_A}/${ORG_2}`);
  });

  test('two accounts at the same time do not mix', async () => {
    const a = configFolder('a', ACCOUNT_A, ORG_1);
    const b = configFolder('b', ACCOUNT_A, ORG_2);
    await ingestHook(store, start('s-a', { CLAUDE_CONFIG_DIR: a }), { receivedAt: at(0) });
    await ingestHook(store, start('s-b', { CLAUDE_CONFIG_DIR: b }), { receivedAt: at(1) });
    await ingestHook(store, hookEvent('Stop', 's-a', { CLAUDE_CONFIG_DIR: a }), { receivedAt: at(2) });
    assert.equal((await store.getSession('s-a'))?.accountId, `${ACCOUNT_A}/${ORG_1}`);
    assert.equal((await store.getSession('s-b'))?.accountId, `${ACCOUNT_A}/${ORG_2}`);
    assert.deepEqual((await store.listSessions({ accountIds: [`${ACCOUNT_A}/${ORG_2}`] })).items.map((s) => s.id), ['s-b']);
    assert.deepEqual((await store.listAccounts()).map((c) => c.id).sort(), [`${ACCOUNT_A}/${ORG_1}`, `${ACCOUNT_A}/${ORG_2}`]);
  });

  test('the first event of a session the receiver did not see start also resolves', async () => {
    const cfg = configFolder('meio', ACCOUNT_B, ORG_3);
    await ingestHook(store, hookEvent('PreToolUse', 's-meio', { CLAUDE_CONFIG_DIR: cfg }), { receivedAt: T0 });
    const s = await store.getSession('s-meio');
    assert.equal(s?.accountId, `${ACCOUNT_B}/${ORG_3}`);
    assert.equal(s?.metadata.accountCheckedAt, T0);
  });

  test('after the first check, only SessionStart rereads the folder', async () => {
    let reads = 0;
    const profiles: HookProfiles = {
      accountForFolder: async () => {
        reads++;
        return null;
      },
      register: async () => assert.fail('no account in the environment, nothing to register'),
    };
    const env = { CLAUDE_CONFIG_DIR: '/cfg/chave-de-api' };
    await ingestHook(store, hookEvent('UserPromptSubmit', 's-api', env), { receivedAt: at(0), profiles });
    await ingestHook(store, hookEvent('Stop', 's-api', env), { receivedAt: at(1), profiles });
    assert.equal(reads, 1);
    assert.equal((await store.getSession('s-api'))?.accountId, null);
    await ingestHook(store, start('s-api', env), { receivedAt: at(2), profiles });
    assert.equal(reads, 2);
  });

  test("precedence: env corrects the inference, config does not replace env's account", async () => {
    const s0 = { ...HOOK_PAYLOADS.SessionStart, session_id: 's-prec' };
    await ingestHook(store, withEnv(s0, {}), { receivedAt: at(0), profiles: { accountForFolder: async () => null, register: async () => assert.fail() } });
    const recorded = await store.getSession('s-prec');
    await store.putSession({ ...recorded!, accountId: `${ACCOUNT_B}/${ORG_3}`, accountSource: 'transcript' });

    await ingestHook(store, start('s-prec', { CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1 }), { receivedAt: at(1) });
    let s = await store.getSession('s-prec');
    assert.equal(s?.accountId, `${ACCOUNT_A}/${ORG_1}`);
    assert.equal(s?.accountSource, 'env');

    // `/clear` or `resume` without the variables: the folder (order 2) does not undo env (order 1).
    await ingestHook(store, start('s-prec', { CLAUDE_CONFIG_DIR: configFolder('outra', ACCOUNT_B, ORG_2) }), { receivedAt: at(2) });
    s = await store.getSession('s-prec');
    assert.equal(s?.accountId, `${ACCOUNT_A}/${ORG_1}`);
    assert.equal(s?.accountSource, 'env');
  });
});

describe('session over SSH', () => {
  let store: SqliteStorage;
  beforeEach(() => {
    store = openSqliteStorage({ path: ':memory:' });
  });
  afterEach(() => store.close());

  test("the account is the remote CLI's; Desktop's goes to desktopScope", async () => {
    const remote = configFolder('remota-mesma-org', ACCOUNT_B, ORG_1);
    await ingestHook(
      store,
      start('s-ssh', { CLAUDE_CONFIG_DIR: remote, CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1, ssh: true }),
      { receivedAt: T0 },
    );
    const s = await store.getSession('s-ssh');
    assert.equal(s?.accountId, `${ACCOUNT_B}/${ORG_1}`);
    assert.equal(s?.accountSource, 'config');
    assert.equal(s?.metadata.desktopScope, `${ACCOUNT_A}/${ORG_1}`);
    assert.equal(s?.metadata.desktopScopeConflict, false);
  });

  test('Desktop in one org, remote CLI in another: marks the conflict', async () => {
    const remote = configFolder('remota-outra-org', ACCOUNT_A, ORG_2);
    await ingestHook(
      store,
      start('s-ssh2', { CLAUDE_CONFIG_DIR: remote, CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1, ssh: true }),
      { receivedAt: T0 },
    );
    const s = await store.getSession('s-ssh2');
    assert.equal(s?.accountId, `${ACCOUNT_A}/${ORG_2}`);
    assert.equal(s?.metadata.desktopScope, `${ACCOUNT_A}/${ORG_1}`);
    assert.equal(s?.metadata.desktopScopeConflict, true);
  });

  test("a later SessionStart without Desktop's variables clears desktopScope", async () => {
    const remote = configFolder('remota-depois', ACCOUNT_A, ORG_2);
    const withDesktop = { CLAUDE_CONFIG_DIR: remote, CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1, ssh: true };
    await ingestHook(store, start('s-ssh5', withDesktop), { receivedAt: at(0) });
    assert.equal((await store.getSession('s-ssh5'))?.metadata.desktopScopeConflict, true);
    await ingestHook(store, start('s-ssh5', { CLAUDE_CONFIG_DIR: remote, ssh: true }), { receivedAt: at(1) });
    const s = await store.getSession('s-ssh5');
    assert.equal(s?.metadata.desktopScope, undefined);
    assert.equal(s?.metadata.desktopScopeConflict, undefined);
    assert.equal(s?.accountId, `${ACCOUNT_A}/${ORG_2}`);
  });

  test("SSH without Desktop's variables: only the folder, no desktopScope", async () => {
    await ingestHook(store, start('s-ssh3', { CLAUDE_CONFIG_DIR: configFolder('remota-sozinha', ACCOUNT_B, ORG_3), ssh: true }), { receivedAt: T0 });
    const s = await store.getSession('s-ssh3');
    assert.equal(s?.accountId, `${ACCOUNT_B}/${ORG_3}`);
    assert.equal(s?.metadata.desktopScope, undefined);
    assert.equal(s?.metadata.desktopScopeConflict, undefined);
  });

  test('remote without OAuth login: "Sem conta", but desktopScope stays', async () => {
    await ingestHook(
      store,
      start('s-ssh4', { CLAUDE_CONFIG_DIR: configFolder('remota-sem-login', null, null), CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1, ssh: true }),
      { receivedAt: T0 },
    );
    const s = await store.getSession('s-ssh4');
    assert.equal(s?.accountId, null);
    assert.equal(s?.metadata.desktopScope, `${ACCOUNT_A}/${ORG_1}`);
    assert.equal(s?.metadata.desktopScopeConflict, undefined);
  });
});
