/*
 * (#740) AC-11: the ai-memory jobs stay out of the remote Tools view: not in the overview the remote credential reads, not
 * cancellable through the remote Cancel; the local /ui sees and cancels them as before.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { OWNER, call, remoteFixture } from '../../test/api/remote-credential-fixture.ts';
import type { CancelJobResult, ToolJob, ToolsControl } from '../tools/executor.ts';
import type { JobsView, ToolsOverview } from '../tools/service.ts';
import { DockerService } from '../docker/service.ts';
import { createDockerRoute } from './docker.ts';
import { respondTools } from './tools.ts';

const job = (id: string, toolId: string, state: ToolJob['state'] = 'running'): ToolJob => ({
  id, toolId, actionId: 'update', label: `Atualizar ${toolId}`, machine: 'local', state, steps: [], step: 0, phase: 'running',
  startedAt: null, endedAt: null, exitCode: null, timeoutSeconds: 60, targetVersion: null, output: [], logFile: 'tools.log',
});
const MEMORY_RUNNING = '111111111111';
const MEMORY_QUEUED = '222222222222';
const MEMORY_RECENT = '333333333333';
const GH_RECENT = '444444444444';
const GH_QUEUED = '555555555555';

function stub() {
  const canceled: string[] = [];
  const all = [job(MEMORY_RUNNING, 'ai-memory'), job(MEMORY_QUEUED, 'ai-memory', 'queued'), job(MEMORY_RECENT, 'ai-memory', 'succeeded'), job(GH_RECENT, 'gh', 'succeeded'), job(GH_QUEUED, 'gh', 'queued')];
  const tools: ToolsControl = {
    // (#740) the overview is a stub: only the jobs the filter reads are filled, so the body is narrowed to the overview's type here.
    overview: async () => ({ items: [], jobs: { current: all[0], queue: [all[1], all[4]], recent: [all[2], all[3]], batch: null } }) as ToolsOverview,
    cancel: (id): CancelJobResult => {
      canceled.push(id);
      const found = all.find((j) => j.id === id);
      return found ? { kind: 'canceled', job: found } : { kind: 'unknown' };
    },
    toolIdOf: (id) => all.find((j) => j.id === id)?.toolId ?? null,
    acceptNoOriginActions: () => true,
  };
  return { tools, canceled };
}

const idsOf = (body: ToolsOverview) => {
  const { current, queue, recent } = body.jobs as JobsView<ToolJob>;
  return [current, ...queue, ...recent].filter((j): j is ToolJob => j !== null && j !== undefined).map((j) => j.id);
};

async function overviewOver(remote: boolean): Promise<ToolsOverview> {
  const { tools } = stub();
  const server = createServer((req, res) => void respondTools(res, new URL(req.url ?? '/', 'http://x'), tools, remote));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tools`);
    return (await response.json()) as ToolsOverview;
  } finally {
    server.close();
  }
}

describe('#740/AC-11 the ai-memory jobs and the remote Tools view', () => {
  test('#740/AC-11 Given ai-memory jobs running, queued and recent, When the remote credential reads the Tools overview, Then none of them is in it and the other jobs are', async () => {
    const ids = idsOf(await overviewOver(true));
    assert.deepEqual(ids.sort(), [GH_QUEUED, GH_RECENT].sort());
  });

  test('#740/AC-11 Given the same jobs, When the local /ui reads the Tools overview, Then every job is in it', async () => {
    const ids = idsOf(await overviewOver(false));
    assert.deepEqual(ids.sort(), [MEMORY_RUNNING, MEMORY_QUEUED, MEMORY_RECENT, GH_RECENT, GH_QUEUED].sort());
  });

  test('#740/AC-11 Given an ai-memory job, When the remote credential cancels it, Then it is refused with the generic unknown-action error and nothing is canceled', async () => {
    const { tools, canceled } = stub();
    const f = await remoteFixture({ api: { tools } });
    try {
      const c = await f.mint();
      const headers = { 'content-type': 'application/json' };
      for (const id of [MEMORY_RUNNING, MEMORY_QUEUED]) {
        const r = await f.signed(c, 'DELETE', `/api/tools/jobs/${id}`, { headers });
        assert.equal(r.status, 404, id);
        assert.deepEqual(r.json, { error: 'ação desconhecida' }, 'the existing generic error, no job and no internal text');
      }
      assert.deepEqual(canceled, []);
      const other = await f.signed(c, 'DELETE', `/api/tools/jobs/${GH_QUEUED}`, { headers });
      assert.equal(other.status, 200, 'the remote Cancel of another tool still works');
      assert.deepEqual(canceled, [GH_QUEUED]);
    } finally {
      await f.close();
    }
  });

  test('#740/AC-11 Given an ai-memory job, When the local /ui cancels it, Then it is canceled as before', async () => {
    const { tools, canceled } = stub();
    const f = await remoteFixture({ api: { tools } });
    try {
      const r = await call(f.url, `/api/tools/jobs/${MEMORY_QUEUED}`, 'DELETE', { authorization: `Bearer ${OWNER}`, origin: `http://${f.host}`, 'content-type': 'application/json' });
      assert.equal(r.status, 200);
      assert.deepEqual(canceled, [MEMORY_QUEUED]);
    } finally {
      await f.close();
    }
  });

  test('#740/AC-11 Given ai-memory jobs on the queue, When the remote credential reads /api/docker, Then no ai-memory job is in its jobs and the other jobs are', async () => {
    const { tools } = stub();
    const jobs = (await tools.overview('local'))!.jobs as JobsView<ToolJob>;
    const queue = { jobs: () => jobs, enqueue: () => ({ kind: 'queued' }) } as never;
    const service = new DockerService({ queue, run: async () => ({ code: 1, stdout: '', stderr: '' }), env: () => ({}), platform: 'darwin', resolve: async () => null, log: () => {} } as never);
    const route = createDockerRoute({ service, cancel: () => ({ kind: 'unknown' }), acceptNoOriginActions: () => false });
    const f = await remoteFixture({ api: { tools, docker: { route, acceptNoOrigin: () => false } } });
    try {
      const c = await f.mint();
      const remote = await f.signed(c, 'GET', '/api/docker');
      assert.equal(remote.status, 200);
      assert.deepEqual(idsOf({ items: [], jobs: (remote.json as { jobs: JobsView<ToolJob> }).jobs } as ToolsOverview).sort(), [GH_QUEUED, GH_RECENT].sort());
      const local = await call(f.url, '/api/docker', 'GET', { authorization: `Bearer ${OWNER}` });
      assert.deepEqual(idsOf({ items: [], jobs: (local.json as { jobs: JobsView<ToolJob> }).jobs } as ToolsOverview).sort(), [MEMORY_RUNNING, MEMORY_QUEUED, MEMORY_RECENT, GH_RECENT, GH_QUEUED].sort(), 'the local /ui still sees every job');
    } finally {
      await f.close();
    }
  });

  test('#740/AC-11 Given a signed remote request, When it reads /api/tools or cancels through /api/docker/jobs, Then the credential is refused with 403 and nothing is canceled', async () => {
    const { tools, canceled } = stub();
    const route = createDockerRoute({ service: null, cancel: (id) => { canceled.push(id); return { kind: 'unknown' }; }, acceptNoOriginActions: () => true });
    const f = await remoteFixture({ api: { tools, docker: { route, acceptNoOrigin: () => true } } });
    try {
      const c = await f.mint();
      const read = await f.signed(c, 'GET', '/api/tools');
      assert.equal(read.status, 403);
      assert.deepEqual((read.json as { reason: string }).reason, 'credential-route');
      const cancel = await f.signed(c, 'DELETE', `/api/docker/jobs/${MEMORY_RUNNING}`, { headers: { 'content-type': 'application/json' } });
      assert.equal(cancel.status, 403);
      assert.deepEqual(canceled, []);
    } finally {
      await f.close();
    }
  });
});
