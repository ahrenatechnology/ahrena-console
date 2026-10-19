import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import {
  backoffMs,
  GithubCache,
  MemoryCacheStore,
  NoDataError,
  openSqliteStorage,
  RateLimitedError,
  SqliteCacheStore,
  type CachePort,
  type Fetcher,
} from '../../src/index.ts';
import { clock } from './helpers.ts';

const counter = <T>(value: T) => {
  const f = (async () => {
    f.calls++;
    return { value };
  }) as unknown as Fetcher<T> & { calls: number };
  f.calls = 0;
  return f;
};
const failing = (err: Error) => async () => {
  throw err;
};

function cacheSuite(name: string, makeStore: () => CachePort) {
  describe(`cache do GitHub (${name})`, () => {
    test('dentro do TTL não chama o GitHub', async () => {
      const now = clock();
      const cache = new GithubCache({ store: makeStore(), now });
      const f = counter('v');
      await cache.get('k', 60_000, f);
      now.add(59_000);
      const r = await cache.get('k', 60_000, f);
      assert.equal(f.calls, 1);
      assert.deepEqual([r.value, r.stale], ['v', false]);
    });

    test('fora do TTL relê uma vez', async () => {
      const now = clock();
      const cache = new GithubCache({ store: makeStore(), now });
      const f = counter('v');
      await cache.get('k', 60_000, f);
      now.add(60_000);
      await cache.get('k', 60_000, f);
      assert.equal(f.calls, 2);
    });

    test('várias telas pedindo a mesma chave fazem uma chamada só', async () => {
      const cache = new GithubCache({ store: makeStore() });
      const f = counter('v');
      await Promise.all([cache.get('k', 1, f), cache.get('k', 1, f), cache.get('k', 1, f)]);
      assert.equal(f.calls, 1);
    });

    test('GitHub falhou: serve o último valor com stale e o motivo', async () => {
      const now = clock();
      const cache = new GithubCache({ store: makeStore(), now });
      await cache.get('k', 1000, counter('bom'));
      now.add(5000);
      const r = await cache.get('k', 1000, failing(new Error('caiu')));
      assert.deepEqual([r.value, r.stale, r.staleReason], ['bom', true, 'caiu']);
    });

    test('sem dado nenhum, o erro vira "sem dados"', async () => {
      const cache = new GithubCache({ store: makeStore() });
      await assert.rejects(cache.get('k', 1000, failing(new Error('caiu'))), (e) => e instanceof NoDataError && /sem dados: caiu/.test(e.message));
    });

    test('dado com mais de 24 h não é servido como velho', async () => {
      const now = clock();
      const cache = new GithubCache({ store: makeStore(), now });
      await cache.get('k', 1000, counter('bom'));
      now.add(24 * 60 * 60_000 + 1);
      await assert.rejects(cache.get('k', 1000, failing(new Error('caiu'))), NoDataError);
      assert.equal(await cache.peek('k'), null);
    });

    test('limite do GitHub: pausa pelo prazo pedido e serve o cache', async () => {
      const now = clock();
      const cache = new GithubCache({ store: makeStore(), now });
      await cache.get('k', 1000, counter('bom'));
      now.add(2000);
      await cache.get('k', 1000, failing(new RateLimitedError('limite', 90_000)));
      const f = counter('novo');
      now.add(60_000);
      const r = await cache.get('k', 1000, f);
      assert.deepEqual([f.calls, r.value, r.stale], [0, 'bom', true]);
      assert.match(r.staleReason ?? '', /limitou/);
      now.add(31_000);
      assert.equal((await cache.get('k', 1000, f)).value, 'novo');
    });

    test('atualizar à força relê, mas no máximo a cada 30 s', async () => {
      const now = clock();
      const cache = new GithubCache({ store: makeStore(), now });
      const f = counter('v');
      await cache.get('k', 5 * 60_000, f);
      now.add(10_000);
      await cache.get('k', 5 * 60_000, f, { force: true });
      assert.equal(f.calls, 1);
      now.add(20_000);
      await cache.get('k', 5 * 60_000, f, { force: true });
      assert.equal(f.calls, 2);
    });

    test('ETag: 304 mantém o valor e renova o fetchedAt', async () => {
      const now = clock();
      const cache = new GithubCache({ store: makeStore(), now });
      await cache.get('k', 1000, async () => ({ value: [1, 2], etag: 'W/"a"' }));
      now.add(2000);
      let sent: string | null = null;
      const r = await cache.get<number[]>('k', 1000, async ({ etag }) => {
        sent = etag;
        return { notModified: true };
      });
      assert.equal(sent, 'W/"a"');
      assert.deepEqual([r.value, r.fetchedAt], [[1, 2], now()]);
    });

    test('patch atualiza na hora, sem chamar e sem mudar o fetchedAt', async () => {
      const now = clock();
      const cache = new GithubCache({ store: makeStore(), now });
      await cache.get('k', 60_000, counter({ status: 'Todo' }));
      const before = (await cache.peek('k'))!.fetchedAt;
      now.add(1000);
      assert.equal(await cache.patch<{ status: string }>('k', (v) => ({ ...v, status: 'Done' })), true);
      const hit = await cache.peek<{ status: string }>('k');
      assert.deepEqual([hit?.value.status, hit?.fetchedAt], ['Done', before]);
      assert.equal(await cache.patch('nada', (v) => v), false);
    });

    test('invalidate apaga a chave', async () => {
      const cache = new GithubCache({ store: makeStore() });
      await cache.put('k', 1);
      await cache.invalidate('k');
      assert.equal(await cache.peek('k'), null);
    });
  });
}

cacheSuite('memória', () => new MemoryCacheStore());
cacheSuite('SQLite', () => new SqliteCacheStore(new DatabaseSync(':memory:')));

test('o cache SQLite fica no banco do núcleo, ao lado da porta de armazenamento', async () => {
  const storage = openSqliteStorage({ path: ':memory:' });
  const store = new SqliteCacheStore(storage.db);
  await store.set('k', { value: { a: [1] }, fetchedAt: 123, etag: null });
  assert.deepEqual(await new SqliteCacheStore(storage.db).get('k'), { value: { a: [1] }, fetchedAt: 123, etag: null });
  assert.equal(storage.schemaVersion, 1, 'não mexe na versão das migrações');
  await storage.close();
});

describe('pausa depois do limite', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  test('retry-after em segundos', () => assert.equal(backoffMs({ 'retry-after': '30' }, now), 30_000));
  test('x-ratelimit-reset quando acabou o limite', () =>
    assert.equal(backoffMs(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 300) }), now), 300_000));
  test('sem nada, 2 min', () => assert.equal(backoffMs({}, now), 120_000));
});
