// Conta da sessão pelos hooks (#110, decisão 0006): ordens 1 (`env`) e 2 (`config`), precedência,
// SSH e o registro da conta. Só contas sintéticas.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import {
  HOOK_CONTEXT_FIELD,
  arquivoDaConta,
  contaDaPasta,
  ingestHook,
  normalizeHook,
  pastaDoHook,
  resolverConta,
  type HookEnv,
} from '../../src/ingest/hooks/index.ts';
import { T0, at } from '../fixtures.ts';
import { HOOK_PAYLOADS } from './hook-payloads.ts';

// Contas sintéticas: A em duas orgs, B numa terceira.
const CONTA_A = '00000000-0000-4000-8000-00000000000a';
const CONTA_B = '00000000-0000-4000-8000-00000000000b';
const ORG_1 = '00000000-0000-4000-8000-000000000001';
const ORG_2 = '00000000-0000-4000-8000-000000000002';
const ORG_3 = '00000000-0000-4000-8000-000000000003';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-conta-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Pasta de configuração sintética com um `.claude.json` logado em `conta/org`. */
function pasta(nome: string, conta: string | null, org: string | null, extra: Record<string, unknown> = {}): string {
  const p = join(dir, nome);
  mkdirSync(p, { recursive: true });
  const oauthAccount = conta && org ? { accountUuid: conta, organizationUuid: org, emailAddress: 'pessoa@example.test', organizationName: 'Org sintética' } : undefined;
  writeFileSync(join(p, '.claude.json'), JSON.stringify({ oauthAccount, ...extra }));
  return p;
}

const comEnv = (payload: object, env: Record<string, unknown>) => ({ ...payload, [HOOK_CONTEXT_FIELD]: { env } });
const start = (session: string, env: Record<string, unknown>) => comEnv({ ...HOOK_PAYLOADS.SessionStart, session_id: session }, env);
const evento = (nome: keyof typeof HOOK_PAYLOADS, session: string, env: Record<string, unknown>) =>
  comEnv({ ...HOOK_PAYLOADS[nome], session_id: session }, env);

describe('campo do encaminhador no payload', () => {
  test('vira pista e não entra no evento gravado', () => {
    const p = start('s-1', { CLAUDE_CONFIG_DIR: '/cfg/a', CLAUDE_CODE_ACCOUNT_UUID: CONTA_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1 });
    const { event, hints } = normalizeHook(p, { receivedAt: T0 });
    assert.deepEqual(hints.env, { configDir: '/cfg/a', accountUuid: CONTA_A, organizationUuid: ORG_1, ssh: false });
    assert.equal((event.data as Record<string, unknown>)[HOOK_CONTEXT_FIELD], undefined);
  });

  test('valores fora do formato são ignorados', () => {
    const p = start('s-1', { CLAUDE_CONFIG_DIR: 42, CLAUDE_CODE_ACCOUNT_UUID: 'não é uuid', CLAUDE_CODE_ORGANIZATION_UUID: ORG_1, ssh: 'sim' });
    assert.deepEqual(normalizeHook(p, { receivedAt: T0 }).hints.env, { configDir: null, accountUuid: null, organizationUuid: ORG_1, ssh: false });
    assert.equal(normalizeHook({ ...HOOK_PAYLOADS.Stop, [HOOK_CONTEXT_FIELD]: 'x' }, { receivedAt: T0 }).hints.env, null);
  });
});

describe('pasta de configuração do hook', () => {
  const env = (configDir: string | null): HookEnv => ({ configDir, accountUuid: null, organizationUuid: null, ssh: false });
  test('CLAUDE_CONFIG_DIR primeiro, senão a raiz do transcript', () => {
    assert.equal(pastaDoHook(env('/cfg/a/'), '/home/dev/.claude/projects/-x/s.jsonl'), '/cfg/a');
    assert.equal(pastaDoHook(env(null), '/home/dev/projects/.claude-b/projects/-repo/s.jsonl'), '/home/dev/projects/.claude-b');
    assert.equal(pastaDoHook(env('relativa'), null), null);
    assert.equal(pastaDoHook(null, '/sem/transcript.txt'), null);
  });
});

describe('conta da pasta (provisória até a #109)', () => {
  test('lê só a conta e a org do .claude.json', async () => {
    const p = pasta('lida', CONTA_A, ORG_2, { primaryApiKey: 'chave-sintetica' });
    assert.deepEqual(await contaDaPasta(p), { accountUuid: CONTA_A, organizationUuid: ORG_2 });
  });

  test('sem arquivo, sem login OAuth ou com JSON quebrado: null', async () => {
    assert.equal(await contaDaPasta(join(dir, 'nao-existe')), null);
    assert.equal(await contaDaPasta(pasta('chave-de-api', null, null)), null);
    const quebrada = join(dir, 'quebrada');
    mkdirSync(quebrada);
    writeFileSync(join(quebrada, '.claude.json'), '{');
    assert.equal(await contaDaPasta(quebrada), null);
  });

  test('a pasta padrão usa o ~/.claude.json', () => {
    assert.equal(arquivoDaConta('/home/dev/.claude', '/home/dev'), '/home/dev/.claude.json');
    assert.equal(arquivoDaConta('/home/dev/.claude-b', '/home/dev'), '/home/dev/.claude-b/.claude.json');
  });
});

describe('resolução pelas ordens 1 e 2', () => {
  const ler = async () => ({ accountUuid: CONTA_B, organizationUuid: ORG_3 });
  const nada = async () => null;

  test('env vence a pasta', async () => {
    const r = await resolverConta({ configDir: '/cfg', accountUuid: CONTA_A, organizationUuid: ORG_1, ssh: false }, null, ler);
    assert.equal(r.conta?.source, 'env');
    assert.equal(r.conta?.id, `${CONTA_A}/${ORG_1}`);
    assert.equal(r.desktopScope, null);
  });

  test('sem as duas variáveis, a pasta', async () => {
    const r = await resolverConta({ configDir: '/cfg', accountUuid: CONTA_A, organizationUuid: null, ssh: false }, null, ler);
    assert.equal(r.conta?.source, 'config');
    assert.equal(r.conta?.id, `${CONTA_B}/${ORG_3}`);
  });

  test('sem nada, "Sem conta"', async () => {
    assert.equal((await resolverConta(null, null, ler)).conta, null);
    assert.equal((await resolverConta(null, '/home/dev/.claude/projects/-x/s.jsonl', nada)).conta, null);
  });
});

describe('gravação da conta pela porta', () => {
  let store: SqliteStorage;
  beforeEach(() => {
    store = openSqliteStorage({ path: ':memory:' });
  });
  afterEach(() => store.close());

  test('SessionStart do Desktop grava a conta do ambiente e registra a ClaudeAccount', async () => {
    const cfg = pasta('desktop', CONTA_B, ORG_3);
    await ingestHook(store, start('s-env', { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_ACCOUNT_UUID: CONTA_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1 }), { receivedAt: T0 });
    const s = await store.getSession('s-env');
    assert.equal(s?.accountId, `${CONTA_A}/${ORG_1}`);
    assert.equal(s?.accountSource, 'env');
    const conta = await store.getAccount(`${CONTA_A}/${ORG_1}`);
    assert.deepEqual(conta?.configDirs, [cfg]);
    assert.equal(conta?.firstSeenAt, T0);
    assert.equal(await store.getAccount(`${CONTA_B}/${ORG_3}`), null, 'a conta da pasta não é registrada quando o ambiente responde');
  });

  test('sessão só de CLI: a conta da pasta, com procedência config', async () => {
    const cfg = pasta('cli', CONTA_B, ORG_3);
    await ingestHook(store, start('s-cfg', { CLAUDE_CONFIG_DIR: cfg }), { receivedAt: T0 });
    const s = await store.getSession('s-cfg');
    assert.equal(s?.accountId, `${CONTA_B}/${ORG_3}`);
    assert.equal(s?.accountSource, 'config');
  });

  test('sem CLAUDE_CONFIG_DIR, a pasta sai do transcript_path', async () => {
    const cfg = pasta('pelo-transcript', CONTA_A, ORG_2);
    const p = { ...HOOK_PAYLOADS.SessionStart, session_id: 's-tr', transcript_path: join(cfg, 'projects', '-repo', 's-tr.jsonl') };
    await ingestHook(store, comEnv(p, {}), { receivedAt: T0 });
    assert.equal((await store.getSession('s-tr'))?.accountId, `${CONTA_A}/${ORG_2}`);
  });

  test('duas contas ao mesmo tempo não se misturam', async () => {
    const a = pasta('a', CONTA_A, ORG_1);
    const b = pasta('b', CONTA_A, ORG_2);
    await ingestHook(store, start('s-a', { CLAUDE_CONFIG_DIR: a }), { receivedAt: at(0) });
    await ingestHook(store, start('s-b', { CLAUDE_CONFIG_DIR: b }), { receivedAt: at(1) });
    await ingestHook(store, evento('Stop', 's-a', { CLAUDE_CONFIG_DIR: a }), { receivedAt: at(2) });
    assert.equal((await store.getSession('s-a'))?.accountId, `${CONTA_A}/${ORG_1}`);
    assert.equal((await store.getSession('s-b'))?.accountId, `${CONTA_A}/${ORG_2}`);
    assert.deepEqual((await store.listSessions({ accountIds: [`${CONTA_A}/${ORG_2}`] })).items.map((s) => s.id), ['s-b']);
    assert.deepEqual((await store.listAccounts()).map((c) => c.id).sort(), [`${CONTA_A}/${ORG_1}`, `${CONTA_A}/${ORG_2}`]);
  });

  test('primeiro evento de uma sessão que o receptor não viu começar também resolve', async () => {
    const cfg = pasta('meio', CONTA_B, ORG_3);
    await ingestHook(store, evento('PreToolUse', 's-meio', { CLAUDE_CONFIG_DIR: cfg }), { receivedAt: T0 });
    const s = await store.getSession('s-meio');
    assert.equal(s?.accountId, `${CONTA_B}/${ORG_3}`);
    assert.equal(s?.metadata.accountCheckedAt, T0);
  });

  test('depois da primeira checagem, só o SessionStart relê a pasta', async () => {
    let leituras = 0;
    const lerContaDaPasta = async () => {
      leituras++;
      return null;
    };
    const env = { CLAUDE_CONFIG_DIR: '/cfg/chave-de-api' };
    await ingestHook(store, evento('UserPromptSubmit', 's-api', env), { receivedAt: at(0), lerContaDaPasta });
    await ingestHook(store, evento('Stop', 's-api', env), { receivedAt: at(1), lerContaDaPasta });
    assert.equal(leituras, 1);
    assert.equal((await store.getSession('s-api'))?.accountId, null);
    await ingestHook(store, start('s-api', env), { receivedAt: at(2), lerContaDaPasta });
    assert.equal(leituras, 2);
  });

  test('precedência: env corrige a inferência, config não troca a conta do env', async () => {
    const s0 = { ...HOOK_PAYLOADS.SessionStart, session_id: 's-prec' };
    await ingestHook(store, comEnv(s0, {}), { receivedAt: at(0), lerContaDaPasta: async () => null });
    const gravada = await store.getSession('s-prec');
    await store.putSession({ ...gravada!, accountId: `${CONTA_B}/${ORG_3}`, accountSource: 'transcript' });

    await ingestHook(store, start('s-prec', { CLAUDE_CODE_ACCOUNT_UUID: CONTA_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1 }), { receivedAt: at(1) });
    let s = await store.getSession('s-prec');
    assert.equal(s?.accountId, `${CONTA_A}/${ORG_1}`);
    assert.equal(s?.accountSource, 'env');

    // `/clear` ou `resume` sem as variáveis: a pasta (ordem 2) não desfaz o env (ordem 1).
    await ingestHook(store, start('s-prec', { CLAUDE_CONFIG_DIR: pasta('outra', CONTA_B, ORG_2) }), { receivedAt: at(2) });
    s = await store.getSession('s-prec');
    assert.equal(s?.accountId, `${CONTA_A}/${ORG_1}`);
    assert.equal(s?.accountSource, 'env');
  });
});

describe('sessão por SSH', () => {
  let store: SqliteStorage;
  beforeEach(() => {
    store = openSqliteStorage({ path: ':memory:' });
  });
  afterEach(() => store.close());

  test('a conta é a do CLI remoto; a do Desktop vai para desktopScope', async () => {
    const remota = pasta('remota-mesma-org', CONTA_B, ORG_1);
    await ingestHook(
      store,
      start('s-ssh', { CLAUDE_CONFIG_DIR: remota, CLAUDE_CODE_ACCOUNT_UUID: CONTA_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1, ssh: true }),
      { receivedAt: T0 },
    );
    const s = await store.getSession('s-ssh');
    assert.equal(s?.accountId, `${CONTA_B}/${ORG_1}`);
    assert.equal(s?.accountSource, 'config');
    assert.equal(s?.metadata.desktopScope, `${CONTA_A}/${ORG_1}`);
    assert.equal(s?.metadata.desktopScopeConflict, false);
  });

  test('Desktop numa org, CLI remoto em outra: marca o conflito', async () => {
    const remota = pasta('remota-outra-org', CONTA_A, ORG_2);
    await ingestHook(
      store,
      start('s-ssh2', { CLAUDE_CONFIG_DIR: remota, CLAUDE_CODE_ACCOUNT_UUID: CONTA_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1, ssh: true }),
      { receivedAt: T0 },
    );
    const s = await store.getSession('s-ssh2');
    assert.equal(s?.accountId, `${CONTA_A}/${ORG_2}`);
    assert.equal(s?.metadata.desktopScope, `${CONTA_A}/${ORG_1}`);
    assert.equal(s?.metadata.desktopScopeConflict, true);
  });

  test('um SessionStart posterior sem as variáveis do Desktop limpa o desktopScope', async () => {
    const remota = pasta('remota-depois', CONTA_A, ORG_2);
    const comDesktop = { CLAUDE_CONFIG_DIR: remota, CLAUDE_CODE_ACCOUNT_UUID: CONTA_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1, ssh: true };
    await ingestHook(store, start('s-ssh5', comDesktop), { receivedAt: at(0) });
    assert.equal((await store.getSession('s-ssh5'))?.metadata.desktopScopeConflict, true);
    await ingestHook(store, start('s-ssh5', { CLAUDE_CONFIG_DIR: remota, ssh: true }), { receivedAt: at(1) });
    const s = await store.getSession('s-ssh5');
    assert.equal(s?.metadata.desktopScope, undefined);
    assert.equal(s?.metadata.desktopScopeConflict, undefined);
    assert.equal(s?.accountId, `${CONTA_A}/${ORG_2}`);
  });

  test('SSH sem as variáveis do Desktop: só a pasta, sem desktopScope', async () => {
    await ingestHook(store, start('s-ssh3', { CLAUDE_CONFIG_DIR: pasta('remota-sozinha', CONTA_B, ORG_3), ssh: true }), { receivedAt: T0 });
    const s = await store.getSession('s-ssh3');
    assert.equal(s?.accountId, `${CONTA_B}/${ORG_3}`);
    assert.equal(s?.metadata.desktopScope, undefined);
    assert.equal(s?.metadata.desktopScopeConflict, undefined);
  });

  test('remoto sem login OAuth: "Sem conta", mas o desktopScope fica', async () => {
    await ingestHook(
      store,
      start('s-ssh4', { CLAUDE_CONFIG_DIR: pasta('remota-sem-login', null, null), CLAUDE_CODE_ACCOUNT_UUID: CONTA_A, CLAUDE_CODE_ORGANIZATION_UUID: ORG_1, ssh: true }),
      { receivedAt: T0 },
    );
    const s = await store.getSession('s-ssh4');
    assert.equal(s?.accountId, null);
    assert.equal(s?.metadata.desktopScope, `${CONTA_A}/${ORG_1}`);
    assert.equal(s?.metadata.desktopScopeConflict, undefined);
  });
});
