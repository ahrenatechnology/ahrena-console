// Perfis (#109, decisão 0006): HOME falso, pastas e `.claude.json` sintéticos. Nenhum dado real.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, CORES_DAS_CONTAS } from '../../src/api/contas.ts';
import { contaDoClaudeJson, descobrirPastas, Perfis } from '../../src/perfis/index.ts';

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
    assert.deepEqual(c, { accountUuid: UUID_A, organizationUuid: ORG_A, organizationName: 'Equipe Exemplo', organizationType: 'claude_team', rotuloSugerido: 'Equipe Exemplo' });
    assert.ok(!JSON.stringify(c).includes(SEGREDO));
    assert.ok(!JSON.stringify(c).includes('@'));
  });

  test('sem nome de org, o e-mail sugere o rótulo; sem oauthAccount ou com UUID inválido, nada', () => {
    assert.equal(contaDoClaudeJson(claudeJson(UUID_A, ORG_A))?.rotuloSugerido, 'pessoa@exemplo.test');
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
      contas.map((a) => [a.id, a.label, a.organizationType, a.color, a.configDirs]),
      [
        [`${UUID_A}/${ORG_A}`, 'Equipe Exemplo', 'claude_team', CORES_DAS_CONTAS[0], [join(home, '.claude')]],
        [`${UUID_B}/${ORG_B}`, 'Cliente Exemplo', 'claude_max', CORES_DAS_CONTAS[1], [join(home, '.claude-cliente')]],
      ],
    );
    assert.ok(!JSON.stringify(contas).includes(SEGREDO), 'nenhum token na porta');
    assert.ok(!JSON.stringify(contas).includes('pessoa@exemplo.test'), 'o e-mail não é gravado quando a org tem nome');
    await storage.close();
  });

  test('contaDaPasta (para a #110): revela a pasta, grava e não sobrescreve o rótulo e a cor editados', async () => {
    const dir = pasta('em/qualquer/lugar', claudeJson(UUID_C, ORG_C, { organizationName: 'Org Sintética' }));
    const storage = openSqliteStorage({ path: ':memory:' });
    const perfis = new Perfis({ storage, home, arquivo: null, agora: () => T0 });

    const a = await perfis.contaDaPasta(dir);
    assert.equal(a?.id, `${UUID_C}/${ORG_C}`);
    assert.equal(a?.label, 'Org Sintética');
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
    assert.deepEqual(contas.daSessao(sessao(`${UUID_A}/${ORG_A}`), null), { id: `${UUID_A}/${ORG_A}`, rotulo: 'Equipe Exemplo', cor: CORES_DAS_CONTAS[0], fonte: 'config' });
    assert.deepEqual(contas.daSessao(sessao(`${UUID_B}/${ORG_B}`), null), { id: `${UUID_B}/${ORG_B}`, rotulo: 'cliente', cor: '#1baf7a', fonte: 'config' });
    await storage.close();
  });
});
