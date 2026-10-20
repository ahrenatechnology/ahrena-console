// A tela Agent Config (#63). A leitura: só nomes, caminhos e contagens saem das pastas de
// configuração; nenhum valor de env, oauth, e-mail, comando ou URL. As rotas pela API local: a
// skill lida e gravada com backup, e cada defesa da gravação (origem e Host da decisão 0003,
// Content-Type, nome, raiz, symlink, versão). Tudo em pastas `mkdtemp`. Um arquivo só: cada
// arquivo de teste é um processo a mais rodando junto com os testes de tempo curto do encaminhador.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, criarRotaDaConfig, iniciarApiLocal, MontadorDoPainel, TrabalhoPorBranch, type ApiLocal } from '../../src/api/index.ts';
import { ErroDaConfig, escolherProjeto, lerConfigDoAgente, lerFrontmatter, MAX_CONTEUDO, montarConfigDaDemo, pastaDaMemoriaAutomatica, projetosConhecidos, versaoDe } from '../../src/config/index.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { pastaDeConfiguracao } from '../../src/perfis/descoberta.ts';
import { session } from '../fixtures.ts';

const temporarias: string[] = [];
after(() => temporarias.forEach((t) => rmSync(t, { recursive: true, force: true })));
const tmp = () => {
  const t = mkdtempSync(join(tmpdir(), 'config-leitura-'));
  temporarias.push(t);
  return t;
};
const escrever = (caminho: string, conteudo: string) => {
  mkdirSync(dirname(caminho), { recursive: true });
  writeFileSync(caminho, conteudo);
};

// Valores que nunca podem sair na resposta.
const SEGREDOS = ['segredo-do-env-123', 'pessoa@exemplo.com', 'token-oauth-xyz', 'echo comando-secreto', 'https://mcp.exemplo.com/segredo', 'valor-de-settings'];

function montarHome(home: string, projeto: string) {
  const u = join(home, '.claude');
  escrever(join(u, 'skills', 'revisar-pr', 'SKILL.md'), '---\nname: revisar-pr\ndescription: >\n  Revisa um PR\n  contra o guia\n---\ncorpo\n');
  escrever(join(u, 'skills', 'Maiuscula', 'SKILL.md'), '---\nname: "Outra Coisa"\n---\n');
  escrever(join(u, 'skills', 'sem-skill-md', 'LEIAME.md'), 'nada');
  escrever(join(u, 'agents', 'revisor.md'), "---\nname: revisor\ndescription: 'Revisa código'\ntools: [Read]\n---\n");
  escrever(join(u, 'agents', 'sem-frontmatter.md'), 'texto');
  escrever(join(u, 'commands', 'resumo.md'), 'x');
  escrever(join(u, 'commands', 'git', 'limpar.md'), 'x');
  escrever(join(u, 'CLAUDE.md'), 'Memória que não pode sair: valor-de-settings');
  escrever(join(u, '.credentials.json'), JSON.stringify({ token: 'token-oauth-xyz' }));
  escrever(
    join(u, 'settings.json'),
    JSON.stringify({
      env: { CHAVE: 'valor-de-settings' },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo comando-secreto' }, { type: 'command', command: 'echo comando-secreto' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo comando-secreto' }] }],
      },
      enabledPlugins: { 'ligado@mercado': true, 'desligado@mercado': false },
    }),
  );
  escrever(join(u, 'settings.local.json'), '{ quebrado');
  escrever(
    join(home, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'pessoa@exemplo.com', accountUuid: '00000000-0000-0000-0000-000000000001', organizationUuid: '00000000-0000-0000-0000-000000000002' },
      userID: 'token-oauth-xyz',
      mcpServers: {
        docs: { type: 'http', url: 'https://mcp.exemplo.com/segredo', headers: { Authorization: 'token-oauth-xyz' } },
        local: { command: 'echo comando-secreto', args: ['segredo-do-env-123'], env: { CHAVE: 'segredo-do-env-123' } },
      },
      projects: { [projeto]: { mcpServers: { banco: { env: { SENHA: 'segredo-do-env-123' } } }, allowedTools: ['valor-de-settings'] } },
    }),
  );
  escrever(join(pastaDaMemoriaAutomatica(u, projeto), 'MEMORY.md'), 'conteúdo da memória: valor-de-settings');
  return pastaDeConfiguracao(u, 'padrao', home);
}

function montarProjeto(projeto: string) {
  const p = join(projeto, '.claude');
  escrever(join(p, 'skills', 'abrir-issue', 'SKILL.md'), '---\nname: abrir-issue\ndescription: Abre uma issue\n---\n');
  escrever(join(p, 'agents', 'regras.md'), '---\nname: regras\n---\n');
  escrever(join(p, 'commands', 'publicar.md'), 'x');
  escrever(join(p, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'echo comando-secreto' }] }] }, enabledPlugins: { 'proj@mercado': true } }));
  escrever(join(p, 'CLAUDE.md'), 'x');
  escrever(join(projeto, 'CLAUDE.local.md'), 'x');
  escrever(join(projeto, '.mcp.json'), JSON.stringify({ mcpServers: { tickets: { command: 'echo comando-secreto', env: { K: 'segredo-do-env-123' } } } }));
}

describe('#63 frontmatter mínimo', () => {
  test('chave simples, aspas, dobrado, literal e continuação indentada', () => {
    const fm = lerFrontmatter("---\nname: a\ndescription: >-\n  linha um\n  linha dois\nb: 'com ''aspas'''\nc: |\n  x\n  y\nd: começo\n  e fim\nlista:\n  - um\n---\ncorpo: não\n");
    assert.equal(fm.name, 'a');
    assert.equal(fm.description, 'linha um linha dois');
    assert.equal(fm.b, "com 'aspas'");
    assert.equal(fm.c, 'x\ny');
    assert.equal(fm.d, 'começo e fim');
    assert.equal(fm.lista, undefined);
    assert.equal(fm.corpo, undefined);
    assert.deepEqual(lerFrontmatter('sem frontmatter'), {});
    assert.deepEqual(lerFrontmatter('---\nname: sem fim\n'), {});
  });
});

describe('#63 GET /api/config: a leitura', () => {
  test('lê as listas e o resumo, sem nenhum valor de env, oauth, e-mail, comando ou URL', async () => {
    const home = tmp();
    const projeto = join(home, 'proj');
    const pasta = montarHome(home, projeto);
    montarProjeto(projeto);
    const r = await lerConfigDoAgente({ pastas: [pasta], projetos: [projeto] });

    assert.equal(r.projeto, projeto);
    assert.deepEqual(r.projetos, [projeto]);
    assert.equal(r.edicao, true);
    assert.deepEqual(
      r.raizes.map((x) => [x.id, x.tipo, x.escopo, x.rotulo]),
      [
        ['u0', 'home', 'usuario', 'Claude home'],
        ['c0', 'configuracao', 'usuario', '.claude.json'],
        ['p', 'claude-projeto', 'projeto', '.claude do projeto'],
        ['r', 'projeto', 'projeto', 'Projeto · proj'],
      ],
    );
    const revisar = r.skills.find((s) => s.nome === 'revisar-pr')!;
    assert.equal(revisar.descricao, 'Revisa um PR contra o guia');
    assert.equal(revisar.raiz, 'u0');
    assert.equal(revisar.escopo, 'usuario');
    assert.equal(revisar.editavel, true);
    assert.ok(revisar.editadoEm > 0);
    const maiuscula = r.skills.find((s) => s.nome === 'Maiuscula')!;
    assert.equal(maiuscula.editavel, false);
    assert.equal(maiuscula.nomeDeclarado, 'Outra Coisa');
    assert.deepEqual(r.skills.map((s) => [s.nome, s.raiz]).sort(), [['Maiuscula', 'u0'], ['abrir-issue', 'p'], ['revisar-pr', 'u0']]);

    assert.deepEqual(r.subagentes.map((s) => [s.nome, s.descricao, s.escopo]), [['revisor', 'Revisa código', 'usuario'], ['sem-frontmatter', null, 'usuario'], ['regras', null, 'projeto']]);
    assert.deepEqual(r.comandos.map((c) => [c.nome, c.escopo]), [['git:limpar', 'usuario'], ['resumo', 'usuario'], ['publicar', 'projeto']]);
    assert.deepEqual(
      r.memoria.map((m) => [m.nome, m.escopo, m.tipo]),
      [['CLAUDE.md', 'usuario', 'instrucoes'], ['MEMORY.md', 'projeto', 'automatica'], ['CLAUDE.local.md', 'projeto', 'instrucoes'], [join('.claude', 'CLAUDE.md'), 'projeto', 'instrucoes']],
    );
    assert.deepEqual(r.hooks, [
      { evento: 'PreToolUse', quantos: 2, escopo: 'usuario' },
      { evento: 'Stop', quantos: 1, escopo: 'usuario' },
      { evento: 'PreToolUse', quantos: 1, escopo: 'projeto' },
    ]);
    assert.deepEqual(r.plugins, [{ nome: 'ligado@mercado', escopo: 'usuario' }, { nome: 'proj@mercado', escopo: 'projeto' }]);
    assert.deepEqual(r.mcp, [
      { nome: 'docs', escopo: 'usuario', origem: '.claude.json' },
      { nome: 'local', escopo: 'usuario', origem: '.claude.json' },
      { nome: 'banco', escopo: 'projeto', origem: '.claude.json' },
      { nome: 'tickets', escopo: 'projeto', origem: '.mcp.json' },
    ]);
    // O settings.local.json quebrado aparece como arquivo, sem derrubar nada.
    assert.deepEqual(r.configuracoes.map((c) => [c.arquivo, c.escopo]), [['settings.json', 'usuario'], ['settings.local.json', 'usuario'], ['settings.json', 'projeto'], ['.claude.json', 'usuario']]);
    assert.deepEqual(r.resumo.hooks, { total: 4, usuario: 3, projeto: 1 });
    assert.deepEqual(r.resumo.skills, { total: 3, usuario: 2, projeto: 1 });
    assert.deepEqual(r.resumo.mcp, { total: 4, usuario: 2, projeto: 2 });

    const json = JSON.stringify(r);
    for (const s of SEGREDOS) assert.ok(!json.includes(s), `vazou: ${s}`);
    assert.ok(!json.includes('credentials'), 'o .credentials.json nem aparece');
    assert.ok(!json.includes('oauthAccount') && !json.includes('emailAddress'));
  });

  test('duas pastas de usuário (perfis) dão duas raízes de usuário, com o nome da pasta no rótulo', async () => {
    const home = tmp();
    const a = montarHome(home, '/nao/existe');
    const b = pastaDeConfiguracao(join(home, '.claude-cliente'), 'nome', home);
    escrever(join(b.dir, 'skills', 'do-cliente', 'SKILL.md'), '---\ndescription: só do cliente\n---\n');
    escrever(b.claudeJson, JSON.stringify({ mcpServers: { cliente: {} } }));
    const r = await lerConfigDoAgente({ pastas: [a, b], projetos: [] });
    assert.equal(r.projeto, null);
    assert.deepEqual(
      r.raizes.map((x) => [x.id, x.rotulo, x.caminho]),
      [
        ['u0', 'Claude home · .claude', a.dir],
        ['c0', '.claude.json · .claude', a.claudeJson],
        ['u1', 'Claude home · .claude-cliente', b.dir],
        ['c1', '.claude.json · .claude-cliente', b.claudeJson],
      ],
    );
    assert.equal(r.skills.find((s) => s.nome === 'do-cliente')?.raiz, 'u1');
    assert.ok(r.mcp.some((m) => m.nome === 'cliente' && m.escopo === 'usuario'));
    assert.equal(r.resumo.skills.projeto, 0);
  });

  test('o projeto do pedido só vale se for um dos conhecidos; sem ele, o mais recente', () => {
    assert.equal(escolherProjeto(null, ['/a', '/b']), '/a');
    assert.equal(escolherProjeto('/b', ['/a', '/b']), '/b');
    assert.equal(escolherProjeto(undefined, []), null);
    assert.throws(() => escolherProjeto('/etc', ['/a']), (e) => e instanceof ErroDaConfig && e.status === 400);
  });

  test('um symlink de skill é listado (só leitura do frontmatter), sem derrubar a resposta', async () => {
    const home = tmp();
    const fora = tmp();
    escrever(join(fora, 'alvo', 'SKILL.md'), '---\nname: alvo\n---\n');
    const pasta = pastaDeConfiguracao(join(home, '.claude'), 'padrao', home);
    mkdirSync(join(pasta.dir, 'skills'), { recursive: true });
    symlinkSync(join(fora, 'alvo'), join(pasta.dir, 'skills', 'link'));
    const r = await lerConfigDoAgente({ pastas: [pasta], projetos: [] });
    assert.deepEqual(r.skills.map((s) => [s.nome, s.editavel]), [['link', false]]);
  });
});

describe('#63 projetos conhecidos', () => {
  test('os cwd das sessões, recentes primeiro, sem repetir, só pastas que existem', async () => {
    const t = tmp();
    const [a, b] = [join(t, 'a'), join(t, 'b')];
    mkdirSync(a);
    mkdirSync(b);
    const storage = openSqliteStorage({ path: ':memory:' });
    await storage.putSession(session({ id: 's1', cwd: a, updatedAt: '2026-10-01T00:00:00.000Z' }));
    await storage.putSession(session({ id: 's2', cwd: b, updatedAt: '2026-10-03T00:00:00.000Z' }));
    await storage.putSession(session({ id: 's3', cwd: a, updatedAt: '2026-10-02T00:00:00.000Z' }));
    await storage.putSession(session({ id: 's4', cwd: join(t, 'sumiu'), updatedAt: '2026-10-04T00:00:00.000Z' }));
    await storage.putSession(session({ id: 's5', cwd: 'relativo', updatedAt: '2026-10-05T00:00:00.000Z' }));
    assert.deepEqual(await projetosConhecidos(storage), [b, a]);
    assert.deepEqual(await projetosConhecidos(storage, 1), [b]);
    await storage.close();
  });
});

describe('#63 a pasta da --demo', () => {
  test('tem as quatro skills do wireframe, o projeto sintético e nada fora do temporário', async () => {
    const demo = montarConfigDaDemo(tmp());
    try {
      const r = await lerConfigDoAgente({ pastas: demo.pastas, projetos: [demo.projeto] });
      assert.equal(r.projeto, demo.projeto);
      assert.match(r.projeto!, /motor-de-regras$/);
      assert.deepEqual(r.skills.map((s) => [s.nome, s.escopo]).sort(), [['abrir-issue', 'projeto'], ['migracao-segura', 'projeto'], ['revisar-pr', 'usuario'], ['rodar-bateria', 'usuario']]);
      assert.equal(r.skills.find((s) => s.nome === 'revisar-pr')?.descricao, 'Revisa um PR contra o guia de estilo do projeto');
      assert.ok(r.subagentes.length >= 2 && r.comandos.length >= 2 && r.memoria.length >= 2);
      assert.ok(r.hooks.length > 0 && r.plugins.length > 0 && r.mcp.some((m) => m.origem === '.mcp.json'));
      for (const x of r.raizes) assert.ok(x.caminho.startsWith(demo.raiz), x.caminho);
    } finally {
      demo.apagar();
    }
  });
});

interface Resposta {
  status: number;
  corpo: string;
  json: Record<string, unknown>;
}

function pedir(url: string, caminho: string, { method = 'GET', headers = {} as Record<string, string>, corpo = '' } = {}): Promise<Resposta> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: caminho, method, headers }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (texto += p));
      res.on('end', () => {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(texto);
        } catch {}
        resolve({ status: res.statusCode ?? 0, corpo: texto, json });
      });
    });
    req.on('error', reject);
    req.end(corpo);
  });
}

describe('#63 /api/config e /api/config/skill', () => {
  let sqlite: SqliteStorage;
  let api: ApiLocal;
  let host: string;
  let t: string;
  let fora: string;
  let projeto: string;
  let backups: string;
  let home: ReturnType<typeof pastaDeConfiguracao>;
  const json = { 'content-type': 'application/json' };
  const postar = (corpo: unknown, headers: Record<string, string> = json) => pedir(api.url, '/api/config/skill', { method: 'POST', headers, corpo: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) });

  before(async () => {
    t = mkdtempSync(join(tmpdir(), 'config-http-'));
    fora = mkdtempSync(join(tmpdir(), 'config-fora-'));
    home = pastaDeConfiguracao(join(t, '.claude'), 'padrao', t);
    projeto = join(t, 'proj');
    backups = join(t, 'backups');
    escrever(join(home.dir, 'skills', 'revisar-pr', 'SKILL.md'), '---\nname: revisar-pr\ndescription: Revisa\n---\nversão antiga\n');
    escrever(home.claudeJson, JSON.stringify({ oauthAccount: { emailAddress: 'pessoa@exemplo.com' }, mcpServers: { docs: { env: { K: 'segredo-do-env-123' } } } }));
    mkdirSync(projeto);
    // Symlinks para fora da raiz: a pasta da skill e o SKILL.md.
    escrever(join(fora, 'alvo', 'SKILL.md'), 'de fora');
    symlinkSync(join(fora, 'alvo'), join(home.dir, 'skills', 'link-pasta'));
    mkdirSync(join(home.dir, 'skills', 'link-arquivo'));
    symlinkSync(join(fora, 'alvo', 'SKILL.md'), join(home.dir, 'skills', 'link-arquivo', 'SKILL.md'));

    sqlite = openSqliteStorage({ path: ':memory:' });
    const trabalho = new TrabalhoPorBranch({ fonte: null, cache: new GithubCache({ store: new SqliteCacheStore(sqlite.db) }) });
    const montador = new MontadorDoPainel({ storage: sqlite, contas: new Contas({ storage: sqlite, arquivo: null }), desktop: null, trabalho });
    const config = criarRotaDaConfig({ pastas: async () => [home], projetos: async () => [projeto], backups, agora: () => new Date('2026-10-20T12:34:56.789Z') });
    api = await iniciarApiLocal({ montador, hooks: { storage: sqlite }, port: 0, log: () => {}, config });
    host = new URL(api.url).host;
  });
  after(async () => {
    await api.close();
    await sqlite.close();
    rmSync(t, { recursive: true, force: true });
    rmSync(fora, { recursive: true, force: true });
  });

  test('GET /api/config: o contrato, sem segredos; a própria /ui pode ler; projeto desconhecido dá 400', async () => {
    const r = await pedir(api.url, '/api/config', { headers: { origin: `http://${host}` } });
    assert.equal(r.status, 200);
    assert.equal(r.json.projeto, projeto);
    assert.deepEqual(r.json.projetos, [projeto]);
    assert.equal(r.json.edicao, true);
    assert.equal(r.json.backups, backups, 'a pasta dos backups, para o botão Backups da tela');
    for (const chave of ['raizes', 'resumo', 'skills', 'subagentes', 'comandos', 'memoria', 'mcp', 'plugins', 'hooks', 'configuracoes']) assert.ok(chave in r.json, chave);
    assert.ok(!r.corpo.includes('segredo-do-env-123') && !r.corpo.includes('pessoa@exemplo.com'));
    assert.equal((await pedir(api.url, `/api/config?projeto=${encodeURIComponent(projeto)}`)).status, 200);
    assert.equal((await pedir(api.url, '/api/config?projeto=%2Fetc')).status, 400);
    assert.equal((await pedir(api.url, '/api/config', { method: 'POST', headers: json })).status, 405);
    assert.equal((await pedir(api.url, '/api/config', { headers: { origin: 'https://exemplo.com' } })).status, 403);
  });

  test('GET da skill: conteúdo e versão; 404 se não existe; 400 com nome ou raiz inválidos', async () => {
    const r = await pedir(api.url, '/api/config/skill?raiz=u0&nome=revisar-pr');
    assert.equal(r.status, 200);
    assert.equal(r.json.conteudo, '---\nname: revisar-pr\ndescription: Revisa\n---\nversão antiga\n');
    assert.equal(r.json.versao, versaoDe(r.json.conteudo as string));
    assert.equal(r.json.escopo, 'usuario');
    assert.equal(r.json.raiz, 'u0');
    assert.equal(r.json.nome, 'revisar-pr');
    assert.ok((r.json.editadoEm as number) > 0);
    assert.equal((await pedir(api.url, '/api/config/skill?raiz=u0&nome=nao-existe')).status, 404);
    assert.equal((await pedir(api.url, '/api/config/skill?raiz=p&nome=nao-existe')).status, 404);
    assert.equal((await pedir(api.url, '/api/config/skill?raiz=u0&nome=..')).status, 400);
    assert.equal((await pedir(api.url, '/api/config/skill?raiz=c0&nome=revisar-pr')).status, 400);
    assert.equal((await pedir(api.url, `/api/config/skill?raiz=${encodeURIComponent(home.dir)}&nome=revisar-pr`)).status, 400);
    assert.equal((await pedir(api.url, '/api/config/skill?raiz=u0&nome=link-pasta')).status, 403);
    assert.equal((await pedir(api.url, '/api/config/skill?raiz=u0&nome=link-arquivo')).status, 403);
  });

  test('POST troca a skill: backup com o conteúdo antigo antes, gravação atômica, nova versão', async () => {
    const antes = await pedir(api.url, '/api/config/skill?raiz=u0&nome=revisar-pr');
    const r = await postar({ raiz: 'u0', nome: 'revisar-pr', conteudo: 'versão nova\n', versao: antes.json.versao });
    assert.equal(r.status, 200, r.corpo);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.caminho, join(home.dir, 'skills', 'revisar-pr', 'SKILL.md'));
    assert.equal(r.json.versao, versaoDe('versão nova\n'));
    assert.equal(readFileSync(r.json.caminho as string, 'utf8'), 'versão nova\n');
    const backup = r.json.backup as string;
    assert.ok(backup.startsWith(join(backups, '2026-10-20') + '/'), backup);
    assert.match(backup, /\/revisar-pr\/SKILL\.md\.bak-2026-10-20T12-34-56-789Z-[0-9a-f]{6}$/);
    assert.equal(readFileSync(backup, 'utf8'), antes.json.conteudo);
    // Nenhum temporário ficou para trás.
    assert.deepEqual(readdirSync(join(home.dir, 'skills', 'revisar-pr')), ['SKILL.md']);
  });

  test('POST com versão que não bate dá 409 e não grava', async () => {
    const r = await postar({ raiz: 'u0', nome: 'revisar-pr', conteudo: 'por cima', versao: versaoDe('outra coisa') });
    assert.equal(r.status, 409);
    assert.notEqual(readFileSync(join(home.dir, 'skills', 'revisar-pr', 'SKILL.md'), 'utf8'), 'por cima');
    assert.equal((await postar({ raiz: 'u0', nome: 'nao-existe-ainda', conteudo: 'x', versao: versaoDe('x') })).status, 409);
    assert.ok(!existsSync(join(home.dir, 'skills', 'nao-existe-ainda', 'SKILL.md')));
  });

  test('POST de skill nova cria skills/<nome>/SKILL.md, sem backup; no projeto, cria a .claude', async () => {
    const r = await postar({ raiz: 'u0', nome: 'nova-skill', conteudo: '---\nname: nova-skill\n---\n' });
    assert.equal(r.status, 200, r.corpo);
    assert.equal(r.json.backup, null);
    assert.equal(readFileSync(join(home.dir, 'skills', 'nova-skill', 'SKILL.md'), 'utf8'), '---\nname: nova-skill\n---\n');
    const p = await postar({ raiz: 'p', nome: 'do-projeto', conteudo: 'oi', projeto });
    assert.equal(p.status, 200, p.corpo);
    assert.equal(readFileSync(join(projeto, '.claude', 'skills', 'do-projeto', 'SKILL.md'), 'utf8'), 'oi');
    const lista = await pedir(api.url, '/api/config');
    assert.ok((lista.json.skills as { nome: string; raiz: string }[]).some((s) => s.nome === 'do-projeto' && s.raiz === 'p'));
  });

  test('POST com criar: true só cria; se a skill já existe, 409 e nada muda (o "Nova" da tela)', async () => {
    const nova = await postar({ raiz: 'u0', nome: 'so-cria', conteudo: 'um', criar: true });
    assert.equal(nova.status, 200, nova.corpo);
    assert.equal(nova.json.backup, null);
    const outra = await postar({ raiz: 'u0', nome: 'so-cria', conteudo: 'dois', criar: true });
    assert.equal(outra.status, 409, outra.corpo);
    assert.equal(readFileSync(join(home.dir, 'skills', 'so-cria', 'SKILL.md'), 'utf8'), 'um');
  });

  test('a própria /ui grava (Origin igual a http://<Host>); Origin de outro site e Host estranho dão 403', async () => {
    const ok = await postar({ raiz: 'u0', nome: 'pela-ui', conteudo: 'x' }, { ...json, origin: `http://${host}` });
    assert.equal(ok.status, 200, ok.corpo);
    for (const origin of ['https://exemplo.com', 'null', `https://${host}`, 'http://localhost:1']) {
      assert.equal((await postar({ raiz: 'u0', nome: 'de-fora', conteudo: 'x' }, { ...json, origin })).status, 403, origin);
    }
    const porta = new URL(api.url).port;
    assert.equal((await postar({ raiz: 'u0', nome: 'de-fora', conteudo: 'x' }, { ...json, host: `exemplo.com:${porta}` })).status, 403);
    assert.equal((await postar({ raiz: 'u0', nome: 'de-fora', conteudo: 'x' }, { ...json, host: `exemplo.com:${porta}`, origin: `http://exemplo.com:${porta}` })).status, 403);
    assert.ok(!existsSync(join(home.dir, 'skills', 'de-fora')));
    // A exceção é só desta rota: outra escrita com Origin continua recusada.
    assert.equal((await pedir(api.url, '/api/decisoes/x/confirmar', { method: 'POST', headers: { ...json, origin: `http://${host}` }, corpo: '{}' })).status, 403);
  });

  test('defesas da gravação: JSON obrigatório, nome, raiz, symlink, tamanho', async () => {
    assert.equal((await postar({ raiz: 'u0', nome: 'x', conteudo: 'x' }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await postar({ raiz: 'u0', nome: 'x', conteudo: 'x' }, {})).status, 415);
    assert.equal((await postar('não é json')).status, 400);
    assert.equal((await postar('[]')).status, 400);
    for (const nome of ['..', 'a..b', 'x/../../evil', '../evil', 'SKILL.md/x', 'Maiuscula', '', '-comeca-com-hifen', 'a'.repeat(65), 7]) {
      assert.equal((await postar({ raiz: 'u0', nome, conteudo: 'x' })).status, 400, String(nome));
    }
    assert.ok(!existsSync(join(t, 'evil')) && !existsSync(join(home.dir, 'evil')));
    for (const raiz of ['zz', 'c0', 'r', home.dir, '/tmp', null]) {
      assert.equal((await postar({ raiz, nome: 'ok', conteudo: 'x' })).status, 400, String(raiz));
    }
    assert.equal((await postar({ raiz: 'p', nome: 'ok', conteudo: 'x', projeto: '/etc' })).status, 400);
    // Symlink para fora: a pasta da skill e o próprio SKILL.md.
    const pasta = await postar({ raiz: 'u0', nome: 'link-pasta', conteudo: 'invadiu' });
    assert.equal(pasta.status, 403);
    assert.match(String(pasta.json.error), /fora da raiz/);
    const arquivo = await postar({ raiz: 'u0', nome: 'link-arquivo', conteudo: 'invadiu' });
    assert.equal(arquivo.status, 403);
    assert.match(String(arquivo.json.error), /symlink/);
    assert.equal(readFileSync(join(fora, 'alvo', 'SKILL.md'), 'utf8'), 'de fora');
    // Conteúdo: texto, até MAX_CONTEUDO.
    assert.equal((await postar({ raiz: 'u0', nome: 'ok', conteudo: 42 })).status, 400);
    assert.equal((await postar({ raiz: 'u0', nome: 'grande', conteudo: 'a'.repeat(MAX_CONTEUDO + 1) })).status, 413);
    assert.equal((await postar({ raiz: 'u0', nome: 'no-limite', conteudo: 'a'.repeat(MAX_CONTEUDO) })).status, 200);
  });

  test('duas gravações juntas com a mesma versão: uma passa, a outra dá 409', async () => {
    const lida = await pedir(api.url, '/api/config/skill?raiz=u0&nome=nova-skill');
    const [a, b] = await Promise.all([
      postar({ raiz: 'u0', nome: 'nova-skill', conteudo: 'aba A', versao: lida.json.versao }),
      postar({ raiz: 'u0', nome: 'nova-skill', conteudo: 'aba B', versao: lida.json.versao }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const venceu = a.status === 200 ? 'aba A' : 'aba B';
    assert.equal(readFileSync(join(home.dir, 'skills', 'nova-skill', 'SKILL.md'), 'utf8'), venceu);
  });

  test('a .claude do projeto como symlink para fora do projeto é recusada', async () => {
    const t3 = mkdtempSync(join(tmpdir(), 'config-claude-link-'));
    try {
      const proj = join(t3, 'clonado');
      mkdirSync(proj);
      mkdirSync(join(t3, 'outra'));
      symlinkSync(join(t3, 'outra'), join(proj, '.claude'));
      const rota = criarRotaDaConfig({ pastas: async () => [], projetos: async () => [proj], backups: join(t3, 'b') });
      const sqlite3 = openSqliteStorage({ path: ':memory:' });
      const montador = new MontadorDoPainel({ storage: sqlite3, contas: new Contas({ storage: sqlite3, arquivo: null }), desktop: null, trabalho: new TrabalhoPorBranch({ fonte: null, cache: new GithubCache({ store: new SqliteCacheStore(sqlite3.db) }) }) });
      const api3 = await iniciarApiLocal({ montador, hooks: { storage: sqlite3 }, port: 0, log: () => {}, config: rota });
      try {
        const r = await pedir(api3.url, '/api/config/skill', { method: 'POST', headers: json, corpo: JSON.stringify({ raiz: 'p', nome: 'nova', conteudo: 'x' }) });
        assert.equal(r.status, 403, r.corpo);
        assert.ok(!existsSync(join(t3, 'outra', 'skills')));
      } finally {
        await api3.close();
        await sqlite3.close();
      }
    } finally {
      rmSync(t3, { recursive: true, force: true });
    }
  });

  test('a pasta skills inteira como symlink para fora também é recusada', async () => {
    const t2 = mkdtempSync(join(tmpdir(), 'config-skills-link-'));
    try {
      const h2 = pastaDeConfiguracao(join(t2, '.claude'), 'padrao', t2);
      mkdirSync(h2.dir);
      symlinkSync(fora, join(h2.dir, 'skills'));
      const rota = criarRotaDaConfig({ pastas: async () => [h2], projetos: async () => [], backups: join(t2, 'b') });
      const sqlite2 = openSqliteStorage({ path: ':memory:' });
      const montador = new MontadorDoPainel({ storage: sqlite2, contas: new Contas({ storage: sqlite2, arquivo: null }), desktop: null, trabalho: new TrabalhoPorBranch({ fonte: null, cache: new GithubCache({ store: new SqliteCacheStore(sqlite2.db) }) }) });
      const api2 = await iniciarApiLocal({ montador, hooks: { storage: sqlite2 }, port: 0, log: () => {}, config: rota });
      try {
        const r = await pedir(api2.url, '/api/config/skill', { method: 'POST', headers: json, corpo: JSON.stringify({ raiz: 'u0', nome: 'nova', conteudo: 'x' }) });
        assert.equal(r.status, 403, r.corpo);
        assert.match(String(r.json.error), /fora da raiz/);
        assert.ok(!existsSync(join(fora, 'nova')));
      } finally {
        await api2.close();
        await sqlite2.close();
      }
    } finally {
      rmSync(t2, { recursive: true, force: true });
    }
  });
});
