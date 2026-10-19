import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildTree, countTree, deltaQuery, findInTree, mergeNodes, missingParents, withoutOpenQualifier } from '../../src/index.ts';
import { detail, k, node } from './helpers.ts';

const map = (...ns: ReturnType<typeof node>[]) => new Map(ns.map((n) => [n.key, n]));

describe('mescla de nós', () => {
  test('o updatedAt mais novo vence', () => {
    const base = map(node(1, { title: 'velho', updatedAt: '2026-10-18T10:00:00Z' }));
    assert.equal(mergeNodes(base, [node(1, { title: 'novo', updatedAt: '2026-10-18T11:00:00Z' })]).get(k(1))?.title, 'novo');
    assert.equal(mergeNodes(base, [node(1, { title: 'antigo', updatedAt: '2026-10-18T09:00:00Z' })]).get(k(1))?.title, 'velho');
  });

  test('não altera o mapa de entrada', () => {
    const base = map(node(1));
    mergeNodes(base, [node(2)]);
    assert.equal(base.size, 1);
  });
});

test('pais citados que não vieram', () => {
  const nodes = map(node(1), node(2, { parent: k(1) }), node(3, { parent: k(9) }), node(4, { parent: k(9) }), node(5, { parent: 'outro/repo#1' }));
  assert.deepEqual(missingParents(nodes), [k(9), 'outro/repo#1']);
});

describe('árvore', () => {
  const nodes = map(
    node(1, { type: 'Initiative' }),
    node(6, { type: 'Epic', parent: k(1) }),
    node(41, { type: 'Tech Task', parent: k(6) }),
    node(40, { type: 'Spike', parent: k(6) }),
    node(70, { type: null, parent: k(41) }),
    node(80, { type: 'Epic', parent: k(99) }),
  );

  test('iniciativa → épico → item → plano, com pai que não veio virando raiz', () => {
    const roots = buildTree({ nodes });
    assert.deepEqual(roots.map((r) => r.number), [1, 80]);
    const [ini] = roots;
    assert.equal(ini.level, 'initiative');
    assert.equal(ini.children[0].level, 'epic');
    assert.deepEqual(ini.children[0].children.map((c) => [c.number, c.level]), [[40, 'item'], [41, 'item']]);
    assert.deepEqual(findInTree(roots, k(70)) && [findInTree(roots, k(70))!.level, findInTree(roots, k(70))!.children.length], ['plan', 0]);
    assert.equal(countTree(roots), 6);
  });

  test('marca cards carregados e pendura o detalhe', () => {
    const roots = buildTree({ nodes, loaded: new Set([k(6)]), details: new Map([[k(41), detail(41, { stage: 'em revisão' })]]) });
    assert.equal(findInTree(roots, k(6))?.childrenLoaded, true);
    assert.equal(findInTree(roots, k(1))?.childrenLoaded, false);
    assert.equal(findInTree(roots, k(41))?.detail?.stage, 'em revisão');
    assert.equal(findInTree(roots, k(40))?.detail, null);
  });

  test('ciclo não trava: vira raiz', () => {
    const roots = buildTree({ nodes: map(node(1, { parent: k(2) }), node(2, { parent: k(1) })) });
    assert.equal(countTree(roots), 2);
  });
});

test('consulta do delta em UTC sem milissegundos', () => {
  assert.equal(deltaQuery('repo:a/b is:issue', Date.parse('2026-10-18T12:34:56.789Z')), 'repo:a/b is:issue updated:>=2026-10-18T12:34:56Z');
});

test('o delta tira is:open do filtro para ver o que fechou', () => {
  assert.deepEqual(withoutOpenQualifier('repo:a/b is:issue is:open'), { filter: 'repo:a/b is:issue', onlyOpen: true });
  assert.deepEqual(withoutOpenQualifier('state:open repo:a/b'), { filter: 'repo:a/b', onlyOpen: true });
  assert.deepEqual(withoutOpenQualifier('repo:a/b is:issue'), { filter: 'repo:a/b is:issue', onlyOpen: false });
});
