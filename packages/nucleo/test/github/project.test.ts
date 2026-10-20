import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  createGithubProject,
  GITHUB_TTL,
  GithubCache,
  MemoryCacheStore,
  NO_STATUS_LANE,
  ProjectPermissionError,
  projectCacheKey,
  RateLimitedError,
  type ProjectBoardValue,
  type QueryCost,
  type RawProjectItem,
} from '../../src/index.ts';
import { clock, replayFetch, REPO, type Recorded } from './helpers.ts';

/** Leitura real do Project 3, gravada por `record-project.ts`. */
const recordedBoard: Recorded[] = JSON.parse(readFileSync(new URL('./fixtures/project.json', import.meta.url), 'utf8'));
const PROJECT = { owner: 'ahrenatechnology', number: 3 };
const raw = recordedBoard[0].body.data!.repositoryOwner as { projectV2: { id: string; field: { id: string } } };
const PROJECT_ID = raw.projectV2.id;
const FIELD_ID = raw.projectV2.field.id;
const TODO = 'f75ad846';
const IN_PROGRESS = '47fc9ee4';
const DONE = '98236657';
// Item da issue #1 no Project, que está em Todo na gravação.
const ITEM = 'PVTI_lADOEyVQDc4BnkAUzhBki-s';

const moveVars = (itemId: string, optionId: string) => ({ p: PROJECT_ID, i: itemId, fid: FIELD_ID, v: optionId, f: 'Status' });
const moved = (itemId: string, optionId: string): Recorded => ({
  operation: 'ProjectMove',
  variables: moveVars(itemId, optionId),
  status: 200,
  body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId, fieldValueByName: { optionId } } } } },
});

function setup(responses: Recorded[] = recordedBoard, onCost?: (c: QueryCost) => void) {
  const now = clock();
  const fetch = replayFetch(responses);
  const store = new MemoryCacheStore();
  const cache = new GithubCache({ store, now });
  const project = createGithubProject({ project: PROJECT, cache, token: 'token-de-teste', fetch, now, onCost });
  return { now, fetch, store, cache, project };
}

const laneOf = (board: { lanes: { name: string; items: { itemId: string }[] }[] }, itemId: string) => board.lanes.find((l) => l.items.some((i) => i.itemId === itemId))?.name;

describe('kanban do Project, com a leitura real gravada', () => {
  test('lê o Project numa consulta de custo 1, com as raias na ordem das opções do Status', async () => {
    const costs: QueryCost[] = [];
    const { fetch, project } = setup(recordedBoard, (c) => costs.push(c));
    const board = await project.board();
    assert.deepEqual(fetch.calls.map((c) => c.operation), ['ProjectBoard']);
    assert.deepEqual(fetch.calls[0].variables, { o: 'ahrenatechnology', n: 3, f: 'Status', after: null });
    assert.match(String(fetch.calls[0].headers.authorization), /token-de-teste/);
    assert.equal(costs[0].cost, 1);
    assert.deepEqual([board.title, board.url, board.field], ['Ahrena Console', 'https://github.com/orgs/ahrenatechnology/projects/3', 'Status']);
    assert.deepEqual(board.lanes.map((l) => [l.name, l.color, l.items.length]), [['Todo', 'GREEN', 51], ['In Progress', 'YELLOW', 5], ['Done', 'PURPLE', 9]]);
    assert.equal(board.count, 65);
    const ini = board.lanes[0].items.find((i) => i.number === 1)!;
    assert.deepEqual([ini.itemId, ini.key, ini.kind, ini.type, ini.parent, ini.statusId], [ITEM, `${REPO}#1`, 'Issue', 'Initiative', null, TODO]);
    const epic = board.lanes.flatMap((l) => l.items).find((i) => i.number === 6)!;
    assert.deepEqual([epic.type, epic.parent], ['Epic', `${REPO}#1`]);
    assert.equal(board.stale, false);
  });

  test('relê só depois do TTL de 2 min', async () => {
    const { now, fetch, project } = setup();
    await project.board();
    now.add(GITHUB_TTL.project - 1);
    await project.board();
    assert.equal(fetch.calls.length, 1);
    now.add(1);
    await project.board();
    assert.equal(fetch.calls.length, 2);
  });

  test('mover um card é uma mutação só: o cache é atualizado com o que ela devolveu, sem reler', async () => {
    const { now, fetch, store, project } = setup([...recordedBoard, moved(ITEM, IN_PROGRESS)]);
    const before = await project.board();
    assert.equal(laneOf(before, ITEM), 'Todo');
    now.add(10_000);
    const after = await project.move(ITEM, IN_PROGRESS);
    assert.deepEqual(fetch.calls.map((c) => c.operation), ['ProjectBoard', 'ProjectMove']);
    assert.deepEqual(fetch.calls[1].variables, moveVars(ITEM, IN_PROGRESS));
    assert.equal(laneOf(after, ITEM), 'In Progress');
    assert.deepEqual(after.lanes.map((l) => l.items.length), [50, 6, 9]);
    // O dado guardado mudou, sem mexer em quando foi lido: o TTL continua contando da leitura.
    const entry = await store.get(projectCacheKey(PROJECT));
    assert.equal(entry?.fetchedAt, before.fetchedAt);
    assert.equal((entry?.value as ProjectBoardValue).items.find((i) => i.itemId === ITEM)?.statusId, IN_PROGRESS);
    assert.equal(laneOf(await project.board(), ITEM), 'In Progress');
    assert.equal(fetch.calls.length, 2, 'a leitura seguinte, dentro do TTL, sai do cache');
  });

  test('mover com o cache vazio lê o Project uma vez antes da mutação', async () => {
    const { fetch, project } = setup([...recordedBoard, moved(ITEM, DONE)]);
    const board = await project.move(ITEM, DONE);
    assert.deepEqual(fetch.calls.map((c) => c.operation), ['ProjectBoard', 'ProjectMove']);
    assert.equal(laneOf(board, ITEM), 'Done');
  });

  test('opção ou item desconhecidos não chegam ao GitHub', async () => {
    const { fetch, project } = setup();
    await project.board();
    await assert.rejects(project.move(ITEM, 'nao-existe'), /opção de Status desconhecida/);
    await assert.rejects(project.move('PVTI_outro', TODO), /item fora do Project/);
    assert.equal(fetch.calls.length, 1);
  });

  test('sem o escopo `project` no token, o erro diz como resolver e o quadro não muda', async () => {
    const denied: Recorded = {
      operation: 'ProjectMove',
      variables: moveVars(ITEM, DONE),
      status: 200,
      body: {
        errors: [
          {
            type: 'INSUFFICIENT_SCOPES',
            message: "Your token has not been granted the required scopes to execute this query. The 'updateProjectV2ItemFieldValue' field requires one of the following scopes: ['project'], but your token has only been granted the: ['read:project', 'repo'] scopes.",
          },
        ],
      },
    };
    const { project } = setup([...recordedBoard, denied]);
    await project.board();
    const err = await project.move(ITEM, DONE).catch((e: unknown) => e);
    assert.ok(err instanceof ProjectPermissionError);
    assert.match(err.message, /escopo `project`/);
    assert.match(err.message, /gh auth refresh -s project/);
    assert.equal(laneOf(await project.board(), ITEM), 'Todo');
  });

  test('sem permissão de escrita no Project, o erro também é de permissão', async () => {
    const forbidden: Recorded = {
      operation: 'ProjectMove',
      variables: moveVars(ITEM, DONE),
      status: 200,
      body: { errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] },
    };
    const { project } = setup([...recordedBoard, forbidden]);
    await assert.rejects(project.move(ITEM, DONE), ProjectPermissionError);
  });

  test('limite do GitHub na mutação pausa as chamadas; o quadro continua saindo do cache', async () => {
    let calls = 0;
    const fetch = (async (_u: unknown, init?: RequestInit) => {
      calls++;
      const op = /(?:query|mutation) (\w+)/.exec(JSON.parse(String(init?.body)).query)?.[1];
      if (op === 'ProjectBoard') return new Response(JSON.stringify(recordedBoard[0].body), { status: 200 });
      return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'retry-after': '60' } });
    }) as typeof globalThis.fetch;
    const now = clock();
    const cache = new GithubCache({ store: new MemoryCacheStore(), now });
    const project = createGithubProject({ project: PROJECT, cache, token: 't', fetch, now });
    await project.board();
    await assert.rejects(project.move(ITEM, DONE), RateLimitedError);
    assert.equal(cache.pauseLeftMs(), 60_000);
    await assert.rejects(project.move(ITEM, DONE), RateLimitedError);
    assert.equal(calls, 2, 'durante a pausa, a mutação não chega ao GitHub');
    assert.equal((await project.board()).count, 65);
  });

  test('GitHub fora depois do TTL: serve o quadro velho com o motivo', async () => {
    let fail = false;
    const fetch = (async () => {
      if (fail) throw new Error('rede caiu');
      return new Response(JSON.stringify(recordedBoard[0].body), { status: 200 });
    }) as typeof globalThis.fetch;
    const now = clock();
    const project = createGithubProject({ project: PROJECT, cache: new GithubCache({ store: new MemoryCacheStore(), now }), token: 't', fetch, now });
    await project.board();
    fail = true;
    now.add(GITHUB_TTL.project);
    const board = await project.board();
    assert.deepEqual([board.stale, board.staleReason, board.count], [true, 'rede caiu', 65]);
  });
});

describe('kanban do Project: formas dos itens e paginação', () => {
  const item = (id: string, optionId: string | null, content: RawProjectItem['content'], isArchived = false): RawProjectItem => ({
    id,
    isArchived,
    fieldValueByName: optionId ? { optionId } : null,
    content,
  });
  const page = (items: RawProjectItem[], next: string | null): Recorded['body'] => ({
    data: {
      rateLimit: { cost: 1 },
      repositoryOwner: {
        projectV2: {
          id: 'P',
          title: 'Quadro',
          url: 'https://github.com/orgs/acme/projects/1',
          field: { id: 'F', name: 'Status', options: [{ id: 'a', name: 'A fazer', color: 'GRAY' }, { id: 'b', name: 'Feito', color: 'GREEN' }] },
          items: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes: items },
        },
      },
    },
  });
  const issue = (n: number) => ({ __typename: 'Issue', number: n, title: `t${n}`, url: `u${n}`, state: 'OPEN', updatedAt: '2026-10-18T10:00:00Z', repository: { nameWithOwner: 'acme/app' }, issueType: null, parent: null });
  const ref = { owner: 'acme', number: 1 };

  test('busca as páginas seguintes em série; sem Status vai para a primeira raia; arquivado e vazio ficam de fora', async () => {
    const fetch = replayFetch([
      {
        operation: 'ProjectBoard',
        variables: { o: 'acme', n: 1, f: 'Status', after: null },
        status: 200,
        body: page([item('i1', 'a', issue(1)), item('i2', null, issue(2)), item('i3', 'b', issue(3), true), item('i4', 'a', null)], 'c1'),
      },
      {
        operation: 'ProjectBoard',
        variables: { o: 'acme', n: 1, f: 'Status', after: 'c1' },
        status: 200,
        body: page(
          [
            item('i5', 'b', { __typename: 'PullRequest', number: 9, title: 'pr', url: 'u9', state: 'MERGED', updatedAt: '2026-10-18T10:00:00Z', repository: { nameWithOwner: 'acme/app' } }),
            item('i6', 'sumiu', { __typename: 'DraftIssue', title: 'rascunho', updatedAt: '2026-10-18T10:00:00Z' }),
          ],
          null,
        ),
      },
    ]);
    const project = createGithubProject({ project: ref, cache: new GithubCache({ store: new MemoryCacheStore() }), token: 't', fetch });
    const board = await project.board();
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(board.lanes.map((l) => [l.id, l.name, l.items.map((i) => i.itemId)]), [
      [null, NO_STATUS_LANE, ['i2', 'i6']],
      ['a', 'A fazer', ['i1']],
      ['b', 'Feito', ['i5']],
    ]);
    const draft = board.lanes[0].items[1];
    assert.deepEqual([draft.kind, draft.key, draft.number, draft.url], ['DraftIssue', null, null, null]);
    assert.deepEqual([board.lanes[2].items[0].kind, board.lanes[2].items[0].key], ['PullRequest', 'acme/app#9']);
  });

  test('Project sem o campo pedido: erro claro', async () => {
    const body = page([], null);
    (body.data!.repositoryOwner as { projectV2: { field: unknown } }).projectV2.field = null;
    const fetch = replayFetch([{ operation: 'ProjectBoard', variables: { o: 'acme', n: 1, f: 'Fase', after: null }, status: 200, body }]);
    const project = createGithubProject({ project: { ...ref, field: 'Fase' }, cache: new GithubCache({ store: new MemoryCacheStore() }), token: 't', fetch });
    await assert.rejects(project.board(), /não tem o campo de seleção "Fase"/);
  });

  test('Project inexistente: erro com dono e número', async () => {
    const fetch = replayFetch([{ operation: 'ProjectBoard', variables: { o: 'acme', n: 1, f: 'Status', after: null }, status: 200, body: { data: { repositoryOwner: { projectV2: null } } } }]);
    const project = createGithubProject({ project: ref, cache: new GithubCache({ store: new MemoryCacheStore() }), token: 't', fetch });
    await assert.rejects(project.board(), /Project não encontrado: acme\/1/);
  });
});
