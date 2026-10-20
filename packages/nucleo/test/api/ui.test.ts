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
import { ErroDeLeitura, leitorHttp } from '../../ui/ler.js';
// @ts-expect-error: idem
import { iniciarAoVivo } from '../../ui/ao-vivo.js';
// @ts-expect-error: idem
import { acharTela, TELAS } from '../../ui/telas.js';

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
    for (const caminho of ['/ui', '/ui/', '/ui/sessoes', `/ui/sessoes/${SESSAO_DO_PAINEL}`, '/ui/qualquer/coisa']) {
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
      assert.doesNotMatch(texto, /\sstyle\s*=|\.style\.|setAttribute\(\s*['"]style/, `${a} usa estilo inline`);
      if (a !== 'ler.js') assert.doesNotMatch(texto, /\bfetch\(/, `${a} chama fetch: só ler.js fala com o núcleo`);
      // `innerHTML` só nos ícones (constantes de dom.js), nunca com dado.
      if (a !== 'dom.js') assert.doesNotMatch(texto, /innerHTML|outerHTML|insertAdjacentHTML/, `${a} monta HTML com texto`);
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
  test('a barra tem Dashboard, Sessões e Decisões; o Detalhe abre por uma sessão e acende Sessões', () => {
    assert.deepEqual(TELAS.filter((t: { item?: unknown }) => t.item).map((t: { id: string }) => t.id), ['dashboard', 'sessoes', 'decisoes']);
    assert.equal(acharTela('/ui/decisoes').tela.arquivo, '/ui/telas/decisoes.js');
    assert.equal(acharTela('/ui').tela.id, 'dashboard');
    assert.equal(acharTela('/ui/').tela.id, 'dashboard');
    assert.equal(acharTela('/ui/sessoes').tela.id, 'sessoes');
    const d = acharTela('/ui/sessoes/b91d04aa-4e1');
    assert.equal(d.tela.id, 'detalhe');
    assert.equal(d.tela.acende, 'sessoes');
    assert.deepEqual(d.params, { id: 'b91d04aa-4e1' });
    assert.equal(acharTela('/ui/sessoes/a%20b'), null);
    assert.equal(acharTela('/ui/kanban'), null);
  });
});
