/*
 * #512 a GitHub GraphQL request of the work board that does not answer within the timeout is aborted
 * (AC-1). Each read of the adapters the work routes use gets a fake `fetch` that accepts the request and
 * never answers, and rejects only when the signal it was handed aborts. Nothing here leaves the loopback.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { GithubCache, githubFailureOf, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubGraphqlSource, GITHUB_TIMEOUT_MS } from '../../src/github/github-source.ts';
import { createGithubProject, GithubProjectSource } from '../../src/github/project.ts';
import { clock, k } from './helpers.ts';

const TIMEOUT_MS = 30;
/** The test fails (instead of hanging) when a read is not bounded: well above the timeout, well below the runner's. */
const GUARD_MS = 5_000;

interface Hanging {
  fetch: typeof globalThis.fetch;
  calls: number;
}

/** A GitHub that accepts the request and never answers; it gives up only when the signal aborts. */
function hangingFetch(): Hanging {
  const hanging: Hanging = {
    calls: 0,
    fetch: ((_url: unknown, init?: RequestInit) => {
      hanging.calls++;
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // no signal handed: the call hangs for good, which the guard reports
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }) as typeof globalThis.fetch,
  };
  return hanging;
}

/** Rejects with a clear message when `read` has not settled within `GUARD_MS`. */
async function settles<T>(read: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the read was not aborted within ${GUARD_MS} ms`)), GUARD_MS);
  });
  try {
    return { ok: true, value: await Promise.race([read, guard]) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('the read was not aborted')) throw error;
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

async function assertAbortedAsNetwork(read: Promise<unknown>) {
  const out = await settles(read);
  assert.equal(out.ok, false, 'the read rejects instead of resolving');
  if (!out.ok) assert.equal(githubFailureOf(out.error), 'network', 'a timeout classifies as network (#495)');
}

describe('#512/AC-1 the GraphQL source aborts a request that does not answer', () => {
  const reads: [string, (s: GithubGraphqlSource) => Promise<unknown>][] = [
    ['listShallow', (s) => s.listShallow('repo:x/y is:issue is:open')],
    ['nodes', (s) => s.nodes([k(1)])],
    ['children', (s) => s.children(k(1))],
    ['detail', (s) => s.detail(k(1))],
    ['issue', (s) => s.issue(k(1))],
    ['current', (s) => s.current(k(1))],
  ];

  for (const [name, read] of reads) {
    test(`#512/AC-1 Given GitHub never answers, When ${name} is read, Then it is aborted after the timeout and classifies as network, with no gateway retry`, async () => {
      const github = hangingFetch();
      const source = new GithubGraphqlSource({ token: 't', fetch: github.fetch, timeoutMs: TIMEOUT_MS });
      await assertAbortedAsNetwork(read(source));
      assert.equal(github.calls, 1, 'a timeout is not a gateway error: one request, no retry');
    });
  }
});

describe('#512/AC-1 the Project source aborts a request that does not answer', () => {
  test('#512/AC-1 Given GitHub never answers, When the Project board is read, Then it is aborted after the timeout and classifies as network, with no retry', async () => {
    const github = hangingFetch();
    const source = new GithubProjectSource({ token: 't', fetch: github.fetch, timeoutMs: TIMEOUT_MS });
    await assertAbortedAsNetwork(source.board({ owner: 'ahrenatechnology', number: 3 }));
    assert.equal(github.calls, 1);
  });

  test('#512/AC-1 Given GitHub never answers, When the Project is read through createGithubProject and its cache, Then the read fails with network and nothing is stored', async () => {
    const github = hangingFetch();
    const cache = new GithubCache({ store: new MemoryCacheStore(), now: clock() });
    const project = createGithubProject({ project: { owner: 'ahrenatechnology', number: 3 }, cache, token: 't', fetch: github.fetch, timeoutMs: TIMEOUT_MS });
    await assertAbortedAsNetwork(project.board());
    assert.equal(github.calls, 1);
  });

  test('#512/AC-1 Given a Project move, When GitHub never answers, Then the mutation is aborted too', async () => {
    const github = hangingFetch();
    const source = new GithubProjectSource({ token: 't', fetch: github.fetch, timeoutMs: TIMEOUT_MS });
    await assertAbortedAsNetwork(source.move({ projectId: 'P', itemId: 'I', fieldId: 'F', optionId: 'O', field: 'Status' }));
  });
});

describe('#512/AC-1 the deadline bounds the response body, not only the headers', () => {
  /** A loopback server that sends the 200 headers and part of a JSON body, then never ends the response. */
  async function withStalledBody(fn: (url: string) => Promise<void>) {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"data":{"repository":');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  test('#512/AC-1 Given GitHub sends the headers and a body that never ends, When the issue is read with the real fetch, Then it is aborted after the timeout and classifies as network', () =>
    withStalledBody(async (url) => {
      const source = new GithubGraphqlSource({ token: 't', url, timeoutMs: 100 });
      await assertAbortedAsNetwork(source.issue(k(1)));
    }));

  test('#512/AC-1 Given GitHub sends the headers and a body that never ends, When the Project is read with the real fetch, Then it is aborted after the timeout and classifies as network', () =>
    withStalledBody(async (url) => {
      const source = new GithubProjectSource({ token: 't', url, timeoutMs: 100 });
      await assertAbortedAsNetwork(source.board({ owner: 'ahrenatechnology', number: 3 }));
    }));
});

describe('#512/AC-1 the default deadline', () => {
  test('#512/AC-1 the default timeout of a GitHub call stays 30 s', () => {
    assert.equal(GITHUB_TIMEOUT_MS, 30_000);
  });
});
