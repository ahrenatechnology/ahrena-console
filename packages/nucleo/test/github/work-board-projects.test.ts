/*
 * #609 the reader of the Projects of every granted organization, and its background-sync step: the step re-reads each Project
 * (forced), waits (pending) without a GitHub connection, and fails when GitHub did not answer so the sync log says it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SYNC_WORK_PROJECTS_EVERY_MS } from '../../src/github/background-sync.ts';
import { GithubCache, MemoryCacheStore, NoDataError } from '../../src/github/cache.ts';
import type { ProjectBoard } from '../../src/github/project.ts';
import type { ProjectOptionsList } from '../../src/github/project-options.ts';
import { trustedOwnersOf } from '../../src/github/trusted-owners.ts';
import { MAX_CHECKED_ORGS } from '../../src/github/connection/connection.ts';
import { createWorkBoardProjects, orgCheckOf, WorkBoardProjects, workProjectsSyncStep, workProjectsSyncSteps } from '../../src/github/work-board-projects.ts';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const list = (): ProjectOptionsList => ({
  projects: [{ owner: 'acme-labs', ownerType: 'organization', number: 3, title: 'Platform', url: 'u', items: 1, hasStatusField: true, closed: false }],
  owners: [{ login: 'acme-labs', ownerType: 'organization', projects: 1, blocked: null }],
  fetchedAt: new Date(NOW).toISOString(),
  stale: false,
  reason: null,
});
const board = (over: Partial<ProjectBoard> = {}): ProjectBoard => ({ owner: 'acme-labs', number: 3, title: 'Platform', url: 'u', field: 'Status', lanes: [], count: 0, fetchedAt: NOW, stale: false, staleReason: null, staleCode: null, ...over });

function rig(fail = false) {
  const forced: boolean[] = [];
  const reader = new WorkBoardProjects({
    options: { list: async () => list(), snapshot: async () => null },
    orgs: async () => [{ login: 'acme-labs', access: 'granted' }],
    project: () => ({
      board: async ({ force } = {}) => {
        forced.push(force === true);
        if (fail) throw new NoDataError('sem dados', { failure: 'network' });
        return board();
      },
    }),
    now: () => NOW,
  });
  return { reader, forced };
}

describe('#609/AC-1 the background sync reads the Projects of every organization', () => {
  test('#609/AC-1 the work-projects step has its own name and the cadence of the project step', () => {
    const step = workProjectsSyncStep(rig().reader, async () => true);
    assert.equal(step.name, 'work-projects');
    assert.equal(step.everyMs, SYNC_WORK_PROJECTS_EVERY_MS);
  });

  test('#609/AC-1 the step forces a read of each Project and is done', async () => {
    const { reader, forced } = rig();
    assert.equal(await workProjectsSyncStep(reader, async () => true).run(), 'done');
    assert.deepEqual(forced, [true]);
  });

  test('#612/AC-1 the step answers pending, reading nothing, while GitHub is not connected or is revoked', async () => {
    const { reader, forced } = rig();
    assert.equal(await workProjectsSyncStep(reader, async () => false).run(), 'pending');
    assert.equal(await workProjectsSyncStep(reader, async () => { throw new Error('status unavailable'); }).run(), 'pending');
    assert.deepEqual(forced, []);
  });

  test('#612/AC-3 the step reads again on the next tick once the connection is back', async () => {
    const { reader, forced } = rig();
    let live = false;
    const step = workProjectsSyncStep(reader, async () => live);
    assert.equal(await step.run(), 'pending');
    live = true;
    assert.equal(await step.run(), 'done');
    assert.deepEqual(forced, [true]);
  });

  test('#612/AC-2 a read during which the connection dropped (GitHub 401) is pending, not a step failure', async () => {
    const { reader } = rig(true);
    let live = true;
    const dropping = new WorkBoardProjects({
      options: { list: async () => list(), snapshot: async () => null },
      orgs: async () => [{ login: 'acme-labs', access: 'granted' }],
      project: () => ({ board: async () => { live = false; return board({ stale: true, staleReason: 'GitHub answered 401', staleCode: 'github-error' }); } }),
      now: () => NOW,
    });
    assert.equal(await workProjectsSyncStep(dropping, async () => live).run(), 'pending');
    assert.ok(reader);
  });

  test('#612/AC-2 a stale read while the connection stays up is still a step failure', async () => {
    const stale = new WorkBoardProjects({
      options: { list: async () => list(), snapshot: async () => null },
      orgs: async () => [{ login: 'acme-labs', access: 'granted' }],
      project: () => ({ board: async () => board({ stale: true, staleReason: 'network', staleCode: 'network' }) }),
      now: () => NOW,
    });
    await assert.rejects(() => workProjectsSyncStep(stale, async () => true).run(), /were not read/);
  });

  test('#609/AC-3 the step fails with a code when nothing could be read, never a message from GitHub', async () => {
    const { reader } = rig(true);
    await assert.rejects(() => workProjectsSyncStep(reader, async () => true).run(), (err: Error) => err instanceof NoDataError || /network/.test(err.message));
  });

  test('#609/AC-3 the step is done when only some Projects failed, and fails only when nothing could be read', async () => {
    const reader = new WorkBoardProjects({
      options: {
        list: async () => ({ ...list(), projects: [...list().projects, { ...list().projects[0]!, number: 4, title: 'Mobile' }] }),
        snapshot: async () => null,
      },
      orgs: async () => [{ login: 'acme-labs', access: 'granted' }],
      project: (ref) => ({
        board: async () => {
          if (ref.number === 4) throw new NoDataError('sem dados', { failure: 'network' });
          return board();
        },
      }),
      now: () => NOW,
    });
    assert.equal(await workProjectsSyncStep(reader, async () => true).run(), 'done');
    const read = await reader.read({ force: true });
    assert.deepEqual([read.stale, read.organizations[0]?.state, read.organizations[0]?.reason], [false, 'failed', 'network']);
  });
});

describe('#609/AC-4 the core builds the reader and its sync step only where GitHub is reachable', () => {
  const projectOptions = { list: async () => list(), snapshot: async () => null };
  const connection = { status: async () => ({ orgs: [{ login: 'acme-labs', access: 'granted' as const }] }) };
  const cache = () => new GithubCache({ store: new MemoryCacheStore(), now: () => NOW });
  const access = (seen: string[]) => ({
    token: async () => 'fake-token-for-the-test',
    fetch: (async (_url: unknown, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? (init?.headers as Record<string, string> | undefined)?.Authorization));
      return new Response('down', { status: 500 });
    }) as typeof fetch,
  });

  test('#609/AC-4 under --demo, without access or without the Projects list there is no reader and no sync step', () => {
    const base = { projectOptions, access: access([]), connection, cache: cache() };
    assert.equal(createWorkBoardProjects({ ...base, demo: true }), null);
    assert.equal(createWorkBoardProjects({ ...base, demo: false, access: null }), null);
    assert.equal(createWorkBoardProjects({ ...base, demo: false, projectOptions: null }), null);
    assert.deepEqual(workProjectsSyncSteps(null, async () => true), []);
  });

  test('#609/AC-4 with access the reader reads through the connection\'s organizations and token, and the sync step is the work-projects one', async () => {
    const seen: string[] = [];
    const reader = createWorkBoardProjects({ demo: false, projectOptions, access: access(seen), connection, cache: cache() });
    assert.ok(reader);
    assert.deepEqual(workProjectsSyncSteps(reader, async () => true).map((s) => s.name), ['work-projects']);
    await assert.rejects(() => reader.read(), NoDataError);
    assert.ok(seen.length > 0 && seen.every((h) => h.includes('fake-token-for-the-test')), 'the Project of acme-labs was asked with the connection\'s token');
    assert.deepEqual(reader.readOwners(), []);
  });
});

describe('#609/AC-2 the chosen Project\'s organization stays on the board whatever the state of the organization check', () => {
  const account = { login: 'maria', ownerType: 'user' as const, projects: 0, blocked: null };
  const accountList = (): ProjectOptionsList => ({ ...list(), owners: [...list().owners, account] });
  const readerFor = (check: Awaited<ReturnType<WorkBoardProjectsOptionsOrgs>>) =>
    new WorkBoardProjects({ options: { list: async () => accountList(), snapshot: async () => null }, orgs: async () => check, project: () => ({ board: async () => board() }), now: () => NOW });

  const keeps = async (check: Awaited<ReturnType<WorkBoardProjectsOptionsOrgs>>) => {
    const reader = readerFor(check);
    const read = await reader.read();
    assert.deepEqual(read.organizations.map((o) => [o.login, o.state, o.projects.length]), [['acme-labs', 'read', 1], ['maria', 'read', 0]]);
    assert.deepEqual(read.boards.map((b) => b.organization), ['acme-labs']);
    assert.deepEqual(trustedOwnersOf({ stored: null, selectedOwner: 'acme-labs', readOwners: reader.readOwners() }), ['acme-labs']);
  };

  test('#609/AC-2 a gh credential source (no organization list) keeps the chosen Project\'s organization on the board and trusted', async () => {
    await keeps(orgCheckOf({ orgs: [], orgsChecked: false, orgsFailed: false }));
  });

  test('#609/AC-2 a console connection before the organization check finishes does the same', async () => {
    await keeps(orgCheckOf({ orgs: [], orgsChecked: false, orgsFailed: false }));
  });

  test('#609/AC-2 a first organization check that failed does the same', async () => {
    await keeps(orgCheckOf({ orgs: [], orgsChecked: true, orgsFailed: true }));
  });

  test('#609/AC-2 organizations still pending approval stay warnings while the check has no list', async () => {
    const pending = { login: 'locked-co', access: 'pending' as const, approvalUrl: 'a', requestUrl: 'r' };
    const read = await readerFor({ orgs: [pending], checked: false }).read();
    assert.deepEqual(read.organizations.map((o) => [o.login, o.state]), [['acme-labs', 'read'], ['locked-co', 'restricted'], ['maria', 'read']]);
  });

  test('#609/AC-2 a finished check is the list: an organization it did not grant is not read from the Projects list', async () => {
    const read = await readerFor(orgCheckOf({ orgs: [], orgsChecked: true, orgsFailed: false })).read();
    assert.deepEqual(read.organizations.map((o) => o.login), ['maria']);
  });
});
describe('#609/AC-4 the board reads the owners the default trust needs', () => {
  test('#609/AC-4 when the organization check hit the cap, the listed organizations that are neither blocked nor pending are read too', async () => {
    const granted = Array.from({ length: MAX_CHECKED_ORGS }, (_, i) => ({ login: `org-${i}`, access: 'granted' as const }));
    const base = list();
    const withBlocked: ProjectOptionsList = { ...base, owners: [...base.owners, { login: 'refused-co', ownerType: 'organization', projects: 0, blocked: { reason: 'saml', message: 'raw' } }] };
    const reader = new WorkBoardProjects({
      options: { list: async () => withBlocked, snapshot: async () => null },
      orgs: async () => ({ orgs: granted, checked: true }),
      project: () => ({ board: async () => board() }),
      now: () => NOW,
    });
    const read = await reader.read();
    assert.ok(read.boards.some((b) => b.organization === 'acme-labs'), 'the listed organization past the cap was read');
    assert.deepEqual(reader.readOwners(), ['acme-labs']);
    assert.equal(read.organizations.find((o) => o.login === 'refused-co')?.state, 'saml');
  });

  test('#609/AC-4 below the cap a finished check is still the list', async () => {
    const reader = new WorkBoardProjects({
      options: { list: async () => list(), snapshot: async () => null },
      orgs: async () => ({ orgs: [{ login: 'org-0', access: 'granted' }], checked: true }),
      project: () => ({ board: async () => board() }),
      now: () => NOW,
    });
    const read = await reader.read();
    assert.deepEqual(read.boards, []);
  });

  const solo = (over: Partial<ProjectBoard> = {}) => board({ owner: 'solo-co', number: 7, title: 'Solo', ...over });
  const selectedReader = (selected: { owner: string; number: number } | null, check: Awaited<ReturnType<WorkBoardProjectsOptionsOrgs>> = [{ login: 'acme-labs', access: 'granted' }]) =>
    new WorkBoardProjects({
      options: { list: async () => list(), snapshot: async () => null },
      orgs: async () => check,
      project: (ref) => ({ board: async () => (ref.owner === 'solo-co' ? solo() : board()) }),
      selected: () => selected,
      now: () => NOW,
    });

  test('#609/AC-4 a chosen Project whose owner is not in the Projects list is still read, and its owner is read', async () => {
    const reader = selectedReader({ owner: 'solo-co', number: 7 });
    const read = await reader.read();
    assert.deepEqual(read.boards.map((b) => [b.organization, b.board.number]).sort(), [['acme-labs', 3], ['solo-co', 7]]);
    assert.deepEqual(reader.readOwners().sort(), ['acme-labs', 'solo-co']);
  });

  test('#609/AC-4 a chosen Project already read through the list is read once', async () => {
    const read = await selectedReader({ owner: 'ACME-labs', number: 3 }).read();
    assert.deepEqual(read.boards.map((b) => b.board.number), [3]);
  });

  test('#609/AC-4 the owner of a chosen Project that came back with a warning is reported, not read', async () => {
    const pending = { login: 'locked-co', access: 'pending' as const, approvalUrl: 'a', requestUrl: 'r' };
    const reader = selectedReader({ owner: 'locked-co', number: 2 }, [pending]);
    const read = await reader.read();
    assert.deepEqual(read.boards.map((b) => b.organization), []);
    assert.deepEqual(reader.warnedOwners(), ['locked-co']);
    assert.ok(!reader.readOwners().includes('locked-co'));
  });
});

type WorkBoardProjectsOptionsOrgs = ConstructorParameters<typeof WorkBoardProjects>[0]['orgs'];
