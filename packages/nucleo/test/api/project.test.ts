// The project kanban in the API (#80, C11): GET /api/project and POST /api/project/move, in the
// contract's shape, with the errors mapped and the origin defenses of decision 0003. GitHub is always fake:
// the recorded real read (test/github/fixtures/project.json), a fake `fetch` or the simulator's Project.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, startLocalApi, MontadorDoPainel, type LocalApi } from '../../src/api/index.ts';
import { PROJECT_ERROR_CODES, quadroDe, type KanbanDoProjeto, type OpcoesDoProjeto, type QuadroDoProjeto } from '../../src/api/project.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { createGithubProject, GithubProject, toProjectCard, type RawProjectItem } from '../../src/github/project.ts';
import { SIMULATOR_PROJECT, SimulatorProject, SIMULATOR_LANES } from '../../src/simulator/project.ts';
import { clock, replayFetch, type Recorded } from '../github/helpers.ts';

const recordedBoard: Recorded[] = JSON.parse(readFileSync(new URL('../github/fixtures/project.json', import.meta.url), 'utf8'));
const PROJECT = { owner: 'ahrenatechnology', number: 3 };
const raw = recordedBoard[0].body.data!.repositoryOwner as { projectV2: { id: string; field: { id: string }; items: { nodes: RawProjectItem[] } } };
const TODO = 'f75ad846';
const IN_PROGRESS = '47fc9ee4';
const ITEM = 'PVTI_lADOEyVQDc4BnkAUzhBki-s';
const AGORA = Date.parse('2026-10-18T12:00:00Z');

const moved = (itemId: string, optionId: string): Recorded => ({
  operation: 'ProjectMove',
  variables: { p: raw.projectV2.id, i: itemId, fid: raw.projectV2.field.id, v: optionId, f: 'Status' },
  status: 200,
  body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: itemId, fieldValueByName: { optionId } } } } },
});

interface Resposta {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  corpo: string;
  json: any;
}

/** Uma raia e um card de `QuadroDoProjeto`, o corpo de `GET /api/project`. */
type Raia = QuadroDoProjeto['lanes'][number];
type Card = Raia['cards'][number];

/** `http.request`, para poder mandar `Host` e `Origin` como um navegador mandaria. */
function pedir(api: LocalApi, caminho: string, { method = 'GET', headers = {} as Record<string, string>, corpo = '' } = {}): Promise<Resposta> {
  const { hostname, port } = new URL(api.url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path: caminho, method, headers }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (p: string) => (texto += p));
      res.on('end', () => {
        let json: unknown = null;
        try {
          json = JSON.parse(texto);
        } catch {
          // não é JSON
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, corpo: texto, json });
      });
    });
    req.on('error', reject);
    req.end(corpo);
  });
}

const JSON_CT = { 'content-type': 'application/json' };
const mover = (api: LocalApi, corpo: unknown, headers: Record<string, string> = JSON_CT) =>
  pedir(api, '/api/project/move', { method: 'POST', headers, corpo: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) });

async function subir(projeto?: OpcoesDoProjeto) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const montador = new MontadorDoPainel({ storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho: null, agora: () => AGORA });
  const api = await startLocalApi({ panelBuilder: montador, hooks: { storage }, port: 0, log: () => {}, ...(projeto ? { project: projeto } : {}) });
  const host = `127.0.0.1:${new URL(api.url).port}`;
  return {
    api,
    host,
    async fechar() {
      await api.close();
      await storage.close();
    },
  };
}

/** Kanban sobre a leitura gravada, com `fetch` e relógio falsos. */
function doGithub(responses: Recorded[] = recordedBoard, fetch = replayFetch(responses)) {
  const now = clock(AGORA);
  const cache = new GithubCache({ store: new MemoryCacheStore(), now });
  const kanban = createGithubProject({ project: PROJECT, cache, token: 'token-de-teste', fetch, now });
  return { now, cache, kanban, fetch };
}

function doSimulador() {
  const fonte = new SimulatorProject(AGORA);
  const kanban = new GithubProject({ source: fonte, cache: new GithubCache({ store: new MemoryCacheStore() }), project: SIMULATOR_PROJECT });
  return { fonte, kanban };
}

const raiaDe = (q: any, itemId: string) => q.lanes.find((r: any) => r.cards.some((c: any) => c.itemId === itemId))?.name;

describe('card do Project: marco, sub-issues e PR', () => {
  test('a leitura gravada continua válida: os campos novos vêm null', () => {
    const card = toProjectCard(raw.projectV2.items.nodes[0])!;
    assert.deepEqual([card.milestone, card.subIssues, card.pullRequest], [null, null, null]);
  });

  test('a fixture estendida à mão traz marco, sub-issues e o PR que fecha a issue, com CI e review', () => {
    const base = structuredClone(raw.projectV2.items.nodes[0]);
    const issue: RawProjectItem = {
      ...base,
      content: {
        ...base.content!,
        milestone: { title: 'M1 · Local' },
        subIssuesSummary: { total: 4, completed: 2 },
        closedByPullRequestsReferences: {
          nodes: [{ number: 78, url: 'https://github.com/exemplo/app/pull/78', state: 'OPEN', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }],
        },
      } as RawProjectItem['content'],
    };
    const card = toProjectCard(issue)!;
    assert.equal(card.milestone, 'M1 · Local');
    assert.deepEqual(card.subIssues, { total: 4, completed: 2 });
    assert.deepEqual([card.pullRequest?.number, card.pullRequest?.ci, card.pullRequest?.review], [78, 'FAILURE', 'CHANGES_REQUESTED']);

    const semFilhas = toProjectCard({ ...issue, content: { ...issue.content!, subIssuesSummary: { total: 0, completed: 0 } } as RawProjectItem['content'] })!;
    assert.equal(semFilhas.subIssues, null, 'zero filhas é sem sub-issues');

    // Um item que é PR é o próprio PR.
    const pr = toProjectCard({
      id: 'PVTI_pr',
      isArchived: false,
      fieldValueByName: { optionId: TODO },
      content: { __typename: 'PullRequest', number: 93, title: 'pr', url: 'https://github.com/exemplo/app/pull/93', state: 'OPEN', updatedAt: '', repository: { nameWithOwner: 'exemplo/app' }, isDraft: false, reviewDecision: 'APPROVED', milestone: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } } as RawProjectItem['content'],
    })!;
    assert.deepEqual([pr.pullRequest?.number, pr.pullRequest?.ci, pr.pullRequest?.review, pr.milestone], [93, 'PENDING', 'APPROVED', null]);

    // E no formato da API: CI e review como o painel mostra.
    const board = { owner: 'exemplo', number: 1, title: 'Q', url: 'u', field: 'Status', count: 2, fetchedAt: 1, stale: false, staleReason: null, lanes: [{ id: TODO, name: 'Todo', color: 'GREEN', items: [card, pr] }] };
    const [c1, c2] = quadroDe(board, 'github').lanes[0].cards;
    assert.deepEqual([c1.milestone, c1.subIssues, c1.pr], ['M1 · Local', { done: 2, total: 4 }, { number: 78, url: 'https://github.com/exemplo/app/pull/78', ci: 'failed', review: 'changes-requested' }]);
    assert.deepEqual(c2.pr, { number: 93, url: 'https://github.com/exemplo/app/pull/93', ci: 'running', review: 'approved' });
    assert.deepEqual(quadroDe(board, 'github').milestones, ['M1 · Local']);
  });

  test('a consulta pede marco, sub-issues e um PR por issue, numa leitura só por página', async () => {
    const { kanban, fetch } = doGithub();
    await kanban.board();
    assert.equal(fetch.calls.length, 1);
    const { PROJECT_QUERIES } = await import('../../src/github/project.ts');
    assert.match(PROJECT_QUERIES.board, /milestone \{ title \}/);
    assert.match(PROJECT_QUERIES.board, /subIssuesSummary \{ total completed \}/);
    assert.match(PROJECT_QUERIES.board, /closedByPullRequestsReferences\(first: 1, includeClosedPrs: true\)/);
  });
});

describe('GET /api/project', () => {
  test('a demo: o Project do C11 com as 5 raias, os 11 cards, os marcos e a fonte', async () => {
    const { kanban } = doSimulador();
    const s = await subir({ kanban, fonte: 'demo' });
    try {
      const r = await pedir(s.api, '/api/project');
      assert.equal(r.status, 200);
      const q = r.json;
      assert.deepEqual(Object.keys(q).sort(), ['fetchedAt', 'lanes', 'milestones', 'project', 'reason', 'source', 'stale', 'total'].sort());
      assert.deepEqual(q.project, { owner: 'exemplo', number: 3, title: 'Ahrena Console', url: 'https://github.com/orgs/exemplo/projects/3', field: 'Status' });
      assert.deepEqual(q.lanes.map((l: Raia) => [l.name, l.cards.map((c) => c.number)]), [
        ['Backlog', [80, 87, 89]],
        ['Ready', [35, 36]],
        ['In Progress', [42, 81]],
        ['In Review', [92, 64]],
        ['Done', [40, 82]],
      ]);
      assert.deepEqual([q.total, q.source, q.stale, q.reason], [11, 'demo', false, null]);
      assert.deepEqual(q.milestones, ['M1 · Local', 'M2 · Bandeja']);
      const card = q.lanes[2].cards[0];
      assert.deepEqual(Object.keys(card).sort(), ['issueType', 'itemId', 'laneId', 'milestone', 'number', 'pr', 'repo', 'state', 'subIssues', 'title', 'type', 'url'].sort());
      assert.deepEqual([card.type, card.issueType, card.title, card.subIssues, card.pr?.number, card.pr?.ci, card.laneId], ['Issue', 'Story', 'Kanban de sessões', { done: 2, total: 4 }, 78, 'running', q.lanes[2].id]);
      const pills = (q.lanes as Raia[]).flatMap((l) => l.cards).filter((c) => c.pr).map((c) => [c.number, c.pr!.ci, c.pr!.review]);
      assert.deepEqual(pills, [[42, 'running', null], [81, 'ok', null], [92, 'ok', 'pending'], [64, 'failed', 'changes-requested'], [40, 'ok', 'approved'], [82, 'ok', 'approved']]);
      assert.deepEqual([...new Set((q.lanes as Raia[]).flatMap((l) => l.cards.map((c) => c.issueType)))].sort(), ['Bug', 'Spike', 'Story', 'Tech Task']);
    } finally {
      await s.fechar();
    }
  });

  test('do GitHub: a leitura gravada, uma chamada; ?refresh=1 relê, respeitando os 30 s', async () => {
    const { now, kanban, fetch } = doGithub();
    const s = await subir({ kanban, fonte: 'github' });
    try {
      const q = (await pedir(s.api, '/api/project')).json;
      assert.deepEqual(q.lanes.map((l: Raia) => [l.id, l.name, l.color, l.cards.length]), [[TODO, 'Todo', 'GREEN', 51], [IN_PROGRESS, 'In Progress', 'YELLOW', 5], ['98236657', 'Done', 'PURPLE', 9]]);
      assert.deepEqual([q.total, q.source, q.fetchedAt, q.milestones], [65, 'github', AGORA, []]);
      assert.deepEqual(q.lanes[0].cards.find((c: Card) => c.itemId === ITEM), {
        itemId: ITEM, type: 'Issue', issueType: 'Initiative', number: 1, title: 'Ahrena Console 0.0.1', url: 'https://github.com/ahrenatechnology/ahrena-console/issues/1',
        repo: 'ahrenatechnology/ahrena-console', state: 'OPEN', milestone: null, subIssues: null, pr: null, laneId: TODO,
      });
      await pedir(s.api, '/api/project');
      assert.equal(fetch.calls.length, 1, 'dentro do TTL sai do cache');
      now.add(10_000);
      await pedir(s.api, '/api/project?refresh=1');
      assert.equal(fetch.calls.length, 1, 'forçar antes de 30 s não relê');
      now.add(20_000);
      const r = await pedir(s.api, '/api/project?refresh=1');
      assert.equal(fetch.calls.length, 2);
      assert.equal(r.json.fetchedAt, AGORA + 30_000);
      assert.equal((await pedir(s.api, '/api/project', { method: 'DELETE' })).status, 405);
    } finally {
      await s.fechar();
    }
  });

  test('GitHub fora com cache: 200 desatualizado, com o motivo', async () => {
    let falhar = false;
    const fetch = (async () => {
      if (falhar) throw new Error('rede caiu');
      return new Response(JSON.stringify(recordedBoard[0].body), { status: 200 });
    }) as unknown as ReturnType<typeof replayFetch>;
    const { now, kanban } = doGithub(recordedBoard, fetch);
    const s = await subir({ kanban, fonte: 'github' });
    try {
      await pedir(s.api, '/api/project');
      falhar = true;
      now.add(2 * 60_000);
      const r = await pedir(s.api, '/api/project');
      assert.equal(r.status, 200);
      assert.deepEqual([r.json.stale, r.json.reason, r.json.total], [true, 'rede caiu', 65]);
    } finally {
      await s.fechar();
    }
  });

  const semCache = async (fetch: (u: unknown, init?: RequestInit) => Promise<Response>) => {
    const { kanban } = doGithub(recordedBoard, fetch as unknown as ReturnType<typeof replayFetch>);
    return subir({ kanban, fonte: 'github' });
  };

  test('GitHub fora sem cache: 502 github-down', async () => {
    const s = await semCache(async () => {
      throw new Error('rede caiu');
    });
    try {
      const r = await pedir(s.api, '/api/project');
      assert.equal(r.status, 502);
      assert.equal(r.json.code, 'github-down');
      assert.match(r.json.error, /rede caiu/);
    } finally {
      await s.fechar();
    }
  });

  test('token sem o escopo project: 401 no-scope, com o comando', async () => {
    const s = await semCache(async () => new Response(JSON.stringify({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: "requires one of the following scopes: ['read:project']" }] }), { status: 200 }));
    try {
      const r = await pedir(s.api, '/api/project');
      assert.equal(r.status, 401);
      assert.deepEqual([r.json.code, r.json.command], ['no-scope', 'gh auth refresh -s project']);
      assert.match(r.json.error, /escopo `project`/);
    } finally {
      await s.fechar();
    }
  });

  test('GitHub limitou sem cache: 429 com Retry-After, e a pausa vale para o pedido seguinte', async () => {
    let chamadas = 0;
    const s = await semCache(async () => {
      chamadas++;
      return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'retry-after': '60' } });
    });
    try {
      const r = await pedir(s.api, '/api/project');
      assert.deepEqual([r.status, r.json.code, r.headers['retry-after']], [429, 'rate-limited', '60']);
      const de_novo = await pedir(s.api, '/api/project');
      assert.deepEqual([de_novo.status, de_novo.headers['retry-after']], [429, '60']);
      assert.equal(chamadas, 1, 'durante a pausa, nada chega ao GitHub');
    } finally {
      await s.fechar();
    }
  });

  test('sem projeto (--sem-github): 503 off nas duas rotas', async () => {
    for (const projeto of [undefined, { kanban: null, fonte: 'github' as const }]) {
      const s = await subir(projeto);
      try {
        const r = await pedir(s.api, '/api/project');
        assert.deepEqual([r.status, r.json.code], [503, 'off']);
        const m = await mover(s.api, { itemId: ITEM, optionId: TODO });
        assert.deepEqual([m.status, m.json.code], [503, 'off']);
      } finally {
        await s.fechar();
      }
    }
  });

  test('sem Project escolhido (sem AHRENA_CONSOLE_PROJECT): 503 no-project, sem Project padrão', async () => {
    const s = await subir({ kanban: null, fonte: 'github', semProjeto: true });
    try {
      const r = await pedir(s.api, '/api/project');
      assert.deepEqual([r.status, r.json.code, r.json.variable], [503, 'no-project', 'AHRENA_CONSOLE_PROJECT']);
      const m = await mover(s.api, { itemId: ITEM, optionId: TODO });
      assert.deepEqual([m.status, m.json.code], [503, 'no-project']);
    } finally {
      await s.fechar();
    }
  });
});

describe('POST /api/project/move', () => {
  test('move na demo: o quadro volta com o card na raia nova, e o Desfazer é outro mover', async () => {
    const { fonte, kanban } = doSimulador();
    const s = await subir({ kanban, fonte: 'demo' });
    try {
      const antes = (await pedir(s.api, '/api/project')).json;
      const c92 = (antes.lanes as Raia[]).flatMap((l) => l.cards).find((c) => c.number === 92)!;
      const done = SIMULATOR_LANES.find((r) => r.name === 'Done')!.id;
      const r = await mover(s.api, { itemId: c92.itemId, optionId: done });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.moved, { itemId: c92.itemId, from: c92.laneId, to: done });
      assert.equal(raiaDe(r.json.board, c92.itemId), 'Done');
      assert.equal(r.json.board.source, 'demo');
      assert.equal(raiaDe((await pedir(s.api, '/api/project')).json, c92.itemId), 'Done', 'o GET seguinte já vê');
      const desfazer = await mover(s.api, { itemId: c92.itemId, optionId: r.json.moved.from });
      assert.equal(raiaDe(desfazer.json.board, c92.itemId), 'In Review');
      assert.deepEqual(fonte.calls, { board: 1, move: 2 });
    } finally {
      await s.fechar();
    }
  });

  test('do GitHub: uma mutação, sem reler o Project', async () => {
    const { kanban, fetch } = doGithub([...recordedBoard, moved(ITEM, IN_PROGRESS)]);
    const s = await subir({ kanban, fonte: 'github' });
    try {
      const r = await mover(s.api, { itemId: ITEM, optionId: IN_PROGRESS });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.moved, { itemId: ITEM, from: TODO, to: IN_PROGRESS });
      assert.deepEqual(r.json.board.lanes.map((l: { cards: unknown[] }) => l.cards.length), [50, 6, 9]);
      assert.deepEqual(fetch.calls.map((c) => c.operation), ['ProjectBoard', 'ProjectMove']);
    } finally {
      await s.fechar();
    }
  });

  test('raia desconhecida 422, item fora 404, ids e JSON inválidos 400, sem chegar ao GitHub', async () => {
    const { kanban, fetch } = doGithub();
    const s = await subir({ kanban, fonte: 'github' });
    try {
      const r422 = await mover(s.api, { itemId: ITEM, optionId: 'naoexiste' });
      assert.deepEqual([r422.status, r422.json.code], [422, 'unknown-lane']);
      const r404 = await mover(s.api, { itemId: 'PVTI_outro', optionId: TODO });
      assert.deepEqual([r404.status, r404.json.code], [404, 'unknown-item']);
      for (const corpo of ['{', '[]', 'null', { itemId: ITEM }, { itemId: ITEM, optionId: null }, { itemId: 'abc', optionId: TODO }, { itemId: ITEM, optionId: 'x"; drop' }, { itemId: `PVTI_${'a'.repeat(200)}`, optionId: TODO }]) {
        const r = await mover(s.api, corpo);
        assert.deepEqual([r.status, r.json.code], [400, 'invalid'], JSON.stringify(corpo));
      }
      assert.deepEqual(fetch.calls.map((c) => c.operation), ['ProjectBoard'], 'só a leitura que o mover faz com o cache vazio');
      assert.equal((await pedir(s.api, '/api/project/move')).status, 405);
    } finally {
      await s.fechar();
    }
  });

  test('sem escopo 401 com o comando; limite 429 com Retry-After; recusa do GitHub 502', async () => {
    const respostas: Record<string, Response | (() => Response)> = {};
    const fetch = (async (_u: unknown, init?: RequestInit) => {
      const op = /(?:query|mutation) (\w+)/.exec(JSON.parse(String(init?.body)).query)?.[1] ?? '?';
      if (op === 'ProjectBoard') return new Response(JSON.stringify(recordedBoard[0].body), { status: 200 });
      return (respostas.move as () => Response)();
    }) as unknown as ReturnType<typeof replayFetch>;
    const { kanban } = doGithub(recordedBoard, fetch);
    const s = await subir({ kanban, fonte: 'github' });
    try {
      respostas.move = () => new Response(JSON.stringify({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: "requires ['project']" }] }), { status: 200 });
      const r401 = await mover(s.api, { itemId: ITEM, optionId: IN_PROGRESS });
      assert.deepEqual([r401.status, r401.json.code, r401.json.command], [401, 'no-scope', 'gh auth refresh -s project']);

      respostas.move = () => new Response(JSON.stringify({ errors: [{ type: 'UNPROCESSABLE', message: 'algo deu errado' }] }), { status: 200 });
      const r502 = await mover(s.api, { itemId: ITEM, optionId: IN_PROGRESS });
      assert.deepEqual([r502.status, r502.json.code], [502, 'github-refused']);

      respostas.move = () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'retry-after': '90' } });
      const r429 = await mover(s.api, { itemId: ITEM, optionId: IN_PROGRESS });
      assert.deepEqual([r429.status, r429.json.code, r429.headers['retry-after']], [429, 'rate-limited', '90']);
      const pausado = await mover(s.api, { itemId: ITEM, optionId: IN_PROGRESS });
      assert.deepEqual([pausado.status, pausado.headers['retry-after']], [429, '90']);
    } finally {
      await s.fechar();
    }
  });
});

describe('origem do mover (decisão 0003)', () => {
  test('a própria /ui move com Origin igual a http://<Host>; outro Origin ou outro Host dá 403', async () => {
    const { kanban } = doSimulador();
    const s = await subir({ kanban, fonte: 'demo' });
    const done = SIMULATOR_LANES.find((r) => r.name === 'Done')!.id;
    const corpo = { itemId: 'PVTI_simulado92', optionId: done };
    try {
      const mesma = await mover(s.api, corpo, { ...JSON_CT, origin: `http://${s.host}` });
      assert.equal(mesma.status, 200, 'mesma origem passa');
      const porta = new URL(s.api.url).port;
      const pelaLocalhost = await mover(s.api, corpo, { ...JSON_CT, host: `localhost:${porta}`, origin: `http://localhost:${porta}` });
      assert.equal(pelaLocalhost.status, 200, 'localhost:<porta> também é nosso');
      for (const origin of ['https://exemplo.com', 'null', `https://${s.host}`, 'http://localhost:1', `http://${s.host}.exemplo.com`]) {
        assert.equal((await mover(s.api, corpo, { ...JSON_CT, origin })).status, 403, origin);
      }
      assert.equal((await mover(s.api, corpo, { ...JSON_CT, host: `exemplo.com:${porta}`, origin: `http://exemplo.com:${porta}` })).status, 403, 'Host de fora');
      // O GET da mesma origem continua liberado; com outro Origin, não.
      assert.equal((await pedir(s.api, '/api/project', { headers: { origin: `http://${s.host}` } })).status, 200);
      assert.equal((await pedir(s.api, '/api/project', { headers: { origin: 'https://exemplo.com' } })).status, 403);
      // Sem Origin, mas um navegador dizendo que outra página pede (`<img src=…?refresh=1>`): 403, e o GitHub não é chamado.
      for (const site of ['cross-site', 'same-site']) {
        assert.equal((await pedir(s.api, '/api/project?refresh=1', { headers: { 'sec-fetch-site': site } })).status, 403, site);
      }
      assert.equal((await pedir(s.api, '/api/project', { headers: { 'sec-fetch-site': 'same-origin', origin: `http://${s.host}` } })).status, 200);
      assert.equal((await pedir(s.api, '/api/project', { headers: { 'sec-fetch-site': 'none' } })).status, 200, 'a URL digitada');
    } finally {
      await s.fechar();
    }
  });

  test('sem Content-Type JSON dá 415, e corpo grande dá 413, mesmo da mesma origem', async () => {
    const { fonte, kanban } = doSimulador();
    const s = await subir({ kanban, fonte: 'demo' });
    const origin = `http://${s.host}`;
    try {
      const corpo = { itemId: 'PVTI_simulado92', optionId: SIMULATOR_LANES[0].id };
      assert.equal((await mover(s.api, corpo, { 'content-type': 'text/plain', origin })).status, 415);
      assert.equal((await mover(s.api, corpo, { origin })).status, 415);
      assert.equal((await mover(s.api, corpo, { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
      const grande = JSON.stringify({ ...corpo, sobra: 'x'.repeat(5000) });
      assert.equal((await mover(s.api, grande, { ...JSON_CT, origin })).status, 413);
      assert.equal(fonte.calls.move, 0);
    } finally {
      await s.fechar();
    }
  });

  test('corpo que não acaba: 413 assim que passa do limite, sem esperar o resto', async () => {
    const { fonte, kanban } = doSimulador();
    const s = await subir({ kanban, fonte: 'demo' });
    const { hostname, port } = new URL(s.api.url);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ hostname, port, path: '/api/project/move', method: 'POST', headers: JSON_CT }, (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        });
        req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? undefined : reject(e)));
        req.write('{"sobra":"' + 'x'.repeat(5000)); // e nunca chama end()
      });
      assert.equal(status, 413);
      assert.equal(fonte.calls.move, 0);
    } finally {
      await s.fechar();
    }
  });

  // O `POST /open/<local_…>` do Detalhe tem a própria exceção (#29/#30), com os testes dela.
  test('as outras rotas de escrita com Origin, mesmo o nosso, continuam 403', async () => {
    const { kanban } = doSimulador();
    const s = await subir({ kanban, fonte: 'demo' });
    const origin = `http://${s.host}`;
    try {
      const escritas = [
        '/api/hooks',
        // As decisões têm a exceção delas (#103), só com o caminho exato: com query, não.
        '/api/decisions/d1/confirm?x=1',
        '/api/decisions/d1/dismiss/',
        '/mcp',
        '/api/project',
        '/api/project/move/',
        '/api/project/move/../../hooks',
      ];
      for (const caminho of escritas) {
        const r = await pedir(s.api, caminho, { method: 'POST', headers: { ...JSON_CT, origin }, corpo: '{}' });
        assert.equal(r.status, 403, caminho);
      }
      // E o mover com Origin, mas por outro método, também não passa.
      assert.equal((await pedir(s.api, '/api/project/move', { method: 'PUT', headers: { ...JSON_CT, origin }, corpo: '{}' })).status, 403);
    } finally {
      await s.fechar();
    }
  });
});

describe('o kanban que a API usa', () => {
  test('GithubProject cumpre a porta da API', () => {
    const { kanban } = doSimulador();
    const k: KanbanDoProjeto = kanban;
    assert.equal(k.project.owner, SIMULATOR_PROJECT.owner);
    assert.equal(k.pauseLeftMs(), 0);
  });
});

// #173: the routes answer English keys and codes (phase 2b layer 6); the old Portuguese routes are gone
// (phase 6).
describe('GET /api/project and POST /api/project/move: the English body', () => {
  test('the old routes are gone: /api/projeto 404, POST /api/projeto/mover refused', async () => {
    const { fonte, kanban } = doSimulador();
    const s = await subir({ kanban, fonte: 'demo' });
    try {
      assert.deepEqual(await pedir(s.api, '/api/projeto').then((r) => [r.status, r.json]), [404, { error: 'não encontrado' }]);
      const m = await pedir(s.api, '/api/projeto/mover', { method: 'POST', headers: JSON_CT, corpo: JSON.stringify({ itemId: 'PVTI_simulado92', optionId: SIMULATOR_LANES[0].id }) });
      assert.ok([403, 405].includes(m.status), String(m.status));
      assert.equal(fonte.calls.move, 0);
    } finally {
      await s.fechar();
    }
  });

  test('the board, a card, the PR pills and the move, in English', async () => {
    const { fonte, kanban } = doSimulador();
    const s = await subir({ kanban, fonte: 'demo' });
    try {
      const q = (await pedir(s.api, '/api/project')).json as QuadroDoProjeto;
      assert.deepEqual(Object.keys(q), ['project', 'lanes', 'milestones', 'total', 'fetchedAt', 'stale', 'reason', 'source']);
      assert.deepEqual(q.project, { owner: 'exemplo', number: 3, title: 'Ahrena Console', url: 'https://github.com/orgs/exemplo/projects/3', field: 'Status' });
      assert.deepEqual(Object.keys(q.lanes[0]!), ['id', 'name', 'color', 'cards']);
      const card = q.lanes[2]!.cards[0]!;
      assert.deepEqual(Object.keys(card), ['itemId', 'type', 'issueType', 'number', 'title', 'url', 'repo', 'state', 'milestone', 'subIssues', 'pr', 'laneId']);
      assert.deepEqual([card.type, card.issueType, card.subIssues, card.pr?.number, card.pr?.ci, card.laneId], ['Issue', 'Story', { done: 2, total: 4 }, 78, 'running', q.lanes[2]!.id]);
      const pills = q.lanes.flatMap((l) => l.cards).filter((c) => c.pr).map((c) => [c.number, c.pr!.ci, c.pr!.review]);
      assert.deepEqual(pills, [[42, 'running', null], [81, 'ok', null], [92, 'ok', 'pending'], [64, 'failed', 'changes-requested'], [40, 'ok', 'approved'], [82, 'ok', 'approved']]);

      const c92 = q.lanes.flatMap((l) => l.cards).find((c) => c.number === 92)!;
      const done = SIMULATOR_LANES.find((r) => r.name === 'Done')!.id;
      const r = await pedir(s.api, '/api/project/move', { method: 'POST', headers: JSON_CT, corpo: JSON.stringify({ itemId: c92.itemId, optionId: done }) });
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json), ['board', 'moved']);
      assert.deepEqual(r.json.moved, { itemId: c92.itemId, from: c92.laneId, to: done });
      assert.equal((r.json.board as QuadroDoProjeto).lanes.find((l) => l.cards.some((c) => c.itemId === c92.itemId))?.name, 'Done');
      assert.deepEqual(fonte.calls, { board: 1, move: 1 });
    } finally {
      await s.fechar();
    }
  });

  test('the errors: every `code` value, and `code` and `variable` in English', async () => {
    assert.deepEqual([...PROJECT_ERROR_CODES], ['invalid', 'no-scope', 'rate-limited', 'unknown-lane', 'unknown-item', 'github-down', 'github-refused', 'off', 'no-project']);
    const s = await subir({ kanban: null, fonte: 'github', semProjeto: true });
    try {
      const r = await pedir(s.api, '/api/project');
      assert.deepEqual([r.status, r.json.code, r.json.variable], [503, 'no-project', 'AHRENA_CONSOLE_PROJECT']);
      const m = await pedir(s.api, '/api/project/move', { method: 'POST', headers: JSON_CT, corpo: '{}' });
      assert.deepEqual([m.status, m.json], [400, { error: 'itemId inválido: o id do item no Project (PVTI_…)', code: 'invalid' }]);
    } finally {
      await s.fechar();
    }
  });
});
