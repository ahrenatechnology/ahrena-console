// A tela Sessões (C3, #28): a rota `GET /api/sessoes` (filtros, ordem e página no servidor) com
// dados do simulador, e as peças da tela que não precisam de navegador.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, ListaDeSessoes, MontadorDoPainel, pedidoDeSessoes, type ApiLocal, type ListaDeSessoesHttp, type PedidoDeSessoes } from '../../src/api/index.ts';
import { PASTA_DA_UI } from '../../src/api/ui.ts';
import { displayStatus, type Session } from '../../src/model.ts';
import { semearCenariosDoPainel, SESSAO_DO_PAINEL } from '../../src/simulador/painel.ts';
import { simular } from '../../src/simulador/index.ts';
// @ts-expect-error: módulo do navegador, em JavaScript puro
import { custo, duracao, estadoDaQuery, faixa, idade, idCurto, queryDoEstado, rotaDaLista } from '../../ui/telas/sessoes.js';
// @ts-expect-error: idem
import { acharTela } from '../../ui/telas.js';

const AGORA = Date.parse('2026-05-01T12:00:00.000Z');
const PADRAO: PedidoDeSessoes = { status: 'todas', busca: null, dir: null, ordem: 'atividade', sentido: 'desc', pagina: 1 };

function pedir(url: string, caminho: string, headers: Record<string, string> = {}): Promise<{ status: number; corpo: string }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: caminho, headers }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (texto += p));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, corpo: texto }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('#28 GET /api/sessoes com o simulador', () => {
  let storage: SqliteStorage;
  let lista: ListaDeSessoes;
  let sessoes: Session[];
  let api: ApiLocal;
  const listar = (p: Partial<PedidoDeSessoes> = {}) => lista.listar({ ...PADRAO, ...p });
  // Todas as páginas de um pedido, juntas.
  const tudo = async (p: Partial<PedidoDeSessoes> = {}) => {
    const primeira = await listar(p);
    const itens = [...primeira.itens];
    for (let pagina = 2; pagina <= primeira.paginas; pagina++) itens.push(...(await listar({ ...p, pagina })).itens);
    return { primeira, itens };
  };

  before(async () => {
    storage = openSqliteStorage({ path: ':memory:' });
    await simular(storage, { semente: 28, sessoes: 16, caos: true, precos: true, agora: () => AGORA });
    await semearCenariosDoPainel(storage, 'p4', AGORA);
    sessoes = (await storage.listSessions({ limit: 500 })).items;
    const contas = new Contas({ storage, arquivo: null });
    lista = new ListaDeSessoes({ storage, contas, agora: () => AGORA });
    const montador = new MontadorDoPainel({ storage, contas, desktop: null, trabalho: null });
    api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, sessoes: lista });
  });
  after(async () => {
    await api.close();
    await storage.close();
  });

  test('o simulador deu sessões de todo status, mais de uma página', () => {
    assert.ok(sessoes.length > 10, `${sessoes.length} sessões`);
    const status = new Set(sessoes.map(displayStatus));
    for (const s of ['active', 'waiting', 'completed', 'error', 'abandoned']) assert.ok(status.has(s as never), `falta ${s}`);
  });

  test('10 por página: a segunda traz o resto, sem repetir; página além do fim cai na última', async () => {
    const p1 = await listar();
    assert.equal(p1.porPagina, 10);
    assert.equal(p1.itens.length, 10);
    assert.equal(p1.total, sessoes.length);
    assert.equal(p1.registradas, sessoes.length);
    assert.equal(p1.paginas, Math.ceil(sessoes.length / 10));
    const { itens } = await tudo();
    assert.equal(itens.length, sessoes.length);
    assert.equal(new Set(itens.map((s) => s.id)).size, sessoes.length);
    const alem = await listar({ pagina: 99 });
    assert.equal(alem.pagina, p1.paginas);
    assert.ok(alem.itens.length > 0);
  });

  test('cada pílula traz só o seu status, e as cinco somam o total', async () => {
    const DO_FILTRO = { ativas: 'active', esperando: 'waiting', concluidas: 'completed', erro: 'error', abandonadas: 'abandoned' } as const;
    let soma = 0;
    for (const [filtro, status] of Object.entries(DO_FILTRO)) {
      const { primeira, itens } = await tudo({ status: filtro as PedidoDeSessoes['status'] });
      assert.ok(itens.length > 0, filtro);
      for (const s of itens) assert.equal(s.status, status, `${filtro}: ${s.id}`);
      assert.equal(primeira.total, sessoes.filter((s) => displayStatus(s) === status).length, filtro);
      assert.equal(primeira.registradas, sessoes.length, 'o total registrado não depende do filtro');
      soma += primeira.total;
    }
    assert.equal(soma, sessoes.length);
  });

  test('esperando traz o motivo; as outras não', async () => {
    const { itens } = await tudo();
    for (const s of itens) {
      if (s.status === 'waiting') assert.ok(['notification', 'interrupted', 'stop', 'session_start'].includes(s.motivo!), s.id);
      else assert.equal(s.motivo, null, s.id);
      assert.equal(s.rodando, s.status === 'active' || s.status === 'waiting');
    }
  });

  test('a busca acha pelo título, pelo id e pelo diretório, sem diferença de caixa', async () => {
    const porTitulo = await listar({ busca: 'SEPARAR PAGAMENTOS' });
    assert.deepEqual(porTitulo.itens.map((s) => s.id), [SESSAO_DO_PAINEL]);
    const alvo = sessoes.find((s) => s.id !== SESSAO_DO_PAINEL)!;
    assert.ok((await listar({ busca: alvo.id })).itens.some((s) => s.id === alvo.id));
    const porDir = await tudo({ busca: 'vitrine-demo' });
    assert.ok(porDir.itens.length > 0 && porDir.itens.every((s) => s.cwd?.includes('vitrine-demo') || s.titulo.toLowerCase().includes('vitrine-demo')));
    assert.equal((await listar({ busca: 'nada-com-isso-aqui' })).total, 0);
  });

  test('o filtro por diretório usa a lista que a própria resposta traz', async () => {
    const { diretorios } = await listar();
    assert.deepEqual(diretorios, [...diretorios].sort());
    assert.equal(diretorios.length, new Set(sessoes.map((s) => s.cwd).filter(Boolean)).size);
    for (const dir of diretorios) {
      const { primeira, itens } = await tudo({ dir });
      assert.ok(itens.every((s) => s.cwd === dir), dir);
      assert.equal(primeira.total, sessoes.filter((s) => s.cwd === dir).length, dir);
    }
    // Combinado com o status.
    const dir = sessoes.find((s) => displayStatus(s) === 'completed')!.cwd!;
    const { itens } = await tudo({ dir, status: 'concluidas' });
    assert.ok(itens.length > 0 && itens.every((s) => s.cwd === dir && s.status === 'completed'));
  });

  test('ordem por atividade, duração e custo, nos dois sentidos', async () => {
    const ordenado = (xs: number[], sentido: 'desc' | 'asc') => xs.every((x, i) => i === 0 || (sentido === 'desc' ? xs[i - 1]! >= x : xs[i - 1]! <= x));
    for (const sentido of ['desc', 'asc'] as const) {
      const atividade = (await tudo({ ordem: 'atividade', sentido })).itens.map((s) => Date.parse(s.ultimaAtividade));
      assert.ok(ordenado(atividade, sentido), `atividade ${sentido}`);
      const dur = (await tudo({ ordem: 'duracao', sentido })).itens.map((s) => s.duracaoMs);
      assert.ok(ordenado(dur, sentido), `duração ${sentido}`);
      const usd = (await tudo({ ordem: 'custo', sentido })).itens.map((s) => s.custoUsd ?? -1);
      assert.ok(ordenado(usd, sentido), `custo ${sentido}`);
    }
    // O simulador grava preços: há sessão com custo, e a mais cara vem primeiro.
    const caras = await listar({ ordem: 'custo' });
    assert.ok(caras.itens[0]!.custoUsd! > 0);
  });

  test('duração: a ativa corre até agora; a encerrada para no fim', async () => {
    const { itens } = await tudo();
    for (const s of itens) {
      const sessao = sessoes.find((x) => x.id === s.id)!;
      const fim = sessao.status === 'active' ? AGORA : Date.parse(sessao.endedAt ?? sessao.updatedAt);
      assert.equal(s.duracaoMs, Math.max(0, fim - Date.parse(sessao.startedAt)), s.id);
    }
  });

  test('a conta sai com rótulo e cor, nunca o id (decisão 0006)', async () => {
    const { itens } = await tudo();
    const comConta = itens.filter((s) => s.conta);
    assert.ok(comConta.length > 0);
    for (const s of comConta) assert.deepEqual(Object.keys(s.conta!).sort(), ['cor', 'rotulo']);
    const contas = await storage.listAccounts();
    const json = JSON.stringify(itens);
    for (const c of contas) {
      assert.ok(!json.includes(c.accountUuid), 'uuid da conta na resposta');
      assert.ok(!json.includes(c.organizationUuid), 'uuid da org na resposta');
    }
  });

  test('HTTP: a rota responde, recusa parâmetro inválido com 400 e aceita a própria /ui lendo', async () => {
    const ok = await pedir(api.url, '/api/sessoes?status=esperando&ordem=custo&sentido=asc&pagina=1');
    assert.equal(ok.status, 200);
    const corpo = JSON.parse(ok.corpo) as ListaDeSessoesHttp;
    assert.ok(corpo.itens.every((s) => s.status === 'waiting'));
    for (const q of ['status=nenhuma', 'ordem=nome', 'sentido=lado', 'pagina=0', 'pagina=1.5', 'dir=relativo', `busca=${'x'.repeat(201)}`]) {
      const r = await pedir(api.url, `/api/sessoes?${q}`);
      assert.equal(r.status, 400, q);
      assert.ok(JSON.parse(r.corpo).error, q);
    }
    const host = new URL(api.url).host;
    assert.equal((await pedir(api.url, '/api/sessoes', { origin: `http://${host}` })).status, 200);
    assert.equal((await pedir(api.url, '/api/sessoes', { origin: 'https://exemplo.com' })).status, 403);
  });

  test('pedidoDeSessoes: os padrões', () => {
    assert.deepEqual(pedidoDeSessoes(new URL('http://x/api/sessoes')), PADRAO);
    assert.deepEqual(pedidoDeSessoes(new URL('http://x/api/sessoes?busca=%20oi%20&dir=/a/b&pagina=3')), { ...PADRAO, busca: 'oi', dir: '/a/b', pagina: 3 });
  });
});

describe('#28 a tela Sessões', () => {
  test('está registrada em /ui/sessoes, e o arquivo existe', () => {
    const { tela } = acharTela('/ui/sessoes');
    assert.equal(tela.arquivo, '/ui/telas/sessoes.js');
    assert.ok(existsSync(`${PASTA_DA_UI}telas/sessoes.js`));
    assert.ok(existsSync(`${PASTA_DA_UI}sessoes.css`));
    // A linha leva ao Detalhe, que casa o id do simulador.
    assert.equal(acharTela(`/ui/sessoes/${encodeURIComponent(SESSAO_DO_PAINEL)}`).tela.id, 'detalhe');
  });

  test('o estado vai e volta pela query da URL; o que não vale cai no padrão', () => {
    const e = estadoDaQuery('?status=esperando&busca=oi&dir=/simulacao/x&ordem=custo&sentido=asc&pagina=2');
    assert.deepEqual(e, { status: 'esperando', busca: 'oi', dir: '/simulacao/x', ordem: 'custo', sentido: 'asc', pagina: 2 });
    assert.deepEqual(estadoDaQuery(queryDoEstado(e)), e);
    assert.equal(queryDoEstado(estadoDaQuery('')), '');
    assert.deepEqual(estadoDaQuery('?status=x&ordem=y&sentido=z&pagina=-1&dir=rel'), estadoDaQuery(''));
  });

  test('a rota da API leva os filtros que o servidor entende', () => {
    const rota = rotaDaLista({ status: 'erro', busca: ' a b ', dir: '/d', ordem: 'duracao', sentido: 'desc', pagina: 2 });
    const url = new URL(rota, 'http://127.0.0.1');
    assert.equal(url.pathname, '/api/sessoes');
    assert.deepEqual(pedidoDeSessoes(url), { status: 'erro', busca: 'a b', dir: '/d', ordem: 'duracao', sentido: 'desc', pagina: 2 });
    assert.ok(!new URL(rotaDaLista(estadoDaQuery('')), 'http://x').searchParams.has('busca'));
  });

  test('os textos da linha: idade, duração, custo, faixa e id', () => {
    const agora = Date.parse('2026-05-01T12:00:00Z');
    assert.equal(idade('2026-05-01T11:59:30Z', agora), 'agora');
    assert.equal(idade('2026-05-01T11:58:00Z', agora), 'há 2 min');
    assert.equal(idade('2026-05-01T09:00:00Z', agora), 'há 3 h');
    assert.equal(idade('2026-04-28T12:00:00Z', agora), 'há 3 d');
    assert.equal(duracao(20_000), '< 1 min');
    assert.equal(duracao(12 * 60_000), '12 min');
    assert.equal(duracao(190 * 60_000), '3 h 10');
    assert.equal(duracao(120 * 60_000), '2 h');
    assert.equal(duracao(28 * 3_600_000), '1 d 4 h');
    assert.equal(custo(1.84), '~US$ 1,84');
    assert.equal(custo(0), '~US$ 0,00');
    assert.equal(custo(null), 'sem preço');
    assert.equal(faixa({ total: 12, pagina: 1, porPagina: 10 }), '1–10 de 12');
    assert.equal(faixa({ total: 12, pagina: 2, porPagina: 10 }), '11–12 de 12');
    assert.equal(faixa({ total: 0, pagina: 1, porPagina: 10 }), '0 de 0');
    assert.equal(idCurto('7f3a2c1e-1111-2222-3333-444455556666'), '7f3a2c1e');
    assert.equal(idCurto('sim-painel-esta'), 'sim-painel-esta');
  });
});
