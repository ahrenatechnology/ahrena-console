// Every GitHub source takes its credential from one provider (#241, decision 0011 §5): no source
// asks `gh` by default, a function token is asked on every request (the connection caches it, not
// the source), and a "not connected" provider means no request leaves.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubGraphqlSource } from '../../src/github/github-source.ts';
import { createGithubWork } from '../../src/github/index.ts';
import { createGithubProject, GithubProjectSource } from '../../src/github/project.ts';
import { GithubReposSource, SemGithubError } from '../../src/github/repos-source.ts';
import { GithubDevConsoleSource } from '../../src/dev-console/source.ts';
import { GithubNotConnectedError } from '../../src/github/connection/index.ts';

const notConnected = async (): Promise<string> => {
  throw new GithubNotConnectedError();
};

function countingFetch() {
  const auth: string[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get('authorization') ?? '');
    return Response.json({ data: { rateLimit: { cost: 1, remaining: 4999 }, repository: { issue: null, refs: { nodes: [], pageInfo: { hasNextPage: false } } } } });
  }) as typeof fetch;
  return { f, auth };
}

/** A token function that hands out a new value each time, so the requests show who asked. */
function rotating() {
  let n = 0;
  const token = async () => `t${++n}`;
  return { token, asked: () => n };
}

describe('#241/AC-3 one credential provider for every GitHub source', () => {
  test('GithubGraphqlSource asks the token function on every request', async () => {
    const { f, auth } = countingFetch();
    const t = rotating();
    const s = new GithubGraphqlSource({ token: t.token, fetch: f });
    await assert.rejects(s.detail('a/b#1'));
    await assert.rejects(s.detail('a/b#1'));
    assert.deepEqual(auth, ['bearer t1', 'bearer t2']);
  });

  test('GithubReposSource asks per request and keeps GithubNotConnectedError as it is, without a request', async () => {
    const { f, auth } = countingFetch();
    const t = rotating();
    const s = new GithubReposSource({ token: t.token, fetch: f, api: 'https://fake.invalid', url: 'https://fake.invalid/graphql' });
    await s.rest('/repos/a/b/languages', null);
    await s.rest('/repos/a/b/languages', null);
    assert.deepEqual(auth, ['bearer t1', 'bearer t2']);
    const off = new GithubReposSource({ token: notConnected, fetch: f, api: 'https://fake.invalid', url: 'https://fake.invalid/graphql' });
    await assert.rejects(off.rest('/repos/a/b/languages', null), GithubNotConnectedError);
    assert.equal(auth.length, 2);
  });

  test('GithubReposSource without a token has no gh fallback: SemGithubError, no request', async () => {
    const { f, auth } = countingFetch();
    const s = new GithubReposSource({ fetch: f } as never);
    await assert.rejects(s.rest('/repos/a/b/languages', null), SemGithubError);
    assert.equal(auth.length, 0);
  });

  test('GithubDevConsoleSource asks per request; not connected sends nothing', async () => {
    const { f, auth } = countingFetch();
    const t = rotating();
    const s = new GithubDevConsoleSource({ token: t.token, fetch: f });
    await s.branches('a/b');
    await s.branches('a/b');
    assert.deepEqual(auth, ['bearer t1', 'bearer t2']);
    await assert.rejects(new GithubDevConsoleSource({ token: notConnected, fetch: f }).branches('a/b'), GithubNotConnectedError);
    assert.equal(auth.length, 2);
  });

  test('GithubProjectSource and createGithubProject ask per request; not connected sends nothing', async () => {
    const { f, auth } = countingFetch();
    const t = rotating();
    const s = new GithubProjectSource({ token: t.token, fetch: f });
    await assert.rejects(s.board({ owner: 'o', number: 1 }));
    await assert.rejects(s.board({ owner: 'o', number: 1 }));
    assert.deepEqual(auth, ['bearer t1', 'bearer t2']);
    const project = createGithubProject({ project: { owner: 'o', number: 1 }, cache: new GithubCache({ store: new MemoryCacheStore() }), token: notConnected, fetch: f });
    await assert.rejects(project.board());
    assert.equal(auth.length, 2);
  });

  test('createGithubWork and createGithubProject have no gh default: the token is required', () => {
    assert.throws(() => createGithubWork({ filter: 'repo:a/b' } as never), /token/);
    assert.throws(() => createGithubProject({ project: { owner: 'o', number: 1 }, cache: new GithubCache({ store: new MemoryCacheStore() }) } as never), /token/);
    assert.throws(() => new GithubDevConsoleSource({} as never), /token/);
    assert.throws(() => new GithubGraphqlSource({} as never), /token/);
  });
});
