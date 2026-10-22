// The core's GitHub-backed screens take their credential from the one provider (#241, decision 0011
// §5): the create* helpers need a `github` access object outside the demo and `--no-github`, the token
// flows from it to every request, and the demo's fake GitHub gets the provider's token too.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { githubReposTransport } from '../../src/api/github-access.ts';
import { criarReposDoNucleo } from '../../src/api/repos.ts';
import { createCoreAgentInstructions } from '../../src/api/agent-instructions.ts';
import { createCoreFrameworkInstall } from '../../src/api/framework-install.ts';
import { createCoreDecisions } from '../../src/api/adrs.ts';
import { createCoreDelivery } from '../../src/api/delivery-github.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { GithubCallQueue } from '../../src/github/call-queue.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { GithubNotConnectedError } from '../../src/github/connection/index.ts';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts } from '../../src/api/index.ts';
import { FleetReader } from '../../src/mcp/fleet.ts';
import { createFakeGithub, DEMO_GITHUB_DATA } from '../../src/simulator/fake-github.ts';

const TOKEN = 'gho_FAKEaccess000000000000000000000000';

function base() {
  const storage = openSqliteStorage({ path: ':memory:' });
  const frota = new FleetReader({ storage, accounts: new Accounts({ storage, file: null }) });
  return { storage, frota, cache: new GithubCache({ store: new MemoryCacheStore() }), changes: new ChangeCursor(), queue: new GithubCallQueue() };
}

describe('#241/AC-3 the github access object of the core screens', () => {
  test('outside the demo and --no-github, every create* helper needs the github access', () => {
    const b = base();
    const common = { demo: false, noGithub: false, cache: b.cache, changes: b.changes, queue: b.queue };
    assert.throws(() => criarReposDoNucleo({ demo: false, semGithub: false, cache: b.cache, frota: b.frota, mudancas: b.changes }), /github access/);
    assert.throws(() => createCoreAgentInstructions(common), /github access/);
    assert.throws(() => createCoreFrameworkInstall(common), /github access/);
    assert.throws(() => createCoreDecisions({ ...common, accountRepos: async () => ({ state: 'ready', error: null, account: null, repos: [] }) }), /github access/);
    assert.throws(
      () => createCoreDelivery({ ...common, sessions: { repoDe: () => null } as never, boards: async () => [], accountRepos: async () => [] }),
      /github access/,
    );
    // --no-github needs none
    assert.doesNotThrow(() => createCoreAgentInstructions({ ...common, noGithub: true }));
  });

  test('the provider\'s token is what every request carries', async () => {
    const b = base();
    const gh = createFakeGithub(DEMO_GITHUB_DATA, { auth: { clientId: 'test-client-id', token: TOKEN, scopes: ['repo'], login: 'dev-sintetico', requireToken: true } });
    let asked = 0;
    const { repos } = criarReposDoNucleo({
      demo: false,
      semGithub: false,
      cache: b.cache,
      frota: b.frota,
      mudancas: b.changes,
      github: { token: async () => (asked++, TOKEN), fetch: gh.fetch, url: 'https://fake.invalid/graphql', api: 'https://fake.invalid' },
    });
    await repos.lista();
    await repos.esperar();
    const l = await repos.lista();
    assert.equal(l.state, 'ready');
    assert.ok(asked >= 1);
    assert.ok(gh.calls.length > 0);
    assert.deepEqual(gh.calls.filter((c) => c.startsWith('UNAUTHORIZED')), []);
  });

  test('a provider that is not connected: nothing leaves', async () => {
    const b = base();
    const sent: string[] = [];
    const { repos } = criarReposDoNucleo({
      demo: false,
      semGithub: false,
      cache: b.cache,
      frota: b.frota,
      mudancas: b.changes,
      log: () => undefined,
      github: {
        token: async () => {
          throw new GithubNotConnectedError();
        },
        fetch: (async (u: string | URL | Request) => (sent.push(String(u)), new Response('{}'))) as typeof fetch,
      },
    });
    await repos.lista();
    await repos.esperar();
    assert.notEqual((await repos.lista()).state, 'ready');
    assert.deepEqual(sent, []);
  });

  test('the demo keeps its fake GitHub but takes the token from the provider', async () => {
    const seen: string[] = [];
    const fake = createFakeGithub(DEMO_GITHUB_DATA);
    const demoFetch = () =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? '');
        return fake.fetch(input, init);
      }) as typeof fetch;
    const t = githubReposTransport({ demo: true, noGithub: false, github: { token: async () => 'demo-token-from-provider' }, demoFetch, demoBase: 'https://fake.invalid' })!;
    await t.rest('/repos/exemplo-labs/vitrine-demo/languages', null);
    assert.deepEqual(seen, ['bearer demo-token-from-provider']);
    assert.equal(githubReposTransport({ demo: false, noGithub: true, demoFetch, demoBase: 'x' }), null);
  });
});
