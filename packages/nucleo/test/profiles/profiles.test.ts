// Profiles (#109, decision 0006): fake HOME, synthetic folders and `.claude.json`. No real data.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, ACCOUNT_COLORS } from '../../src/api/contas.ts';
import { accountFromClaudeJson, freeColor, discoverFolders, Profiles } from '../../src/profiles/index.ts';

const UUID_A = '00000000-0000-4000-8000-00000000000a';
const ORG_A = '00000000-0000-4000-8000-0000000000aa';
const UUID_B = '00000000-0000-4000-8000-00000000000b';
const ORG_B = '00000000-0000-4000-8000-0000000000bb';
const UUID_C = '00000000-0000-4000-8000-00000000000c';
const ORG_C = '00000000-0000-4000-8000-0000000000cc';
const T0 = '2026-10-19T12:00:00.000Z';
const SEGREDO = 'segredo-sintetico-nao-pode-vazar';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ahrena-profiles-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Synthetic `.claude.json` with fields the core must not keep (tokens, key, e-mail). */
function claudeJson(conta: string, org: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    primaryApiKey: SEGREDO,
    oauthAccount: { accountUuid: conta, organizationUuid: org, emailAddress: 'pessoa@exemplo.test', accessToken: SEGREDO, ...extra },
    projects: { '/tmp/x': { history: [SEGREDO] } },
  });
}

function pasta(nome: string, json?: string): string {
  const dir = join(home, nome);
  mkdirSync(join(dir, 'projects'), { recursive: true });
  if (json) writeFileSync(join(dir, '.claude.json'), json);
  return dir;
}

describe('reading .claude.json', () => {
  test('only account, org, org name and type; tokens, key and e-mail stay out', () => {
    const c = accountFromClaudeJson(claudeJson(UUID_A, ORG_A, { organizationName: 'Equipe Exemplo', organizationType: 'claude_team' }));
    assert.deepEqual(c, { accountUuid: UUID_A, organizationUuid: ORG_A, organizationName: 'Equipe Exemplo', organizationType: 'claude_team' });
    assert.ok(!JSON.stringify(c).includes(SEGREDO));
    assert.ok(!JSON.stringify(c).includes('@'));
  });

  test('no org name: the name is null and the e-mail stays out; no oauthAccount or an invalid UUID: nothing', () => {
    const c = accountFromClaudeJson(claudeJson(UUID_A, ORG_A));
    assert.equal(c?.organizationName, null);
    assert.ok(!JSON.stringify(c).includes('@'));
    assert.equal(accountFromClaudeJson(JSON.stringify({ primaryApiKey: SEGREDO })), null);
    assert.equal(accountFromClaudeJson(claudeJson('não é uuid', ORG_A)), null);
    assert.equal(accountFromClaudeJson('{ quebrado'), null);
  });
});

describe('discovery of the configuration folders', () => {
  test('default, ~/.claude-*, configured and revealed; only those with the structure, without repeats', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), claudeJson(UUID_A, ORG_A));
    pasta('.claude-cliente');
    mkdirSync(join(home, '.claude-vazia'));
    writeFileSync(join(home, '.claude-arquivo'), 'não é pasta');
    const configurada = pasta('configs/trabalho');
    const revelada = pasta('outra/pasta');
    mkdirSync(join(home, '.ahrena-console'));
    const arquivo = join(home, '.ahrena-console', 'perfis.json');
    writeFileSync(arquivo, JSON.stringify({ pastas: ['~/configs/trabalho', '~/.claude-cliente', 42] }));

    const pastas = await discoverFolders({ home, file: arquivo, revealed: [revelada, join(home, '.claude')] });
    assert.deepEqual(
      pastas.map((p) => [p.dir, p.origin, p.isDefault]),
      [
        [join(home, '.claude'), 'default', true],
        [join(home, '.claude-cliente'), 'name', false],
        [configurada, 'configured', false],
        [revelada, 'hook', false],
      ],
    );
    assert.equal(pastas[0].claudeJson, join(home, '.claude.json'), 'na pasta padrão, o .claude.json fica no HOME');
    assert.equal(pastas[1].claudeJson, join(home, '.claude-cliente', '.claude.json'));
    assert.equal(pastas[1].projectsDir, join(home, '.claude-cliente', 'projects'));
  });

  test('HOME without any folder: empty list', async () => {
    assert.deepEqual(await discoverFolders({ home, file: null }), []);
  });
});

describe('Profiles in the port', () => {
  test('two accounts at once: each folder writes its own, with the org name and a brand color', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), claudeJson(UUID_A, ORG_A, { organizationName: 'Equipe Exemplo', organizationType: 'claude_team' }));
    pasta('.claude-cliente', claudeJson(UUID_B, ORG_B, { organizationName: 'Cliente Exemplo', organizationType: 'claude_max' }));
    pasta('.claude-sem-login');
    const storage = openSqliteStorage({ path: ':memory:' });
    const perfis = new Profiles({ storage, home, file: null, now: () => T0 });

    const lista = await perfis.sync();
    assert.deepEqual(
      lista.map((p) => [p.dir, p.accountId, p.projectsDir]),
      [
        [join(home, '.claude'), `${UUID_A}/${ORG_A}`, join(home, '.claude', 'projects')],
        [join(home, '.claude-cliente'), `${UUID_B}/${ORG_B}`, join(home, '.claude-cliente', 'projects')],
        [join(home, '.claude-sem-login'), null, join(home, '.claude-sem-login', 'projects')],
      ],
    );
    const contas = await storage.listAccounts();
    assert.deepEqual(
      contas.map((a) => [a.id, a.label, a.organizationName, a.organizationType, a.color, a.configDirs]),
      [
        [`${UUID_A}/${ORG_A}`, null, 'Equipe Exemplo', 'claude_team', ACCOUNT_COLORS[0], [join(home, '.claude')]],
        [`${UUID_B}/${ORG_B}`, null, 'Cliente Exemplo', 'claude_max', ACCOUNT_COLORS[1], [join(home, '.claude-cliente')]],
      ],
    );
    assert.ok(!JSON.stringify(contas).includes(SEGREDO), 'nenhum token na porta');
    assert.ok(!JSON.stringify(contas).includes('pessoa@exemplo.test'), 'o e-mail não é gravado');
    await storage.close();
  });

  test('accountForFolder (for #110): reveals the folder, writes, and does not overwrite the edited label and color', async () => {
    const dir = pasta('em/qualquer/lugar', claudeJson(UUID_C, ORG_C, { organizationName: 'Org Sintética' }));
    const storage = openSqliteStorage({ path: ':memory:' });
    const perfis = new Profiles({ storage, home, file: null, now: () => T0 });

    const a = await perfis.accountForFolder(dir);
    assert.equal(a?.id, `${UUID_C}/${ORG_C}`);
    assert.deepEqual([a?.label, a?.organizationName], [null, 'Org Sintética'], 'o label só existe quando a pessoa edita');
    assert.deepEqual((await perfis.list()).map((p) => [p.dir, p.origin]), [[dir, 'hook']], 'a pasta revelada entra na lista');

    await storage.putAccount({ ...a!, label: 'meu rótulo', color: '#123456' });
    const depois = await perfis.accountForFolder(dir);
    assert.deepEqual([depois?.label, depois?.color, depois?.firstSeenAt], ['meu rótulo', '#123456', T0]);

    assert.equal(await perfis.accountForFolder(join(home, 'não-existe')), null);
    assert.equal(await perfis.accountForFolder(pasta('sem-login')), null);
    await storage.close();
  });

  test('the same account in two folders joins the folders; simultaneous writes are not lost', async () => {
    const um = pasta('.claude-um', claudeJson(UUID_A, ORG_A));
    const dois = pasta('.claude-dois', claudeJson(UUID_A, ORG_A));
    const storage = openSqliteStorage({ path: ':memory:' });
    const perfis = new Profiles({ storage, home, file: null, now: () => T0 });
    await Promise.all([perfis.accountForFolder(um), perfis.accountForFolder(dois)]);
    assert.deepEqual((await storage.getAccount(`${UUID_A}/${ORG_A}`))?.configDirs, [dois, um], 'em ordem de caminho');
    await storage.close();
  });

  test('the API shows the org name instead of "conta 1"; contas.json still wins', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), claudeJson(UUID_A, ORG_A, { organizationName: 'Equipe Exemplo' }));
    pasta('.claude-cliente', claudeJson(UUID_B, ORG_B, { organizationName: 'Cliente Exemplo' }));
    const storage = openSqliteStorage({ path: ':memory:' });
    await new Profiles({ storage, home, file: null, now: () => T0 }).sync();
    const arquivo = join(home, 'contas.json');
    writeFileSync(arquivo, JSON.stringify({ [`${UUID_B}/${ORG_B}`]: { rotulo: 'cliente', cor: '#1baf7a' } }));
    const contas = new Contas({ storage, arquivo });
    await contas.atualizar();
    const sessao = (accountId: string) => ({ id: 's', accountId, accountSource: 'config' as const });
    assert.deepEqual(contas.daSessao(sessao(`${UUID_A}/${ORG_A}`), null), { id: `${UUID_A}/${ORG_A}`, label: 'Equipe Exemplo', color: ACCOUNT_COLORS[0], source: 'config' });
    assert.deepEqual(contas.daSessao(sessao(`${UUID_B}/${ORG_B}`), null), { id: `${UUID_B}/${ORG_B}`, label: 'cliente', color: '#1baf7a', source: 'config' });
    await storage.close();
  });

  test('org without a name: neither the e-mail nor anything of the account becomes the label; the API shows "conta N"', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), claudeJson(UUID_A, ORG_A));
    const storage = openSqliteStorage({ path: ':memory:' });
    await new Profiles({ storage, home, file: null, now: () => T0 }).sync();
    const [a] = await storage.listAccounts();
    assert.deepEqual([a.label, a.organizationName], [null, null]);
    assert.ok(!JSON.stringify(a).includes('pessoa@exemplo.test'));
    const contas = new Contas({ storage, arquivo: null });
    await contas.atualizar();
    assert.equal(contas.daSessao({ id: 's', accountId: a.id, accountSource: 'config' }, null)?.label, 'conta 1');
    await storage.close();
  });

  test('personal org ("<e-mail>\'s Organization"): the e-mail never becomes the label; the API shows "conta pessoal"', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), claudeJson(UUID_A, ORG_A, { organizationName: "pessoa@exemplo.test's Organization" }));
    pasta('.claude-cliente', claudeJson(UUID_B, ORG_B, { organizationName: "pessoa@exemplo.test's Organization" }));
    const storage = openSqliteStorage({ path: ':memory:' });
    await new Profiles({ storage, home, file: null, now: () => T0 }).sync();
    const arquivo = join(home, 'contas.json');
    writeFileSync(arquivo, JSON.stringify({ [`${UUID_B}/${ORG_B}`]: { rotulo: 'cliente' } }));
    const contas = new Contas({ storage, arquivo });
    await contas.atualizar();
    const sessao = (accountId: string) => ({ id: 's', accountId, accountSource: 'config' as const });
    const a = contas.daSessao(sessao(`${UUID_A}/${ORG_A}`), null);
    assert.equal(a?.label, 'conta pessoal');
    assert.ok(!JSON.stringify(a).includes('@'));
    // O contas.json continua por cima.
    assert.equal(contas.daSessao(sessao(`${UUID_B}/${ORG_B}`), null)?.label, 'cliente');
    await storage.close();
  });

  test('a renamed org shows the new name; the edited label stays', async () => {
    const dir = pasta('.claude-x', claudeJson(UUID_A, ORG_A, { organizationName: 'Nome Antigo' }));
    const storage = openSqliteStorage({ path: ':memory:' });
    const perfis = new Profiles({ storage, home, file: null, now: () => T0 });
    await perfis.sync();
    writeFileSync(join(dir, '.claude.json'), claudeJson(UUID_A, ORG_A, { organizationName: 'Nome Novo' }));
    await perfis.sync();
    const contas = new Contas({ storage, arquivo: null, intervaloMs: 0 });
    await contas.atualizar();
    const s = { id: 's', accountId: `${UUID_A}/${ORG_A}`, accountSource: 'config' as const };
    assert.equal(contas.daSessao(s, null)?.label, 'Nome Novo');
    await storage.putAccount({ ...(await storage.getAccount(`${UUID_A}/${ORG_A}`))!, label: 'meu rótulo' });
    writeFileSync(join(dir, '.claude.json'), claudeJson(UUID_A, ORG_A, { organizationName: 'Outro Nome' }));
    await perfis.sync();
    await contas.atualizar();
    assert.equal(contas.daSessao(s, null)?.label, 'meu rótulo');
    await storage.close();
  });

  test('syncing again without a change does not write to the port', async () => {
    pasta('.claude-x', claudeJson(UUID_A, ORG_A, { organizationName: 'Org' }));
    const storage = openSqliteStorage({ path: ':memory:' });
    let gravacoes = 0;
    const contada = {
      getAccount: (id: string) => storage.getAccount(id),
      listAccounts: () => storage.listAccounts(),
      putAccount: (a: Parameters<typeof storage.putAccount>[0]) => (gravacoes++, storage.putAccount(a)),
    };
    let t = 0;
    const perfis = new Profiles({ storage: contada, home, file: null, now: () => new Date(Date.parse(T0) + t++ * 60_000).toISOString() });
    await perfis.sync();
    await perfis.sync();
    await perfis.accountForFolder(join(home, '.claude-x'));
    assert.equal(gravacoes, 1);
    await storage.close();
  });

  test('new account color: the first one no account uses', async () => {
    assert.equal(freeColor([]), ACCOUNT_COLORS[0]);
    assert.equal(freeColor([ACCOUNT_COLORS[0], ACCOUNT_COLORS[2], '#123456']), ACCOUNT_COLORS[1]);
    assert.equal(freeColor([...ACCOUNT_COLORS, ACCOUNT_COLORS[0]]), ACCOUNT_COLORS[1]);
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putAccount({
      id: `${UUID_B}/${ORG_B}`, accountUuid: UUID_B, organizationUuid: ORG_B, organizationName: null, organizationType: null,
      label: null, color: ACCOUNT_COLORS[0], configDirs: [], firstSeenAt: T0, lastSeenAt: T0, metadata: {},
    });
    const a = await new Profiles({ storage, home, file: null, now: () => T0 }).accountForFolder(pasta('.claude-x', claudeJson(UUID_A, ORG_A)));
    assert.equal(a?.color, ACCOUNT_COLORS[1]);
    await storage.close();
  });

  test('a symlink to a configuration folder does not become a second profile', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), claudeJson(UUID_A, ORG_A));
    const alvo = pasta('.claude-alvo', claudeJson(UUID_B, ORG_B));
    symlinkSync(alvo, join(home, '.claude-link'));
    symlinkSync(join(home, '.claude'), join(home, 'atalho'));
    const storage = openSqliteStorage({ path: ':memory:' });
    const perfis = new Profiles({ storage, home, file: null, now: () => T0 });
    assert.deepEqual((await perfis.list()).map((p) => p.dir), [join(home, '.claude'), alvo]);
    const padrao = await perfis.accountForFolder(join(home, 'atalho'));
    assert.deepEqual(padrao?.configDirs, [join(home, '.claude')], 'o symlink da pasta padrão lê o ~/.claude.json');
    await storage.close();
  });
});
