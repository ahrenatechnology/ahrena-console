/*
 * #609 the reader of the Projects of every granted organization, and its background-sync step: the step re-reads each Project
 * (forced), is skipped without a GitHub connection, and fails when GitHub did not answer so the sync log says it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SYNC_WORK_PROJECTS_EVERY_MS } from '../../src/github/background-sync.ts';
import { GithubCache, MemoryCacheStore, NoDataError } from '../../src/github/cache.ts';
import type { ProjectBoard } from '../../src/github/project.ts';
import type { ProjectOptionsList } from '../../src/github/project-options.ts';
import { createWorkBoardProjects, WorkBoardProjects, workProjectsSyncStep, workProjectsSyncSteps } from '../../src/github/work-board-projects.ts';

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

  test('#609/AC-1 the step is skipped, reading nothing, without a GitHub connection', async () => {
    const { reader, forced } = rig();
    assert.equal(await workProjectsSyncStep(reader, async () => false).run(), 'skipped');
    assert.deepEqual(forced, []);
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
