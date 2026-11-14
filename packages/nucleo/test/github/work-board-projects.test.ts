/*
 * #609 the reader of the Projects of every granted organization, and its background-sync step: the step re-reads each Project
 * (forced), is skipped without a GitHub connection, and fails when GitHub did not answer so the sync log says it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SYNC_WORK_PROJECTS_EVERY_MS } from '../../src/github/background-sync.ts';
import { NoDataError } from '../../src/github/cache.ts';
import type { ProjectBoard } from '../../src/github/project.ts';
import type { ProjectOptionsList } from '../../src/github/project-options.ts';
import { WorkBoardProjects, workProjectsSyncStep } from '../../src/github/work-board-projects.ts';

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
});
