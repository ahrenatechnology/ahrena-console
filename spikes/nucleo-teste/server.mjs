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
  const { execFile } = await import('node:child_process');
  const out = await new Promise((resolve, reject) =>
    execFile('/opt/homebrew/bin/gh', ['api', 'graphql', '-f', `query=${ISSUES_QUERY}`, '-f', 'q=is:issue is:open involves:@me sort:updated-desc'], { timeout: 20_000, maxBuffer: 8 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );
  const search = JSON.parse(out).data.search;
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
const WORK_TTL_MS = 60_000;
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
  const { execFile } = await import('node:child_process');
  const out = await new Promise((resolve, reject) =>
    execFile('/opt/homebrew/bin/gh', ['api', 'graphql', '-H', 'GraphQL-Features: sub_issues,issue_types', '-f', `query=${WORK_QUERY}`, '-f', 'q=is:issue is:open involves:@me sort:updated-desc'], { timeout: 30_000, maxBuffer: 16 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );
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
  for (const raw of JSON.parse(out).data.search.nodes) walkDown(raw, walkUp(raw));
  const byRank = (a, b) => a.rank - b.rank || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  for (const n of nodes.values()) n.children.sort((a, b) => byRank(nodes.get(a), nodes.get(b)));
  const roots = [...nodes.values()].filter((n) => !n.parent).sort(byRank).map((n) => n.key);
  const byType = {};
  for (const n of nodes.values()) byType[n.type ?? 'Sem tipo'] = (byType[n.type ?? 'Sem tipo'] ?? 0) + 1;
  workCache = { at: Date.now(), data: { nodes: Object.fromEntries(nodes), roots, byType, count: nodes.size, generatedAt: new Date().toISOString() } };
  return workCache.data;
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
    if (req.url === '/api/work') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await work()));
      return;
    }
    if (req.url === '/api/issues') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await issues()));
      return;
    }
    if (req.url === '/api/fleet') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await fleet()));
      return;
    }
    if (req.url === '/api/overview') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(await overview()));
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
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

http.listen(PORT, HOST, () => console.log(`ahrena-console (teste) em http://${HOST}:${PORT}  MCP: /mcp  API: /api/overview`));
}
