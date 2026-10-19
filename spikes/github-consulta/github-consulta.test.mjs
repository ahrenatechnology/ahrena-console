import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GithubCache, MemoryStore, DiskStore, RateLimited, backoffMs } from './cache.mjs';
import { merge, mergeChildren, missingParents, tree, deltaQuery } from './arvore.mjs';

const clock = (t = 0) => { const c = () => t; c.add = (ms) => { t += ms; }; return c; };
const counter = (value = 'v') => { const f = async () => { f.calls++; return { value }; }; f.calls = 0; return f; };

test('dentro do TTL não chama o GitHub', async () => {
  const now = clock();
  const cache = new GithubCache({ store: new MemoryStore(), now });
  const f = counter();
  await cache.get('k', 60_000, f);
  now.add(30_000);
  const r = await cache.get('k', 60_000, f);
  assert.equal(f.calls, 1);
  assert.equal(r.stale, false);
});

test('fora do TTL relê uma vez', async () => {
  const now = clock();
  const cache = new GithubCache({ store: new MemoryStore(), now });
  const f = counter();
  await cache.get('k', 60_000, f);
  now.add(61_000);
  await cache.get('k', 60_000, f);
  assert.equal(f.calls, 2);
});

test('chamadas simultâneas da mesma chave viram uma só', async () => {
  const cache = new GithubCache({ store: new MemoryStore() });
  const f = counter();
  await Promise.all([cache.get('k', 1, f), cache.get('k', 1, f), cache.get('k', 1, f)]);
  assert.equal(f.calls, 1);
});

test('falha com dado velho serve o velho marcado como stale', async () => {
  const now = clock();
  const cache = new GithubCache({ store: new MemoryStore(), now });
  await cache.get('k', 1000, counter('bom'));
  now.add(2000);
  const r = await cache.get('k', 1000, async () => { throw new Error('caiu'); });
  assert.equal(r.value, 'bom');
  assert.equal(r.stale, true);
  assert.equal(r.staleReason, 'caiu');
});

test('falha sem dado nenhum propaga o erro', async () => {
  const cache = new GithubCache({ store: new MemoryStore() });
  await assert.rejects(cache.get('k', 1000, async () => { throw new Error('caiu'); }), /caiu/);
});

test('limite de taxa bloqueia novas chamadas até o prazo', async () => {
  const now = clock();
  const cache = new GithubCache({ store: new MemoryStore(), now });
  await cache.get('k', 1000, counter('bom'));
  now.add(2000);
  await cache.get('k', 1000, async () => { throw new RateLimited('limite', 60_000); });
  const f = counter('novo');
  now.add(30_000);
  const r = await cache.get('k', 1000, f);
  assert.equal(f.calls, 0);
  assert.equal(r.stale, true);
  now.add(31_000);
  assert.equal((await cache.get('k', 1000, f)).value, 'novo');
});

test('ETag: 304 mantém o valor e renova o prazo', async () => {
  const now = clock();
  const cache = new GithubCache({ store: new MemoryStore(), now });
  await cache.get('k', 1000, async () => ({ value: [1, 2], etag: 'W/"a"' }));
  now.add(2000);
  let sent;
  const r = await cache.get('k', 1000, async ({ etag }) => { sent = etag; return { notModified: true }; });
  assert.equal(sent, 'W/"a"');
  assert.deepEqual(r.value, [1, 2]);
  assert.equal(r.fetchedAt, 2000);
});

test('patch atualiza o cache sem reler (mover card)', async () => {
  const cache = new GithubCache({ store: new MemoryStore() });
  await cache.get('board', 60_000, async () => ({ value: { '#1': 'Todo' } }));
  await cache.patch('board', (v) => ({ ...v, '#1': 'Done' }));
  assert.deepEqual((await cache.get('board', 60_000, counter())).value, { '#1': 'Done' });
});

test('o cache em disco sobrevive a um novo processo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ahrena-cache-'));
  await new GithubCache({ store: new DiskStore(dir) }).get('o/r#1', 60_000, counter('salvo'));
  const f = counter('outro');
  const r = await new GithubCache({ store: new DiskStore(dir) }).get('o/r#1', 60_000, f);
  assert.equal(r.value, 'salvo');
  assert.equal(f.calls, 0);
});

test('backoff respeita retry-after e x-ratelimit-reset', () => {
  assert.equal(backoffMs({ 'retry-after': '60' }), 60_000);
  assert.equal(backoffMs({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' }, 40_000), 60_000);
  assert.equal(backoffMs({}), 120_000);
});

const repo = { nameWithOwner: 'o/r' };
const raw = (number, parent, extra = {}) => ({ number, title: `#${number}`, state: 'OPEN', updatedAt: '2026-10-01T00:00:00Z', repository: repo, issueType: { name: 'Task' }, parent: parent ? { number: parent } : null, subIssuesSummary: { total: 0 }, ...extra });

test('árvore a partir de nós rasos, só com a chave do pai', () => {
  const nodes = merge(new Map(), [raw(1, null), raw(2, 1), raw(3, 2)]);
  const t = tree(nodes);
  assert.deepEqual(t.roots, ['o/r#1']);
  assert.deepEqual(t.children.get('o/r#1'), ['o/r#2']);
  assert.deepEqual(t.children.get('o/r#2'), ['o/r#3']);
});

test('pai ausente vira raiz e entra na lista de pais a buscar', () => {
  const nodes = merge(new Map(), [raw(5, 9)]);
  assert.deepEqual(tree(nodes).roots, ['o/r#5']);
  assert.deepEqual(missingParents(nodes), ['o/r#9']);
});

test('expandir carrega as filhas sob o pai', () => {
  let nodes = merge(new Map(), [raw(6, null, { subIssuesSummary: { total: 2 } })]);
  assert.equal(nodes.get('o/r#6').childrenLoaded, false);
  nodes = mergeChildren(nodes, 'o/r#6', [raw(40, null), raw(41, null)]);
  assert.equal(nodes.get('o/r#6').childrenLoaded, true);
  assert.deepEqual(tree(nodes).children.get('o/r#6'), ['o/r#40', 'o/r#41']);
});

test('delta mais novo substitui o nó; mais velho é ignorado', () => {
  let nodes = merge(new Map(), [raw(1, null, { title: 'v1', updatedAt: '2026-10-02T00:00:00Z' })]);
  nodes = merge(nodes, [raw(1, null, { title: 'velho', updatedAt: '2026-10-01T00:00:00Z' })]);
  assert.equal(nodes.get('o/r#1').title, 'v1');
  nodes = merge(nodes, [raw(1, null, { title: 'v2', updatedAt: '2026-10-03T00:00:00Z' })]);
  assert.equal(nodes.get('o/r#1').title, 'v2');
});

test('consulta delta no formato da busca do GitHub', () => {
  assert.equal(deltaQuery('repo:o/r is:issue', Date.parse('2026-10-18T12:34:56.789Z')), 'repo:o/r is:issue updated:>=2026-10-18T12:34:56Z');
});
