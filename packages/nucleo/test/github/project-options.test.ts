// The Projects the account sees (#241, decision 0011 §7): the GraphQL `ProjectOptions` read (the
// person's and their organizations' Projects v2), through the 0001 cache with the "projects and
// fields" TTL (1 h) and the single call queue; a forced refresh respects the 30 s minimum.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GithubCallQueue } from '../../src/github/call-queue.ts';
import { GITHUB_TTL, GithubCache, MemoryCacheStore, NoDataError } from '../../src/github/cache.ts';
import { GithubGatewayError, GithubHttpError, GraphqlResponseError } from '../../src/github/github-source.ts';
import { blockReasonOf, GithubProjectOptionsSource, PROJECT_OPTIONS_CACHE_KEY, PROJECT_OPTIONS_QUERY, ProjectOptions } from '../../src/github/project-options.ts';
import { createFakeGithub, DEMO_GITHUB_DATA } from '../../src/simulator/fake-github.ts';
import { clock } from './helpers.ts';

const TOKEN = 'gho_FAKEprojects00000000000000000000000';

function setup() {
  const now = clock();
  const gh = createFakeGithub(DEMO_GITHUB_DATA, { now, auth: { clientId: 'test-client-id', token: TOKEN, scopes: ['repo', 'read:org', 'project'], login: 'dev-sintetico', requireToken: true } });
  const source = new GithubProjectOptionsSource({ token: async () => TOKEN, fetch: gh.fetch, url: 'https://fake.invalid/graphql' });
  const store = new MemoryCacheStore();
  const cache = new GithubCache({ store, now });
  const queue = new GithubCallQueue();
  let queued = 0;
  const run = queue.run.bind(queue);
  queue.run = (fn) => (queued++, run(fn));
  return { now, gh, source, store, cache, queue, queued: () => queued, options: new ProjectOptions({ source, cache, queue }) };
}

describe('#241/AC-5 the Projects the account sees', () => {
  test('the query reads the viewer\'s and the organizations\' Projects with owner, items and the Status field', () => {
    assert.match(PROJECT_OPTIONS_QUERY, /query ProjectOptions\b/);
    for (const part of ['viewer', 'projectsV2(first: 50)', 'organizations(first: 50)', 'items { totalCount }', 'field(name: "Status")', 'closed', 'rateLimit', '... on Organization { login }', '... on User { login }']) {
      assert.ok(PROJECT_OPTIONS_QUERY.includes(part), part);
    }
  });

  test('the source maps every Project of the fake: the simulator one, a user one without Status, a closed one', async () => {
    const { source } = setup();
    const { projects, owners } = await source.list();
    assert.deepEqual(
      owners.map((o) => [o.login, o.ownerType, o.projects, o.blocked]),
      [['dev-sintetico', 'user', 2, null], ['exemplo', 'organization', 1, null], ...DEMO_GITHUB_DATA.organizations.map((login) => [login, 'organization', 0, null])],
    );
    assert.deepEqual(
      projects.map((p) => [`${p.owner}/${p.number}`, p.ownerType, p.hasStatusField, p.closed]),
      [
        ['dev-sintetico/1', 'user', false, false],
        ['dev-sintetico/2', 'user', true, true],
        ['exemplo/3', 'organization', true, false],
      ],
    );
    const sim = projects.find((p) => p.owner === 'exemplo')!;
    assert.equal(typeof sim.title, 'string');
    assert.match(sim.url, /^https:\/\/github\.com\/orgs\/exemplo\/projects\/3$/);
    assert.ok(sim.items > 0);
  });

  test('cached for GITHUB_TTL.projects (1 h) under one key, through the queue; refresh=1 respects the 30 s minimum', async () => {
    const { options, gh, now, store, queued } = setup();
    assert.equal(GITHUB_TTL.projects, 60 * 60_000);
    const first = await options.list();
    assert.equal(first.projects.length, 3);
    assert.ok(first.owners.length >= 2);
    assert.equal(first.stale, false);
    assert.equal(first.reason, null);
    assert.equal(first.fetchedAt, new Date(now()).toISOString());
    assert.ok(await store.get(PROJECT_OPTIONS_CACHE_KEY));
    const reads = () => gh.calls.filter((c) => c === 'GRAPHQL ProjectOptions').length;
    now.add(59 * 60_000);
    await options.list();
    assert.equal(reads(), 1);
    await options.list({ refresh: true });
    assert.equal(reads(), 2, 'forced after 59 min');
    now.add(10_000);
    await options.list({ refresh: true });
    assert.equal(reads(), 2, 'not again within 30 s');
    assert.equal(queued(), 2);
  });

  test('GitHub down with an old read: stale with the reason; without one: NoDataError', async () => {
    const { cache, queue, now, source } = setup();
    let down = false;
    const flaky = { list: () => (down ? Promise.reject(new GithubHttpError('GitHub respondeu 500: boom', 500)) : source.list()) };
    const options = new ProjectOptions({ source: flaky, cache, queue });
    await options.list();
    down = true;
    now.add(61 * 60_000);
    const r = await options.list();
    assert.equal(r.stale, true);
    assert.match(r.reason!, /500/);
    await cache.clear();
    await assert.rejects(options.list(), NoDataError);
  });

  // The answer recorded on 2026-10-25 with the real login: 200, data for every owner, and one FORBIDDEN
  // per Project node of the organization that restricts the OAuth App.
  const RESTRICTED = 'Although you appear to have the correct authorization credentials, the `guardiafinance` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.';
  const node = (owner: string, number: number) => ({ number, title: `P${number}`, url: `https://github.com/orgs/${owner}/projects/${number}`, closed: false, owner: { __typename: 'Organization', login: owner }, items: { totalCount: 1 }, field: { __typename: 'ProjectV2SingleSelectField' } });
  function answering(body: unknown, status = 200): GithubProjectOptionsSource {
    const fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
    return new GithubProjectOptionsSource({ token: TOKEN, fetch, url: 'https://fake.invalid/graphql', sleep: async () => {} });
  }
  const partial = (errors: unknown[]) => ({
    data: {
      rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-10-25T23:00:00Z' },
      viewer: {
        login: 'fernandoseguim',
        projectsV2: { totalCount: 0, nodes: [] },
        organizations: {
          nodes: [
            { login: 'guardiafinance', projectsV2: { totalCount: 2, nodes: [null, null] } },
            { login: 'ahrenatechnology', projectsV2: { totalCount: 2, nodes: [node('ahrenatechnology', 1), node('ahrenatechnology', 4)] } },
          ],
        },
      },
    },
    errors,
  });
  const forbidden = (path: unknown[], message = RESTRICTED) => ({ type: 'FORBIDDEN', path, message });

  test('#340 one organization restricting the OAuth App: it comes back blocked, the others keep their Projects', async () => {
    const { projects, owners } = await answering(partial([forbidden(['viewer', 'organizations', 'nodes', 0, 'projectsV2', 'nodes', 0]), forbidden(['viewer', 'organizations', 'nodes', 0, 'projectsV2', 'nodes', 1])])).list();
    assert.deepEqual(projects.map((p) => `${p.owner}/${p.number}`), ['ahrenatechnology/1', 'ahrenatechnology/4']);
    assert.deepEqual(owners, [
      { login: 'fernandoseguim', ownerType: 'user', projects: 0, blocked: null },
      { login: 'guardiafinance', ownerType: 'organization', projects: 2, blocked: { reason: 'oauth-restricted', message: RESTRICTED } },
      { login: 'ahrenatechnology', ownerType: 'organization', projects: 2, blocked: null },
    ]);
  });

  test('#340 the reason: OAuth App restriction, SAML, anything else', () => {
    assert.equal(blockReasonOf(RESTRICTED), 'oauth-restricted');
    assert.equal(blockReasonOf('Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.'), 'saml');
    assert.equal(blockReasonOf('Resource not accessible by integration'), 'forbidden');
  });

  test('#340 the person\'s own Projects refused: the user owner is blocked', async () => {
    const { owners } = await answering(partial([forbidden(['viewer', 'projectsV2', 'nodes', 0], 'Resource not accessible by integration')])).list();
    assert.deepEqual(owners[0], { login: 'fernandoseguim', ownerType: 'user', projects: 0, blocked: { reason: 'forbidden', message: 'Resource not accessible by integration' } });
  });

  test('#340 an error no owner explains, or errors without data, still fail the read with GitHub\'s message', async () => {
    await assert.rejects(answering(partial([forbidden(['viewer', 'organizations'], 'boom')])).list(), (e: Error) => e instanceof GraphqlResponseError && /GitHub: boom/.test(e.message));
    await assert.rejects(answering({ data: null, errors: [{ type: 'FORBIDDEN', message: 'nope' }] }).list(), (e: Error) => e instanceof GraphqlResponseError && /nope/.test(e.message));
  });

  test('#340 the HTTP status travels: 401 is a refusal, 502 a gateway error', async () => {
    await assert.rejects(answering({ message: 'Bad credentials' }, 401).list(), (e: Error) => e instanceof GithubHttpError && e.status === 401 && /Bad credentials/.test(e.message));
    await assert.rejects(answering({ message: 'bad gateway' }, 502).list(), GithubGatewayError);
  });
});
