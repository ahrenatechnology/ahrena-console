import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import {
  backoffMs,
  GithubCache,
  MIGRATIONS,
  MemoryCacheStore,
  NoDataError,
  openSqliteStorage,
  RateLimitedError,
  SqliteCacheStore,
  type CachePort,
  type Fetcher,
} from '../../src/index.ts';
import { GithubGatewayError, GithubScopeError } from '../../src/github/github-source.ts';
import { githubFailureOf } from '../../src/github/cache.ts';
import { ProjectPermissionError } from '../../src/github/project.ts';
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

function clearSuite(name: string, makeStore: () => CachePort) {
  describe(`#241/AC-4 clearing the GitHub cache on an identity change (${name})`, () => {
    test('clear drops every row, the rate-limit pause and what is in flight', async () => {
      const now = clock();
      const store = makeStore();
      const cache = new GithubCache({ store, now });
      await cache.get('a', 60_000, counter('va'));
      await cache.get('b', 60_000, counter('vb'));
      cache.pause(60_000);
      await cache.clear();
      assert.equal(await store.get('a'), null);
      assert.equal(await store.get('b'), null);
      assert.equal(cache.pauseLeftMs(), 0);
      const f = counter('new');
      assert.equal((await cache.get('a', 60_000, f)).value, 'new');
      assert.equal(f.calls, 1);
    });

    test('a read in flight when the identity changed is neither stored nor served', async () => {
      const now = clock();
      const store = makeStore();
      const cache = new GithubCache({ store, now });
      await cache.get('k', 1, counter('old'));
      now.add(10);
      let release!: () => void;
      const slow: Fetcher<string> = async () => {
        await new Promise<void>((r) => (release = r));
        return { value: 'read with the old identity' };
      };
      const reading = cache.get('k', 1, slow);
      await new Promise((r) => setImmediate(r));
      await cache.clear();
      release();
      await assert.rejects(reading, NoDataError);
      assert.equal(await store.get('k'), null);
      const f = counter('fresh');
      assert.equal((await cache.get('k', 1, f)).value, 'fresh');
      assert.equal(f.calls, 1, 'the in-flight read is not shared after clear');
    });
  });
}

clearSuite('memory', () => new MemoryCacheStore());
clearSuite('SQLite', () => new SqliteCacheStore(new DatabaseSync(':memory:')));

cacheSuite('memória', () => new MemoryCacheStore());
cacheSuite('SQLite', () => new SqliteCacheStore(new DatabaseSync(':memory:')));

test('o cache SQLite fica no banco do núcleo, ao lado da porta de armazenamento', async () => {
  const storage = openSqliteStorage({ path: ':memory:' });
  const store = new SqliteCacheStore(storage.db);
  await store.set('k', { value: { a: [1] }, fetchedAt: 123, etag: null });
  assert.deepEqual(await new SqliteCacheStore(storage.db).get('k'), { value: { a: [1] }, fetchedAt: 123, etag: null });
  assert.equal(storage.schemaVersion, MIGRATIONS.at(-1)?.version, 'não mexe na versão das migrações');
  await storage.close();
});

describe('pausa depois do limite', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  test('retry-after em segundos', () => assert.equal(backoffMs({ 'retry-after': '30' }, now), 30_000));
  test('x-ratelimit-reset quando acabou o limite', () =>
    assert.equal(backoffMs(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 300) }), now), 300_000));
  test('sem nada, 2 min', () => assert.equal(backoffMs({}, now), 120_000));
});

describe('#495/AC-1 the failure code of a GitHub read', () => {
  test('#495/AC-1 githubFailureOf classifies by class, never by message text', () => {
    const net = new TypeError('fetch failed');
    assert.equal(githubFailureOf(net), 'network');
    assert.equal(githubFailureOf(Object.assign(new Error('x'), { name: 'AbortError' })), 'network');
    assert.equal(githubFailureOf(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'network');
    assert.equal(githubFailureOf(new RateLimitedError('limite', 1000)), 'rate-limited');
    assert.equal(githubFailureOf(new GithubScopeError('sem escopo')), 'no-scope');
    assert.equal(githubFailureOf(new ProjectPermissionError('detail')), 'no-scope');
    assert.equal(githubFailureOf(new GithubGatewayError('502', 502)), 'github-error');
    assert.equal(githubFailureOf(new Error('fetch failed')), 'github-error', 'a plain Error with network-like text is not a network failure');
    assert.equal(githubFailureOf('texto'), 'github-error');
  });

  test('#495/AC-1 a NoDataError carries its failure, else the code of its cause', () => {
    assert.equal(githubFailureOf(new NoDataError('x', { cause: new TypeError('fetch failed') })), 'network');
    assert.equal(githubFailureOf(new NoDataError('x', { failure: 'rate-limited' })), 'rate-limited');
    assert.equal(githubFailureOf(new NoDataError('x')), 'github-error');
  });

  test('#495/AC-1 the stale result carries staleCode and keeps the raw staleReason', async () => {
    const now = clock();
    const cache = new GithubCache({ store: new MemoryCacheStore(), now });
    await cache.get('k', 1000, counter('bom'));
    now.add(5000);
    const r = await cache.get('k', 1000, failing(new TypeError('fetch failed')));
    assert.deepEqual([r.stale, r.staleCode, r.staleReason], [true, 'network', 'fetch failed']);
    assert.equal(cache.failure('k'), 'network');
  });

  test('#495/AC-1 the rate-limit pause answers rate-limited, and a fresh read has no code', async () => {
    const now = clock();
    const cache = new GithubCache({ store: new MemoryCacheStore(), now });
    assert.equal((await cache.get('k', 1000, counter('bom'))).staleCode, null);
    now.add(2000);
    await cache.get('k', 1000, failing(new RateLimitedError('limite', 90_000)));
    now.add(5000);
    const paused = await cache.get('k', 1000, counter('novo'));
    assert.deepEqual([paused.stale, paused.staleCode], [true, 'rate-limited']);
  });

  test('#495/AC-1 no data: the NoDataError carries the code, the cause stays the source error', async () => {
    const cache = new GithubCache({ store: new MemoryCacheStore() });
    const cause = new TypeError('fetch failed');
    await assert.rejects(cache.get('k', 1000, failing(cause)), (e) => e instanceof NoDataError && e.failure === 'network' && e.cause === cause);
    await assert.rejects(cache.get('p', 1000, failing(new RateLimitedError('l', 60_000))), (e) => e instanceof NoDataError && e.failure === 'rate-limited');
    await assert.rejects(cache.get('q', 1000, counter('x')), (e) => e instanceof NoDataError && e.failure === 'rate-limited', 'the pause path');
  });

  test('#495/AC-1 failure(key) is recorded per key, dropped by a good read and by clear()', async () => {
    const now = clock();
    const cache = new GithubCache({ store: new MemoryCacheStore(), now });
    assert.equal(cache.failure('k'), null);
    await cache.get('k', 1000, counter('bom'));
    now.add(5000);
    await cache.get('k', 1000, failing(new GithubScopeError('x')));
    assert.equal(cache.failure('k'), 'no-scope');
    assert.equal(cache.failure('other'), null);
    now.add(5000);
    await cache.get('k', 1000, counter('novo'));
    assert.equal(cache.failure('k'), null);
    now.add(5000);
    await cache.get('k', 1000, failing(new Error('caiu')));
    assert.equal(cache.failure('k'), 'github-error');
    await cache.clear();
    assert.equal(cache.failure('k'), null);
  });
});
