// As telas de ADR e PDR (C28 a C31 e C38, #174) montadas no DOM falso, com um `ctx.read` falso que
// devolve respostas no formato de src/adrs/model.ts (dados inventados), e o texto hostil de um
// repositório, que nunca vira HTML.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import type { DecisionList, DecisionRecordView, DecisionSummary, RepoDecisions } from '../../src/adrs/model.ts';
import { ElementoFalso, instalarDomFalso, texto, type NoFalso } from './fake-dom.ts';

instalarDomFalso();

const local = { pathname: '/ui/adrs', search: '' };
const replaced: string[] = [];
Object.assign(globalThis, { location: local, history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) }, getSelection: () => ({ toString: () => '' }) });

// @ts-expect-error: módulo do navegador, em JavaScript puro
const { mount: mountList, filtersFrom, listRoute, sortRecords } = await import('../../ui/screens/adrs.js');
// @ts-expect-error: idem
const { mount: mountRecord, presentSections } = await import('../../ui/screens/adr-record.js');
// @ts-expect-error: idem
const { mount: mountRepo } = await import('../../ui/screens/repo.js');
// @ts-expect-error: idem
const { tabKindFrom, filterRecords } = await import('../../ui/screens/repo-adrs.js');
// @ts-expect-error: idem
const { dateBr, recordHref, recordNumber, decisionsChangeMatters, kindOfPath, rowNote } = await import('../../ui/screens/adrs-common.js');

const NOW = new Date().toISOString();
const REPO = 'exemplo-labs/motor-de-regras';

const row = (n: number, title: string, extra: Partial<DecisionSummary> = {}): DecisionSummary => ({
  repo: REPO,
  id: `${String(n).padStart(4, '0')}-${title.toLowerCase().replace(/\W+/g, '-')}`,
  path: `docs/adr/${String(n).padStart(4, '0')}-x.md`,
  number: n,
  title,
  kind: 'adr',
  kindReason: 'folder',
  format: 'madr4',
  status: 'accepted',
  date: '2026-09-30',
  missing: [],
  links: [],
  ...extra,
});

const ROWS = [
  row(9, 'Cobrança vira um serviço à parte', { status: 'proposed', date: '2026-10-17' }),
  row(8, 'Regras em tabela de decisão versionada', { links: [{ kind: 'supersedes', target: '0007-x', via: 'text', number: 7, title: 'Motor', targetKind: 'adr', status: 'superseded' }] }),
  row(7, 'Motor de regras em processo', { status: 'superseded', date: '2026-07-02' }),
  row(6, 'Fila entre pedidos e cobrança', { status: 'deprecated', date: '2026-05-11' }),
  row(5, 'Avaliar regras no banco', { status: 'superseded', date: '2026-03-20', missing: ['consequences'] }),
  row(4, 'Regras escritas em YAML', { date: '2026-02-02' }),
];

function list(extra: Partial<DecisionList> = {}): DecisionList {
  return {
    state: 'ready',
    error: null,
    kind: 'adr',
    readAt: NOW,
    retryAt: null,
    account: 'dev-sintetico',
    totals: { records: 7, reposWith: 2, reposRead: 3, accepted: 3, proposed: 1, replaced: 3, incomplete: 2 },
    counts: { all: 7, accepted: 3, proposed: 1, superseded: 2, deprecated: 1, rejected: 0, unknown: 0 },
    groups: [
      { repo: REPO, folders: ['docs/adr'], format: 'madr4', total: 6, byTypeField: false, records: ROWS },
      { repo: 'estudio-ficticio/app-receitas', folders: ['docs/decisions'], format: 'y-statement', total: 1, byTypeField: false, records: [row(1, 'Kotlin Multiplatform no app', { repo: 'estudio-ficticio/app-receitas', status: 'unknown', date: null, missing: ['status', 'date', 'options'] })] },
    ],
    without: ['dev-sintetico/blog-estatico'],
    owners: ['exemplo-labs', 'estudio-ficticio', 'dev-sintetico'],
    repos: [REPO, 'estudio-ficticio/app-receitas'],
    ...extra,
  };
}

const HOSTILE = '<script>alert(1)</script> <img src=x onerror=alert(2)> [link](javascript:alert(3))';

function record(extra: Partial<DecisionRecordView> = {}): DecisionRecordView {
  return {
    ...row(8, 'Regras em tabela de decisão versionada'),
    path: 'docs/adr/0008-regras-em-tabela.md',
    id: '0008-regras-em-tabela',
    links: [
      { kind: 'supersedes', target: '0007-motor', via: 'text', number: 7, title: 'Motor de regras em processo', targetKind: 'adr', status: 'superseded' },
      { kind: 'related', target: '0009-cobranca', via: 'inverse', number: 9, title: 'Cobrança vira um serviço à parte', targetKind: 'adr', status: 'proposed' },
    ],
    state: 'ready',
    error: null,
    readAt: NOW,
    commit: 'abc123',
    language: 'pt',
    statusRaw: 'accepted',
    dateRaw: '2026-09-30',
    deciders: ['dev-sintetico', 'colega-a'],
    consulted: ['colega-b'],
    informed: ['time de produto'],
    context: `As regras mudam toda semana. ${HOSTILE}`,
    drivers: ['Mudar uma regra sem deploy'],
    decision: 'Chosen option: "Tabela de decisão versionada", because é revisada no PR.',
    chosen: 'Tabela de decisão versionada',
    chosenReason: 'é revisada no PR.',
    options: [
      { name: 'Tabela de decisão versionada', chosen: true, pros: ['é revisada', 'sem deploy'], cons: ['laços não cabem'] },
      { name: 'Motor de regras em processo', chosen: false, pros: [], cons: [] },
    ],
    consequences: '* Good, because …',
    consequencesGood: ['Mudar uma regra vira um PR de uma linha'],
    consequencesBad: ['A tabela precisa de validação na CI'],
    confirmation: 'O job de CI recusa a tabela.',
    other: [{ heading: 'More Information', text: 'Supersedes [0007](0007-motor.md).' }],
    statusConflict: null,
    chain: [
      { id: '0005-x', number: 5, title: 'Avaliar regras no banco', kind: 'adr', status: 'superseded' },
      { id: '0007-motor', number: 7, title: 'Motor de regras em processo', kind: 'adr', status: 'superseded' },
      { id: '0008-regras-em-tabela', number: 8, title: 'Regras em tabela de decisão versionada', kind: 'adr', status: 'accepted' },
    ],
    markdown: `# 8. Regras\n\n${HOSTILE}\n`,
    ...extra,
  };
}

function repoAnswer(extra: Partial<RepoDecisions> = {}): RepoDecisions {
  return {
    state: 'ready',
    error: null,
    kind: 'adr',
    repo: REPO,
    commit: 'abc123',
    readAt: NOW,
    retryAt: null,
    fromCache: false,
    folders: ['docs/adr'],
    format: 'madr4',
    counts: { adr: 6, pdr: 2, all: 8 },
    statusCounts: { all: 6, accepted: 2, proposed: 1, superseded: 2, deprecated: 1, rejected: 0, unknown: 0 },
    records: ROWS,
    chains: [record().chain],
    ...extra,
  };
}

const METRICS = { state: 'ready', updatedAt: NOW, error: null, computing: [], period: '90d', repo: { fullName: REPO, url: `https://github.com/${REPO}`, visibility: 'private', ci: 'ok', defaultBranch: 'main', stars: 1, forks: 0, watchers: 1, release: null, license: null }, tabs: { issues: 9, prs: 5, sessions: 3 }, canWrite: false };

// ---------- montar ----------

interface Mounted {
  area: ElementoFalso;
  reads: string[];
  navigated: string[];
  change: (changes: unknown[]) => void;
  leave: () => void;
}
const opened: Mounted[] = [];
afterEach(() => {
  for (const m of opened.splice(0)) m.leave();
});
const settle = async () => {
  for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r));
};

async function mountWith(mount: (area: ElementoFalso, ctx: unknown) => Promise<(() => void) | undefined>, path: string, answer: (route: string) => unknown, params: Record<string, string> = {}): Promise<Mounted> {
  const [pathname, search = ''] = path.split('?');
  Object.assign(local, { pathname, search: search ? `?${search}` : '' });
  const area = new ElementoFalso('main');
  const reads: string[] = [];
  const navigated: string[] = [];
  const listeners = new Set<(c: unknown[]) => void>();
  const signal = new AbortController();
  const ctx = {
    params,
    signal: signal.signal,
    read: async (route: string) => {
      reads.push(route);
      if (route.startsWith('/api/repos/')) return METRICS;
      const r = answer(route);
      if (r instanceof Error) throw r;
      return r;
    },
    onChange: (f: (c: unknown[]) => void) => listeners.add(f),
    onRestart: () => {},
    liveState: () => 'live',
    counter: () => {},
    title: () => {},
    navigate: (to: string) => navigated.push(to),
  };
  const cleanup = await mount(area, ctx);
  await settle();
  const m = { area, reads, navigated, change: (c: unknown[]) => listeners.forEach((f) => f(c)), leave: () => (signal.abort(), cleanup?.()) };
  opened.push(m);
  return m;
}

/** O texto como a pessoa lê: sem o espaço que `texto()` põe antes da vírgula e do ponto. */
const lido = (n: NoFalso | null) => texto(n).replace(/\s+([,.])/g, '$1');

/** Todo elemento com `innerHTML` posto: só os ícones (SVG do próprio console) podem ter. */
function innerHtmlOutsideIcons(no: NoFalso): string[] {
  const out: string[] = [];
  const visit = (n: NoFalso) => {
    if (!(n instanceof ElementoFalso)) return;
    if (n.innerHTMLFalso && n.tagName !== 'SVG') out.push(n.tagName);
    n.childNodes.forEach(visit);
  };
  visit(no);
  return out;
}

// ---------- a lista geral ----------

describe('ADR (C28): the list of every repository', () => {
  test('the five cards, the filters with the counts, the groups and the line of repositories without ADR', async () => {
    const { area, reads } = await mountWith(mountList, '/ui/adrs', () => list());
    assert.deepEqual(reads, ['/api/adrs']);
    assert.deepEqual(area.querySelectorAll('.adr-stat').map((s) => texto(s)), ['ADRs 7 em 2 de 3 repositórios', 'Aceitas 3 valem hoje', 'Propostas 1 esperando decisão', 'Substituídas 3 substituídas ou obsoletas', 'Incompletas 2 sem status, data ou seção']);
    assert.deepEqual(area.querySelectorAll('.adr-status-slot button').map((b) => texto(b)), ['Todas 7', 'Aceitas 3', 'Propostas 1', 'Substituídas 2', 'Obsoletas 1', 'Rejeitadas 0', 'Sem status 0']);
    const groups = area.querySelectorAll('.adr-group');
    assert.equal(texto(groups[0].querySelector('.adr-group-head')), `${REPO} docs/adr · MADR 4 · 6 ADRs Ver as 6 ›`);
    assert.equal(groups[0].querySelectorAll('.adr-row').length, 5, 'sem filtro, até 5 por repositório');
    assert.equal(groups[0].querySelector('.adr-group-more')!.getAttribute('href'), '/ui/repos/exemplo-labs/motor-de-regras/adrs?kind=adr');
    const first = groups[0].querySelector('.adr-row')!;
    assert.equal(first.getAttribute('href'), '/ui/adrs/exemplo-labs/motor-de-regras/0009-cobran-a-vira-um-servi-o-parte');
    assert.match(texto(groups[0].querySelectorAll('.adr-row')[1]), /0008 Regras em tabela de decisão versionada substitui 0007 Aceita/);
    assert.match(texto(groups[1]), /0001 Kotlin Multiplatform no app sem data · sem alternativas Sem status/);
    assert.match(lido(area.querySelector('.adr-without')), /Sem ADR em 1 repositório: blog-estatico\./);
  });

  test('the filters go to the URL and to the API; the counts stay before the status filter', async () => {
    replaced.length = 0;
    const { area, reads } = await mountWith(mountList, '/ui/adrs?q=fila&status=accepted&repo=exemplo-labs', () => list());
    assert.deepEqual(reads, ['/api/adrs?q=fila&status=accepted&repo=exemplo-labs']);
    assert.equal(area.querySelector('.adr-status-slot [aria-pressed="true"]')!.getAttribute('data-value'), 'accepted');
    area.querySelectorAll('.adr-status-slot button').find((b) => b.getAttribute('data-value') === 'superseded')!.click();
    await settle();
    assert.equal(reads.at(-1), '/api/adrs?q=fila&status=superseded&repo=exemplo-labs');
    assert.equal(replaced.at(-1), '/ui/adrs?q=fila&status=superseded&repo=exemplo-labs');
    assert.equal(area.querySelectorAll('.adr-group')[0].querySelectorAll('.adr-row').length, 6, 'com filtro, todas as linhas');
  });

  test('PDR (C38): the same screen with another label, and the mixed folder says the type field separates them', async () => {
    const pdrs = list({ kind: 'pdr', groups: [{ repo: 'exemplo-labs/vitrine-demo', folders: ['docs/decisoes'], format: 'free', total: 1, byTypeField: true, records: [row(7, 'Kanban só do usuário', { kind: 'pdr', kindReason: 'type-field', repo: 'exemplo-labs/vitrine-demo' })] }] });
    const { area, reads } = await mountWith(mountList, '/ui/pdrs', () => pdrs);
    assert.deepEqual(reads, ['/api/pdrs']);
    assert.match(texto(area.querySelector('header')), /^PDR Ao vivo Decisões de produto/);
    assert.match(texto(area.querySelector('.adr-group-head')), /docs\/decisoes · livre · 1 PDR · separadas das ADRs pelo campo Tipo: produto/);
    assert.equal(area.querySelector('.adr-row')!.getAttribute('href'), '/ui/pdrs/exemplo-labs/vitrine-demo/0007-kanban-s-do-usu-rio');
    assert.match(lido(area.querySelector('.adr-without')), /Sem PDR em 1 repositório/);
  });

  test('GitHub limited: the band with the cache time and when it tries again; the list still shows', async () => {
    const retryAt = new Date(Date.now() + 2 * 60_000).toISOString();
    const { area } = await mountWith(mountList, '/ui/adrs', () => list({ error: 'GitHub limitou as chamadas: API rate limit exceeded', retryAt }));
    assert.match(texto(area.querySelector('.adr-band')), /^GitHub limitou as leituras\. Mostrando as ADRs em cache, de \d\d:\d\d\. Tentamos de novo em 2 min\. Tentar agora$/);
    assert.equal(area.querySelectorAll('.adr-row').length, 6);
  });

  test('loading, no GitHub, nothing at all and the live change of the list', async () => {
    let answer: unknown = list({ state: 'loading', groups: [] });
    const m = await mountWith(mountList, '/ui/adrs', () => answer);
    assert.match(texto(m.area), /Lendo o GitHub/);
    answer = list({ totals: { records: 0, reposWith: 0, reposRead: 3, accepted: 0, proposed: 0, replaced: 0, incomplete: 0 }, groups: [], without: ['a/b', 'a/c', 'a/d'] });
    m.change([{ type: 'adrs', key: 'other/repo' }]);
    await settle();
    assert.match(texto(m.area), /Lendo o GitHub/, 'a mudança de outro repositório não relê a lista');
    m.change([{ type: 'adrs', key: 'list' }]);
    await settle();
    assert.match(lido(m.area), /Nenhuma ADR nos repositórios da conta Procuramos em docs\/adr, docs\/adrs, docs\/decisions, docs\/decisoes, docs\/architecture\/decisions e mais 9 pastas, nos 3 repositórios lidos\./);
    const none = await mountWith(mountList, '/ui/adrs', () => list({ state: 'no-github', groups: [] }));
    assert.match(texto(none.area), /GitHub/);
  });
});

// ---------- o registro aberto ----------

describe('ADR (C30): the open record, structured', () => {
  const params = { owner: 'exemplo-labs', repo: 'motor-de-regras', id: '0008-regras-em-tabela' };

  test('the header, the links both ways, the sections, the Registro card, the chain and the index', async () => {
    const { area, reads } = await mountWith(mountRecord, '/ui/adrs/exemplo-labs/motor-de-regras/0008-regras-em-tabela', () => record(), params);
    assert.deepEqual(reads, ['/api/adrs/exemplo-labs/motor-de-regras/0008-regras-em-tabela']);
    assert.match(texto(area.querySelector('.adr-head')), /^0008 Regras em tabela de decisão versionada Aceita Estruturada Markdown Abrir no GitHub exemplo-labs\/motor-de-regras 30\/09\/2026 docs\/adr\/0008-regras-em-tabela\.md MADR 4 tipo pela pasta$/);
    assert.equal(texto(area.querySelector('.adr-links')), 'Substitui 0007 Motor de regras em processo Substituída Relacionada a 0009 Cobrança vira um serviço à parte Proposta Substituída por: nenhuma');
    assert.equal(area.querySelector('.adr-link')!.getAttribute('href'), '/ui/adrs/exemplo-labs/motor-de-regras/0007-motor');
    assert.deepEqual(area.querySelectorAll('.adr-main [data-section]').map((s) => s.getAttribute('data-section')), ['context', 'drivers', 'decision', 'options', 'consequences', 'confirmation']);
    assert.equal(texto(area.querySelector('.adr-chosen')), 'Opção escolhida Tabela de decisão versionada');
    assert.match(texto(area.querySelector('[data-section="options"]')), /Alternativas 2 consideradas Tabela de decisão versionada 2 prós · 1 contra Prós é revisada sem deploy Contras laços não cabem Motor de regras em processo/);
    assert.equal(texto(area.querySelector('[data-section="consequences"]')), 'Consequências Boas Mudar uma regra vira um PR de uma linha Ruins A tabela precisa de validação na CI');
    assert.match(texto(area.querySelector('.adr-other')), /^Outras seções do texto More Information/);
    assert.equal(texto(area.querySelector('[data-card="registry"]')), 'Registro Status Aceita accepted Data 30/09/2026 Decidiram dev-sintetico, colega-a Consultados colega-b Informados time de produto Formato MADR 4 Tipo ADR · tipo pela pasta');
    assert.equal(texto(area.querySelector('[data-card="chain"]')), 'Cadeia 0005 Substituída Avaliar regras no banco substituída por 0007 Substituída Motor de regras em processo substituída por 0008 esta Aceita Regras em tabela de decisão versionada');
    assert.equal(area.querySelector('.adr-node-here')!.getAttribute('aria-current'), 'true');
    assert.deepEqual(area.querySelectorAll('.adr-toc a').map((a) => texto(a)), ['Contexto', 'Motivadores', 'Decisão', 'Alternativas', 'Consequências', 'Confirmação']);
  });

  test('what is missing shows dashed, "não está no texto"; drivers and confirmation simply do not show', async () => {
    const incomplete = record({ status: 'unknown', statusRaw: null, date: null, dateRaw: null, deciders: [], consulted: [], informed: [], format: 'free', options: [], consequences: null, consequencesGood: [], consequencesBad: [], drivers: [], confirmation: null, chain: [], links: [], other: [], chosen: null, chosenReason: null, decision: 'Um módulo comum.' });
    assert.deepEqual(presentSections(incomplete), { context: true, drivers: false, decision: true, options: false, consequences: false, confirmation: false });
    const { area } = await mountWith(mountRecord, '/ui/adrs/a/b/c', () => incomplete, params);
    assert.deepEqual(area.querySelectorAll('.adr-missing').map((s) => texto(s)), ['Alternativas não está no texto', 'Consequências não está no texto']);
    assert.match(texto(area.querySelector('[data-card="registry"]')), /Status não está no texto Data não está no texto Decidiram não está no texto Formato livre/);
    assert.equal(area.querySelector('[data-card="chain"]'), null);
    assert.equal(texto(area.querySelector('.adr-links')), 'Substituída por: nenhuma');
  });

  test('the Markdown button shows the original text, and the repository text never becomes HTML', async () => {
    const { area } = await mountWith(mountRecord, '/ui/adrs/a/b/c', () => record(), params);
    assert.match(texto(area.querySelector('[data-section="context"]')), /<script>alert\(1\)<\/script>/);
    area.querySelectorAll('.adr-head button').find((b) => texto(b) === 'Markdown')!.click();
    await settle();
    const md = area.querySelector('.adr-markdown')!;
    assert.match(texto(md), /<script>alert\(1\)<\/script> <img src=x onerror=alert\(2\)>/);
    assert.equal(md.querySelectorAll('script').length + md.querySelectorAll('img').length, 0);
    assert.ok(md.querySelectorAll('a').every((a) => !/^javascript:/i.test(a.getAttribute('href') ?? '')), 'nenhum link javascript:');
    assert.deepEqual(innerHtmlOutsideIcons(area), []);
  });

  test('a record of the other kind goes to its route; one that does not exist shows the reason', async () => {
    const wrong = Object.assign(new Error('0002-free-plan não é uma ADR: é uma PDR'), { status: 404 });
    const a = await mountWith(mountRecord, '/ui/adrs/org/repo/0002-free-plan', () => wrong, { owner: 'org', repo: 'repo', id: '0002-free-plan' });
    assert.deepEqual(a.navigated, ['/ui/pdrs/org/repo/0002-free-plan']);
    const none = Object.assign(new Error('registro não encontrado em org/repo'), { status: 404 });
    const b = await mountWith(mountRecord, '/ui/adrs/org/repo/nope', () => none, { owner: 'org', repo: 'repo', id: 'nope' });
    assert.match(texto(b.area), /ADR não encontrada registro não encontrado em org\/repo/);
  });
});

// ---------- a aba do repositório ----------

describe('ADRs tab (C29, C31): the repository', () => {
  const params = { owner: 'exemplo-labs', repo: 'motor-de-regras', tab: 'adrs' };

  test('the tab sits between Decisões and Instruções, with the count; the ADR · PDR · Todas selector on top', async () => {
    const { area, reads } = await mountWith(mountRepo, '/ui/repos/exemplo-labs/motor-de-regras/adrs', () => repoAnswer(), params);
    assert.ok(reads.includes('/api/adrs/exemplo-labs/motor-de-regras?kind=adr'));
    const tabs = area.querySelector('nav.repo-tabs')!.children.map((t) => texto(t));
    assert.deepEqual(tabs, ['Métricas', 'Issues (9)', 'PRs (5)', 'CI', 'Sessões (3)', 'Decisões', 'ADRs (8)', 'Instruções']);
    assert.equal(texto(area.querySelector('nav.repo-tabs [aria-current="page"]')), 'ADRs (8)');
    assert.deepEqual(area.querySelectorAll('.adr-kind-bar button').map((b) => texto(b)), ['ADR 6', 'PDR 2', 'Todas 8']);
    assert.equal(area.querySelectorAll('.adr-repo-grid .adr-row').length, 6);
    assert.match(texto(area.querySelector('[data-card="where"]')), /^Onde li Pasta docs\/adr Arquivos 6 · formato MADR 4 Lido agora/);
    assert.match(texto(area.querySelector('[data-card="chains"]')), /0005 .* substituída por 0007 .* substituída por 0008 vale hoje Aceita/);
  });

  test('Todas reads kind=all and marks the type on each row; the search and the status filter are local', async () => {
    replaced.length = 0;
    const answer = (route: string) => (route.includes('kind=all') ? repoAnswer({ kind: 'all', records: [...ROWS, row(2, 'Plano gratuito', { kind: 'pdr' })] }) : repoAnswer());
    const { area, reads } = await mountWith(mountRepo, '/ui/repos/exemplo-labs/motor-de-regras/adrs', answer, params);
    area.querySelectorAll('.adr-kind-bar button').find((b) => texto(b) === 'Todas 8')!.click();
    await settle();
    assert.ok(reads.includes('/api/adrs/exemplo-labs/motor-de-regras?kind=all'));
    assert.equal(replaced.at(-1), '/ui/repos/exemplo-labs/motor-de-regras/adrs?kind=all');
    assert.deepEqual(area.querySelectorAll('.adr-repo-grid .adr-kind').map((k) => texto(k)).slice(-1), ['PDR']);
    const n = reads.length;
    const input = area.querySelector('.adr-toolbar input')!;
    input.value = 'regras';
    input.dispatchEvent({ type: 'input' });
    assert.equal(area.querySelectorAll('.adr-repo-grid .adr-row').length, 4);
    assert.equal(reads.length, n, 'a busca da aba não chama o núcleo');
  });

  test('C31: the repository without records, and GitHub limited', async () => {
    const empty = await mountWith(mountRepo, '/ui/repos/a/b/adrs', () => repoAnswer({ records: [], chains: [], folders: [], counts: { adr: 0, pdr: 0, all: 0 } }), { owner: 'a', repo: 'b', tab: 'adrs' });
    assert.match(lido(empty.area.querySelector('.adr-empty')), /^Nenhuma ADR neste repositório Procuramos em docs\/adr, docs\/adrs, docs\/decisions, docs\/decisoes, docs\/architecture\/decisions e mais 9 pastas\. Uma pasta com arquivos 0001-titulo\.md já aparece aqui\. Como escrever uma ADR$/);
    assert.equal(empty.area.querySelector('.adr-empty a')!.getAttribute('rel'), 'noopener noreferrer');
    const limited = await mountWith(mountRepo, '/ui/repos/a/b/adrs', () => repoAnswer({ error: 'GitHub limitou as chamadas', fromCache: true }), { owner: 'a', repo: 'b', tab: 'adrs' });
    assert.match(texto(limited.area.querySelector('.adr-band')), /^GitHub limitou as leituras\. Mostrando as ADRs em cache/);
    assert.match(texto(limited.area.querySelector('[data-card="where"]')), /do cache/);
  });
});

describe('ADR helpers', () => {
  test('filters, routes, sort, numbers, dates and the change', () => {
    assert.deepEqual(filtersFrom('?q=x&status=nope&repo=a/b&sort=date'), { q: 'x', status: '', repo: 'a/b', sort: 'date' });
    assert.equal(listRoute('/api/pdrs', { q: 'a b', status: '', repo: '' }), '/api/pdrs?q=a+b');
    assert.deepEqual(sortRecords([row(1, 'a', { date: '2026-01-01' }), row(2, 'b', { date: null }), row(3, 'c', { date: '2026-05-01' })], 'date').map((r: DecisionSummary) => r.number), [3, 1, 2]);
    assert.equal(recordNumber(7), '0007');
    assert.equal(recordNumber(null), '—');
    assert.equal(dateBr('2026-09-30'), '30/09/2026');
    assert.equal(dateBr(null), null);
    assert.equal(recordHref('pdr', 'a/b', 'x y'), '/ui/pdrs/a/b/x%20y');
    assert.ok(decisionsChangeMatters([{ type: 'adrs', key: 'Org/Repo' }], 'org/repo'));
    assert.ok(!decisionsChangeMatters([{ type: 'repos', key: 'org/repo' }], 'org/repo'));
    assert.equal(kindOfPath('/ui/pdrs/a/b/c').kind, 'pdr');
    assert.equal(tabKindFrom('?kind=all'), 'all');
    assert.equal(tabKindFrom('?kind=x'), 'adr');
    assert.deepEqual(filterRecords(ROWS, { q: 'COBRANCA', status: '' }).map((r: DecisionSummary) => r.number), [9, 6]);
    assert.deepEqual(rowNote(row(5, 'x', { status: 'unknown', missing: ['status', 'date', 'options'] })), { links: '', missing: 'sem data · sem alternativas' });
  });
});
