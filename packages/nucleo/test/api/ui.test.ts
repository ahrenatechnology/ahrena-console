// A interface do console em /ui (#26): o servidor serve a página e as sub-rotas, recusa Origin e Host
// estranhos (decisão 0003), e a camada de leitura e o "Ao vivo" funcionam contra a API com dados do
// simulador.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, TrabalhoPorBranch, type ApiLocal } from '../../src/api/index.ts';
import { PASTA_DA_UI } from '../../src/api/ui.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { comMudancas, CursorDeMudancas } from '../../src/mudancas/index.ts';
import { semearCenariosDoPainel, SESSAO_DO_PAINEL } from '../../src/simulador/painel.ts';
// @ts-expect-error: módulos do navegador, em JavaScript puro
import { ErroDeLeitura, escritorHttp, leitorHttp } from '../../ui/ler.js';
// @ts-expect-error: idem
import { iniciarAoVivo } from '../../ui/ao-vivo.js';
// @ts-expect-error: idem
import { acharTela, TELAS } from '../../ui/telas.js';
// @ts-expect-error: idem
import * as agentConfigScreen from '../../ui/telas/agent-config.js';

interface Resposta {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  corpo: string;
}

function pedir(url: string, caminho: string, { method = 'GET', headers = {} as Record<string, string>, corpo = '' } = {}): Promise<Resposta> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: caminho, method, headers }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (texto += p));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, corpo: texto }));
    });
    req.on('error', reject);
    req.end(corpo);
  });
}

const ate = async (cond: () => boolean, ms = 3000) => {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error('não aconteceu a tempo');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('/ui no núcleo', () => {
  let sqlite: SqliteStorage;
  let cursor: CursorDeMudancas;
  let api: ApiLocal;
  let host: string;
  before(async () => {
    cursor = new CursorDeMudancas({ agruparMs: 0, intervaloMinimoMs: 0 });
    sqlite = openSqliteStorage({ path: ':memory:' });
    const storage = comMudancas(sqlite, cursor);
    await semearCenariosDoPainel(storage, 'p1');
    const trabalho = new TrabalhoPorBranch({ fonte: null, cache: new GithubCache({ store: new SqliteCacheStore(sqlite.db) }) });
    const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, mudancas: cursor });
    host = new URL(api.url).host;
  });
  after(async () => {
    await api.close();
    await sqlite.close();
  });

  test('/ui, /ui/sessoes e /ui/sessoes/<id> devolvem a mesma página, com a política de conteúdo', async () => {
    const pagina = readFileSync(`${PASTA_DA_UI}index.html`, 'utf8');
    for (const caminho of ['/ui', '/ui/', '/ui/sessoes', `/ui/sessoes/${SESSAO_DO_PAINEL}`, '/ui/qualquer/coisa', '/ui/agent-config', '/ui/agent-config?tab=skills&project=%2Fx']) {
      const r = await pedir(api.url, caminho);
      assert.equal(r.status, 200, caminho);
      assert.match(String(r.headers['content-type']), /^text\/html/);
      assert.equal(r.corpo, pagina, caminho);
      assert.match(String(r.headers['content-security-policy']), /connect-src 'self'/);
      assert.match(String(r.headers['content-security-policy']), /default-src 'none'/);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
  });

  test('os arquivos da página saem com o tipo certo; o que não existe ou está fora da pasta dá 404', async () => {
    const js = await pedir(api.url, '/ui/app.js');
    assert.equal(js.status, 200);
    assert.match(String(js.headers['content-type']), /^text\/javascript/);
    assert.match(String((await pedir(api.url, '/ui/marca.css')).headers['content-type']), /^text\/css/);
    // The Agent Config screen (#63): the module in telas/ and its own CSS.
    const screen = await pedir(api.url, '/ui/telas/agent-config.js');
    assert.equal(screen.status, 200);
    assert.match(String(screen.headers['content-type']), /^text\/javascript/);
    assert.match(screen.corpo, /export async function montar/);
    const css = await pedir(api.url, '/ui/agent-config.css');
    assert.equal(css.status, 200);
    assert.match(String(css.headers['content-type']), /^text\/css/);
    for (const caminho of ['/ui/nada.js', '/ui/telas/nada.js', '/ui/index.html', '/ui/README.md', '/ui/%2e%2e/src/api/ui.ts', '/ui/..%2fpackage.json']) {
      const r = await pedir(api.url, caminho);
      assert.ok(r.status === 404 || r.corpo.startsWith('<!doctype html>'), `${caminho}: ${r.status}`);
      assert.doesNotMatch(r.corpo, /import \{ readFile \}|"name": "@ahrena-console/, caminho);
    }
  });

  test('Origin estranho dá 403, na página e na API; a própria página pode ler', async () => {
    for (const origin of ['https://exemplo.com', 'null', `http://localhost:1`, `https://${host}`]) {
      assert.equal((await pedir(api.url, '/ui', { headers: { origin } })).status, 403, origin);
      assert.equal((await pedir(api.url, '/api/mudancas?desde=&espera=0', { headers: { origin } })).status, 403, origin);
    }
    assert.equal((await pedir(api.url, '/ui', { headers: { host: `exemplo.com:${new URL(api.url).port}` } })).status, 403);
    // Navegador lendo da mesma origem: aceito.
    assert.equal((await pedir(api.url, '/api/overview', { headers: { origin: `http://${host}` } })).status, 200);
    // Escrita com Origin, mesmo o nosso: recusada.
    const hook = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    assert.equal((await pedir(api.url, '/api/hooks', { method: 'POST', headers: { origin: `http://${host}`, 'content-type': 'application/json' }, corpo: hook })).status, 403);
  });

  test('a página não chama nada fora da própria origem e não escreve cor à mão', () => {
    // A pasta e as telas (`telas/`): as regras valem para todo arquivo servido.
    const arquivos = readdirSync(PASTA_DA_UI, { recursive: true })
      .map(String)
      .filter((a) => /\.(js|css|html)$/.test(a) && a !== 'marca.css');
    assert.ok(arquivos.includes('index.html') && arquivos.includes('app.js'));
    for (const a of arquivos) {
      const texto = readFileSync(`${PASTA_DA_UI}${a}`, 'utf8');
      const urls = (texto.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
      assert.deepEqual(urls, [], `${a} cita endereço externo`);
      assert.doesNotMatch(texto, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${a} escreve cor à mão`);
      assert.doesNotMatch(texto, /\sstyle\s*=|setAttribute\(\s*['"]style/, `${a} usa estilo inline`);
      if (a !== 'ler.js') assert.doesNotMatch(texto, /\bfetch\(/, `${a} chama fetch: só ler.js fala com o núcleo`);
      // `innerHTML` só nos ícones (constantes de dom.js), nunca com dado.
      if (a !== 'dom.js') assert.doesNotMatch(texto, /innerHTML|outerHTML|insertAdjacentHTML/, `${a} monta HTML com texto`);
    }
    // As telas, em ui/telas/: a mesma regra, e nada de estilo inline, innerHTML ou fetch direto.
    const telas = readdirSync(`${PASTA_DA_UI}telas`).filter((a) => /\.(js|css)$/.test(a));
    for (const a of telas) {
      const texto = readFileSync(`${PASTA_DA_UI}telas/${a}`, 'utf8');
      const urls = (texto.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
      assert.deepEqual(urls, [], `telas/${a} cita endereço externo`);
      assert.doesNotMatch(texto, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `telas/${a} escreve cor à mão`);
      if (a.endsWith('.js')) {
        // O que a CSP (`style-src 'self'`) bloqueia é o atributo `style`: `{ style: … }` no el(),
        // `style="…"` e `setAttribute('style', …)`. O CSSOM (`x.style.setProperty`) ela deixa passar.
        assert.doesNotMatch(texto, /(?<![.\w-])style\s*[=:]|['"]style['"]|innerHTML|insertAdjacentHTML|\bfetch\(/, `telas/${a} usa estilo inline, HTML ou fetch`);
        for (const [, css] of texto.matchAll(/href: '\/ui\/telas\/([a-z0-9-]+\.css)'/g)) assert.ok(telas.includes(css!), `telas/${a} carrega ${css}, que não existe`);
      }
    }
    const pagina = readFileSync(`${PASTA_DA_UI}index.html`, 'utf8');
    for (const [, ref] of pagina.matchAll(/(?:href|src)="\/ui\/([^"]+)"/g)) assert.ok(readdirSync(PASTA_DA_UI).includes(ref!), `index.html cita ${ref}, que não existe`);
  });

  test('ler(rota) lê a API por HTTP e só a API do núcleo local', async () => {
    const ler = leitorHttp({ base: api.url });
    const overview = await ler('/api/overview');
    assert.equal(overview.nome, 'ahrena-console');
    const painel = await ler(`/api/painel/${SESSAO_DO_PAINEL}`);
    assert.ok(JSON.stringify(painel).includes(SESSAO_DO_PAINEL), 'o painel da sessão do simulador');

    await assert.rejects(ler('/api/nao-existe'), (e: InstanceType<typeof ErroDeLeitura>) => e instanceof ErroDeLeitura && e.status === 404);
    await assert.rejects(ler('/ui'), /rota fora da API/);
    await assert.rejects(ler('https://exemplo.com/api/overview'), /rota fora da API/);
    await assert.rejects(ler('/api/../../ui'), /rota fora do núcleo/);
    assert.throws(() => leitorHttp({ base: 'http://exemplo.com:4720' }), /só lê o núcleo local/);
    assert.throws(() => leitorHttp({ base: 'https://127.0.0.1:4720' }), /só lê o núcleo local/);

    const fechado = leitorHttp({ base: 'http://127.0.0.1:1' });
    await assert.rejects(fechado('/api/overview'), (e: InstanceType<typeof ErroDeLeitura>) => e.status === 0 && /não respondeu/.test(e.message));
  });

  test('Ao vivo: conecta com reiniciar, entrega a mudança de um hook e para', async () => {
    const estados: string[] = [];
    const mudancas: { tipo: string; chave: string }[][] = [];
    let reiniciou = 0;
    const vivo = iniciarAoVivo({
      ler: leitorHttp({ base: api.url }),
      espera: 5,
      aoEstado: ({ estado }: { estado: string }) => estados.push(estado),
      aoReiniciar: () => reiniciou++,
      aoMudar: (m: { tipo: string; chave: string }[]) => mudancas.push(m),
    });
    await ate(() => reiniciou === 1 && cursor.abertas === 1);
    assert.deepEqual(estados, ['ao-vivo']);

    const hook = { session_id: 'sess-ui', hook_event_name: 'SessionStart', cwd: '/repo/app', source: 'startup', model: 'claude-opus-5-5', transcript_path: '/x.jsonl' };
    const h = await fetch(`${api.url}/api/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hook) });
    assert.equal(h.status, 202);
    await ate(() => mudancas.flat().some((m) => m.tipo === 'sessao' && m.chave === 'sess-ui'));
    assert.equal(reiniciou, 1, 'mudança comum não pede releitura');

    await vivo.parar();
    await ate(() => cursor.abertas === 0);
  });

  test('Ao vivo: sem o núcleo mostra a falha, tenta de novo e relê quando volta', async () => {
    const estados: string[] = [];
    const esperas: number[] = [];
    let reiniciou = 0;
    let fora = 3;
    const real = leitorHttp({ base: api.url });
    const vivo = iniciarAoVivo({
      ler: (rota: string, o: unknown) => (fora-- > 0 ? leitorHttp({ base: 'http://127.0.0.1:1' })(rota, o) : real(rota, o)),
      espera: 5,
      atrasos: [10, 20],
      dormir: (ms: number) => (esperas.push(ms), Promise.resolve()),
      aoEstado: ({ estado }: { estado: string }) => estados.push(estado),
      aoReiniciar: () => reiniciou++,
    });
    await ate(() => reiniciou === 1);
    assert.deepEqual(esperas, [10, 20, 20]);
    assert.equal(estados[0], 'sem-conexao');
    assert.equal(estados.at(-1), 'ao-vivo');
    assert.ok(vivo.estado === 'ao-vivo');
    await vivo.parar();
  });

  test('Ao vivo: 503 com Retry-After espera o que o núcleo pediu', async () => {
    const esperas: number[] = [];
    let n = 0;
    const vivo = iniciarAoVivo({
      ler: async () => {
        if (n++ === 0) throw new ErroDeLeitura('lotado', { status: 503, tentarEm: 5000 });
        await new Promise((r) => setTimeout(r, 5));
        return { cursor: 'c', mudancas: [], reiniciar: true, expirou: false };
      },
      dormir: (ms: number) => (esperas.push(ms), Promise.resolve()),
    });
    await ate(() => n >= 2);
    assert.deepEqual(esperas, [5000]);
    await vivo.parar();
  });
});

describe('registro das telas', () => {
  test('a barra tem Dashboard, Mural ao vivo, Sessões, o Feed, Kanban, o Kanban do projeto, Analytics, Workflows, Histórico, Decisões e Agent Config; o Detalhe abre por uma sessão e acende Sessões', () => {
    assert.deepEqual(TELAS.filter((t: { item?: unknown }) => t.item).map((t: { id: string }) => t.id), ['dashboard', 'mural', 'sessoes', 'feed', 'kanban', 'projeto', 'analytics', 'workflows', 'historico', 'decisoes', 'agent-config']);
    assert.equal(acharTela('/ui/decisoes').tela.arquivo, '/ui/telas/decisoes.js');
    assert.equal(acharTela('/ui/mural').tela.id, 'mural');
    assert.equal(acharTela('/ui/workflows').tela.id, 'workflows');
    assert.equal(acharTela('/ui/feed').tela.arquivo, '/ui/telas/feed.js');
    assert.equal(acharTela('/ui').tela.id, 'dashboard');
    assert.equal(acharTela('/ui/').tela.id, 'dashboard');
    assert.equal(acharTela('/ui/sessoes').tela.id, 'sessoes');
    assert.equal(acharTela('/ui/historico').tela.id, 'historico');
    const d = acharTela('/ui/sessoes/b91d04aa-4e1');
    assert.equal(d.tela.id, 'detalhe');
    assert.equal(d.tela.acende, 'sessoes');
    assert.deepEqual(d.params, { id: 'b91d04aa-4e1' });
    assert.equal(acharTela('/ui/sessoes/a%20b'), null);
    assert.equal(acharTela('/ui/kanban').tela.id, 'kanban');
    assert.equal(acharTela('/ui/nao-existe'), null);
  });
});

describe('escrever(rota, corpo): the /ui write (#63)', () => {
  test('POSTs JSON to its own origin; an error becomes ErroDeLeitura with the status; only the local core API', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const responses = [new Response(JSON.stringify({ ok: true, backup: '/b/x' }), { status: 200 }), new Response(JSON.stringify({ error: 'a skill mudou desde a leitura' }), { status: 409 })];
    const write = escritorHttp({ base: 'http://127.0.0.1:4720', fetch: async (url: URL, init: RequestInit) => (requests.push({ url: String(url), init }), responses.shift()!) });
    assert.deepEqual(await write('/api/agent-config/skill', { root: 'u0', name: 'x', content: 'oi' }), { ok: true, backup: '/b/x' });
    assert.equal(requests[0]!.url, 'http://127.0.0.1:4720/api/agent-config/skill');
    assert.equal(requests[0]!.init.method, 'POST');
    assert.equal((requests[0]!.init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { root: 'u0', name: 'x', content: 'oi' });
    assert.equal(requests[0]!.init.credentials, 'omit');
    await assert.rejects(write('/api/agent-config/skill', {}), (e: InstanceType<typeof ErroDeLeitura>) => e instanceof ErroDeLeitura && e.status === 409 && /mudou/.test(e.message));
    await assert.rejects(write('/ui', {}), /rota fora da API/);
    await assert.rejects(write('/api/../../ui', {}), /rota fora do núcleo/);
    assert.throws(() => escritorHttp({ base: 'http://exemplo.com:4720' }), /só escreve no núcleo local/);
    assert.equal(requests.length, 2);
  });
});

describe('Agent Config screen (#63): registration and pure functions', () => {
  // Each screen's CSS stays loaded after it opens once: a selector without the screen's own class
  // (`ac-…`) would leak into the other screens (/ui rules, item 1).
  test('every selector in agent-config.css goes through an ac- class', () => {
    const css = readFileSync(`${PASTA_DA_UI}agent-config.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1]!.split(',')).map((s) => s.trim()).filter((s) => s && !s.startsWith('@') && !/^(from|to|\d+%)$/.test(s));
    assert.ok(selectors.length > 20);
    assert.deepEqual(selectors.filter((s) => !s.includes('.ac-')), []);
  });

  test('registered at /ui/agent-config, with the Agent Config item (bot icon) and the file in telas/', () => {
    const found = acharTela('/ui/agent-config');
    assert.equal(found.tela.id, 'agent-config');
    assert.equal(found.tela.arquivo, '/ui/telas/agent-config.js');
    assert.deepEqual(found.tela.item, { rotulo: 'Agent Config', icone: 'bot' });
    assert.equal(acharTela('/ui/agent-config/').tela.id, 'agent-config');
  });

  test('tab and project in the URL, round trip', () => {
    const { readUrl, urlFor } = agentConfigScreen;
    assert.deepEqual(readUrl(''), { tab: 'overview', project: null });
    assert.deepEqual(readUrl('?tab=skills&project=%2Fa%2Fb'), { tab: 'skills', project: '/a/b' });
    assert.deepEqual(readUrl('?tab=made-up'), { tab: 'overview', project: null });
    assert.equal(urlFor({ tab: 'overview' }), '/ui/agent-config');
    assert.equal(urlFor({ tab: 'skills', project: '/a b' }), '/ui/agent-config?tab=skills&project=%2Fa+b');
    assert.deepEqual(readUrl(urlFor({ tab: 'hooks', project: '/x/y' }).split('?')[1]), { tab: 'hooks', project: '/x/y' });
  });

  test('scope and search filter on the client', () => {
    const { inScope, searchSkills } = agentConfigScreen;
    const skills = [
      { name: 'revisar-pr', declaredName: null, description: 'Revisa um PR contra o guia', scope: 'user' },
      { name: 'migracao-segura', declaredName: 'Migração', description: 'Escreve migrações com volta', scope: 'project' },
    ];
    assert.equal(inScope(skills, 'all').length, 2);
    assert.deepEqual(inScope(skills, 'project').map((s: { name: string }) => s.name), ['migracao-segura']);
    assert.deepEqual(searchSkills(skills, '  MIGRAÇÃO ').map((s: { name: string }) => s.name), ['migracao-segura']);
    assert.deepEqual(searchSkills(skills, 'guia').map((s: { name: string }) => s.name), ['revisar-pr']);
    assert.equal(searchSkills(skills, '').length, 2);
  });

  test('"editado há N dias"', () => {
    const { editedAgo } = agentConfigScreen;
    const now = Date.parse('2026-10-20T12:00:00Z');
    assert.equal(editedAgo(now - 10_000, now), 'editado agora');
    assert.equal(editedAgo(now + 60_000, now), 'editado agora');
    assert.equal(editedAgo(now - 5 * 60_000, now), 'editado há 5 min');
    assert.equal(editedAgo(now - 3 * 3600_000, now), 'editado há 3 h');
    assert.equal(editedAgo(now - 26 * 3600_000, now), 'editado há 1 dia');
    assert.equal(editedAgo(now - 3 * 86400_000, now), 'editado há 3 dias');
    assert.equal(editedAgo(undefined, now), '');
  });

  test("a new skill's name follows the core's pattern and does not repeat the folder", async () => {
    const { validateSkillName, SKILL_NAME, skillTemplate } = agentConfigScreen;
    const { SKILL_NAME: fromCore } = await import('../../src/agent-config/skills.ts');
    assert.equal(String(SKILL_NAME), String(fromCore));
    assert.equal(validateSkillName('revisar-pr'), null);
    assert.equal(validateSkillName('v1.2_ok'), null);
    assert.match(validateSkillName(''), /Dê um nome/);
    for (const bad of ['Maiuscula', '-comeca', 'com espaco', 'a/b', '..', 'x'.repeat(65)]) assert.match(validateSkillName(bad), /minúsculas/, bad);
    assert.match(validateSkillName('revisar-pr', new Set(['revisar-pr'])), /Já existe/);
    assert.match(skillTemplate('minha'), /^---\nname: minha\ndescription: .+\n---\n/);
  });

  test('the summary: total and "N do usuário · M do projeto", or the filtered scope', () => {
    const { countFor, captionFor } = agentConfigScreen;
    const c = { total: 24, user: 18, project: 6 };
    assert.equal(countFor(c, 'all'), 24);
    assert.equal(countFor(c, 'user'), 18);
    assert.equal(countFor(c, 'project'), 6);
    assert.equal(captionFor(c, 'all'), '18 do usuário · 6 do projeto');
    assert.equal(captionFor(c, 'project'), 'do projeto');
  });
});
