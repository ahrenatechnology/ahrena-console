// The Projects the account sees (#241, decision 0011 §7): the GraphQL `ProjectOptions` read (the
// person's and their organizations' Projects v2), through the 0001 cache with the "projects and
// fields" TTL (1 h) and the single call queue; a forced refresh respects the 30 s minimum.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GithubCallQueue } from '../../src/github/call-queue.ts';
import { GITHUB_TTL, GithubCache, MemoryCacheStore, NoDataError } from '../../src/github/cache.ts';
import { GithubProjectOptionsSource, PROJECT_OPTIONS_CACHE_KEY, PROJECT_OPTIONS_QUERY, ProjectOptions } from '../../src/github/project-options.ts';
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
    const projects = await source.list();
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
    const flaky = { list: () => (down ? Promise.reject(new Error('GitHub respondeu 500: boom')) : source.list()) };
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
});
