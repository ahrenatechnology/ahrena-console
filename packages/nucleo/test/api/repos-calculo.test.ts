// O cálculo das telas de repositórios (#104 e #105), com números escritos à mão: o que entra é a
// forma crua do GitHub, o que sai é o campo da resposta.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  abertoPorAgente,
  ciDoRollup,
  ciDosRuns,
  commits12,
  commitsDoPeriodo,
  contribuidoresDoPeriodo,
  DIA_MS,
  frequenciaDoPeriodo,
  inicioDoPeriodo,
  issuesDoPeriodo,
  linguagensDe,
  linhasDe,
  mediana,
  montarLista,
  prsDoPeriodo,
  SEMANA_MS,
  temEscrita,
} from '../../src/github/repos-calculo.ts';
import type { PrCru, RepoCru } from '../../src/github/repos-source.ts';

const AGORA = Date.parse('2026-10-15T12:00:00Z');
const H = 3_600_000;
const semanaSeg = (atras: number) => Math.floor((AGORA - atras * SEMANA_MS) / 1000);
const iso = (ms: number) => new Date(ms).toISOString();

function repo(nome: string, extra: Partial<RepoCru> = {}): RepoCru {
  const [dono, n] = nome.split('/');
  return {
    name: n, nameWithOwner: nome, url: `https://github.com/${nome}`, isPrivate: false, pushedAt: iso(AGORA - H), viewerPermission: 'WRITE',
    owner: { login: dono }, primaryLanguage: { name: 'TypeScript' }, issues: { totalCount: 2 }, pullRequests: { totalCount: 1 },
    defaultBranchRef: { name: 'main', target: { statusCheckRollup: { state: 'SUCCESS' } } }, ...extra,
  };
}

function pr(extra: Partial<PrCru>): PrCru {
  return {
    createdAt: iso(AGORA - 10 * DIA_MS), mergedAt: null, closedAt: null, state: 'OPEN', additions: 0, deletions: 0, headRefName: 'feat/1',
    author: { login: 'pessoa', __typename: 'User' }, reviews: { totalCount: 0, nodes: [] }, pedidosDeMudanca: { totalCount: 0 }, ...extra,
  };
}

describe('#104 CA1: agrupados por organização e pela conta pessoal, ordenados por atividade', () => {
  test('orgs pela atividade mais recente, a conta pessoal por último; dentro do grupo, pelo último push', () => {
    const lista = montarLista(
      {
        login: 'eu',
        organizacoes: ['org-b', 'org-a', 'org-vazia'],
        repos: [
          repo('eu/notas', { pushedAt: iso(AGORA - 1000) }),
          repo('org-a/velho', { pushedAt: iso(AGORA - 10 * DIA_MS) }),
          repo('org-b/novo', { pushedAt: iso(AGORA - 2 * H), isPrivate: true }),
          repo('org-a/recente', { pushedAt: iso(AGORA - H) }),
        ],
      },
      { esperandoReview: 2, fechadasNaSemana: 5 },
      new Map(),
      { taxaVerde: 0.5, execucoes: 4 },
    );
    assert.deepEqual(lista.grupos.map((g) => [g.dono, g.tipo, g.repos.map((r) => r.nome)]), [
      ['org-a', 'org', ['recente', 'velho']],
      ['org-b', 'org', ['novo']],
      ['eu', 'pessoal', ['notas']],
    ]);
    assert.equal(lista.grupos[1].repos[0].visibilidade, 'privado');
    // A org sem repositório conta no resumo, como no cabeçalho "2 organizações".
    assert.equal(lista.resumo.organizacoes, 3);
    assert.equal(lista.resumo.repositorios, 4);
    assert.equal(lista.resumo.prsAbertos, 4);
    assert.equal(lista.resumo.issuesAbertas, 8);
    assert.equal(lista.resumo.prsEsperandoReview, 2);
    assert.equal(lista.resumo.issuesFechadasNaSemana, 5);
    assert.deepEqual(lista.resumo.ci, { taxaVerde: 0.5, execucoes: 4, dias: 7 });
  });
});

describe('#104 CA2: linguagem, commits das 12 semanas e CI de cada linha', () => {
  test('commits12 são as 12 últimas semanas, a mais antiga primeiro; menos de 12 completa com zero', () => {
    const atividade = Array.from({ length: 52 }, (_, i) => ({ week: semanaSeg(51 - i), total: i }));
    assert.deepEqual(commits12(atividade), [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51]);
    assert.deepEqual(commits12([{ week: semanaSeg(1), total: 3 }, { week: semanaSeg(0), total: 4 }]), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 4]);
    assert.deepEqual(commits12(null), []);
  });

  test('CI do branch padrão: sucesso, falha e em andamento; sem checks, nulo', () => {
    assert.equal(ciDoRollup('SUCCESS'), 'ok');
    assert.equal(ciDoRollup('FAILURE'), 'falhou');
    assert.equal(ciDoRollup('ERROR'), 'falhou');
    assert.equal(ciDoRollup('PENDING'), 'rodando');
    assert.equal(ciDoRollup('EXPECTED'), 'rodando');
    assert.equal(ciDoRollup(null), null);
  });
});

describe('#105 CA1: linhas de código, commits por semana e frequência', () => {
  const frequencia: [number, number, number][] = [
    [semanaSeg(100), 1000, -100],
    [semanaSeg(20), 300, -50],
    [semanaSeg(2), 200, -20],
    [semanaSeg(0), 10, -40],
  ];

  test('linhas são a soma de adições menos remoções desde o primeiro commit; o saldo do período à parte', () => {
    assert.deepEqual(linhasDe(frequencia, inicioDoPeriodo('90d', AGORA)), { total: 1300, noPeriodo: 150 });
    assert.deepEqual(linhasDe(frequencia, inicioDoPeriodo('1a', AGORA)), { total: 1300, noPeriodo: 400 });
  });

  test('a frequência traz adicionadas e removidas por semana do período, com as remoções positivas', () => {
    const f = frequenciaDoPeriodo(frequencia, inicioDoPeriodo('30d', AGORA));
    assert.deepEqual(f.semanas.map((s) => [s.adicionadas, s.removidas]), [[200, 20], [10, 40]]);
    assert.equal(f.adicionadas, 210);
    assert.equal(f.removidas, 60);
  });

  test('commits por semana: total e média das semanas do período', () => {
    const atividade = [{ week: semanaSeg(20), total: 9 }, { week: semanaSeg(2), total: 4 }, { week: semanaSeg(1), total: 6 }, { week: semanaSeg(0), total: 2 }];
    assert.deepEqual(commitsDoPeriodo(atividade, inicioDoPeriodo('30d', AGORA)), { total: 12, porSemana: 4, semanas: [4, 6, 2] });
  });
});

describe('#105 CA2: issues por tipo e o tempo mediano até fechar', () => {
  test('fechadas no período e abertas agora, por tipo; sem tipo vira "Sem tipo"', () => {
    const fechadas = [
      { createdAt: iso(AGORA - 10 * H), closedAt: iso(AGORA), issueType: { name: 'Bug' } },
      { createdAt: iso(AGORA - 30 * H), closedAt: iso(AGORA), issueType: { name: 'Bug' } },
      { createdAt: iso(AGORA - 20 * H), closedAt: iso(AGORA), issueType: null },
    ];
    const abertas = [{ issueType: { name: 'História' } }, { issueType: { name: 'Bug' } }];
    const r = issuesDoPeriodo(fechadas, abertas);
    assert.deepEqual(r.porTipo, [
      { tipo: 'Bug', fechadas: 2, abertas: 1 },
      { tipo: 'História', fechadas: 0, abertas: 1 },
      { tipo: 'Sem tipo', fechadas: 1, abertas: 0 },
    ]);
    assert.equal(r.fechadas, 3);
    assert.equal(r.abertas, 2);
    assert.equal(r.medianaAteFecharMs, 20 * H);
    // Sem as contagens (cache gravado antes delas), o total é o que se leu.
    assert.deepEqual(r.amostra, { lidos: 5, total: 5, truncado: false });
  });

  test('mediana com número par e vazia', () => {
    assert.equal(mediana([4, 1, 3, 2]), 2.5);
    assert.equal(mediana([]), null);
  });
});

describe('#105 CA3: PRs, review e a fatia aberta por agentes', () => {
  const desde = inicioDoPeriodo('90d', AGORA);
  const criado = AGORA - 10 * DIA_MS;
  const prs = [
    pr({ state: 'MERGED', createdAt: iso(criado), mergedAt: iso(criado + 10 * H), closedAt: iso(criado + 10 * H), additions: 100, deletions: 10, reviews: { totalCount: 2, nodes: [{ createdAt: iso(criado + 2 * H) }] }, pedidosDeMudanca: { totalCount: 1 } }),
    pr({ state: 'MERGED', createdAt: iso(criado), mergedAt: iso(criado + 30 * H), closedAt: iso(criado + 30 * H), additions: 300, deletions: 30, reviews: { totalCount: 1, nodes: [{ createdAt: iso(criado + 4 * H) }] }, author: { login: 'dependabot[bot]', __typename: 'Bot' } }),
    pr({ state: 'MERGED', createdAt: iso(criado), mergedAt: iso(criado + 20 * H), closedAt: iso(criado + 20 * H), additions: 200, deletions: 20, headRefName: 'claude/ajuste' }),
    pr({ state: 'CLOSED', createdAt: iso(criado), closedAt: iso(criado + H) }),
    // Mergeado antes do período: não conta.
    pr({ state: 'MERGED', createdAt: iso(AGORA - 200 * DIA_MS), mergedAt: iso(AGORA - 199 * DIA_MS), closedAt: iso(AGORA - 199 * DIA_MS), additions: 9999 }),
  ];

  test('mergeados e fechados sem merge do período, abertos de agora, medianas e tamanho', () => {
    const r = prsDoPeriodo(prs, 7, desde);
    assert.equal(r.mergeados, 3);
    assert.equal(r.fechadosSemMerge, 1);
    assert.equal(r.abertos, 7);
    assert.equal(r.medianaAteMergeMs, 20 * H);
    assert.equal(r.medianaAtePrimeiroReviewMs, 3 * H);
    assert.deepEqual(r.tamanhoMediano, { adicionadas: 200, removidas: 20 });
    // Mergeados com review: (1 pedido + 1) e (0 + 1) → média 1,5.
    assert.equal(r.rodadasDeReview, 1.5);
    // Criados no período: 4; por agente: o do bot e o do branch claude/.
    assert.equal(r.fatiaPorAgentes, 0.5);
    assert.deepEqual(r.amostra, { lidos: 5, total: 5, truncado: false });
  });

  test('com as contagens, mergeados e fechados sem merge são o total do GitHub, e a amostra diz se cortou', () => {
    const r = prsDoPeriodo(prs, 7, desde, { prs: 500, mergeados: 420, fechadosSemMerge: 30 });
    assert.deepEqual([r.mergeados, r.fechadosSemMerge, r.abertos], [420, 30, 7]);
    assert.deepEqual(r.amostra, { lidos: 5, total: 500, truncado: true });
    // As medianas continuam sobre a amostra.
    assert.equal(r.medianaAteMergeMs, 20 * H);
  });

  test('agente: autor Bot, login terminado em [bot] ou branch claude/; o resto não', () => {
    assert.equal(abertoPorAgente({ author: { login: 'renovate[bot]' }, headRefName: 'x' }), true);
    assert.equal(abertoPorAgente({ author: { login: 'app', __typename: 'Bot' }, headRefName: 'x' }), true);
    assert.equal(abertoPorAgente({ author: { login: 'pessoa' }, headRefName: 'claude/tarefa' }), true);
    assert.equal(abertoPorAgente({ author: { login: 'pessoa' }, headRefName: 'feat/claude' }), false);
    assert.equal(abertoPorAgente({ author: null, headRefName: null }), false);
  });

  test('sem PR no período: medianas e fatia nulas', () => {
    const r = prsDoPeriodo([], 0, desde);
    assert.deepEqual([r.medianaAteMergeMs, r.tamanhoMediano, r.rodadasDeReview, r.fatiaPorAgentes], [null, null, null, null]);
  });
});

describe('#105 CA4: CI, linguagens e contribuidores', () => {
  test('taxa verde e duração média dos runs concluídos; cancelado não conta', () => {
    const run = (conclusion: string, min: number) => ({ status: 'completed', conclusion, run_started_at: iso(AGORA), updated_at: iso(AGORA + min * 60_000) });
    const r = ciDosRuns({ total_count: 40, workflow_runs: [run('success', 4), run('success', 6), run('failure', 2), run('cancelled', 1), run('success', 8)] });
    assert.deepEqual(r, { taxaVerde: 0.75, execucoes: 40, duracaoMediaMs: 5 * 60_000 });
    assert.deepEqual(ciDosRuns({ total_count: 0, workflow_runs: [] }), { taxaVerde: null, execucoes: 0, duracaoMediaMs: null });
  });

  test('linguagens por bytes, a maior primeiro, com a fatia', () => {
    assert.deepEqual(linguagensDe({ CSS: 25, TypeScript: 75 }), [{ nome: 'TypeScript', bytes: 75, fatia: 0.75 }, { nome: 'CSS', bytes: 25, fatia: 0.25 }]);
  });

  test('contribuidores com commits e linhas no período, quem mais contribuiu primeiro', () => {
    const c = contribuidoresDoPeriodo(
      [
        { author: { login: 'a' }, total: 5, weeks: [{ w: semanaSeg(40), a: 100, d: 1, c: 4 }, { w: semanaSeg(1), a: 10, d: 2, c: 1 }] },
        { author: { login: 'b' }, total: 3, weeks: [{ w: semanaSeg(0), a: 30, d: 3, c: 3 }] },
      ],
      inicioDoPeriodo('30d', AGORA),
    );
    assert.deepEqual(c, [{ login: 'b', commits: 3, adicionadas: 30, removidas: 3 }, { login: 'a', commits: 1, adicionadas: 10, removidas: 2 }]);
  });
});

describe('#105 CA5: escrita pelo viewerPermission', () => {
  test('ADMIN, MAINTAIN e WRITE escrevem; TRIAGE, READ e nulo não', () => {
    assert.deepEqual(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ', null].map(temEscrita), [true, true, true, false, false, false]);
  });
});
