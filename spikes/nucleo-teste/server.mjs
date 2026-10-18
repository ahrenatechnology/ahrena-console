// Núcleo de teste do Ahrena Console: só para as validações da proposta 0.0.1.
// Expõe o mesmo dado de três jeitos: GET /api/overview (para o mod), MCP em /mcp
// (ferramentas e artefato) e uma MCP App em ui://ahrena-console/teste.html.
// Lê só nomes e datas dos arquivos em ~/.claude/projects, nunca o conteúdo.
import { createServer } from 'node:http';
import { readdir, stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = Number(process.env.AHRENA_CONSOLE_PORT ?? 4720);
const HOST = '127.0.0.1';
const UI_URI = 'ui://ahrena-console/teste.html';
const UI_MIME = 'text/html;profile=mcp-app';
const here = dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();
let requests = 0;

async function overview() {
  const root = join(homedir(), '.claude', 'projects');
  let projects = 0;
  let sessions = 0;
  let last = 0;
  for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    projects++;
    for (const f of await readdir(join(root, dir.name)).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      sessions++;
      const s = await stat(join(root, dir.name, f)).catch(() => null);
      if (s && s.mtimeMs > last) last = s.mtimeMs;
    }
  }
  return {
    projects,
    sessions,
    lastActivity: last ? new Date(last).toISOString() : null,
    generatedAt: new Date().toISOString(),
    startedAt,
    requests,
  };
}

// Visão mais rica para o painel: sessões recentes com um estado estimado pela
// última escrita no transcript, atividade por hora (12 h) e projetos mais usados.
const ACTIVE_MS = 2 * 60_000;
const IDLE_MS = 30 * 60_000;
const label = (dir) => dir.replace(/^-Users-[^-]+(-[^-]+)?-/, '').replace(/^Workspace-/, '').replace(/--claude-worktrees-/, ' · ').replace(/^ssh-([0-9a-f]{8}).*$/, 'remota · $1');

async function fleet() {
  const root = join(homedir(), '.claude', 'projects');
  const now = Date.now();
  const files = [];
  const perProject = new Map();
  for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    for (const f of await readdir(join(root, dir.name)).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      const s = await stat(join(root, dir.name, f)).catch(() => null);
      if (!s) continue;
      files.push({ project: label(dir.name), id: f.replace(/\.jsonl$/, ''), mtime: s.mtimeMs, size: s.size });
      perProject.set(label(dir.name), (perProject.get(label(dir.name)) ?? 0) + 1);
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const state = (m) => (now - m < ACTIVE_MS ? 'ativa' : now - m < IDLE_MS ? 'ociosa' : 'encerrada');
  const hours = Array.from({ length: 12 }, (_, i) => files.filter((f) => {
    const age = now - f.mtime;
    return age >= (11 - i) * 3_600_000 && age < (12 - i) * 3_600_000;
  }).length);
  return {
    totals: {
      projects: perProject.size,
      sessions: files.length,
      active: files.filter((f) => state(f.mtime) === 'ativa').length,
      idle: files.filter((f) => state(f.mtime) === 'ociosa').length,
      sizeMb: Math.round(files.reduce((n, f) => n + f.size, 0) / 1_048_576),
    },
    recent: files.slice(0, 12).map((f) => ({ ...f, state: state(f.mtime), lastActivity: new Date(f.mtime).toISOString(), sizeKb: Math.round(f.size / 1024) })),
    activityByHour: hours,
    topProjects: [...perProject].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([project, sessions]) => ({ project, sessions })),
    generatedAt: new Date().toISOString(),
  };
}

async function uiHtml() {
  const app = await readFile(join(here, 'node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js'), 'utf8');
  const page = await readFile(join(here, 'ui.html'), 'utf8');
  return page.replace('/*APP_BUNDLE*/', () => app.replace(/export\{[^}]*\};?\s*$/, '') + '\nwindow.__App = OO;');
}

// Issues do GitHub em que a pessoa está envolvida, com o estado de execução:
// PR ligado (rascunho, aberto, mergeado) e o resultado do CI. Usa o `gh` já
// autenticado na máquina; o resultado fica 60 s em cache.
const ISSUES_TTL_MS = 60_000;
let issuesCache = { at: 0, data: null };
const ISSUES_QUERY = `query($q: String!) { search(query: $q, type: ISSUE, first: 40) {
  issueCount
  nodes { ... on Issue { number title url updatedAt createdAt repository { nameWithOwner }
    labels(first: 4) { nodes { name } } assignees(first: 3) { nodes { login } }
    closedByPullRequestsReferences(first: 3, includeClosedPrs: true) { nodes { number state isDraft url reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } } } }`;

function stageOf(prs) {
  const open = prs.filter((p) => p.state === 'OPEN');
  if (prs.some((p) => p.state === 'MERGED')) return 'mergeado';
  if (!open.length) return 'a fazer';
  const p = open[0];
  if (p.isDraft) return 'em andamento';
  if (p.ci === 'FAILURE' || p.ci === 'ERROR') return 'ci falhou';
  if (p.ci === 'PENDING' || p.ci === 'EXPECTED') return 'ci rodando';
  if (p.review === 'CHANGES_REQUESTED') return 'ajustes pedidos';
  return 'em revisão';
}

async function issues() {
  if (issuesCache.data && Date.now() - issuesCache.at < ISSUES_TTL_MS) return issuesCache.data;
  let search;
  try {
    search = (await gh(['-f', `query=${ISSUES_QUERY}`, '-f', 'q=is:issue is:open involves:@me sort:updated-desc'])).search;
  } catch (err) {
    if (issuesCache.data) return { ...issuesCache.data, stale: true, staleReason: err.message };
    throw err;
  }
  const items = search.nodes.map((n) => {
    const prs = n.closedByPullRequestsReferences.nodes.map((p) => ({
      number: p.number, state: p.state, isDraft: p.isDraft, url: p.url, review: p.reviewDecision,
      ci: p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    }));
    return {
      repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url, updatedAt: n.updatedAt,
      labels: n.labels.nodes.map((l) => l.name), assignees: n.assignees.nodes.map((a) => a.login), prs, stage: stageOf(prs),
    };
  });
  const byStage = {};
  for (const i of items) byStage[i.stage] = (byStage[i.stage] ?? 0) + 1;
  issuesCache = { at: Date.now(), data: { total: search.issueCount, shown: items.length, byStage, items, generatedAt: new Date().toISOString() } };
  return issuesCache.data;
}

// Hierarquia do trabalho: Iniciativa → Épico → História/Tarefa → Plano, montada a
// partir do tipo de issue e das sub-issues do GitHub. Parte das issues abertas em que
// a pessoa está envolvida e sobe até os pais e desce até as filhas.
const WORK_TTL_MS = 3 * 60_000;
let workCache = { at: 0, data: null };
const NODE_FIELDS = `number title url state updatedAt repository { nameWithOwner } issueType { name }
  subIssuesSummary { total completed percentCompleted } assignees(first: 2) { nodes { login } } labels(first: 4) { nodes { name } }
  closedByPullRequestsReferences(first: 2, includeClosedPrs: true) { nodes { number state isDraft url reviewDecision
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }`;
const WORK_QUERY = `query($q: String!) { search(query: $q, type: ISSUE, first: 50) { issueCount nodes { ... on Issue {
  ${NODE_FIELDS}
  parent { ${NODE_FIELDS} parent { ${NODE_FIELDS} parent { ${NODE_FIELDS} } } }
  subIssues(first: 25) { nodes { ${NODE_FIELDS} subIssues(first: 15) { nodes { ${NODE_FIELDS} } } } }
} } } }`;
const TYPE_RANK = { Initiative: 0, Epic: 1, 'Epic / Milestone': 1, Milestone: 1, 'User Story': 2, Story: 2, Feature: 2, Task: 3, 'Tech Task': 3, Spike: 3, Bug: 3, Plan: 4 };

function toNode(n) {
  const prs = n.closedByPullRequestsReferences.nodes.map((p) => ({
    number: p.number, state: p.state, isDraft: p.isDraft, url: p.url, review: p.reviewDecision,
    ci: p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
  }));
  const type = n.issueType?.name ?? null;
  return {
    key: `${n.repository.nameWithOwner}#${n.number}`, repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url,
    state: n.state, updatedAt: n.updatedAt, type, rank: TYPE_RANK[type] ?? 3,
    progress: n.subIssuesSummary?.total ? { total: n.subIssuesSummary.total, completed: n.subIssuesSummary.completed, pct: n.subIssuesSummary.percentCompleted } : null,
    assignees: n.assignees.nodes.map((a) => a.login), labels: n.labels.nodes.map((l) => l.name), prs,
    stage: n.state === 'CLOSED' ? 'concluída' : stageOf(prs), parent: null, children: [],
  };
}

async function work() {
  if (workCache.data && Date.now() - workCache.at < WORK_TTL_MS) return workCache.data;
  let searchData;
  try {
    searchData = await gh(['-f', `query=${WORK_QUERY}`, '-f', 'q=is:issue is:open involves:@me sort:updated-desc']);
  } catch (err) {
    if (workCache.data) return { ...workCache.data, stale: true, staleReason: err.message };
    throw err;
  }
  const nodes = new Map();
  const add = (raw) => {
    const node = toNode(raw);
    if (!nodes.has(node.key)) nodes.set(node.key, node);
    return nodes.get(node.key);
  };
  const link = (child, parent) => {
    if (child.parent) return;
    child.parent = parent.key;
    if (!parent.children.includes(child.key)) parent.children.push(child.key);
  };
  const walkUp = (raw) => {
    const node = add(raw);
    if (raw.parent) link(node, walkUp(raw.parent));
    return node;
  };
  const walkDown = (raw, node) => {
    for (const c of raw.subIssues?.nodes ?? []) {
      const child = add(c);
      link(child, node);
      walkDown(c, child);
    }
  };
  for (const raw of searchData.search.nodes) walkDown(raw, walkUp(raw));
  const byRank = (a, b) => a.rank - b.rank || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  for (const n of nodes.values()) n.children.sort((a, b) => byRank(nodes.get(a), nodes.get(b)));
  const roots = [...nodes.values()].filter((n) => !n.parent).sort(byRank).map((n) => n.key);
  const byType = {};
  for (const n of nodes.values()) byType[n.type ?? 'Sem tipo'] = (byType[n.type ?? 'Sem tipo'] ?? 0) + 1;
  workCache = { at: Date.now(), data: { nodes: Object.fromEntries(nodes), roots, byType, count: nodes.size, generatedAt: new Date().toISOString() } };
  void saveCache('work', workCache);
  return workCache.data;
}

// GitHub Projects: os mesmos projetos, abas (views), filtros e colunas de Status que
// a pessoa vê no GitHub. As organizações vêm de AHRENA_CONSOLE_ORGS (separadas por vírgula).
const PROJECT_ORGS = (process.env.AHRENA_CONSOLE_ORGS ?? 'ahrenatechnology,barte-ai-services').split(',').map((s) => s.trim()).filter(Boolean);
const PROJECTS_TTL_MS = 5 * 60_000;
let projectsCache = { at: 0, data: null };
let lastProjectsError = null;
const projectItemsCache = new Map();
const GH_COLOR = { GRAY: '#8c8c8c', BLUE: '#3987e5', GREEN: '#1baf7a', YELLOW: '#ffc30a', ORANGE: '#f47720', RED: '#e34948', PINK: '#df285d', PURPLE: '#9085e9' };

// Cache em disco: o que veio do GitHub sobrevive a reinícios do núcleo, que antes
// zeravam tudo e faziam o núcleo bater no GitHub de novo (e estourar o limite).
const CACHE_DIR = join(homedir(), 'Library', 'Caches', 'ahrena-console');
async function saveCache(name, value) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(CACHE_DIR, { recursive: true }).catch(() => null);
  await writeFile(join(CACHE_DIR, `${name}.json`), JSON.stringify(value)).catch(() => null);
}
async function loadCache(name) {
  try { return JSON.parse(await readFile(join(CACHE_DIR, `${name}.json`), 'utf8')); } catch { return null; }
}

// Quando o GitHub limita (rate limit), o núcleo para de chamar por alguns minutos e
// serve o último dado bom. Toda chamada ao GitHub passa por aqui.
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
let ghBlockedUntil = 0;
async function gh(args) {
  if (Date.now() < ghBlockedUntil) throw new Error(`GitHub limitou as chamadas; nova tentativa em ${Math.ceil((ghBlockedUntil - Date.now()) / 60_000)} min`);
  const { execFile } = await import('node:child_process');
  const out = await new Promise((resolve, reject) =>
    execFile('/opt/homebrew/bin/gh', ['api', 'graphql', '-H', 'GraphQL-Features: sub_issues,issue_types', ...args], { timeout: 45_000, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const msg = (stderr || err.message || '').trim();
      if (/rate limit/i.test(msg)) ghBlockedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      reject(new Error(msg.split('\n')[0] || 'falha no gh'));
    }),
  );
  const json = JSON.parse(out);
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function projects() {
  if (projectsCache.data && Date.now() - projectsCache.at < PROJECTS_TTL_MS) return projectsCache.data;
  const list = [];
  for (const org of PROJECT_ORGS) {
    const data = await gh(['-f', `query=query($org: String!) { organization(login: $org) { projectsV2(first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes {
      number title closed url updatedAt items { totalCount }
      views(first: 20) { nodes { name number layout filter
        groupByFields(first: 1) { nodes { ... on ProjectV2FieldCommon { name } } }
        verticalGroupByFields(first: 1) { nodes { ... on ProjectV2FieldCommon { name } } } } }
      fields(first: 40) { nodes { ... on ProjectV2SingleSelectField { name options { name color } } } }
    } } } }`, '-f', `org=${org}`]).catch((err) => { lastProjectsError = err.message; return null; });
    for (const p of data?.organization?.projectsV2?.nodes ?? []) {
      if (p.closed) continue;
      const selects = {};
      for (const fl of p.fields.nodes) if (fl?.options) selects[fl.name] = fl.options.map((o) => ({ name: o.name, color: GH_COLOR[o.color] ?? GH_COLOR.GRAY }));
      list.push({
        id: `${org}/${p.number}`, org, number: p.number, title: p.title, url: p.url, updatedAt: p.updatedAt, itemCount: p.items.totalCount,
        views: p.views.nodes.map((v) => ({
          number: v.number, name: v.name, layout: v.layout === 'BOARD_LAYOUT' ? 'board' : v.layout === 'ROADMAP_LAYOUT' ? 'roadmap' : 'table',
          filter: v.filter ?? '', groupBy: v.groupByFields.nodes[0]?.name ?? null, columnsBy: v.verticalGroupByFields.nodes[0]?.name ?? null,
        })),
        selects,
      });
    }
  }
  if (!list.length && projectsCache.data) return { ...projectsCache.data, stale: true, staleReason: lastProjectsError };
  if (!list.length && lastProjectsError) throw new Error(lastProjectsError);
  projectsCache = { at: Date.now(), data: { projects: list, generatedAt: new Date().toISOString() } };
  void saveCache('projects', projectsCache);
  return projectsCache.data;
}

const ITEM_CONTENT = `
  ... on Issue { __typename number title url state updatedAt repository { nameWithOwner } issueType { name } milestone { title }
    assignees(first: 3) { nodes { login } } labels(first: 8) { nodes { name } } parent { number title }
    subIssuesSummary { total completed percentCompleted }
    closedByPullRequestsReferences(first: 2, includeClosedPrs: true) { nodes { number state isDraft url reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }
  ... on PullRequest { __typename number title url state isDraft updatedAt reviewDecision repository { nameWithOwner } milestone { title }
    assignees(first: 3) { nodes { login } } labels(first: 8) { nodes { name } } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
  ... on DraftIssue { __typename title updatedAt }`;

async function projectItems(org, number) {
  const key = `${org}/${number}`;
  const hit = projectItemsCache.get(key);
  if (hit) {
    if (Date.now() - hit.at >= PROJECTS_TTL_MS && !hit.refreshing) {
      hit.refreshing = true;
      fetchProjectItems(org, number).catch(() => { hit.refreshing = false; });
    }
    return hit.data;
  }
  return fetchProjectItems(org, number);
}

async function fetchProjectItems(org, number) {
  const key = `${org}/${number}`;
  try {
    return await fetchProjectItemsNow(org, number);
  } catch (err) {
    const old = projectItemsCache.get(key);
    if (old) { old.refreshing = false; return { ...old.data, stale: true, staleReason: err.message }; }
    throw err;
  }
}

async function fetchProjectItemsNow(org, number) {
  const key = `${org}/${number}`;
  const items = [];
  let after = null;
  for (let page = 0; page < 12; page++) {
    const data = await gh(['-f', `query=query($org: String!, $n: Int!, $after: String) { organization(login: $org) { projectV2(number: $n) { items(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id isArchived fieldValues(first: 20) { nodes {
        ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } } } }
        content { ${ITEM_CONTENT} } } } } } }`, '-f', `org=${org}`, '-F', `n=${number}`, ...(after ? ['-f', `after=${after}`] : [])]);
    const conn = data.organization.projectV2.items;
    for (const it of conn.nodes) {
      if (it.isArchived || !it.content) continue;
      const c = it.content;
      const fields = {};
      for (const fv of it.fieldValues.nodes) if (fv?.field?.name) fields[fv.field.name] = fv.name ?? fv.date ?? fv.text ?? fv.title ?? null;
      const prs = c.__typename === 'Issue'
        ? c.closedByPullRequestsReferences.nodes.map((p) => ({ number: p.number, state: p.state, isDraft: p.isDraft, url: p.url, review: p.reviewDecision, ci: p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null }))
        : c.__typename === 'PullRequest'
          ? [{ number: c.number, state: c.state, isDraft: c.isDraft, url: c.url, review: c.reviewDecision, ci: c.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null }]
          : [];
      items.push({
        id: it.id, kind: c.__typename, number: c.number ?? null, title: c.title, url: c.url ?? null, state: c.state ?? 'OPEN', updatedAt: c.updatedAt,
        repo: c.repository?.nameWithOwner ?? null, type: c.issueType?.name ?? (c.__typename === 'PullRequest' ? 'Pull request' : c.__typename === 'DraftIssue' ? 'Rascunho' : null),
        milestone: c.milestone?.title ?? null, assignees: (c.assignees?.nodes ?? []).map((a) => a.login), labels: (c.labels?.nodes ?? []).map((l) => l.name),
        parent: c.parent ? `#${c.parent.number} ${c.parent.title}` : null,
        progress: c.subIssuesSummary?.total ? { total: c.subIssuesSummary.total, completed: c.subIssuesSummary.completed, pct: c.subIssuesSummary.percentCompleted } : null,
        prs, fields,
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    await new Promise((r) => setTimeout(r, 400));
  }
  const data = { id: key, items, generatedAt: new Date().toISOString() };
  projectItemsCache.set(key, { at: Date.now(), data });
  void saveCache(`project-${key.replace('/', '-')}`, { at: Date.now(), data });
  return data;
}

// Cada chamada de ferramenta vai para um log próprio: o log do Claude Desktop não
// registra as chamadas que chegam pela ponte dos artefatos.
const CALL_LOG = join(homedir(), 'Library', 'Logs', 'ahrena-console', 'mcp-calls.log');
async function logCall(tool, mode) {
  const { mkdir, appendFile } = await import('node:fs/promises');
  await mkdir(dirname(CALL_LOG), { recursive: true });
  await appendFile(CALL_LOG, `${new Date().toISOString()} ${mode} ${tool}\n`);
}
const MODE = process.argv.includes('--stdio') ? 'stdio' : 'http';

function buildMcp() {
  const server = new McpServer({ name: 'ahrena-console', version: '0.0.2-teste' });
  const json = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }], structuredContent: o });

  server.registerTool(
    'fleet_overview',
    {
      title: 'Visão geral das sessões',
      description: 'Contagem de projetos e sessões do Claude Code nesta máquina e a última atividade.',
      annotations: { readOnlyHint: true },
    },
    async () => { await logCall('fleet_overview', MODE); return json(await overview()); },
  );

  server.registerTool(
    'open_console',
    {
      title: 'Abrir o Ahrena Console',
      description: 'Abre a visão do Ahrena Console (teste de UI inline).',
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: UI_URI }, 'ui/resourceUri': UI_URI },
    },
    async () => { await logCall('open_console', MODE); return json(await overview()); },
  );

  server.registerResource(
    'Ahrena Console (teste)',
    UI_URI,
    { mimeType: UI_MIME, description: 'UI de teste do Ahrena Console' },
    async () => ({ contents: [{ uri: UI_URI, mimeType: UI_MIME, text: await uiHtml() }] }),
  );
  return server;
}

// --stdio: o mesmo servidor MCP por stdio, para o Claude Desktop (claude_desktop_config.json).
if (process.argv.includes('--stdio')) {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await buildMcp().connect(new StdioServerTransport());
  console.error('ahrena-console (teste) em stdio');
} else startHttp();

function startHttp() {
const http = createServer(async (req, res) => {
  requests++;
  console.log(new Date().toISOString(), req.method, req.url, req.headers['user-agent'] ?? '');
  try {
    if (req.url === '/api/projects') {
      const body = JSON.stringify(await projects());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    const pm = req.url?.match(/^\/api\/project\/([^/]+)\/(\d+)$/);
    if (pm) {
      const body = JSON.stringify(await projectItems(decodeURIComponent(pm[1]), Number(pm[2])));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.url === '/api/work') {
      const body = JSON.stringify(await work());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.url === '/api/issues') {
      const body = JSON.stringify(await issues());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.url === '/api/fleet') {
      const body = JSON.stringify(await fleet());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.url === '/api/overview') {
      const body = JSON.stringify(await overview());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.url?.startsWith('/mcp')) {
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const msg = JSON.parse(body);
          for (const m of Array.isArray(msg) ? msg : [msg]) {
            console.log('  mcp>', m.method ?? 'resposta', m.method === 'initialize' ? JSON.stringify(m.params?.capabilities) : (m.params?.uri ?? m.params?.name ?? ''));
          }
        } catch {}
        req.body = body ? JSON.parse(body) : undefined;
      }
      const server = buildMcp();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.url === '/' || req.url === '/ui') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await uiHtml());
      return;
    }
    res.writeHead(404).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err?.message ?? err) }));
  }
});

const restore = async () => {
  const w = await loadCache('work');
  if (w?.data) workCache = w;
  const pr = await loadCache('projects');
  if (pr?.data) {
    projectsCache = pr;
    for (const p of pr.data.projects) {
      const it = await loadCache(`project-${p.org}-${p.number}`);
      if (it?.data) projectItemsCache.set(`${p.org}/${p.number}`, it);
    }
  }
};
const warm = async () => {
  try {
    const { projects: list } = await projects();
    for (const p of list) await projectItems(p.org, p.number).catch(() => null);
    await work().catch(() => null);
  } catch {}
};
// Sem aquecimento automático: o núcleo só chama o GitHub quando o painel pede.
void restore();
void warm;
http.listen(PORT, HOST, () => console.log(`ahrena-console (teste) em http://${HOST}:${PORT}  MCP: /mcp  API: /api/overview`));
}
