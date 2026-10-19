// Núcleo de teste do Ahrena Console: só para as validações da proposta 0.0.1.
// Expõe o mesmo dado de três jeitos: GET /api/overview e /api/sessao/<id> (para o mod), MCP em /mcp
// (ferramentas e artefato) e uma MCP App em ui://ahrena-console/teste.html. O kanban
// do Project (GET /api/kanban, POST /api/kanban/move) usa o núcleo de packages/nucleo.
// Lê só nomes e datas dos arquivos em ~/.claude/projects, nunca o conteúdo.
import { createServer } from 'node:http';
import { readdir, stat, readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createGithubProject, GithubCache, MemoryCacheStore, ProjectPermissionError, RateLimitedError } from '../../packages/nucleo/src/index.ts';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = Number(process.env.AHRENA_CONSOLE_PORT ?? 4720);
const HOST = '127.0.0.1';
const UI_URI = 'ui://ahrena-console/teste.html';
const UI_MIME = 'text/html;profile=mcp-app';
const here = dirname(fileURLToPath(import.meta.url));
const startedAt = new Date().toISOString();
let requests = 0;

// Índice dos transcripts de ~/.claude/projects, em memória (issue #81): a primeira
// leitura varre tudo uma vez; depois o fs.watch atualiza só o arquivo que mudou. Sem
// watch (sistema que não suporta), uma nova varredura a cada RESCAN_MS, uma por vez
// mesmo com pedidos simultâneos. Antes cada pedido varria os ~1.900 arquivos (~80 ms de CPU).
const ROOT = join(homedir(), '.claude', 'projects');
const RESCAN_MS = 15_000;
// Rede de segurança contra eventos perdidos do watch: varredura de fundo, só quando alguém pede.
const SAFETY_RESCAN_MS = 10 * 60_000;
const FLUSH_MS = 500;
const index = new Map(); // "dir/arquivo.jsonl" → { dir, id, mtime, size }
let firstScan = null;
let rescan = null;
let scannedAt = 0;
let watcher = null;
const pending = new Set();
let flushTimer = null;

async function fullScan() {
  const next = new Map();
  for (const dir of await readdir(ROOT, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    for (const f of await readdir(join(ROOT, dir.name)).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      const s = await stat(join(ROOT, dir.name, f)).catch(() => null);
      if (s) next.set(`${dir.name}/${f}`, { dir: dir.name, id: f.replace(/\.jsonl$/, ''), mtime: s.mtimeMs, size: s.size });
    }
  }
  index.clear();
  for (const [k, v] of next) index.set(k, v);
  scannedAt = Date.now();
  summaryMemo = null;
}

function scanOnce() {
  rescan ??= fullScan().finally(() => { rescan = null; });
  return rescan;
}

// Só os transcripts do primeiro nível de cada projeto, como a varredura (subagentes ficam fora).
async function flush() {
  flushTimer = null;
  const names = [...pending];
  pending.clear();
  for (const name of names) {
    const [dir, f, ...rest] = name.split(/[\\/]/);
    if (!f || rest.length || !f.endsWith('.jsonl')) continue;
    const s = await stat(join(ROOT, dir, f)).catch(() => null);
    if (s) index.set(`${dir}/${f}`, { dir, id: f.replace(/\.jsonl$/, ''), mtime: s.mtimeMs, size: s.size });
    else index.delete(`${dir}/${f}`);
  }
  if (names.length) summaryMemo = null;
}

function startWatch() {
  try {
    watcher = watch(ROOT, { recursive: true, persistent: false }, (_event, name) => {
      if (!name || !String(name).endsWith('.jsonl')) return;
      pending.add(String(name));
      flushTimer ??= setTimeout(() => void flush(), FLUSH_MS);
    });
    watcher.on('error', () => { watcher?.close(); watcher = null; });
  } catch {
    watcher = null;
  }
}

async function transcripts() {
  if (!firstScan) firstScan = scanOnce().then(startWatch);
  await firstScan;
  if (!watcher && Date.now() - scannedAt > RESCAN_MS) await scanOnce();
  else if (Date.now() - scannedAt > SAFETY_RESCAN_MS) void scanOnce();
  return index;
}

async function overview() {
  const files = [...(await transcripts()).values()];
  const last = files.reduce((m, f) => Math.max(m, f.mtime), 0);
  return {
    projects: new Set(files.map((f) => f.dir)).size,
    sessions: files.length,
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
const stateAt = (now, m) => (now - m < ACTIVE_MS ? 'ativa' : now - m < IDLE_MS ? 'ociosa' : 'encerrada');
const rowOf = (f, now) => ({ project: label(f.dir), id: f.id, mtime: f.mtime, size: f.size, state: stateAt(now, f.mtime), lastActivity: new Date(f.mtime).toISOString(), sizeKb: Math.round(f.size / 1024) });

async function fleet() {
  const now = Date.now();
  const files = [...(await transcripts()).values()].map((f) => ({ project: label(f.dir), id: f.id, mtime: f.mtime, size: f.size }));
  const perProject = new Map();
  for (const f of files) perProject.set(f.project, (perProject.get(f.project) ?? 0) + 1);
  files.sort((a, b) => b.mtime - a.mtime);
  const state = (m) => stateAt(now, m);
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

// O que o painel pede a cada 5 s (decisão 0004): a própria sessão e quantas precisam
// de você, nunca a frota. "Precisa de você" aqui é uma estimativa: sessão que parou de
// escrever há pouco (ociosa), à espera da próxima mensagem. O estado de verdade vem dos
// hooks (1.4) quando o painel por sessão (4.1) chegar. O resumo vale SUMMARY_MS.
const SUMMARY_MS = 2000;
let summaryMemo = null;
async function summary() {
  const files = await transcripts();
  const now = Date.now();
  if (summaryMemo && now - summaryMemo.at < SUMMARY_MS) return summaryMemo;
  const byId = new Map();
  const waiting = new Set();
  for (const f of files.values()) {
    byId.set(f.id, f);
    if (stateAt(now, f.mtime) === 'ociosa') waiting.add(f.id);
  }
  summaryMemo = { at: now, byId, waiting };
  return summaryMemo;
}

async function sessionView(id) {
  const { at, byId, waiting } = await summary();
  const f = byId.get(id);
  const { mtime, size, ...session } = f ? rowOf(f, at) : {};
  return {
    session: f ? session : null,
    needsYou: waiting.size - (waiting.has(id) ? 1 : 0),
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
// Consulta enxuta: o GitHub cobra pelo número de nós, e a versão anterior (3 níveis de
// pais, 25 filhas e 15 netas por issue) estourava o limite. Netas entram pelos pais delas.
const WORK_QUERY = `query($q: String!) { search(query: $q, type: ISSUE, first: 30) { issueCount nodes { ... on Issue {
  ${NODE_FIELDS}
  parent { ${NODE_FIELDS} parent { ${NODE_FIELDS} } }
  subIssues(first: 15) { nodes { ${NODE_FIELDS} } }
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
const PROJECT_ORGS = (process.env.AHRENA_CONSOLE_ORGS ?? 'ahrenatechnology').split(',').map((s) => s.trim()).filter(Boolean);
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
const RATE_LIMIT_BACKOFF_MS = 2 * 60_000;
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

// Kanban do próprio projeto (item 5.3): o GitHub Project por Status, pelas funções do
// núcleo (decisão 0001: custo 1 por 100 itens, TTL de 2 min, mover sem reler).
// Qual Project: AHRENA_CONSOLE_PROJECT=dono/número; o padrão é o deste repositório.
const [KANBAN_OWNER, KANBAN_NUMBER] = (process.env.AHRENA_CONSOLE_PROJECT ?? 'ahrenatechnology/3').split('/');
const kanban = createGithubProject({
  project: { owner: KANBAN_OWNER, number: Number(KANBAN_NUMBER) },
  cache: new GithubCache({ store: new MemoryCacheStore() }),
  onCost: (c) => console.log(`  github> ${c.operation} custo ${c.cost}, restam ${c.remaining}`),
});
const statusOf = (err) => (err instanceof ProjectPermissionError ? 403 : err instanceof RateLimitedError ? 429 : 502);

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
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
    if (req.url?.startsWith('/api/kanban')) {
      const sendJson = (status, o) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      try {
        if (req.method === 'POST' && req.url === '/api/kanban/move') {
          const { itemId, optionId } = await readBody(req);
          if (!itemId || !optionId) return sendJson(400, { error: 'informe itemId e optionId' });
          return sendJson(200, await kanban.move(itemId, optionId));
        }
        if (req.method === 'GET') return sendJson(200, await kanban.board({ force: req.url.includes('force=1') }));
        return sendJson(405, { error: 'método não suportado' });
      } catch (err) {
        return sendJson(statusOf(err), { error: String(err?.message ?? err) });
      }
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
    const sm = req.url?.match(/^\/api\/sessao\/([^/?]+)/);
    if (sm) {
      const body = JSON.stringify(await sessionView(decodeURIComponent(sm[1])));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    if (req.url?.startsWith('/api/fleet')) {
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
