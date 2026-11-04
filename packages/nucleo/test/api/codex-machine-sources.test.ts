import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { createMachineSessionsRoute } from '../../src/api/machine-sessions.ts';
import { MachineReader } from '../../src/api/machine-reader.ts';
import type { ListaDeSessoes } from '../../src/api/sessions.ts';
import type { Wall } from '../../src/api/types.ts';

const failure = 'Índice do Codex indisponível: arquivo ausente.';
const sources = { codex: { error: failure } };
const count = { all: 0, active: 0, waiting: 0, blocked: 0, idle: 0 };
const list = { sources, items: [], total: 0, registered: 0, page: 1, perPage: 10, pages: 1, directories: [], counts: { ...count, completed: 0, error: 0, abandoned: 0 } };
const wall: Wall = { sources, version: 1, generatedAt: new Date(0).toISOString(), count, cards: [], parked: { total: 0, items: [] } };

async function read(path: string, withRemote: boolean) {
  const paths: string[] = [];
  const reader = new MachineReader({ machines: () => withRemote ? [{ id: 'remote-test', label: 'Teste remoto', port: 1, status: () => ({ state: 'connected', reason: null }) }] : [], get: async (_port, path) => {
    paths.push(path);
    const response = path.startsWith('/api/wall') ? wall : list;
    return { kind: 'response', status: 200, body: { ...response, sources: { codex: { error: 'private exception never forwarded', authorization: 'synthetic-only' }, extra: 'discard' } } };
  } });
  const route = createMachineSessionsRoute({ reader, local: { sessions: { listar: async () => list } as unknown as ListaDeSessoes, wall: { montar: async () => wall } } });
  let body: any;
  let status: number | undefined;
  const res = { writeHead(code: number) { status = code; }, end(value: string) { body = JSON.parse(value); } } as unknown as ServerResponse;
  assert.equal(await route(res, new URL(path, 'http://localhost')), true);
  assert.equal(status, 200);
  return { body, paths };
}

for (const route of ['/api/sessions', '/api/wall']) {
  test(`${route} preserves empty local discovery errors with machine=local and machine=all`, async () => {
    for (const machine of ['local', 'all']) {
      const { body } = await read(`${route}?machine=${machine}`, false);
      assert.equal(body.sources.codex.error, failure);
      assert.equal(body.byMachine[0].sources.codex.error, failure);
      assert.equal(body.byMachine[0].id, 'local');
    }
  });
  test(`${route} retains discovery error attribution across machines without copying remote fields`, async () => {
    const { body } = await read(`${route}?machine=all`, true);
    assert.match(body.sources.codex.error, /Esta máquina:.*Teste remoto:/);
    assert.equal(body.byMachine.find((p: any) => p.id === 'local').sources.codex.error, failure);
    assert.equal(body.byMachine.find((p: any) => p.id === 'remote-test').sources.codex.error, 'Índice do Codex indisponível nesta máquina.');
    assert.doesNotMatch(JSON.stringify(body), /private exception|authorization|synthetic-only|discard/);
  });
}
test('provider and profile filters survive machine aggregation', async () => {
  const { paths } = await read('/api/sessions?machine=all&provider=codex&profileId=profile-test', true);
  assert.ok(paths.length);
  const remote = new URL(paths[0], 'http://localhost');
  assert.equal(remote.searchParams.get('provider'), 'codex');
  assert.equal(remote.searchParams.get('profileId'), 'profile-test');
  assert.equal(remote.searchParams.has('machine'), false);
});
