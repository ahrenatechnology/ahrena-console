// Mede o custo de cada formato de consulta ao GitHub (spike #40). Poucas chamadas,
// em série, com pausa entre elas. Uso: node medir.mjs > medicoes.json
import { execFileSync } from 'node:child_process';

const OWNER = 'ahrenatechnology';
const REPO = 'ahrena-console';
const PROJECT = 3;
const EPIC = 6;
const PAUSA_MS = 3000;
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NODE_FIELDS = `number title url state updatedAt repository { nameWithOwner } issueType { name }
  subIssuesSummary { total completed percentCompleted } assignees(first: 2) { nodes { login } } labels(first: 4) { nodes { name } }
  closedByPullRequestsReferences(first: 2, includeClosedPrs: true) { nodes { number state isDraft url reviewDecision
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }`;
const LEAN_FIELDS = `number title url state updatedAt repository { nameWithOwner } issueType { name }
  subIssuesSummary { total completed percentCompleted } parent { number repository { nameWithOwner } }`;

const RL = 'rateLimit(dryRun: $dry) { cost remaining resetAt nodeCount }';
const FORMATOS = {
  // Versão de antes do paliativo: 3 níveis de pais, 25 filhas, 15 netas.
  antiga: `query($q: String!, $dry: Boolean!) { ${RL} search(query: $q, type: ISSUE, first: 30) { issueCount nodes { ... on Issue {
    ${NODE_FIELDS} parent { ${NODE_FIELDS} parent { ${NODE_FIELDS} parent { ${NODE_FIELDS} } } }
    subIssues(first: 25) { nodes { ${NODE_FIELDS} subIssues(first: 15) { nodes { ${NODE_FIELDS} } } } } } } } }`,
  // Paliativo atual do núcleo de teste (WORK_QUERY).
  atual: `query($q: String!, $dry: Boolean!) { ${RL} search(query: $q, type: ISSUE, first: 30) { issueCount nodes { ... on Issue {
    ${NODE_FIELDS} parent { ${NODE_FIELDS} parent { ${NODE_FIELDS} } } subIssues(first: 15) { nodes { ${NODE_FIELDS} } } } } } }`,
  // Enxuta: só o card, sem PR/CI, com a chave do pai e o resumo das filhas.
  enxuta: `query($q: String!, $dry: Boolean!) { ${RL} search(query: $q, type: ISSUE, first: 30) { issueCount nodes { ... on Issue { ${LEAN_FIELDS} } } } }`,
  // Enxuta com PR e CI do próprio card (sem descer nem subir).
  enxutaComPr: `query($q: String!, $dry: Boolean!) { ${RL} search(query: $q, type: ISSUE, first: 30) { issueCount nodes { ... on Issue { ${NODE_FIELDS} parent { number repository { nameWithOwner } } } } } }`,
};
const FILHAS = `query($o: String!, $r: String!, $n: Int!, $dry: Boolean!) { ${RL} repository(owner: $o, name: $r) { issue(number: $n) {
  subIssues(first: 50) { totalCount nodes { ${NODE_FIELDS} } } } } }`;
const PROJETO = `query($o: String!, $n: Int!, $dry: Boolean!) { ${RL} organization(login: $o) { projectV2(number: $n) { items(first: 100) {
  totalCount pageInfo { hasNextPage } nodes { id fieldValues(first: 20) { nodes {
    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } } }
    content { ... on Issue { number title state updatedAt issueType { name } parent { number }
      closedByPullRequestsReferences(first: 2, includeClosedPrs: true) { nodes { number state isDraft reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } } } } } } }`;
const PROJETO_STATUS = `query($o: String!, $n: Int!, $dry: Boolean!) { ${RL} organization(login: $o) { projectV2(number: $n) { items(first: 100) {
  totalCount nodes { id updatedAt fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    content { ... on Issue { number title state updatedAt issueType { name } parent { number } } } } } } } }`;

async function graphql(query, variables) {
  const t0 = Date.now();
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'GraphQL-Features': 'sub_issues,issue_types' },
    body: JSON.stringify({ query, variables }),
  });
  const ms = Date.now() - t0;
  const json = await res.json();
  if (json.errors) return { erro: json.errors[0].message, ms };
  const bytes = JSON.stringify(json.data).length;
  return { ...json.data.rateLimit, ms, bytes, data: json.data };
}

async function rest(path, etag) {
  const t0 = Date.now();
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `bearer ${token}`, accept: 'application/vnd.github+json', ...(etag ? { 'if-none-match': etag } : {}) },
  });
  const body = res.status === 200 ? await res.json() : null;
  return { status: res.status, ms: Date.now() - t0, etag: res.headers.get('etag'), remaining: Number(res.headers.get('x-ratelimit-remaining')), used: Number(res.headers.get('x-ratelimit-used')), itens: Array.isArray(body) ? body.length : null };
}

const out = { quando: new Date().toISOString(), graphql: {}, rest: {} };
const q = `repo:${OWNER}/${REPO} is:issue is:open`;

// 1) Estimativas sem executar (dryRun não roda a consulta).
for (const [nome, query] of Object.entries(FORMATOS)) {
  const r = await graphql(query, { q, dry: true });
  out.graphql[nome] = { estimativa: { cost: r.cost, nodeCount: r.nodeCount, erro: r.erro } };
  await sleep(PAUSA_MS);
}
for (const [nome, query, vars] of [['filhasDoEpico', FILHAS, { o: OWNER, r: REPO, n: EPIC }], ['projeto', PROJETO, { o: OWNER, n: PROJECT }], ['projetoStatus', PROJETO_STATUS, { o: OWNER, n: PROJECT }]]) {
  const r = await graphql(query, { ...vars, dry: true });
  out.graphql[nome] = { estimativa: { cost: r.cost, nodeCount: r.nodeCount, erro: r.erro } };
  await sleep(PAUSA_MS);
}

// 2) Execução real dos formatos que valem a pena (a antiga fica só na estimativa).
for (const nome of ['atual', 'enxuta', 'enxutaComPr']) {
  const r = await graphql(FORMATOS[nome], { q, dry: false });
  out.graphql[nome].real = { cost: r.cost, remaining: r.remaining, ms: r.ms, bytes: r.bytes, issues: r.data?.search?.nodes?.length, erro: r.erro };
  await sleep(PAUSA_MS);
}
for (const [nome, query, vars] of [['filhasDoEpico', FILHAS, { o: OWNER, r: REPO, n: EPIC }], ['projeto', PROJETO, { o: OWNER, n: PROJECT }], ['projetoStatus', PROJETO_STATUS, { o: OWNER, n: PROJECT }]]) {
  const r = await graphql(query, { ...vars, dry: false });
  const itens = r.data?.organization?.projectV2?.items?.totalCount ?? r.data?.repository?.issue?.subIssues?.totalCount;
  out.graphql[nome].real = { cost: r.cost, remaining: r.remaining, ms: r.ms, bytes: r.bytes, itens, erro: r.erro };
  await sleep(PAUSA_MS);
}

// 3) Delta: só o que mudou desde uma data (busca incremental).
{
  const desde = new Date(Date.now() - 60 * 60_000).toISOString().slice(0, 19) + 'Z';
  const r = await graphql(FORMATOS.enxuta, { q: `${q} updated:>=${desde}`, dry: false });
  out.graphql.deltaUltimaHora = { real: { cost: r.cost, ms: r.ms, bytes: r.bytes, issues: r.data?.search?.nodes?.length, erro: r.erro } };
  await sleep(PAUSA_MS);
}

// 4) REST com ETag: a segunda chamada é condicional e deve voltar 304.
for (const [nome, path] of [['issuesAbertas', `/repos/${OWNER}/${REPO}/issues?state=open&per_page=100`], ['filhasDoEpico', `/repos/${OWNER}/${REPO}/issues/${EPIC}/sub_issues?per_page=50`], ['eventosDoRepo', `/repos/${OWNER}/${REPO}/events?per_page=30`]]) {
  const primeira = await rest(path);
  await sleep(PAUSA_MS);
  const condicional = await rest(path, primeira.etag);
  out.rest[nome] = { primeira, condicional, consumiu: primeira.remaining - condicional.remaining };
  await sleep(PAUSA_MS);
}

console.log(JSON.stringify(out, null, 2));
