// Perfis (#109, decisão 0006): HOME falso, pastas e `.claude.json` sintéticos. Nenhum dado real.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, CORES_DAS_CONTAS } from '../../src/api/contas.ts';
import { contaDoClaudeJson, corLivre, descobrirPastas, Perfis } from '../../src/perfis/index.ts';

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
  home = mkdtempSync(join(tmpdir(), 'ahrena-perfis-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** `.claude.json` sintético com campos que o núcleo não pode guardar (tokens, chave, e-mail). */
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

describe('leitura do .claude.json', () => {
  test('só conta, org, nome e tipo da org; tokens, chave e e-mail não saem', () => {
    const c = contaDoClaudeJson(claudeJson(UUID_A, ORG_A, { organizationName: 'Equipe Exemplo', organizationType: 'claude_team' }));
    assert.deepEqual(c, { accountUuid: UUID_A, organizationUuid: ORG_A, organizationName: 'Equipe Exemplo', organizationType: 'claude_team' });
    assert.ok(!JSON.stringify(c).includes(SEGREDO));
    assert.ok(!JSON.stringify(c).includes('@'));
  });

  test('sem nome de org, o nome fica nulo e o e-mail não entra; sem oauthAccount ou com UUID inválido, nada', () => {
    const c = contaDoClaudeJson(claudeJson(UUID_A, ORG_A));
    assert.equal(c?.organizationName, null);
    assert.ok(!JSON.stringify(c).includes('@'));
    assert.equal(contaDoClaudeJson(JSON.stringify({ primaryApiKey: SEGREDO })), null);
    assert.equal(contaDoClaudeJson(claudeJson('não é uuid', ORG_A)), null);
    assert.equal(contaDoClaudeJson('{ quebrado'), null);
  });
});

describe('descoberta das pastas de configuração', () => {
  test('padrão, ~/.claude-*, configuradas e reveladas; só as que têm a estrutura, sem repetir', async () => {
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

    const pastas = await descobrirPastas({ home, arquivo, reveladas: [revelada, join(home, '.claude')] });
    assert.deepEqual(
      pastas.map((p) => [p.dir, p.origem, p.padrao]),
      [
        [join(home, '.claude'), 'padrao', true],
        [join(home, '.claude-cliente'), 'nome', false],
        [configurada, 'configurada', false],
        [revelada, 'hook', false],
      ],
    );
    assert.equal(pastas[0].claudeJson, join(home, '.claude.json'), 'na pasta padrão, o .claude.json fica no HOME');
    assert.equal(pastas[1].claudeJson, join(home, '.claude-cliente', '.claude.json'));
    assert.equal(pastas[1].projetos, join(home, '.claude-cliente', 'projects'));
  });

  test('HOME sem pasta nenhuma: lista vazia', async () => {
    assert.deepEqual(await descobrirPastas({ home, arquivo: null }), []);
  });
});

describe('Perfis na porta', () => {
  test('duas contas ao mesmo tempo: cada pasta grava a sua, com o nome da org e uma cor da marca', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), claudeJson(UUID_A, ORG_A, { organizationName: 'Equipe Exemplo', organizationType: 'claude_team' }));
    pasta('.claude-cliente', claudeJson(UUID_B, ORG_B, { organizationName: 'Cliente Exemplo', organizationType: 'claude_max' }));
    pasta('.claude-sem-login');
    const storage = openSqliteStorage({ path: ':memory:' });
    const perfis = new Perfis({ storage, home, arquivo: null, agora: () => T0 });

    const lista = await perfis.sincronizar();
    assert.deepEqual(
      lista.map((p) => [p.dir, p.accountId, p.projetos]),
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
        [`${UUID_A}/${ORG_A}`, null, 'Equipe Exemplo', 'claude_team', CORES_DAS_CONTAS[0], [join(home, '.claude')]],
        [`${UUID_B}/${ORG_B}`, null, 'Cliente Exemplo', 'claude_max', CORES_DAS_CONTAS[1], [join(home, '.claude-cliente')]],
      ],
    );
    assert.ok(!JSON.stringify(contas).includes(SEGREDO), 'nenhum token na porta');
    assert.ok(!JSON.stringify(contas).includes('pessoa@exemplo.test'), 'o e-mail não é gravado');
    await storage.close();
  });

  test('contaDaPasta (para a #110): revela a pasta, grava e não sobrescreve o rótulo e a cor editados', async () => {
    const dir = pasta('em/qualquer/lugar', claudeJson(UUID_C, ORG_C, { organizationName: 'Org Sintética' }));
    const storage = openSqliteStorage({ path: ':memory:' });
    const perfis = new Perfis({ storage, home, arquivo: null, agora: () => T0 });

    const a = await perfis.contaDaPasta(dir);
    assert.equal(a?.id, `${UUID_C}/${ORG_C}`);
    assert.deepEqual([a?.label, a?.organizationName], [null, 'Org Sintética'], 'o label só existe quando a pessoa edita');
    assert.deepEqual((await perfis.listar()).map((p) => [p.dir, p.origem]), [[dir, 'hook']], 'a pasta revelada entra na lista');

    await storage.putAccount({ ...a!, label: 'meu rótulo', color: '#123456' });
    const depois = await perfis.contaDaPasta(dir);
    assert.deepEqual([depois?.label, depois?.color, depois?.firstSeenAt], ['meu rótulo', '#123456', T0]);

    assert.equal(await perfis.contaDaPasta(join(home, 'não-existe')), null);
    assert.equal(await perfis.contaDaPasta(pasta('sem-login')), null);
    await storage.close();
  });

  test('a mesma conta em duas pastas junta as pastas; gravações simultâneas não se perdem', async () => {
    const um = pasta('.claude-um', claudeJson(UUID_A, ORG_A));
    const dois = pasta('.claude-dois', claudeJson(UUID_A, ORG_A));
    const storage = openSqliteStorage({ path: ':memory:' });
    const perfis = new Perfis({ storage, home, arquivo: null, agora: () => T0 });
    await Promise.all([perfis.contaDaPasta(um), perfis.contaDaPasta(dois)]);
    assert.deepEqual((await storage.getAccount(`${UUID_A}/${ORG_A}`))?.configDirs, [dois, um], 'em ordem de caminho');
    await storage.close();
  });

  test('a API mostra o nome da org em vez de "conta 1"; o contas.json continua por cima', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), claudeJson(UUID_A, ORG_A, { organizationName: 'Equipe Exemplo' }));
    pasta('.claude-cliente', claudeJson(UUID_B, ORG_B, { organizationName: 'Cliente Exemplo' }));
    const storage = openSqliteStorage({ path: ':memory:' });
    await new Perfis({ storage, home, arquivo: null, agora: () => T0 }).sincronizar();
    const arquivo = join(home, 'contas.json');
    writeFileSync(arquivo, JSON.stringify({ [`${UUID_B}/${ORG_B}`]: { rotulo: 'cliente', cor: '#1baf7a' } }));
    const contas = new Contas({ storage, arquivo });
    await contas.atualizar();
    const sessao = (accountId: string) => ({ id: 's', accountId, accountSource: 'config' as const });
    assert.deepEqual(contas.daSessao(sessao(`${UUID_A}/${ORG_A}`), null), { id: `${UUID_A}/${ORG_A}`, label: 'Equipe Exemplo', color: CORES_DAS_CONTAS[0], source: 'config' });
    assert.deepEqual(contas.daSessao(sessao(`${UUID_B}/${ORG_B}`), null), { id: `${UUID_B}/${ORG_B}`, label: 'cliente', color: '#1baf7a', source: 'config' });
    await storage.close();
  });

  test('org sem nome: nem o e-mail nem nada da conta vira rótulo; a API mostra "conta N"', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), claudeJson(UUID_A, ORG_A));
    const storage = openSqliteStorage({ path: ':memory:' });
    await new Perfis({ storage, home, arquivo: null, agora: () => T0 }).sincronizar();
    const [a] = await storage.listAccounts();
    assert.deepEqual([a.label, a.organizationName], [null, null]);
    assert.ok(!JSON.stringify(a).includes('pessoa@exemplo.test'));
    const contas = new Contas({ storage, arquivo: null });
    await contas.atualizar();
    assert.equal(contas.daSessao({ id: 's', accountId: a.id, accountSource: 'config' }, null)?.label, 'conta 1');
    await storage.close();
  });

  test('org pessoal ("<e-mail>\'s Organization"): o e-mail nunca vira rótulo; a API mostra "conta pessoal"', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), claudeJson(UUID_A, ORG_A, { organizationName: "pessoa@exemplo.test's Organization" }));
    pasta('.claude-cliente', claudeJson(UUID_B, ORG_B, { organizationName: "pessoa@exemplo.test's Organization" }));
    const storage = openSqliteStorage({ path: ':memory:' });
    await new Perfis({ storage, home, arquivo: null, agora: () => T0 }).sincronizar();
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

  test('org renomeada aparece com o nome novo; o rótulo editado continua', async () => {
    const dir = pasta('.claude-x', claudeJson(UUID_A, ORG_A, { organizationName: 'Nome Antigo' }));
    const storage = openSqliteStorage({ path: ':memory:' });
    const perfis = new Perfis({ storage, home, arquivo: null, agora: () => T0 });
    await perfis.sincronizar();
    writeFileSync(join(dir, '.claude.json'), claudeJson(UUID_A, ORG_A, { organizationName: 'Nome Novo' }));
    await perfis.sincronizar();
    const contas = new Contas({ storage, arquivo: null, intervaloMs: 0 });
    await contas.atualizar();
    const s = { id: 's', accountId: `${UUID_A}/${ORG_A}`, accountSource: 'config' as const };
    assert.equal(contas.daSessao(s, null)?.label, 'Nome Novo');
    await storage.putAccount({ ...(await storage.getAccount(`${UUID_A}/${ORG_A}`))!, label: 'meu rótulo' });
    writeFileSync(join(dir, '.claude.json'), claudeJson(UUID_A, ORG_A, { organizationName: 'Outro Nome' }));
    await perfis.sincronizar();
    await contas.atualizar();
    assert.equal(contas.daSessao(s, null)?.label, 'meu rótulo');
    await storage.close();
  });

  test('sincronizar de novo sem mudança não grava na porta', async () => {
    pasta('.claude-x', claudeJson(UUID_A, ORG_A, { organizationName: 'Org' }));
    const storage = openSqliteStorage({ path: ':memory:' });
    let gravacoes = 0;
    const contada = {
      getAccount: (id: string) => storage.getAccount(id),
      listAccounts: () => storage.listAccounts(),
      putAccount: (a: Parameters<typeof storage.putAccount>[0]) => (gravacoes++, storage.putAccount(a)),
    };
    let t = 0;
    const perfis = new Perfis({ storage: contada, home, arquivo: null, agora: () => new Date(Date.parse(T0) + t++ * 60_000).toISOString() });
    await perfis.sincronizar();
    await perfis.sincronizar();
    await perfis.contaDaPasta(join(home, '.claude-x'));
    assert.equal(gravacoes, 1);
    await storage.close();
  });

  test('cor de conta nova: a primeira que nenhuma conta usa', async () => {
    assert.equal(corLivre([]), CORES_DAS_CONTAS[0]);
    assert.equal(corLivre([CORES_DAS_CONTAS[0], CORES_DAS_CONTAS[2], '#123456']), CORES_DAS_CONTAS[1]);
    assert.equal(corLivre([...CORES_DAS_CONTAS, CORES_DAS_CONTAS[0]]), CORES_DAS_CONTAS[1]);
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putAccount({
      id: `${UUID_B}/${ORG_B}`, accountUuid: UUID_B, organizationUuid: ORG_B, organizationName: null, organizationType: null,
      label: null, color: CORES_DAS_CONTAS[0], configDirs: [], firstSeenAt: T0, lastSeenAt: T0, metadata: {},
    });
    const a = await new Perfis({ storage, home, arquivo: null, agora: () => T0 }).contaDaPasta(pasta('.claude-x', claudeJson(UUID_A, ORG_A)));
    assert.equal(a?.color, CORES_DAS_CONTAS[1]);
    await storage.close();
  });

  test('symlink para uma pasta de configuração não vira um segundo perfil', async () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), claudeJson(UUID_A, ORG_A));
    const alvo = pasta('.claude-alvo', claudeJson(UUID_B, ORG_B));
    symlinkSync(alvo, join(home, '.claude-link'));
    symlinkSync(join(home, '.claude'), join(home, 'atalho'));
    const storage = openSqliteStorage({ path: ':memory:' });
    const perfis = new Perfis({ storage, home, arquivo: null, agora: () => T0 });
    assert.deepEqual((await perfis.listar()).map((p) => p.dir), [join(home, '.claude'), alvo]);
    const padrao = await perfis.contaDaPasta(join(home, 'atalho'));
    assert.deepEqual(padrao?.configDirs, [join(home, '.claude')], 'o symlink da pasta padrão lê o ~/.claude.json');
    await storage.close();
  });
});
