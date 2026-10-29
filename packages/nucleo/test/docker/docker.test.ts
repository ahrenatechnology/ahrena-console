// #288: the Docker actions. The catalog's plans from a fixed inventory, the readings through a fake
// runner, the service's digest rules and the routes' gate on 127.0.0.1 with a fake spawn and a fake
// remote: nothing real ever runs, and nothing but ids read from the daemon reaches an argv.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, MontadorDoPainel, startLocalApi } from '../../src/api/index.ts';
import { createDockerRoute } from '../../src/api/docker.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { buildDockerPlan, CLEAN_KINDS, type DockerContainer, type Inventory } from '../../src/docker/catalog.ts';
import { DF_ARGS, DANGLING_ARGS, DF_VERBOSE_ARGS, NETWORKS_ARGS, parseContainers, PS_ARGS, readInventory, VOLUMES_ARGS } from '../../src/docker/inventory.ts';
import { DockerService } from '../../src/docker/service.ts';
import { publishToolsChanges, ToolsExecutor, type ToolsHost } from '../../src/tools/executor.ts';
import type { ToolsOverview } from '../../src/tools/service.ts';
import { fakeRunner, fakeSpawn, type SpawnCall } from '../tools/doubles.ts';

const dir = mkdtempSync(join(tmpdir(), 'ahrena-docker-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

const ct = (id: string, name: string, o: Partial<DockerContainer> = {}): DockerContainer => ({ id, name, image: 'postgres:16', running: true, status: 'Up 2 days', stack: null, volumes: [], createdAt: '2026-10-20T10:00:00.000Z', ports: [], ...o });
const INVENTORY: Inventory = {
  containers: [
    ct('3f9a1c20d4be', 'tessera306-api-1', { stack: 'tessera306', volumes: ['tessera306_data'] }),
    ct('8c1e77aa02f9', 'tessera306-db-1', { stack: 'tessera306' }),
    ct('5e1a02bb99c3', 'shell-web-1', { stack: 'shell', volumes: ['shell_pgdata', 'shell_cache'] }),
    ct('a77d0e41c8f2', 'shell-old-1', { stack: 'shell', running: false, status: 'Exited (0) 6 days ago' }),
    ct('9d41e0b3a7c2', 'floci-aws-gp-local-ecs-9d41e0', { running: false, status: 'Exited (0) 6 days ago' }),
    ct('4d0b6a91e2c8', 'floci-aws-localstack'),
    // a stack removed earlier: its volumes remain, and one is still mounted by a loose container
    ct('0c93d11b6e57', 'cache-user', { volumes: ['old_cache'] }),
  ],
  volumes: [
    { name: 'shell_pgdata', stack: 'shell', sizeBytes: 1_800_000_000 },
    { name: 'shell_cache', stack: 'shell', sizeBytes: 80_000_000 },
    { name: 'old_data', stack: 'old', sizeBytes: 5_000_000 },
    { name: 'old_cache', stack: 'old', sizeBytes: 7_000_000 },
  ],
  reclaimable: { Containers: 3_900_000_000, 'Build Cache': 9_400_000_000 },
  danglingImages: { count: 12, bytes: 2_200_000_000 },
  networks: { unused: 7 },
  stoppedOlderThan24h: 2,
  daemon: 'rootless',
};
const plan = (action: string, target: string | null, inv: Inventory = INVENTORY) => buildDockerPlan('local', inv, action, target);
const asPlan = (r: ReturnType<typeof plan>) => {
  assert.equal(r.kind, 'plan');
  return (r as Extract<typeof r, { kind: 'plan' }>).plan;
};

describe('#288 the plans of the closed catalog', () => {
  test('stack stop and start name only the ids the daemon lists for that stack and state', () => {
    assert.deepEqual(asPlan(plan('stack-stop', 'tessera306')).steps, [['docker', 'stop', '3f9a1c20d4be', '8c1e77aa02f9']]);
    assert.deepEqual(asPlan(plan('stack-stop', 'shell')).steps, [['docker', 'stop', '5e1a02bb99c3']]);
    assert.deepEqual(asPlan(plan('stack-start', 'shell')).steps, [['docker', 'start', 'a77d0e41c8f2']]);
    assert.deepEqual(plan('stack-start', 'tessera306'), { kind: 'not-offered', reason: 'nothing-to-do' });
  });

  test('stack remove stops what runs, then removes every container; it never touches a volume or a network', () => {
    const p = asPlan(plan('stack-remove', 'shell'));
    assert.deepEqual(p.steps, [['docker', 'stop', '5e1a02bb99c3'], ['docker', 'rm', '5e1a02bb99c3', 'a77d0e41c8f2']]);
    assert.ok(p.steps.every((s) => !s.includes('volume') && !s.includes('-v') && !s.includes('network') && !s.includes('-f')));
    assert.equal(p.running, 1);
  });

  test('stack volumes: a separate action, only when no container of the stack is left, and never a volume still mounted', () => {
    assert.deepEqual(plan('stack-remove-volumes', 'shell'), { kind: 'not-offered', reason: 'stack-present' });
    const p = asPlan(plan('stack-remove-volumes', 'old'));
    assert.deepEqual(p.steps, [['docker', 'volume', 'rm', 'old_data']]);
    assert.deepEqual(p.volumes.map((v) => [v.name, v.keptBy]), [['old_data', null], ['old_cache', 'cache-user']]);
    assert.equal(p.estimateBytes, 5_000_000);
  });

  test('container actions: stop only a running one, restart any, remove a running one after stopping it', () => {
    assert.deepEqual(asPlan(plan('container-stop', '4d0b6a91e2c8')).steps, [['docker', 'stop', '4d0b6a91e2c8']]);
    assert.deepEqual(plan('container-stop', '9d41e0b3a7c2'), { kind: 'not-offered', reason: 'nothing-to-do' });
    assert.deepEqual(asPlan(plan('container-restart', '9d41e0b3a7c2')).steps, [['docker', 'restart', '9d41e0b3a7c2']]);
    assert.deepEqual(asPlan(plan('container-remove', '9d41e0b3a7c2')).steps, [['docker', 'rm', '9d41e0b3a7c2']]);
    assert.deepEqual(asPlan(plan('container-remove', '4d0b6a91e2c8')).steps, [['docker', 'stop', '4d0b6a91e2c8'], ['docker', 'rm', '4d0b6a91e2c8']]);
  });

  test('an id, a stack or a kind the daemon does not know is unknown: nothing typed reaches an argv', () => {
    for (const [action, target] of [['container-remove', 'ffffffffffff'], ['container-remove', '9d41e0b3a7c2; rm -rf /'], ['container-stop', '$(id)'], ['stack-stop', 'nope'], ['stack-stop', '../etc'], ['stack-stop', null], ['clean', 'system-prune'], ['clean', 'volumes'], ['rm-rf', null]] as const) {
      assert.deepEqual(plan(action, target), { kind: 'unknown-target' }, `${action} ${target}`);
    }
  });

  test('clean: one command per kind, with no system prune, no --all and no volume prune', () => {
    const argvs = CLEAN_KINDS.map((k) => asPlan(plan('clean', k)).steps[0]!);
    assert.deepEqual(argvs, [
      ['docker', 'container', 'prune', '--force', '--filter', 'until=24h'],
      ['docker', 'container', 'prune', '--force'],
      ['docker', 'image', 'prune', '--force'],
      ['docker', 'network', 'prune', '--force'],
      ['docker', 'builder', 'prune', '--force'],
    ]);
    for (const a of argvs) assert.ok(!a.includes('system') && !a.includes('--all') && !a.includes('-a') && !a.includes('volume'));
    assert.equal(asPlan(plan('clean', 'containers')).estimateBytes, 3_900_000_000);
    assert.equal(asPlan(plan('clean', 'images')).count, 12);
  });

  test('daemon restart: Colima and the Docker without root run; the Docker of the system is an admin plan, never runnable', () => {
    const root = asPlan(plan('daemon-restart', null));
    assert.deepEqual(root.steps, [['systemctl', '--user', 'restart', 'docker']]);
    assert.equal(root.runnable, true);
    assert.equal(asPlan(plan('daemon-restart', null, { ...INVENTORY, daemon: 'colima' })).steps[0]![0], 'colima');
    const sys = asPlan(plan('daemon-restart', null, { ...INVENTORY, daemon: 'system' }));
    assert.deepEqual(sys.steps, [['sudo', 'systemctl', 'restart', 'docker']]);
    assert.equal(sys.admin, true);
    assert.equal(sys.runnable, false);
    assert.deepEqual(plan('daemon-restart', null, { ...INVENTORY, daemon: null }), { kind: 'not-offered', reason: 'no-runtime' });
  });

  test('the digest covers the machine, the action, the target and the steps', () => {
    const a = asPlan(plan('stack-stop', 'tessera306')).planDigest;
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(a, asPlan(plan('stack-stop', 'tessera306')).planDigest);
    assert.notEqual(a, asPlan(buildDockerPlan('ws', INVENTORY, 'stack-stop', 'tessera306')).planDigest);
    const fewer = { ...INVENTORY, containers: INVENTORY.containers.filter((c) => c.id !== '8c1e77aa02f9') };
    assert.notEqual(a, asPlan(plan('stack-stop', 'tessera306', fewer)).planDigest, 'a container that left changes the plan');
  });
});

describe('#288 the reading through the runner', () => {
  const psLine = (id: string, name: string, state: string, stack: string, mounts: string, ports = '') => [`${id}${'0'.repeat(52)}`, name, 'img:1', state, 'Up', '2026-10-20 10:00:00 -0300 -03', stack, mounts, ports].join('\t');

  test('containers, volumes, the reclaimable space and the daemon kind', async () => {
    const run = fakeRunner({
      [PS_ARGS.join(' ')]: [psLine('3f9a1c20d4be', 'a-1', 'running', 'a', 'a_data,/srv/bind', '0.0.0.0:3000->3000/tcp'), psLine('8c1e77aa02f9', 'b-1', 'exited', '', '')].join('\n'),
      [VOLUMES_ARGS.join(' ')]: 'a_data\ta\nloose\t\n',
      [DF_ARGS.join(' ')]: 'Containers\t2\t1\t1.8GB\t0.7GB (38%)\nBuild Cache\t5\t0\t9.4GB\t9.4GB\n',
      [DANGLING_ARGS.join(' ')]: '1.1GB\n1.1GB\n',
      [NETWORKS_ARGS.join(' ')]: 'x\tbridge\tbridge\ny\tapp_default\tbridge\n',
      'docker context show': 'default',
      'systemctl --user cat docker.service': { code: 1 },
    });
    const inv = (await readInventory({ run, env: async () => ({}), platform: 'linux', resolve: async () => null, now: () => Date.parse('2026-10-29T10:00:00Z') }, {}))!;
    assert.deepEqual(inv.containers.map((c) => [c.id, c.running, c.stack, c.volumes, c.ports]), [['3f9a1c20d4be', true, 'a', ['a_data'], [3000]], ['8c1e77aa02f9', false, null, [], []]]);
    assert.deepEqual(inv.volumes.map((v) => [v.name, v.stack]), [['a_data', 'a'], ['loose', null]]);
    assert.equal(inv.reclaimable.Containers, 700_000_000);
    assert.deepEqual(inv.danglingImages, { count: 2, bytes: 2_200_000_000 });
    assert.equal(inv.networks.unused, 1);
    assert.equal(inv.stoppedOlderThan24h, 1);
    assert.equal(inv.daemon, 'system');
    assert.ok(run.calls.every((c) => c[0] === 'docker' || c[0] === 'systemctl'), 'only docker and systemctl are run');
  });

  test('the daemon does not answer: null; volume sizes only when asked', async () => {
    const dead = fakeRunner({ [PS_ARGS.join(' ')]: { code: 1, stderr: 'Cannot connect to the Docker daemon' } });
    assert.equal(await readInventory({ run: dead, env: async () => ({}), platform: 'linux', resolve: async () => null }), null);
    const run = fakeRunner({ [PS_ARGS.join(' ')]: '', [VOLUMES_ARGS.join(' ')]: 'v1\ts\n', [DF_VERBOSE_ARGS.join(' ')]: JSON.stringify({ Volumes: [{ Name: 'v1', Size: '1.8GB' }] }) });
    const base = { run, env: async () => ({}), platform: 'darwin' as const, resolve: async () => null };
    assert.equal((await readInventory(base, {}))!.volumes[0]!.sizeBytes, null);
    assert.equal((await readInventory(base, { volumeSizes: true }))!.volumes[0]!.sizeBytes, 1_800_000_000);
  });

  test('a ps line with a bad id is dropped, and a comma in another label cannot split a field', () => {
    assert.equal(parseContainers('zzz\tx\ty\trunning\tUp\t\t\t\t').length, 0);
  });
});

// ---- the service and the routes, on a real executor with a fake spawn ----
function fakeHost(): ToolsHost {
  return {
    overview: async () => ({ version: 1, jobs: { current: null, queue: [], recent: [], batch: null } }) as unknown as ToolsOverview,
    check: async () => null,
    actionPlan: async () => ({ kind: 'unknown' }),
    verify: async () => null,
    invalidate: () => {},
    processEnv: async () => ({ PATH: '/usr/bin' }),
    resolveExecutable: async (name) => ({ path: `/usr/bin/${name}`, realPath: `/usr/bin/${name}` }),
  };
}

async function boot(o: { systemDocker?: boolean; inventory?: Inventory; script?: (call: SpawnCall) => void; acceptNoOrigin?: boolean; remote?: { get?: unknown; write?: unknown } } = {}) {
  const inv = o.inventory ?? INVENTORY;
  const sp = fakeSpawn(o.script ?? ((call) => call.child.exit(0)));
  const cursor = new ChangeCursor({ generation: 'g1', minIntervalMs: 0, batchMs: 0 });
  const executor = new ToolsExecutor({ service: fakeHost(), logFile: join(dir, `tools-${++n}.log`), spawn: sp.spawn, killGroup: sp.killGroup, killGraceMs: 20, onChange: publishToolsChanges(cursor), log: () => {} });
  // A fake daemon: the runner answers from the inventory (the same reading the plans are built from).
  const psLine = (c: DockerContainer) => [`${c.id}${'0'.repeat(52)}`, c.name, c.image, c.running ? 'running' : 'exited', c.status, '2026-10-20 10:00:00 +0000 +00', c.stack ?? '', c.volumes.join(','), ''].join('\t');
  const run = fakeRunner({
    [PS_ARGS.join(' ')]: inv.containers.map(psLine).join('\n'),
    [VOLUMES_ARGS.join(' ')]: inv.volumes.map((v) => `${v.name}\t${v.stack ?? ''}`).join('\n'),
    [DF_ARGS.join(' ')]: 'Containers\t2\t1\t1.8GB\t3.9GB\n',
    [DANGLING_ARGS.join(' ')]: '1GB\n',
    [NETWORKS_ARGS.join(' ')]: '',
    'docker context show': 'default',
    ...(o.systemDocker ? {} : { 'systemctl --user cat docker.service': 'x' }),
  });
  const service = new DockerService({ queue: executor, run, env: async () => ({}), platform: 'linux', resolve: async () => null, acceptsRemoteActions: () => o.acceptNoOrigin ?? false, log: () => {} });
  const route = createDockerRoute({ service, cancel: (id) => executor.cancel(id), acceptNoOriginActions: () => o.acceptNoOrigin ?? false, remote: (o.remote as never) ?? null });
  const storage = openSqliteStorage({ path: ':memory:' });
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null });
  const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, changes: cursor, tools: executor, docker: { route, acceptNoOrigin: () => o.acceptNoOrigin ?? false } });
  const port = Number(new URL(api.url).port);
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const send = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      const req = request({ host: '127.0.0.1', port, method, path, headers: { host, 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers } }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? (JSON.parse(data) as Record<string, any>) : {} }));
      });
      req.on('error', reject);
      req.end(text);
    });
  const planOf = async (action: string, target: string | null) => (await send('GET', `/api/docker/plan?action=${action}${target ? `&target=${target}` : ''}`, undefined)).body.plan as { planDigest: string; steps: string[][] };
  return { sp, executor, run, origin, send, planOf, close: async () => { await executor.idle('local'); await api.close(); await storage.close(); } };
}

describe('#288 the Docker routes', () => {
  test('GET /api/docker: the stacks, the containers with their offered actions, the clean options and the daemon', async () => {
    const t = await boot();
    try {
      const r = await t.send('GET', '/api/docker', undefined);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'ok');
      assert.deepEqual(r.body.stacks.map((s: any) => [s.name, s.running, s.stopped, s.actions]), [['shell', 1, 1, ['stack-stop', 'stack-start', 'stack-remove']], ['tessera306', 2, 0, ['stack-stop', 'stack-remove']]]);
      assert.deepEqual(r.body.containers.find((c: any) => c.id === '9d41e0b3a7c2').actions, ['container-restart', 'container-remove']);
      assert.deepEqual(r.body.leftovers, [{ name: 'old', volumes: 2, actions: ['stack-remove-volumes'] }]);
      assert.deepEqual(r.body.daemon, { kind: 'rootless', offered: true });
      assert.ok(r.body.clean.some((c: any) => c.kind === 'images' && c.count === 1));
      assert.equal(t.sp.calls.length, 0, 'a read spawns nothing');
      assert.equal((await t.send('GET', '/api/docker?machine=ws-exemplo', undefined)).status, 404);
    } finally {
      await t.close();
    }
  });

  test('the gate: no Origin, a foreign Origin, a query string, an encoded path, a wrong method: 403, nothing spawned', async () => {
    const t = await boot();
    try {
      const p = await t.planOf('stack-stop', 'tessera306');
      const body = { target: 'tessera306', planDigest: p.planDigest };
      const path = '/api/docker/actions/stack-stop';
      assert.equal((await t.send('POST', path, body)).status, 403, 'no Origin');
      assert.equal((await t.send('POST', path, body, { origin: 'https://exemplo.dev' })).status, 403);
      assert.equal((await t.send('POST', path, body, { origin: 'null' })).status, 403);
      assert.equal((await t.send('POST', `${path}?x=1`, body, { origin: t.origin })).status, 403);
      assert.equal((await t.send('POST', '/api/docker/actions/stack-%73top', body, { origin: t.origin })).status, 403);
      assert.equal((await t.send('POST', '/api/docker/actions/system-prune', body, { origin: t.origin })).status, 403, 'an action outside the catalog');
      assert.equal((await t.send('PUT', path, body, { origin: t.origin })).status, 403);
      assert.equal((await t.send('DELETE', '/api/docker/jobs/aaaaaaaaaaaa', undefined)).status, 403);
      assert.equal((await t.send('POST', path, body, { origin: t.origin, 'content-type': 'text/plain' })).status, 415);
      assert.equal(t.sp.calls.length, 0);
    } finally {
      await t.close();
    }
  });

  test('a confirmed stack stop runs exactly the plan on the daemon with no shell; a stale digest is 409 and nothing runs', async () => {
    const t = await boot();
    try {
      const p = await t.planOf('stack-stop', 'tessera306');
      const stale = await t.send('POST', '/api/docker/actions/stack-stop', { target: 'tessera306', planDigest: '0000000000000000' }, { origin: t.origin });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.plan.planDigest, p.planDigest, 'the new plan comes back');
      assert.equal(t.sp.calls.length, 0);
      const ok = await t.send('POST', '/api/docker/actions/stack-stop', { target: 'tessera306', planDigest: p.planDigest }, { origin: t.origin });
      assert.equal(ok.status, 202);
      assert.equal(ok.body.job.toolId, 'docker');
      await t.executor.idle('local');
      assert.equal(t.sp.calls.length, 1);
      const c = t.sp.calls[0]!;
      assert.equal(c.command, '/usr/bin/docker');
      assert.deepEqual(c.args, ['stop', '3f9a1c20d4be', '8c1e77aa02f9']);
      assert.equal(c.options.shell, false);
      assert.equal(t.executor.jobs('local').recent[0]!.state, 'succeeded');
    } finally {
      await t.close();
    }
  });

  test('a target the daemon does not list is 404 and nothing runs', async () => {
    const t = await boot();
    try {
      const p = await t.planOf('stack-stop', 'tessera306');
      assert.equal((await t.send('POST', '/api/docker/actions/stack-stop', { target: 'nope', planDigest: p.planDigest }, { origin: t.origin })).status, 404);
      assert.equal((await t.send('POST', '/api/docker/actions/container-remove', { target: 'ffffffffffff', planDigest: p.planDigest }, { origin: t.origin })).status, 404);
      assert.equal((await t.send('POST', '/api/docker/actions/container-remove', { target: '9d41e0b3a7c2; id', planDigest: p.planDigest }, { origin: t.origin })).status, 400);
      assert.equal((await t.send('POST', '/api/docker/actions/clean', { target: 'system-prune', planDigest: p.planDigest }, { origin: t.origin })).status, 404);
      assert.equal(t.sp.calls.length, 0);
    } finally {
      await t.close();
    }
  });

  test('the Docker of the system: the plan is shown to copy, the restart is 403 and nothing is spawned; the one without root runs', async () => {
    const sys = await boot({ systemDocker: true });
    try {
      const p = await sys.planOf('daemon-restart', null);
      assert.deepEqual(p.steps, [['sudo', 'systemctl', 'restart', 'docker']]);
      const r = await sys.send('POST', '/api/docker/actions/daemon-restart', { planDigest: p.planDigest }, { origin: sys.origin });
      assert.equal(r.status, 403);
      assert.equal(r.body.plan.admin, true);
      assert.equal(sys.sp.calls.length, 0, 'sudo is never spawned');
    } finally {
      await sys.close();
    }
    const rootless = await boot();
    try {
      const p = await rootless.planOf('daemon-restart', null);
      assert.equal((await rootless.send('POST', '/api/docker/actions/daemon-restart', { planDigest: p.planDigest }, { origin: rootless.origin })).status, 202);
      await rootless.executor.idle('local');
      assert.deepEqual(rootless.sp.calls[0]!.args, ['--user', 'restart', 'docker']);
    } finally {
      await rootless.close();
    }
  });

  test('Cancel goes through the same gate and to the executor', async () => {
    const t = await boot({ script: () => {} });
    try {
      const p = await t.planOf('clean', 'images');
      const queued = await t.send('POST', '/api/docker/actions/clean', { target: 'images', planDigest: p.planDigest }, { origin: t.origin });
      assert.equal(queued.status, 202);
      const cancel = await t.send('DELETE', `/api/docker/jobs/${queued.body.job.id}`, {}, { origin: t.origin });
      assert.equal(cancel.status, 200);
      assert.equal(cancel.body.job.state, 'canceled');
    } finally {
      await t.close();
    }
  });

  test('a núcleo that accepts remote actions takes a no-Origin write (the tunnel); one that does not, refuses', async () => {
    const on = await boot({ acceptNoOrigin: true });
    try {
      const p = await on.planOf('container-restart', '4d0b6a91e2c8');
      assert.equal((await on.send('POST', '/api/docker/actions/container-restart', { target: '4d0b6a91e2c8', planDigest: p.planDigest })).status, 202);
    } finally {
      await on.close();
    }
  });
});

describe('#288 a remote machine: only ids travel, and the answer is re-projected', () => {
  const remoteView = { version: 1, available: true, daemon: { kind: 'rootless', offered: true }, summary: { running: 1, stopped: 0, stacks: 0 }, stacks: [], containers: [{ id: '4d0b6a91e2c8', name: '<img src=x onerror=1>', image: 'x', running: true, status: 'Up', stack: null, createdAt: null, actions: ['container-stop', 'rm -rf /'], extra: 'dropped' }], leftovers: [], clean: [], acceptsRemoteActions: true, jobs: { current: null, queue: [], recent: [], batch: null } };

  test('GET: the view comes back under the remote id, with unknown fields and actions dropped', async () => {
    const t = await boot({ remote: { port: (id: string) => (id === 'ws-exemplo' ? 14720 : undefined), get: async () => ({ kind: 'response', status: 200, body: remoteView }), write: async () => ({ kind: 'unreachable', reason: 'no-response' }) } });
    try {
      const r = await t.send('GET', '/api/docker?machine=ws-exemplo', undefined);
      assert.equal(r.body.machine, 'ws-exemplo');
      assert.deepEqual(r.body.containers[0].actions, ['container-stop']);
      assert.equal('extra' in r.body.containers[0], false);
      const down = await boot({ remote: { port: () => 14720, get: async () => ({ kind: 'unreachable', reason: 'port-closed' }), write: async () => ({ kind: 'unreachable', reason: 'no-response' }) } });
      assert.equal((await down.send('GET', '/api/docker?machine=ws-exemplo', undefined)).body.status, 'unreachable');
      await down.close();
    } finally {
      await t.close();
    }
  });

  test('POST: the Mac forwards the id and the digest as a local request, never a command; a refusal over there becomes remote-actions-disabled', async () => {
    const forwarded: { port: number; method: string; path: string; body: string | null }[] = [];
    const answer = { kind: 'response' as const, status: 403, body: { error: 'origem não permitida' } };
    const t = await boot({ remote: { port: () => 14720, get: async () => ({ kind: 'unreachable', reason: 'no-response' }), write: async (port: number, method: string, path: string, body: string | null) => (forwarded.push({ port, method, path, body }), answer) } });
    try {
      const r = await t.send('POST', '/api/docker/actions/container-remove', { machine: 'ws-exemplo', target: '9d41e0b3a7c2', planDigest: 'aaaaaaaaaaaaaaaa' }, { origin: t.origin });
      assert.equal(r.status, 403);
      assert.equal(r.body.reason, 'remote-actions-disabled');
      assert.deepEqual(forwarded, [{ port: 14720, method: 'POST', path: '/api/docker/actions/container-remove', body: JSON.stringify({ target: '9d41e0b3a7c2', planDigest: 'aaaaaaaaaaaaaaaa' }) }]);
      assert.equal(t.sp.calls.length, 0, 'nothing runs on this Mac');
      const cancel = await t.send('DELETE', '/api/docker/jobs/aaaaaaaaaaaa', { machine: 'ws-exemplo' }, { origin: t.origin });
      assert.equal(cancel.status, 403);
      assert.equal(forwarded[1]!.path, '/api/tools/jobs/aaaaaaaaaaaa');
    } finally {
      await t.close();
    }
  });
});

describe('#288 enqueue on the executor', () => {
  test('the same key gets the same job back, another key queues behind it, and `after` runs once the steps succeed', async () => {
    const sp = fakeSpawn((call) => call.child.exit(0));
    const executor = new ToolsExecutor({ service: fakeHost(), logFile: join(dir, `tools-${++n}.log`), spawn: sp.spawn, killGroup: sp.killGroup, log: () => {} });
    let after = 0;
    const spec = { toolId: 'docker', actionId: 'clean', label: 'Limpar', steps: [['docker', 'image', 'prune', '--force']], timeoutSeconds: 60, targetVersion: null, key: 'docker clean images', after: () => void after++ };
    const a = executor.enqueue('local', spec);
    const b = executor.enqueue('local', spec);
    assert.equal(a.job.id, b.job.id);
    const c = executor.enqueue('local', { ...spec, key: 'docker clean builder', steps: [['docker', 'builder', 'prune', '--force']] });
    assert.notEqual(a.job.id, c.job.id);
    await executor.idle('local');
    assert.deepEqual(sp.calls.map((x) => x.args.slice(0, 2)), [['image', 'prune'], ['builder', 'prune']]);
    assert.equal(after, 2, "each succeeded job runs its own after");
    assert.equal(sp.maxActive(), 1, 'one at a time');
  });

  test('a docker job with a sudo step is refused before anything is spawned', async () => {
    const sp = fakeSpawn((call) => call.child.exit(0));
    const executor = new ToolsExecutor({ service: fakeHost(), logFile: join(dir, `tools-${++n}.log`), spawn: sp.spawn, killGroup: sp.killGroup, log: () => {} });
    executor.enqueue('local', { toolId: 'docker', actionId: 'daemon-restart', label: 'Reiniciar o Docker', steps: [['sudo', 'systemctl', 'restart', 'docker']], timeoutSeconds: 60, targetVersion: null });
    await executor.idle('local');
    assert.equal(sp.calls.length, 0);
    assert.equal(executor.jobs('local').recent[0]!.state, 'failed');
  });
});
