// O kanban do projeto na API (#80, C11): GET /api/projeto e POST /api/projeto/mover, no formato do
// contrato, com os erros mapeados e as defesas de origem da decisão 0003. GitHub sempre falso: a
// leitura real gravada (test/github/fixtures/project.json), `fetch` falso ou o Project do simulador.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { describe, test } from 'node:test';
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, iniciarApiLocal, MontadorDoPainel, type ApiLocal } from '../../src/api/index.ts';
import { quadroDe, type KanbanDoProjeto, type OpcoesDoProjeto, type QuadroDoProjeto } from '../../src/api/projeto.ts';
import { GithubCache, MemoryCacheStore } from '../../src/github/cache.ts';
import { createGithubProject, GithubProject, toProjectCard, type RawProjectItem } from '../../src/github/project.ts';
import { PROJECT_DO_SIMULADOR, ProjetoDoSimulador, RAIAS_DO_SIMULADOR } from '../../src/simulador/projeto.ts';
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

/** `http.request`, para poder mandar `Host` e `Origin` como um navegador mandaria. */
function pedir(api: ApiLocal, caminho: string, { method = 'GET', headers = {} as Record<string, string>, corpo = '' } = {}): Promise<Resposta> {
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
const mover = (api: ApiLocal, corpo: unknown, headers: Record<string, string> = JSON_CT) =>
  pedir(api, '/api/projeto/mover', { method: 'POST', headers, corpo: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) });

async function subir(projeto?: OpcoesDoProjeto) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho: null, agora: () => AGORA });
  const api = await iniciarApiLocal({ montador, hooks: { storage }, port: 0, log: () => {}, ...(projeto ? { projeto } : {}) });
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
  const fonte = new ProjetoDoSimulador(AGORA);
  const kanban = new GithubProject({ source: fonte, cache: new GithubCache({ store: new MemoryCacheStore() }), project: PROJECT_DO_SIMULADOR });
  return { fonte, kanban };
}

const raiaDe = (q: QuadroDoProjeto, itemId: string) => q.raias.find((r) => r.cards.some((c) => c.itemId === itemId))?.nome;

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
    const [c1, c2] = quadroDe(board, 'github').raias[0].cards;
    assert.deepEqual([c1.marco, c1.subIssues, c1.pr], ['M1 · Local', { feitas: 2, total: 4 }, { numero: 78, url: 'https://github.com/exemplo/app/pull/78', ci: 'falhou', review: 'ajustes' }]);
    assert.deepEqual(c2.pr, { numero: 93, url: 'https://github.com/exemplo/app/pull/93', ci: 'rodando', review: 'aprovado' });
    assert.deepEqual(quadroDe(board, 'github').marcos, ['M1 · Local']);
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

describe('GET /api/projeto', () => {
  test('a demo: o Project do C11 com as 5 raias, os 11 cards, os marcos e a fonte', async () => {
    const { kanban } = doSimulador();
    const s = await subir({ kanban, fonte: 'demo' });
    try {
      const r = await pedir(s.api, '/api/projeto');
      assert.equal(r.status, 200);
      const q = r.json as QuadroDoProjeto;
      assert.deepEqual(Object.keys(q).sort(), ['desatualizado', 'fonte', 'lidoEm', 'marcos', 'motivo', 'projeto', 'raias', 'total'].sort());
      assert.deepEqual(q.projeto, { dono: 'exemplo', numero: 3, titulo: 'Ahrena Console', url: 'https://github.com/orgs/exemplo/projects/3', campo: 'Status' });
      assert.deepEqual(q.raias.map((l) => [l.nome, l.cards.map((c) => c.numero)]), [
        ['Backlog', [80, 87, 89]],
        ['Ready', [35, 36]],
        ['In Progress', [42, 81]],
        ['In Review', [92, 64]],
        ['Done', [40, 82]],
      ]);
      assert.deepEqual([q.total, q.fonte, q.desatualizado, q.motivo], [11, 'demo', false, null]);
      assert.deepEqual(q.marcos, ['M1 · Local', 'M2 · Bandeja']);
      const card = q.raias[2].cards[0];
      assert.deepEqual(Object.keys(card).sort(), ['estado', 'itemId', 'marco', 'numero', 'pr', 'raiaId', 'repo', 'subIssues', 'tipo', 'tipoDaIssue', 'titulo', 'url'].sort());
      assert.deepEqual([card.tipo, card.tipoDaIssue, card.titulo, card.subIssues, card.pr?.numero, card.pr?.ci, card.raiaId], ['Issue', 'Story', 'Kanban de sessões', { feitas: 2, total: 4 }, 78, 'rodando', q.raias[2].id]);
      const pills = q.raias.flatMap((l) => l.cards).filter((c) => c.pr).map((c) => [c.numero, c.pr!.ci, c.pr!.review]);
      assert.deepEqual(pills, [[42, 'rodando', null], [81, 'ok', null], [92, 'ok', 'pendente'], [64, 'falhou', 'ajustes'], [40, 'ok', 'aprovado'], [82, 'ok', 'aprovado']]);
      assert.deepEqual([...new Set(q.raias.flatMap((l) => l.cards.map((c) => c.tipoDaIssue)))].sort(), ['Bug', 'Spike', 'Story', 'Tech Task']);
    } finally {
      await s.fechar();
    }
  });

  test('do GitHub: a leitura gravada, uma chamada; ?forcar=1 relê, respeitando os 30 s', async () => {
    const { now, kanban, fetch } = doGithub();
    const s = await subir({ kanban, fonte: 'github' });
    try {
      const q = (await pedir(s.api, '/api/projeto')).json as QuadroDoProjeto;
      assert.deepEqual(q.raias.map((l) => [l.id, l.nome, l.cor, l.cards.length]), [[TODO, 'Todo', 'GREEN', 51], [IN_PROGRESS, 'In Progress', 'YELLOW', 5], ['98236657', 'Done', 'PURPLE', 9]]);
      assert.deepEqual([q.total, q.fonte, q.lidoEm, q.marcos], [65, 'github', AGORA, []]);
      assert.deepEqual(q.raias[0].cards.find((c) => c.itemId === ITEM), {
        itemId: ITEM, tipo: 'Issue', tipoDaIssue: 'Initiative', numero: 1, titulo: 'Ahrena Console 0.0.1', url: 'https://github.com/ahrenatechnology/ahrena-console/issues/1',
        repo: 'ahrenatechnology/ahrena-console', estado: 'OPEN', marco: null, subIssues: null, pr: null, raiaId: TODO,
      });
      await pedir(s.api, '/api/projeto');
      assert.equal(fetch.calls.length, 1, 'dentro do TTL sai do cache');
      now.add(10_000);
      await pedir(s.api, '/api/projeto?forcar=1');
      assert.equal(fetch.calls.length, 1, 'forçar antes de 30 s não relê');
      now.add(20_000);
      const r = await pedir(s.api, '/api/projeto?forcar=1');
      assert.equal(fetch.calls.length, 2);
      assert.equal((r.json as QuadroDoProjeto).lidoEm, AGORA + 30_000);
      assert.equal((await pedir(s.api, '/api/projeto', { method: 'DELETE' })).status, 405);
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
      await pedir(s.api, '/api/projeto');
      falhar = true;
      now.add(2 * 60_000);
      const r = await pedir(s.api, '/api/projeto');
      assert.equal(r.status, 200);
      assert.deepEqual([r.json.desatualizado, r.json.motivo, r.json.total], [true, 'rede caiu', 65]);
    } finally {
      await s.fechar();
    }
  });

  const semCache = async (fetch: (u: unknown, init?: RequestInit) => Promise<Response>) => {
    const { kanban } = doGithub(recordedBoard, fetch as unknown as ReturnType<typeof replayFetch>);
    return subir({ kanban, fonte: 'github' });
  };

  test('GitHub fora sem cache: 502 github-fora', async () => {
    const s = await semCache(async () => {
      throw new Error('rede caiu');
    });
    try {
      const r = await pedir(s.api, '/api/projeto');
      assert.equal(r.status, 502);
      assert.equal(r.json.codigo, 'github-fora');
      assert.match(r.json.error, /rede caiu/);
    } finally {
      await s.fechar();
    }
  });

  test('token sem o escopo project: 401 sem-escopo, com o comando', async () => {
    const s = await semCache(async () => new Response(JSON.stringify({ errors: [{ type: 'INSUFFICIENT_SCOPES', message: "requires one of the following scopes: ['read:project']" }] }), { status: 200 }));
    try {
      const r = await pedir(s.api, '/api/projeto');
      assert.equal(r.status, 401);
      assert.deepEqual([r.json.codigo, r.json.comando], ['sem-escopo', 'gh auth refresh -s project']);
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
      const r = await pedir(s.api, '/api/projeto');
      assert.deepEqual([r.status, r.json.codigo, r.headers['retry-after']], [429, 'limitado', '60']);
      const de_novo = await pedir(s.api, '/api/projeto');
      assert.deepEqual([de_novo.status, de_novo.headers['retry-after']], [429, '60']);
      assert.equal(chamadas, 1, 'durante a pausa, nada chega ao GitHub');
    } finally {
      await s.fechar();
    }
  });

  test('sem projeto (--sem-github): 503 desligado nas duas rotas', async () => {
    for (const projeto of [undefined, { kanban: null, fonte: 'github' as const }]) {
      const s = await subir(projeto);
      try {
        const r = await pedir(s.api, '/api/projeto');
        assert.deepEqual([r.status, r.json.codigo], [503, 'desligado']);
        const m = await mover(s.api, { itemId: ITEM, optionId: TODO });
        assert.deepEqual([m.status, m.json.codigo], [503, 'desligado']);
      } finally {
        await s.fechar();
      }
    }
  });
});

describe('POST /api/projeto/mover', () => {
  test('move na demo: o quadro volta com o card na raia nova, e o Desfazer é outro mover', async () => {
    const { fonte, kanban } = doSimulador();
    const s = await subir({ kanban, fonte: 'demo' });
    try {
      const antes = (await pedir(s.api, '/api/projeto')).json as QuadroDoProjeto;
      const c92 = antes.raias.flatMap((l) => l.cards).find((c) => c.numero === 92)!;
      const done = RAIAS_DO_SIMULADOR.find((r) => r.name === 'Done')!.id;
      const r = await mover(s.api, { itemId: c92.itemId, optionId: done });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.movido, { itemId: c92.itemId, de: c92.raiaId, para: done });
      assert.equal(raiaDe(r.json.quadro, c92.itemId), 'Done');
      assert.equal(r.json.quadro.fonte, 'demo');
      assert.equal(raiaDe((await pedir(s.api, '/api/projeto')).json, c92.itemId), 'Done', 'o GET seguinte já vê');
      const desfazer = await mover(s.api, { itemId: c92.itemId, optionId: r.json.movido.de });
      assert.equal(raiaDe(desfazer.json.quadro, c92.itemId), 'In Review');
      assert.deepEqual(fonte.chamadas, { board: 1, move: 2 });
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
      assert.deepEqual(r.json.movido, { itemId: ITEM, de: TODO, para: IN_PROGRESS });
      assert.deepEqual(r.json.quadro.raias.map((l: { cards: unknown[] }) => l.cards.length), [50, 6, 9]);
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
      assert.deepEqual([r422.status, r422.json.codigo], [422, 'raia-desconhecida']);
      const r404 = await mover(s.api, { itemId: 'PVTI_outro', optionId: TODO });
      assert.deepEqual([r404.status, r404.json.codigo], [404, 'item-desconhecido']);
      for (const corpo of ['{', '[]', 'null', { itemId: ITEM }, { itemId: ITEM, optionId: null }, { itemId: 'abc', optionId: TODO }, { itemId: ITEM, optionId: 'x"; drop' }, { itemId: `PVTI_${'a'.repeat(200)}`, optionId: TODO }]) {
        const r = await mover(s.api, corpo);
        assert.deepEqual([r.status, r.json.codigo], [400, 'invalido'], JSON.stringify(corpo));
      }
      assert.deepEqual(fetch.calls.map((c) => c.operation), ['ProjectBoard'], 'só a leitura que o mover faz com o cache vazio');
      assert.equal((await pedir(s.api, '/api/projeto/mover')).status, 405);
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
      assert.deepEqual([r401.status, r401.json.codigo, r401.json.comando], [401, 'sem-escopo', 'gh auth refresh -s project']);

      respostas.move = () => new Response(JSON.stringify({ errors: [{ type: 'UNPROCESSABLE', message: 'algo deu errado' }] }), { status: 200 });
      const r502 = await mover(s.api, { itemId: ITEM, optionId: IN_PROGRESS });
      assert.deepEqual([r502.status, r502.json.codigo], [502, 'github-recusou']);

      respostas.move = () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'retry-after': '90' } });
      const r429 = await mover(s.api, { itemId: ITEM, optionId: IN_PROGRESS });
      assert.deepEqual([r429.status, r429.json.codigo, r429.headers['retry-after']], [429, 'limitado', '90']);
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
    const done = RAIAS_DO_SIMULADOR.find((r) => r.name === 'Done')!.id;
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
      assert.equal((await pedir(s.api, '/api/projeto', { headers: { origin: `http://${s.host}` } })).status, 200);
      assert.equal((await pedir(s.api, '/api/projeto', { headers: { origin: 'https://exemplo.com' } })).status, 403);
    } finally {
      await s.fechar();
    }
  });

  test('sem Content-Type JSON dá 415, e corpo grande dá 413, mesmo da mesma origem', async () => {
    const { fonte, kanban } = doSimulador();
    const s = await subir({ kanban, fonte: 'demo' });
    const origin = `http://${s.host}`;
    try {
      const corpo = { itemId: 'PVTI_simulado92', optionId: RAIAS_DO_SIMULADOR[0].id };
      assert.equal((await mover(s.api, corpo, { 'content-type': 'text/plain', origin })).status, 415);
      assert.equal((await mover(s.api, corpo, { origin })).status, 415);
      assert.equal((await mover(s.api, corpo, { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
      const grande = JSON.stringify({ ...corpo, sobra: 'x'.repeat(5000) });
      assert.equal((await mover(s.api, grande, { ...JSON_CT, origin })).status, 413);
      assert.equal(fonte.chamadas.move, 0);
    } finally {
      await s.fechar();
    }
  });

  test('as outras rotas de escrita com Origin, mesmo o nosso, continuam 403', async () => {
    const { kanban } = doSimulador();
    const s = await subir({ kanban, fonte: 'demo' });
    const origin = `http://${s.host}`;
    try {
      const escritas = [
        '/api/hooks',
        '/api/decisoes/d1/confirmar',
        '/api/decisoes/d1/descartar',
        '/abrir/local_00000000-0000-4000-8000-000000000000',
        '/mcp',
        '/api/projeto',
        '/api/projeto/mover/',
        '/api/projeto/mover/../../hooks',
      ];
      for (const caminho of escritas) {
        const r = await pedir(s.api, caminho, { method: 'POST', headers: { ...JSON_CT, origin }, corpo: '{}' });
        assert.equal(r.status, 403, caminho);
      }
      // E o mover com Origin, mas por outro método, também não passa.
      assert.equal((await pedir(s.api, '/api/projeto/mover', { method: 'PUT', headers: { ...JSON_CT, origin }, corpo: '{}' })).status, 403);
    } finally {
      await s.fechar();
    }
  });
});

describe('o kanban que a API usa', () => {
  test('GithubProject cumpre a porta da API', () => {
    const { kanban } = doSimulador();
    const k: KanbanDoProjeto = kanban;
    assert.equal(k.project.owner, PROJECT_DO_SIMULADOR.owner);
    assert.equal(k.pauseLeftMs(), 0);
  });
});
