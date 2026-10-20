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
import { ReadError, httpWriter, httpReader } from '../../ui/api.js';
// @ts-expect-error: idem
import { startLive } from '../../ui/live.js';
// @ts-expect-error: idem
import { findScreen, legacyUrl, litItem, machineItems, MACHINES_ROUTE, SECTIONS, sidebarSections, SCREENS } from '../../ui/screens.js';
// @ts-expect-error: idem
import * as agentConfigScreen from '../../ui/screens/agent-config.js';

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

  test('/ui, /ui/sessions and /ui/sessions/<id> (and the old /ui/sessoes/<id>) return the same page, with the content policy', async () => {
    const pagina = readFileSync(`${PASTA_DA_UI}index.html`, 'utf8');
    for (const caminho of ['/ui', '/ui/', '/ui/sessions', `/ui/sessions/${SESSAO_DO_PAINEL}`, '/ui/sessoes', `/ui/sessoes/${SESSAO_DO_PAINEL}`, '/ui/historico', '/ui/analytics/custo', '/ui/qualquer/coisa', '/ui/agent-config', '/ui/agent-config?tab=skills&project=%2Fx']) {
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
    assert.match(String((await pedir(api.url, '/ui/brand.css')).headers['content-type']), /^text\/css/);
    // The Agent Config screen (#63): the module in screens/ and its own CSS.
    const screen = await pedir(api.url, '/ui/screens/agent-config.js');
    assert.equal(screen.status, 200);
    assert.match(String(screen.headers['content-type']), /^text\/javascript/);
    assert.match(screen.corpo, /export async function mount/);
    // The old folder (`/ui/telas/`) serves the same file until the aliases leave (#173).
    const legacy = await pedir(api.url, '/ui/telas/agent-config.js');
    assert.equal(legacy.status, 200);
    assert.match(String(legacy.headers['content-type']), /^text\/javascript/);
    assert.equal(legacy.corpo, screen.corpo);
    assert.equal((await pedir(api.url, '/ui/telas/nada.js')).status, 404);
    const css = await pedir(api.url, '/ui/agent-config.css');
    assert.equal(css.status, 200);
    assert.match(String(css.headers['content-type']), /^text\/css/);
    for (const caminho of ['/ui/nada.js', '/ui/screens/nada.js', '/ui/index.html', '/ui/README.md', '/ui/%2e%2e/src/api/ui.ts', '/ui/..%2fpackage.json']) {
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

  // Endereços que só viram `href` de link aberto pela pessoa (nova aba, `noopener`), nunca chamada:
  // a aba Instruções (#183) aponta para o arquivo no GitHub e para a documentação do CLAUDE.md.
  const LINK_TARGETS: Record<string, string[]> = {
    'screens/agent-instructions.js': ['https://docs.claude.com/en/docs/claude-code/memory'],
    'screens/agent-instructions-markdown.js': ['https://github.com/$'],
  };
  test('a página não chama nada fora da própria origem e não escreve cor à mão', () => {
    // A pasta e as telas (`screens/`): as regras valem para todo arquivo servido.
    const arquivos = readdirSync(PASTA_DA_UI, { recursive: true })
      .map(String)
      .filter((a) => /\.(js|css|html)$/.test(a) && a !== 'brand.css');
    assert.ok(arquivos.includes('index.html') && arquivos.includes('app.js') && arquivos.includes('screens/repos.js'));
    for (const a of arquivos) {
      const texto = readFileSync(`${PASTA_DA_UI}${a}`, 'utf8');
      const urls = (texto.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg' && !(LINK_TARGETS[a] ?? []).some((l) => u.startsWith(l)));
      assert.deepEqual(urls, [], `${a} cita endereço externo`);
      assert.doesNotMatch(texto, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `${a} escreve cor à mão`);
      assert.doesNotMatch(texto, /\sstyle\s*=|setAttribute\(\s*['"]style/, `${a} usa estilo inline`);
      if (a !== 'api.js') assert.doesNotMatch(texto, /\bfetch\(/, `${a} chama fetch: só api.js fala com o núcleo`);
      // `innerHTML` só nos ícones (constantes de dom.js), nunca com dado.
      if (a !== 'dom.js') assert.doesNotMatch(texto, /innerHTML|outerHTML|insertAdjacentHTML/, `${a} monta HTML com texto`);
    }
    // As telas, em ui/screens/: a mesma regra, e nada de estilo inline, innerHTML ou fetch direto.
    const telas = readdirSync(`${PASTA_DA_UI}screens`).filter((a) => /\.(js|css)$/.test(a));
    for (const a of telas) {
      const texto = readFileSync(`${PASTA_DA_UI}screens/${a}`, 'utf8');
      const urls = (texto.match(/https?:\/\/[^\s"'`)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg' && !(LINK_TARGETS[`screens/${a}`] ?? []).some((l) => u.startsWith(l)));
      assert.deepEqual(urls, [], `screens/${a} cita endereço externo`);
      assert.doesNotMatch(texto, /#[0-9a-f]{3,8}\b(?![\w-])|rgba?\(|hsla?\(/i, `screens/${a} escreve cor à mão`);
      if (a.endsWith('.js')) {
        // O que a CSP (`style-src 'self'`) bloqueia é o atributo `style`: `{ style: … }` no el(),
        // `style="…"` e `setAttribute('style', …)`. O CSSOM (`x.style.setProperty`) ela deixa passar.
        assert.doesNotMatch(texto, /(?<![.\w-])style\s*[=:]|['"]style['"]|innerHTML|insertAdjacentHTML|\bfetch\(/, `screens/${a} usa estilo inline, HTML ou fetch`);
        for (const [, css] of texto.matchAll(/href: '\/ui\/telas\/([a-z0-9-]+\.css)'/g)) assert.ok(telas.includes(css!), `screens/${a} carrega ${css}, que não existe`);
      }
    }
    const pagina = readFileSync(`${PASTA_DA_UI}index.html`, 'utf8');
    for (const [, ref] of pagina.matchAll(/(?:href|src)="\/ui\/([^"]+)"/g)) assert.ok(readdirSync(PASTA_DA_UI).includes(ref!), `index.html cita ${ref}, que não existe`);
  });

  test('ler(rota) lê a API por HTTP e só a API do núcleo local', async () => {
    const read = httpReader({ base: api.url });
    const overview = await read('/api/overview');
    assert.equal(overview.name, 'ahrena-console');
    // `nome` stays beside `name` until phase 6 of #173: the installed app reads it.
    assert.equal(overview.nome, 'ahrena-console');
    const painel = await read(`/api/painel/${SESSAO_DO_PAINEL}`);
    assert.ok(JSON.stringify(painel).includes(SESSAO_DO_PAINEL), 'o painel da sessão do simulador');

    await assert.rejects(read('/api/nao-existe'), (e: InstanceType<typeof ReadError>) => e instanceof ReadError && e.status === 404);
    await assert.rejects(read('/ui'), /rota fora da API/);
    await assert.rejects(read('https://exemplo.com/api/overview'), /rota fora da API/);
    await assert.rejects(read('/api/../../ui'), /rota fora do núcleo/);
    assert.throws(() => httpReader({ base: 'http://exemplo.com:4720' }), /só lê o núcleo local/);
    assert.throws(() => httpReader({ base: 'https://127.0.0.1:4720' }), /só lê o núcleo local/);

    const fechado = httpReader({ base: 'http://127.0.0.1:1' });
    await assert.rejects(fechado('/api/overview'), (e: InstanceType<typeof ReadError>) => e.status === 0 && /não respondeu/.test(e.message));
  });

  test('Ao vivo: conecta com reset, entrega a mudança de um hook e para', async () => {
    const estados: string[] = [];
    const mudancas: { type: string; key: string }[][] = [];
    let reiniciou = 0;
    const vivo = startLive({
      read: httpReader({ base: api.url }),
      wait: 5,
      onState: ({ state }: { state: string }) => estados.push(state),
      onRestart: () => reiniciou++,
      onChange: (m: { type: string; key: string }[]) => mudancas.push(m),
    });
    await ate(() => reiniciou === 1 && cursor.abertas === 1);
    assert.deepEqual(estados, ['live']);

    const hook = { session_id: 'sess-ui', hook_event_name: 'SessionStart', cwd: '/repo/app', source: 'startup', model: 'claude-opus-5-5', transcript_path: '/x.jsonl' };
    const h = await fetch(`${api.url}/api/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(hook) });
    assert.equal(h.status, 202);
    await ate(() => mudancas.flat().some((m) => m.type === 'session' && m.key === 'sess-ui'));
    assert.equal(reiniciou, 1, 'mudança comum não pede releitura');

    await vivo.stop();
    await ate(() => cursor.abertas === 0);
  });

  test('Ao vivo: sem o núcleo mostra a falha, tenta de novo e relê quando volta', async () => {
    const estados: string[] = [];
    const esperas: number[] = [];
    let reiniciou = 0;
    let fora = 3;
    const real = httpReader({ base: api.url });
    const vivo = startLive({
      read: (rota: string, o: unknown) => (fora-- > 0 ? httpReader({ base: 'http://127.0.0.1:1' })(rota, o) : real(rota, o)),
      wait: 5,
      delays: [10, 20],
      sleep: (ms: number) => (esperas.push(ms), Promise.resolve()),
      onState: ({ state }: { state: string }) => estados.push(state),
      onRestart: () => reiniciou++,
    });
    await ate(() => reiniciou === 1);
    assert.deepEqual(esperas, [10, 20, 20]);
    assert.equal(estados[0], 'offline');
    assert.equal(estados.at(-1), 'live');
    assert.ok(vivo.state === 'live');
    await vivo.stop();
  });

  test('Ao vivo: 503 com Retry-After espera o que o núcleo pediu', async () => {
    const esperas: number[] = [];
    let n = 0;
    const vivo = startLive({
      read: async () => {
        if (n++ === 0) throw new ReadError('lotado', { status: 503, retryIn: 5000 });
        await new Promise((r) => setTimeout(r, 5));
        return { cursor: 'c', changes: [], reset: true, timedOut: false };
      },
      sleep: (ms: number) => (esperas.push(ms), Promise.resolve()),
    });
    await ate(() => n >= 2);
    assert.deepEqual(esperas, [5000]);
    await vivo.stop();
  });
});

describe('registro das telas', () => {
  test('a barra tem Dashboard, Mural ao vivo, Sessões, o Feed, Kanban, Analytics, Workflows e Histórico; em Entrega Repositórios, o Kanban do projeto e Dev Console; em Decisões, Das sessões; em Máquinas Esta máquina e, em Controle, Agent Config; o Detalhe abre por uma sessão e acende Sessões', () => {
    assert.deepEqual(SCREENS.filter((t: { item?: unknown }) => t.item).map((t: { id: string }) => t.id), ['dashboard', 'wall', 'sessions', 'feed', 'kanban', 'repos', 'project', 'dev-console', 'analytics', 'workflows', 'history', 'decisions', 'this-machine', 'agent-config']);
    assert.deepEqual(
      sidebarSections().map((s: { id: string; label: string | null; items: { id: string }[] }) => [s.id, s.label, s.items.map((t) => t.id)]),
      [
        ['main', null, ['dashboard', 'wall', 'sessions', 'feed', 'kanban', 'analytics', 'workflows', 'history']],
        ['delivery', 'Entrega', ['repos', 'project', 'dev-console']],
        ['decisions', 'Decisões', ['decisions']],
        ['machines', 'Máquinas', ['this-machine']],
        ['control', 'Controle', ['agent-config']],
      ],
    );
    assert.equal(findScreen('/ui/decisions').screen.file, '/ui/screens/decisions.js');
    assert.equal(findScreen('/ui/wall').screen.id, 'wall');
    assert.equal(findScreen('/ui/workflows').screen.id, 'workflows');
    assert.equal(findScreen('/ui/feed').screen.file, '/ui/screens/feed.js');
    assert.equal(findScreen('/ui').screen.id, 'dashboard');
    assert.equal(findScreen('/ui/').screen.id, 'dashboard');
    assert.equal(findScreen('/ui/sessions').screen.id, 'sessions');
    assert.equal(findScreen('/ui/history').screen.id, 'history');
    const d = findScreen('/ui/sessions/b91d04aa-4e1');
    assert.equal(d.screen.id, 'session-detail');
    assert.equal(d.screen.highlights, 'sessions');
    assert.deepEqual(d.params, { id: 'b91d04aa-4e1' });
    assert.equal(findScreen('/ui/sessions/a%20b'), null);
    assert.equal(findScreen('/ui/kanban').screen.id, 'kanban');
    assert.equal(findScreen('/ui/dev-console').screen.file, '/ui/screens/dev-console.js');
    assert.equal(findScreen('/ui/nao-existe'), null);
    // The old URLs match nothing: the shell swaps them for the new one first (legacyUrl).
    for (const old of ['/ui/sessoes', '/ui/sessoes/b91d04aa-4e1', '/ui/historico', '/ui/mural', '/ui/projeto', '/ui/decisoes']) assert.equal(findScreen(old), null, old);
  });

  test('a barra tem as seções: as telas do dia a dia sem título, Entrega, Decisões, Máquinas e Controle; seção vazia não aparece', () => {
    assert.deepEqual(SECTIONS, [
      { id: 'main', label: null },
      { id: 'delivery', label: 'Entrega' },
      { id: 'decisions', label: 'Decisões' },
      { id: 'machines', label: 'Máquinas' },
      { id: 'control', label: 'Controle' },
    ]);
    for (const t of SCREENS.filter((x: { item?: unknown }) => x.item)) assert.ok(SECTIONS.some((s: { id: string }) => s.id === t.item.section), t.id);
    // Um item de Controle registrado antes dos do dia a dia ainda sai no bloco dele, depois de Máquinas.
    const telas = [
      { id: 'config', item: { label: 'Agent Config', icon: 'x', section: 'control' } },
      { id: 'dashboard', item: { label: 'Dashboard', icon: 'x', section: 'main' } },
      { id: 'session-detail', highlights: 'dashboard' },
      { id: 'local', item: { label: 'Esta máquina', icon: 'x', section: 'machines' } },
      { id: 'dev', item: { label: 'Dev Console', icon: 'x', section: 'main' } },
    ];
    const ver = (ts: unknown[]) => sidebarSections(ts).map((s: { id: string; items: { id: string }[] }) => [s.id, s.items.map((t) => t.id)]);
    assert.deepEqual(ver(telas), [['main', ['dashboard', 'dev']], ['machines', ['local']], ['control', ['config']]]);
    assert.deepEqual(ver(telas.filter((t) => t.id !== 'local')), [['main', ['dashboard', 'dev']], ['control', ['config']]]);
    // Um item com seção errada não some: cai no bloco de cima (e o laço acima recusa o registro).
    assert.deepEqual(ver([{ id: 'x', item: { label: 'X', icon: 'x', section: 'unknown' } }]), [['main', ['x']]]);
  });

  test('a moldura desenha o título de cada seção com as classes da moldura, sem estilo inline', () => {
    const app = readFileSync(`${PASTA_DA_UI}nav.js`, 'utf8');
    assert.match(app, /sidebarSections\(\[\.\.\.screens, \.\.\.remoteItems\]\)/);
    assert.match(app, /'cc-nav-section'/);
    assert.match(app, /'cc-nav-title eyebrow'/);
    const css = readFileSync(`${PASTA_DA_UI}shell.css`, 'utf8');
    assert.match(css, /\.cc-nav-section \{/);
    assert.match(css, /\.cc-nav-title \{/);
  });

  // Issue 178, criterion 1: the remote machines are not in the static registry; the shell reads
  // GET /api/machines and adds one item per remote to the Máquinas block, after "Esta máquina".
  test('#178 criterion 1: Máquinas has "Esta máquina" and one item per remote of /api/machines, with its state; without remotes, only "Esta máquina"', () => {
    const local = { id: 'local', label: 'Esta máquina', state: 'connected', reason: null, version: 1, port: null, lastReadAt: null, alerts: 0 };
    const ws = { id: 'ws-exemplo', label: 'Workstation', state: 'unreachable', reason: 'port-closed', version: 1, port: 14720, lastReadAt: null, alerts: 1 };
    const lab = { id: 'lab', label: 'Laboratório', state: 'connected', reason: null, version: 1, port: 14721, lastReadAt: null, alerts: 0 };
    assert.equal(MACHINES_ROUTE, '/api/machines');
    const machinesBlock = (list: unknown) => sidebarSections([...SCREENS, ...machineItems(list)]).find((s: { id: string }) => s.id === 'machines');
    // Without remotes (only `local`, or the core without telemetry): only "Esta máquina".
    for (const list of [[local], [], null, { error: 'x' }]) assert.deepEqual(machinesBlock(list).items.map((t: { id: string }) => t.id), ['this-machine'], JSON.stringify(list));
    const block = machinesBlock([local, ws, lab]);
    assert.equal(block.label, 'Máquinas');
    assert.deepEqual(
      block.items.map((t: { id: string; route: string; item: { label: string; icon: string }; state?: string }) => [t.id, t.route, t.item.label, t.item.icon, t.state ?? null]),
      [
        ['this-machine', '/ui/machines/local', 'Esta máquina', 'monitor', null],
        ['machine-ws-exemplo', '/ui/machines/ws-exemplo', 'Workstation', 'server', 'unreachable'],
        ['machine-lab', '/ui/machines/lab', 'Laboratório', 'server', 'connected'],
      ],
    );
    // The other blocks do not move.
    assert.deepEqual(sidebarSections([...SCREENS, ...machineItems([local, ws])]).map((s: { id: string }) => s.id), ['main', 'delivery', 'decisions', 'machines', 'control']);
    // What the core sends is checked: a bad id, a repeated one, `local` and junk are left out.
    assert.deepEqual(machineItems([ws, { ...ws }, { id: '../x', label: 'x' }, { id: 'local' }, 'junk', null, { id: 'sem-rotulo', state: 'weird' }]).map((t: { id: string; item: { label: string }; state: string }) => [t.id, t.item.label, t.state]), [
      ['machine-ws-exemplo', 'Workstation', 'unreachable'],
      ['machine-sem-rotulo', 'sem-rotulo', 'unreachable'],
    ]);
    // The routes: /ui/machines/local is this machine; /ui/machines/<id> opens the same screen and lights its item.
    const here = findScreen('/ui/machines/local');
    assert.equal(here.screen.id, 'this-machine');
    assert.equal(here.screen.file, '/ui/screens/machine.js');
    assert.equal(litItem(here.screen, here.params), 'this-machine');
    const there = findScreen('/ui/machines/ws-exemplo');
    assert.equal(there.screen.id, 'machine');
    assert.equal(there.screen.file, '/ui/screens/machine.js');
    assert.deepEqual(there.params, { id: 'ws-exemplo' });
    assert.equal(litItem(there.screen, there.params), 'machine-ws-exemplo');
    assert.equal(litItem(findScreen('/ui/sessions/abc').screen, { id: 'abc' }), 'sessions');
    assert.equal(findScreen('/ui/machines/a/b'), null);
  });

  // The drawing itself (nav.js) is tested on the fake DOM in ui-machines.test.ts; here, the wiring.
  test('#178 criterion 1: the shell draws the sidebar through nav.js and re-reads the machines on an alert', () => {
    const app = readFileSync(`${PASTA_DA_UI}app.js`, 'utf8');
    assert.match(app, /createNav\(\{ nav, read \}\)/);
    assert.match(app, /highlight\(litItem\(screen, params\)\)/);
    assert.match(app, /changes\.some\(\(c\) => c\.type === 'alert'\)\) readMachines\(\)/);
    const css = readFileSync(`${PASTA_DA_UI}shell.css`, 'utf8');
    assert.match(css, /\.cc-nav-dot \{/);
    assert.match(css, /\.cc-nav-dot\[data-state="connected"\]/);
  });

  test('#104 critério 1: /ui/repos abre a lista de repositórios, com item na barra', () => {
    const r = findScreen('/ui/repos');
    assert.equal(r.screen.id, 'repos');
    assert.equal(r.screen.item.label, 'Repositórios');
    assert.equal(r.screen.item.section, 'delivery');
    assert.equal(findScreen('/ui/repos/').screen.id, 'repos');
  });

  test('#105: /ui/repos/<owner>/<repo> abre o repositório e acende Repositórios', () => {
    const r = findScreen('/ui/repos/exemplo-labs/vitrine-demo');
    assert.equal(r.screen.id, 'repo');
    assert.equal(r.screen.highlights, 'repos');
    assert.deepEqual(r.params, { owner: 'exemplo-labs', repo: 'vitrine-demo' });
    // Nomes do GitHub com ponto e sublinhado.
    assert.deepEqual(findScreen('/ui/repos/meu_org/site.github.io').params, { owner: 'meu_org', repo: 'site.github.io' });
    assert.deepEqual(findScreen('/ui/repos/meu_org/site.github.io/').params, { owner: 'meu_org', repo: 'site.github.io' });
  });

  test('#105: caminho de repositório estranho não casa nada', () => {
    for (const caminho of ['/ui/repos/a/..', '/ui/repos/a/.', '/ui/repos/../x', '/ui/repos/a/%2e%2e', '/ui/repos/a%20b/x', '/ui/repos/a%2Fb/x', '/ui/repos/a', '/ui/repos/a/b/c/d', '/ui/repos/a/b/..', '/ui/sessions/..']) {
      assert.equal(findScreen(caminho), null, caminho);
    }
  });

  test('#183: a aba Instruções tem URL própria, na mesma tela do repositório', () => {
    const found = findScreen('/ui/repos/exemplo-labs/vitrine-demo/instructions');
    assert.equal(found?.screen.id, 'repo-tab');
    assert.equal(found?.screen.file, '/ui/screens/repo.js');
    assert.deepEqual(found?.params, { owner: 'exemplo-labs', repo: 'vitrine-demo', tab: 'instructions' });
    assert.equal(litItem(found!.screen, found!.params), 'repos');
  });

  test('toda tela com arquivo aponta para um arquivo que existe em ui/screens/', () => {
    for (const t of SCREENS as { id: string; file?: string | null }[]) {
      if (!t.file) continue;
      assert.match(t.file, /^\/ui\/screens\/[a-z0-9-]+\.js$/, t.id);
      readFileSync(`${PASTA_DA_UI}${t.file.slice('/ui/'.length)}`);
    }
  });

  test('an old /ui URL becomes the new one: path, query and the detail tab (decision 0009, #173)', () => {
    const at = (url: string) => {
      const u = new URL(url, 'http://127.0.0.1:4720');
      return legacyUrl({ pathname: u.pathname, search: u.search, hash: u.hash });
    };
    const pairs: [string, string][] = [
      ['/ui/sessoes', '/ui/sessions'],
      ['/ui/sessoes/c3f09b52', '/ui/sessions/c3f09b52'],
      ['/ui/sessoes/sim-detalhe-pedidos#conversa', '/ui/sessions/sim-detalhe-pedidos#conversation'],
      ['/ui/sessoes/a#agentes', '/ui/sessions/a#agents'],
      ['/ui/sessoes/a#tempo', '/ui/sessions/a#timeline'],
      ['/ui/sessoes/a#decisoes', '/ui/sessions/a#decisions'],
      ['/ui/sessoes/a#workflow', '/ui/sessions/a#workflow'],
      ['/ui/sessions/a#decisoes', '/ui/sessions/a#decisions'],
      ['/ui/sessoes?status=esperando&busca=oi&ordem=custo&sentido=asc&pagina=2', '/ui/sessions?status=waiting&search=oi&order=cost&direction=asc&page=2'],
      ...(
        [['todas', 'all'], ['ativas', 'active'], ['esperando', 'waiting'], ['concluidas', 'completed'], ['erro', 'error'], ['abandonadas', 'abandoned']] as const
      ).map(([old, status]): [string, string] => [`/ui/sessions?status=${old}`, `/ui/sessions?status=${status}`]),
      ...([['atividade', 'activity'], ['duracao', 'duration'], ['custo', 'cost']] as const).map(([old, order]): [string, string] => [`/ui/sessoes?ordem=${old}`, `/ui/sessions?order=${order}`]),
      ['/ui/historico', '/ui/history'],
      ['/ui/mural', '/ui/wall'],
      ['/ui/projeto', '/ui/project'],
      ['/ui/decisoes', '/ui/decisions'],
      ['/ui/analytics/custo', '/ui/analytics/cost'],
      ['/ui/kanban?visao=agentes', '/ui/kanban?view=agents'],
      ['/ui/repos/exemplo-labs/vitrine-demo?periodo=1a', '/ui/repos/exemplo-labs/vitrine-demo?period=1y'],
      ['/ui/repos/exemplo-labs/vitrine-demo?periodo=30d', '/ui/repos/exemplo-labs/vitrine-demo?period=30d'],
    ];
    for (const [old, next] of pairs) {
      assert.equal(at(old), next, old);
      assert.equal(at(next), null, `${next} stays`);
      assert.ok(findScreen(new URL(next, 'http://x').pathname), next);
    }
    // The new name wins over the old one; nothing else is touched.
    assert.equal(at('/ui/kanban?visao=agentes&view=sessions'), '/ui/kanban?view=sessions');
    for (const url of ['/ui', '/ui/feed', '/ui/agent-config?tab=skills&project=%2Fx', '/ui/sessions?dir=%2Fa%2Fb', '/ui/analytics', '/ui/nao-existe', '/ui/sessionsx']) assert.equal(at(url), null, url);
  });

  test('the shell swaps an old URL for the new one with replaceState before routing', () => {
    const app = readFileSync(`${PASTA_DA_UI}app.js`, 'utf8');
    assert.match(app, /const next = legacyUrl\(location\);\n\s+if \(next\) history\.replaceState\(history\.state, '', next\);\n\s+const found = findScreen\(location\.pathname\);/);
  });
});

describe('escrever(rota, corpo): the /ui write (#63)', () => {
  test('POSTs JSON to its own origin; an error becomes ErroDeLeitura with the status; only the local core API', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const responses = [new Response(JSON.stringify({ ok: true, backup: '/b/x' }), { status: 200 }), new Response(JSON.stringify({ error: 'a skill mudou desde a leitura' }), { status: 409 })];
    const write = httpWriter({ base: 'http://127.0.0.1:4720', fetch: async (url: URL, init: RequestInit) => (requests.push({ url: String(url), init }), responses.shift()!) });
    assert.deepEqual(await write('/api/agent-config/skill', { root: 'u0', name: 'x', content: 'oi' }), { ok: true, backup: '/b/x' });
    assert.equal(requests[0]!.url, 'http://127.0.0.1:4720/api/agent-config/skill');
    assert.equal(requests[0]!.init.method, 'POST');
    assert.equal((requests[0]!.init.headers as Record<string, string>)['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { root: 'u0', name: 'x', content: 'oi' });
    assert.equal(requests[0]!.init.credentials, 'omit');
    await assert.rejects(write('/api/agent-config/skill', {}), (e: InstanceType<typeof ReadError>) => e instanceof ReadError && e.status === 409 && /mudou/.test(e.message));
    await assert.rejects(write('/ui', {}), /rota fora da API/);
    await assert.rejects(write('/api/../../ui', {}), /rota fora do núcleo/);
    assert.throws(() => httpWriter({ base: 'http://exemplo.com:4720' }), /só escreve no núcleo local/);
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

  test('registered at /ui/agent-config, with the Agent Config item (bot icon) and the file in screens/', () => {
    const found = findScreen('/ui/agent-config');
    assert.equal(found.screen.id, 'agent-config');
    assert.equal(found.screen.file, '/ui/screens/agent-config.js');
    assert.deepEqual(found.screen.item, { label: 'Agent Config', icon: 'bot', section: 'control' });
    assert.equal(findScreen('/ui/agent-config/').screen.id, 'agent-config');
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
