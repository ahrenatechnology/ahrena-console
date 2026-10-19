import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  cacheKeys,
  createGithubWork,
  DELTA_OVERLAP_MS,
  findInTree,
  GithubCache,
  GithubWork,
  MemoryCacheStore,
  NoDataError,
  RateLimitedError,
  type ChildrenResult,
} from '../../src/index.ts';
import { clock, detail, FakeSource, FILTER, k, node, replayFetch } from './helpers.ts';

function setup() {
  const now = clock();
  const source = new FakeSource();
  const store = new MemoryCacheStore();
  const cache = new GithubCache({ store, now });
  const work = new GithubWork({ source, cache, filter: FILTER, now });
  source.list = [node(1, { type: 'Initiative' }), node(6, { type: 'Epic', parent: k(1) }), node(41, { type: 'Tech Task', parent: k(6) })];
  return { now, source, store, cache, work };
}

describe('árvore do trabalho, de ponta a ponta com respostas gravadas', () => {
  test('lê raso uma vez, monta iniciativa → épico → item e expande com PR, CI e review', async () => {
    const fetch = replayFetch();
    const work = createGithubWork({ filter: FILTER, token: 't', fetch, now: clock() });
    const tree = await work.tree();
    assert.deepEqual(fetch.calls.map((c) => c.operation), ['WorkShallow'], 'sem pais faltando, a leitura inicial é uma consulta');
    assert.equal(tree.count, 60);
    assert.deepEqual(tree.roots.map((r) => [r.number, r.level]), [[1, 'initiative']]);
    const epic = findInTree(tree.roots, k(6))!;
    assert.deepEqual([epic.level, epic.childrenLoaded, epic.detail, epic.progress], ['epic', false, null, { total: 3, completed: 1, percent: 33 }]);
    assert.equal(findInTree(tree.roots, k(41))?.level, 'item');

    const opened = await work.expand(k(6));
    assert.deepEqual(fetch.calls.map((c) => c.operation), ['WorkShallow', 'WorkChildren', 'WorkDetail']);
    assert.equal(opened?.childrenLoaded, true);
    assert.deepEqual(opened?.children.map((c) => c.number), [40, 41, 42], 'a filha fechada (#40) entra ao expandir');
    const spike = opened!.children[0];
    assert.deepEqual([spike.state, spike.detail?.stage, spike.detail?.pullRequests[0].number], ['CLOSED', 'concluída', 67]);
    assert.equal(opened?.detail?.stage, 'a fazer');

    await work.tree();
    assert.equal(fetch.calls.length, 3, 'dentro do TTL, nada sai para o GitHub');
  });
});

describe('leitura inicial', () => {
  test('pais que não vieram entram numa consulta só', async () => {
    const { source, work } = setup();
    source.list = [node(41, { parent: k(6) }), node(42, { parent: k(6) }), node(50, { parent: k(8) })];
    source.extra.set(k(6), node(6, { type: 'Epic', parent: k(1) }));
    source.extra.set(k(1), node(1, { type: 'Initiative' }));
    source.extra.set(k(8), node(8, { type: 'Epic', parent: k(1) }));
    const tree = await work.tree();
    assert.equal(source.count('nodes'), 1);
    assert.deepEqual(source.calls.find((c) => c.op === 'nodes')?.arg, [k(6), k(8)]);
    assert.deepEqual(tree.roots.map((r) => r.number), [1]);
    assert.equal(tree.count, 6);
  });

  test('sem cache e com o GitHub fora: sem dados', async () => {
    const { source, work } = setup();
    source.fail = new Error('caiu');
    await assert.rejects(work.tree(), NoDataError);
  });
});

describe('delta a cada 60 s', () => {
  test('não roda logo depois da leitura inteira; roda depois de 60 s, uma vez', async () => {
    const { now, source, work } = setup();
    const first = await work.tree();
    await work.tree();
    assert.equal(source.count('delta'), 0);
    now.add(60_000);
    await Promise.all([work.tree(), work.tree()]);
    assert.equal(source.count('delta'), 1);
    const arg = source.calls.find((c) => c.op === 'delta')?.arg as { filter: string; since: number };
    assert.equal(arg.filter, 'repo:ahrenatechnology/ahrena-console is:issue', 'sem is:open, para ver o que fechou');
    assert.equal(arg.since, first.fetchedAt - DELTA_OVERLAP_MS);
    assert.equal(source.count('listShallow'), 1);
  });

  test('mescla o que mudou, tira o que fechou e lê o pai novo que não estava', async () => {
    const { now, source, work } = setup();
    await work.tree();
    now.add(60_000);
    source.delta = [
      node(6, { type: 'Epic', parent: k(1), title: 'Épico renomeado', updatedAt: '2026-10-18T12:00:30Z' }),
      node(41, { type: 'Tech Task', parent: k(6), state: 'CLOSED', updatedAt: '2026-10-18T12:00:30Z' }),
      node(43, { type: 'Tech Task', parent: k(9), updatedAt: '2026-10-18T12:00:30Z' }),
    ];
    source.extra.set(k(9), node(9, { type: 'Epic', parent: k(1) }));
    const tree = await work.tree();
    assert.equal(findInTree(tree.roots, k(6))?.title, 'Épico renomeado');
    assert.equal(findInTree(tree.roots, k(41)), null);
    assert.equal(findInTree(tree.roots, k(43))?.parent, k(9));
    assert.equal(findInTree(tree.roots, k(9))?.level, 'epic');
    assert.equal(tree.fetchedAt, Date.parse('2026-10-18T12:01:00Z'));
  });

  test('fechada que ainda é pai de alguém da lista fica', async () => {
    const { now, source, work } = setup();
    await work.tree();
    now.add(60_000);
    source.delta = [node(6, { type: 'Epic', parent: k(1), state: 'CLOSED', updatedAt: '2026-10-18T12:00:30Z' })];
    assert.equal(findInTree((await work.tree()).roots, k(6))?.state, 'CLOSED');
  });

  test('filha que mudou de pai invalida as filhas dos dois pais', async () => {
    const { now, source, work, cache } = setup();
    source.childrenOf.set(k(6), { children: [node(41, { parent: k(6) })], details: [] });
    await work.expand(k(6));
    await cache.put<ChildrenResult>(cacheKeys.children(k(7)), { children: [], details: [] });
    now.add(60_000);
    source.delta = [node(41, { type: 'Tech Task', parent: k(7), updatedAt: '2026-10-18T12:00:30Z' })];
    await work.tree();
    assert.equal(await cache.peek(cacheKeys.children(k(7))), null);
    assert.equal(source.count('children'), 2, 'o card aberto relê as filhas na mesma montagem');
  });

  test('delta atualiza a filha guardada de um card aberto', async () => {
    const { now, source, work } = setup();
    source.childrenOf.set(k(6), { children: [node(41, { parent: k(6) }), node(40, { parent: k(6), state: 'CLOSED' })], details: [] });
    await work.expand(k(6));
    now.add(60_000);
    source.delta = [node(40, { parent: k(6), state: 'CLOSED', title: 'novo título', updatedAt: '2026-10-18T12:00:30Z' })];
    const tree = await work.tree();
    assert.equal(findInTree(tree.roots, k(40))?.title, 'novo título');
    assert.equal(source.count('children'), 1);
  });

  test('delta falhou: a árvore sai com o que tem, marcada como velha', async () => {
    const { now, source, work } = setup();
    await work.tree();
    now.add(60_000);
    source.fail = new Error('timeout');
    const tree = await work.tree();
    assert.equal(tree.count, 3);
    assert.equal(tree.stale, true);
    assert.match(tree.staleReason ?? '', /delta: timeout/);
  });
});

describe('expandir', () => {
  test('filhas e detalhe só ao expandir, cada um com o seu TTL', async () => {
    const { now, source, work } = setup();
    source.childrenOf.set(k(6), { children: [node(41, { parent: k(6) })], details: [detail(41, { stage: 'ci rodando' })] });
    source.details.set(k(6), detail(6, { stage: 'a fazer' }));
    await work.tree();
    assert.deepEqual([source.count('children'), source.count('detail')], [0, 0]);

    const epic = await work.expand(k(6));
    assert.deepEqual([epic?.detail?.stage, epic?.children[0].detail?.stage], ['a fazer', 'ci rodando']);
    assert.deepEqual([source.count('children'), source.count('detail')], [1, 1]);

    now.add(59_000);
    await work.tree();
    assert.deepEqual([source.count('children'), source.count('detail')], [1, 1]);
    now.add(1_000);
    await work.tree();
    assert.deepEqual([source.count('children'), source.count('detail')], [1, 2], 'PR e CI do card aberto: 60 s');
    now.add(9 * 60_000);
    await work.tree();
    assert.equal(source.count('children'), 2, 'filhas: 10 min');
  });

  test('fechar o card para de buscar filhas e detalhe', async () => {
    const { now, source, work } = setup();
    await work.expand(k(6));
    work.collapse(k(6));
    now.add(11 * 60_000);
    const tree = await work.tree();
    assert.deepEqual([source.count('children'), source.count('detail')], [1, 1]);
    assert.equal(findInTree(tree.roots, k(6))?.childrenLoaded, false);
    assert.deepEqual(work.expandedKeys, []);
  });

  test('falha ao expandir sem cache: o resto da árvore sai, com o motivo', async () => {
    const { source, work } = setup();
    await work.tree();
    source.fail = new Error('caiu');
    const tree = await work.tree().then(() => work.expand(k(6)));
    assert.equal(tree?.childrenLoaded, false);
    const full = await work.tree();
    assert.match(full.staleReason ?? '', /filhas de .*#6: sem dados: caiu/);
  });
});

describe('atualizar e escrever', () => {
  test('botão de atualizar relê, mas no máximo a cada 30 s', async () => {
    const { now, source, work } = setup();
    await work.tree();
    now.add(10_000);
    await work.tree({ force: true });
    assert.equal(source.count('listShallow'), 1);
    now.add(20_000);
    await work.tree({ force: true });
    assert.equal(source.count('listShallow'), 2);
  });

  test('patch: a escrita do console aparece na hora, sem reler', async () => {
    const { source, work } = setup();
    source.childrenOf.set(k(6), { children: [node(41, { parent: k(6) })], details: [] });
    await work.expand(k(6));
    const calls = source.calls.length;
    assert.equal(await work.patchNode(k(41), (n) => ({ ...n, title: 'movido' })), true);
    assert.equal(findInTree((await work.tree()).roots, k(41))?.title, 'movido');
    assert.equal(source.calls.length, calls);
    assert.equal(await work.patchNode(k(999), (n) => n), false);
  });

  test('limite do GitHub depois do TTL: serve o cache, marcado como velho, sem insistir', async () => {
    const { now, source, work } = setup();
    await work.tree();
    now.add(5 * 60_000);
    source.fail = new RateLimitedError('limite', 120_000);
    const a = await work.tree();
    assert.deepEqual([a.count, a.stale], [3, true]);
    const calls = source.calls.length;
    now.add(60_000);
    await work.tree();
    assert.equal(source.calls.length, calls, 'pausado: nenhuma chamada');
  });
});
