// A aba Instruções de um repositório (C32 e C33, issue 183): o que um agente herda ao trabalhar nele.
// A tela Repositório (repo.js) monta o cabeçalho e as abas; esta monta o conteúdo da aba em
// `/ui/repos/<owner>/<repo>/instructions`.
//
// - Lê `GET /api/agent-instructions/<owner>/<repo>` (src/agent-instructions/model.ts). A rota nunca
//   espera o GitHub: com `state: 'loading'`, a tela espera a mudança ao vivo
//   `{ type: 'agent-instructions', key: '<owner>/<repo>' }` (e relê a cada 5 s, se ela não vier).
// - Cada arquivo abre por `…/file?path=`, renderizado como Markdown (agent-instructions-markdown.js),
//   com os `@imports` abertos no lugar; "Markdown" mostra o texto como está.
// - Dos hooks, só o evento, o matcher e a quantidade: o núcleo nem manda o comando.
// - A busca procura no texto dos arquivos deste repositório (e dos imports deles), na tela.
// - O texto do repositório é dado: entra por `textContent`, nunca como HTML.
// - Instalar o Ahrena Framework (C34 a C37, issue 184): lê também o plano de instalação
//   (`GET /api/framework-install/<owner>/<repo>/plan`, framework-install.js). Sem o framework, o card
//   "Sem Ahrena Framework" fica no topo, e "Instalar" troca o conteúdo da aba pelo fluxo em três passos.

import { el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { ago, NO_GITHUB } from '../repos-format.js';
import { blobUrl, IMPORT_ICON, IMPORT_STATUS, renderMarkdown } from './agent-instructions-markdown.js';
import { canInstall, installCard, installChangeMatters, installEmptyButton, loadInstallStyle, mountInstallFlow, planRoute } from './framework-install.js';
import { connectEmptyFor, connectionChanged, isGithubNotConnected } from '../github-connect.js';

const REREAD_MS = 5000;
const SEARCH_MIN = 2;
const SEARCH_MAX = 60;
const HOW_TO_CLAUDE_MD = 'https://docs.claude.com/en/docs/claude-code/memory';

export function loadInstructionsStyle() {
  if (!document.querySelector('link[data-screen="agent-instructions"]')) document.head.append(el('link', { rel: 'stylesheet', href: '/ui/screens/agent-instructions.css', 'data-screen': 'agent-instructions' }));
}

/** A mudança ao vivo diz respeito a este repositório. */
export const instructionsChangeMatters = (changes, key) => (changes ?? []).some((c) => c?.type === 'agent-instructions' && String(c.key).toLowerCase() === key.toLowerCase());

const ROOT_ORDER = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md'];
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

/** Os arquivos na ordem da lista: os da raiz primeiro, depois as subpastas, agrupadas por pasta. */
export function fileGroups(files) {
  const roots = files.filter((f) => f.kind.endsWith('-root')).sort((a, b) => ROOT_ORDER.indexOf(a.path) - ROOT_ORDER.indexOf(b.path));
  const folders = new Map();
  for (const f of files.filter((x) => !x.kind.endsWith('-root')).sort((a, b) => a.folder.localeCompare(b.folder) || b.kind.localeCompare(a.kind))) {
    if (!folders.has(f.folder)) folders.set(f.folder, []);
    folders.get(f.folder).push(f);
  }
  return { roots, folders: [...folders].map(([folder, list]) => ({ folder, files: list })) };
}

const imported = (f) => (f.importedBy.length ? `importado pelo ${f.importedBy.join(', ')}` : null);

/** Quem lê o arquivo, como o cabeçalho do visor diz (C32). */
export function fileRole(f) {
  switch (f.kind) {
    case 'claude-root':
      return 'raiz · carregado em toda sessão do Claude Code';
    case 'agents-root':
      return `raiz · ${imported(f) ?? 'lido pelos agentes da convenção AGENTS.md, como o Codex; nenhum CLAUDE.md o importa'}`;
    case 'claude-nested':
      return `subpasta · carregado quando o Claude Code mexe em ${f.folder}/`;
    default:
      return `subpasta · ${imported(f) ?? `lido pelos agentes da convenção AGENTS.md em ${f.folder}/`}`;
  }
}

/** O texto de cada aviso (C33): `{ icon, tone, name, text }`. */
export function warningLine(w) {
  switch (w.kind) {
    case 'truncated':
      return { icon: 'folder-tree', tone: 'wait', name: 'Árvore', text: 'o GitHub cortou a lista de arquivos: subpastas podem faltar' };
    case 'agents-not-imported':
      return { icon: 'alert', tone: 'wait', name: w.path ?? 'AGENTS.md', text: `nenhum CLAUDE.md importa este ${basename(w.path ?? 'AGENTS.md')}` };
    case 'missing-import':
      return { icon: 'error', tone: 'error', name: `@${w.ref ?? ''}`, text: `não existe no repositório${w.path ? ` (importado por ${w.path})` : ''}` };
    case 'invalid-settings':
      return { icon: 'alert', tone: 'error', name: w.path ?? '.claude/settings.json', text: 'JSON inválido: hooks e plugins não foram lidos' };
    default:
      return { icon: 'alert', tone: 'wait', name: w.path ?? '', text: 'aviso da leitura' };
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Os cards do que `.claude/` traz (C32): `{ id, icon, title, count, rows: [[nome, detalhe]], none }`. */
export function claudeCards(d) {
  const invalid = d.settings === 'invalid';
  return [
    { id: 'rules', icon: 'list-checks', title: 'Regras', count: String(d.rules.length), rows: d.rules.map((r) => [r.name, r.paths.length ? `só em ${r.paths.join(', ')}` : 'todo o repositório']), none: 'Nenhuma regra em .claude/rules/' },
    { id: 'skills', icon: 'bolt', title: 'Skills', count: String(d.skills.length), rows: d.skills.map((s) => [s.name, s.description ?? '']), none: 'Nenhuma skill em .claude/skills/' },
    { id: 'agents', icon: 'bot', title: 'Agentes', count: String(d.agents.length), rows: d.agents.map((a) => [a.name, a.description ?? '']), none: 'Nenhum agente em .claude/agents/' },
    { id: 'commands', icon: 'slash', title: 'Comandos', count: String(d.commands.length), rows: d.commands.map((c) => [c.name, '']), none: 'Nenhum comando em .claude/commands/' },
    {
      id: 'hooks',
      icon: 'webhook',
      title: 'Hooks',
      count: plural(d.hooks.length, 'evento', 'eventos'),
      // Evento, matcher e quantos comandos; o comando nunca.
      rows: d.hooks.map((h) => [h.event, [h.matchers.length ? h.matchers.join(', ') : null, plural(h.count, 'comando', 'comandos')].filter(Boolean).join(' · ')]),
      none: invalid ? 'settings.json inválido: os hooks não foram lidos' : 'Nenhum hook em .claude/settings.json',
    },
    {
      id: 'plugins',
      icon: 'plug',
      title: 'Plugins habilitados',
      count: String(d.plugins.length),
      rows: d.plugins.map((p) => [p.name, p.marketplace ? `@${p.marketplace}` : '']),
      none: invalid ? 'settings.json inválido: os plugins não foram lidos' : 'Nenhum plugin habilitado em .claude/settings.json',
    },
    { id: 'mcp', icon: 'server', title: 'MCP', count: String(d.mcp.length), rows: d.mcp.map((m) => [m, '.mcp.json']), none: 'Nenhum servidor em .mcp.json' },
  ];
}

/** Nada em `.claude/` nem `.mcp.json`. */
const noClaudeFolder = (d) => d.settings === 'none' && !d.rules.length && !d.skills.length && !d.agents.length && !d.commands.length && !d.hooks.length && !d.plugins.length && !d.mcp.length;

/** Sem acento e sem caixa, para a busca. */
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * As linhas que casam com a busca num arquivo aberto e nos imports dele: `[{ path, via, line, text }]`.
 * `via`: os `@ref` do arquivo aberto até o import onde a linha está (vazio no próprio arquivo), para
 * abrir em sequência os blocos ancestrais.
 */
export function searchFile(view, query) {
  const q = fold(query);
  const out = [];
  const seen = new Set();
  const visit = (path, text, via) => {
    if (seen.has(path) || typeof text !== 'string') return;
    seen.add(path);
    text.split('\n').forEach((t, k) => {
      if (fold(t).includes(q)) out.push({ path, via, line: k + 1, text: t });
    });
  };
  visit(view.path, view.text, []);
  const walk = (node, via) => {
    for (const n of node.imports ?? []) {
      const chain = [...via, n.ref];
      if (n.status === 'ok' && n.path) visit(n.path, n.text, chain);
      walk(n, chain);
    }
  };
  walk(view.tree ?? {}, []);
  return out;
}

/**
 * O texto dobrado (`fold`) caractere a caractere, com `at[j]`: o índice no original de onde veio o
 * j-ésimo caractere dobrado. Um caractere pode dobrar em zero (acento solto) ou mais caracteres.
 */
export function foldWithMap(text) {
  let folded = '';
  const at = [];
  let i = 0;
  for (const ch of String(text)) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) at.push(i);
    folded += f;
    i += ch.length;
  }
  return { folded, at };
}

/** O trecho com o que casou em `<mark>`, por `textContent`; os índices do texto dobrado voltam ao original pelo mapa. */
export function highlighted(text, query) {
  const { folded, at: origin } = foldWithMap(text);
  const q = fold(query);
  const toOriginal = (j) => (j < origin.length ? origin[j] : text.length);
  const parts = [];
  let at = 0;
  for (let k = q ? folded.indexOf(q) : -1; k >= 0; k = folded.indexOf(q, k + q.length)) {
    const start = toOriginal(k);
    const end = toOriginal(k + q.length);
    if (start > at) parts.push(text.slice(at, start));
    parts.push(el('mark', { class: 'ins-mark' }, text.slice(start, end)));
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

export async function mountInstructions(area, ctx, { owner, name }) {
  loadInstructionsStyle();
  loadInstallStyle();
  const key = `${owner}/${name}`;
  const base = `/api/agent-instructions/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  let data = null;
  let failure = null;
  let timer = null;
  let request = 0;
  let openPath = null;
  let pendingRef = null;
  let mode = 'rendered';
  let query = '';
  let searchTimer = null;
  const views = new Map(); // path → { view } | { failure } | { promise }
  let install = null; // o plano de instalação padrão (issue 184), ou null enquanto não leu / se falhou
  let installTimer = null;
  let installRequest = 0;
  let flow = null; // o fluxo de instalação aberto na aba

  // ---------- as peças fixas ----------
  const band = el('div', { class: 'ins-bands' });
  const warnings = el('div', { class: 'ins-warnings-slot' });
  const input = el('input', { type: 'search', placeholder: 'Buscar nas instruções deste repositório: "inglês", "npm test"…', 'aria-label': 'Buscar nas instruções deste repositório' });
  const readLabel = el('span', { class: 'ins-read' });
  const toolbar = el('div', { class: 'ins-toolbar' }, el('label', { class: 'ins-field' }, icon('search'), input), readLabel);
  const nav = el('nav', { class: 'card ins-nav', 'aria-label': 'Arquivos de instrução e .claude' });
  const viewer = el('section', { class: 'card ins-viewer', 'aria-label': 'Arquivo aberto' });
  const side = el('section', { class: 'ins-side', 'aria-label': 'O que .claude/ traz' });
  const grid = el('div', { class: 'ins-grid' }, nav, el('div', { class: 'ins-main' }, viewer), side);
  const body = el('div', { class: 'ins-body' });
  const root = el('div', { class: 'ins-tab' }, band, body);
  area.replaceChildren(root);

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = input.value.trim();
      drawViewer();
    }, 180);
  });

  // ---------- leitura ----------
  async function read({ refresh = false } = {}) {
    clearTimeout(timer);
    timer = null;
    const n = ++request;
    try {
      const d = await ctx.read(`${base}${refresh ? '?refresh=1' : ''}`);
      if (n !== request) return;
      if (data && d.commit !== data.commit) views.clear();
      data = d;
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError' || n !== request) return;
      failure = e instanceof Error ? e : new Error(String(e));
    }
    draw();
  }

  /** O plano de instalação padrão; falhar não derruba a aba: o card só não aparece. */
  async function readInstall({ refresh = false } = {}) {
    clearTimeout(installTimer);
    installTimer = null;
    const n = ++installRequest;
    try {
      const d = await ctx.read(planRoute(owner, name, null, { refresh }));
      if (n !== installRequest) return;
      // Só um plano de instalação conta (o núcleo sem a rota responde outra coisa ou 404): senão, sem card.
      install = d && (d.state !== 'ready' || typeof d.installed === 'boolean') ? d : null;
      if (d?.state === 'loading') installTimer = setTimeout(() => readInstall(), REREAD_MS);
    } catch (e) {
      if (e?.name === 'AbortError' || n !== installRequest) return;
      install = null;
    }
    if (!flow) draw();
  }

  function openFlow(step = 0) {
    flow?.leave();
    flow = mountInstallFlow(body, ctx, {
      owner,
      name,
      plan: install,
      step,
      onClose: () => {
        flow = null;
        readInstall();
        draw();
      },
    });
  }

  function topCard({ inEmpty = false } = {}) {
    return installCard(install, { onInstall: () => openFlow(0), onFollow: () => openFlow(2), inEmpty });
  }

  function loadFile(path) {
    const hit = views.get(path);
    if (hit) return hit.promise ?? Promise.resolve();
    const promise = ctx
      .read(`${base}/file?path=${encodeURIComponent(path)}`)
      .then((view) => views.set(path, { view }))
      .catch((e) => {
        if (e?.name === 'AbortError') throw e;
        views.set(path, { failure: e instanceof Error ? e : new Error(String(e)) });
      });
    views.set(path, { promise });
    return promise;
  }

  // ---------- desenho ----------
  function draw() {
    clearTimeout(timer);
    timer = null;
    if (flow) return;
    const hasData = data && data.state === 'ready';
    band.replaceChildren();
    if (isGithubNotConnected(failure)) {
      warnings.replaceChildren();
      return body.replaceChildren(connectEmptyFor('instructions', ctx.navigate));
    }
    if (failure && hasData) band.append(errorBand({ title: 'Sem conexão com o núcleo.', text: `${failure.message}. Mostrando a última leitura.`, action: { label: 'Tentar de novo', onClick: () => read() } }));
    else if (hasData && data.error) band.append(errorBand({ title: 'GitHub com problema.', text: `${data.error}. Mostrando a leitura${data.readAt ? ` de ${new Date(data.readAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ' anterior'}.`, action: { label: 'Tentar agora', onClick: () => read({ refresh: true }) } }));
    if (hasData && data.truncated) band.append(truncatedBand());

    if (!hasData) {
      if (failure) return body.replaceChildren(error({ text: failure.message, retry: () => (body.replaceChildren(loading()), read()) }));
      if (!data) return body.replaceChildren(loading());
      if (data.state === 'loading') {
        timer = setTimeout(read, REREAD_MS);
        return body.replaceChildren(loading({ label: 'Lendo o GitHub…' }));
      }
      if (data.state === 'no-github') return body.replaceChildren(empty({ icon: 'github', title: NO_GITHUB.titulo, text: NO_GITHUB.texto }));
      if (data.state === 'not-found') return body.replaceChildren(empty({ icon: 'repos', title: 'Repositório não encontrado', text: `${key} não existe ou a conta do GitHub não tem acesso a ele.` }));
      return body.replaceChildren(error({ title: 'O GitHub não respondeu', text: data.error ?? 'A leitura das instruções falhou.', retry: () => read({ refresh: true }) }));
    }

    readLabel.replaceChildren(icon('clock'), `lido ${ago(data.readAt)}${data.error ? ' · do cache' : ''}`);
    if (data.empty || !data.files.length) {
      // C33: sem nenhuma instrução. Com `.claude/` mas sem CLAUDE.md, os cards ainda aparecem.
      const nodes = [emptyCard()];
      if (!data.empty) nodes.push(drawSide(true));
      warnings.replaceChildren(...warningCard());
      const top = topCard({ inEmpty: true });
      return body.replaceChildren(...(top ? [top] : []), ...(warnings.children.length ? [warnings] : []), ...nodes);
    }
    if (!openPath || !data.files.some((f) => f.path === openPath)) openPath = fileGroups(data.files).roots[0]?.path ?? data.files[0].path;
    warnings.replaceChildren(...warningCard());
    drawNav();
    drawSide();
    drawViewer();
    const top = topCard();
    body.replaceChildren(...(top ? [top] : []), ...(warnings.children.length ? [warnings] : []), toolbar, grid);
  }

  function truncatedBand() {
    return el(
      'div',
      { class: 'ins-band', role: 'status' },
      icon('folder-tree'),
      el('p', {}, el('b', {}, 'Árvore grande demais.'), ' O GitHub cortou a lista de arquivos: a raiz e ', el('code', {}, '.claude/'), ' estão aqui, mas subpastas podem faltar.'),
      el('button', { type: 'button', class: 'btn outline', onClick: () => read({ refresh: true }) }, 'Tentar agora'),
    );
  }

  function warningCard() {
    const list = data.warnings.filter((w) => w.kind !== 'truncated');
    if (!list.length) return [];
    const lines = list.map((w) => {
      const l = warningLine(w);
      return el('div', { class: 'ins-warn', 'data-kind': w.kind }, el('span', { class: `ins-tone-${l.tone}` }, icon(l.icon)), el('span', { class: 'mono ins-warn-name' }, l.name), el('span', { class: 'ins-warn-text' }, l.text));
    });
    const agents = list.some((w) => w.kind === 'agents-not-imported');
    return [
      el(
        'section',
        { class: 'card ins-warnings', 'aria-label': 'Avisos das instruções' },
        el('h2', { class: 'ins-ttl' }, icon('alert'), 'Instruções com avisos', el('span', { class: 'ins-ttl-r' }, plural(list.length, 'aviso', 'avisos'))),
        el('span', { class: 'ins-muted' }, 'O que não deu para ler aparece tracejado, com o motivo.'),
        ...lines,
        agents ? el('span', { class: 'ins-foot' }, 'O aviso do AGENTS.md some quando um CLAUDE.md passa a ter @AGENTS.md.') : null,
      ),
    ];
  }

  function emptyCard() {
    return el(
      'section',
      { class: 'card state center ins-empty' },
      el('div', { class: 'seal' }, icon('book-open')),
      el('h2', {}, 'Nenhuma instrução para agentes neste repositório'),
      el(
        'p',
        {},
        'Procuramos ',
        el('code', {}, 'CLAUDE.md'),
        ', ',
        el('code', {}, '.claude/CLAUDE.md'),
        ' e ',
        el('code', {}, 'AGENTS.md'),
        ' na raiz e nas subpastas, e ',
        el('code', {}, '.claude/'),
        ' e ',
        el('code', {}, '.mcp.json'),
        ' na raiz. Um agente que trabalhe aqui só leva as instruções do usuário, da máquina dele.',
      ),
      el('div', { class: 'ins-empty-actions' }, canInstall(install) ? installEmptyButton(() => openFlow(0)) : null, el('a', { class: 'btn outline', href: HOW_TO_CLAUDE_MD, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'Como escrever um CLAUDE.md')),
    );
  }

  // ---------- a lista (à esquerda) ----------
  function open(path, ref = null) {
    openPath = path;
    pendingRef = ref;
    if (query) {
      query = '';
      input.value = '';
    }
    drawNav();
    drawViewer();
  }

  function drawNav() {
    const { roots, folders } = fileGroups(data.files);
    const item = (f, label) => {
      const current = f.path === openPath;
      const warn = data.warnings.some((w) => w.kind === 'agents-not-imported' && w.path === f.path);
      const b = el(
        'button',
        { type: 'button', class: 'ins-nav-item', 'aria-current': current ? 'true' : null, title: f.path },
        icon('file-text'),
        el('span', { class: 'ins-trunc' }, label),
        warn ? el('span', { class: 'ins-tone-wait', title: 'nenhum CLAUDE.md importa este arquivo' }, icon('alert')) : null,
        f.kind.endsWith('-root') ? el('span', { class: 'ins-chip' }, 'raiz') : null,
      );
      b.addEventListener('click', () => open(f.path));
      const subs = (f.tree?.imports ?? []).map((n) => {
        const s = el(
          'button',
          { type: 'button', class: 'ins-nav-sub', 'data-status': n.status, title: n.status === 'ok' ? n.path : IMPORT_STATUS[n.status] },
          el('span', { class: 'ins-nav-arrow', 'aria-hidden': 'true' }, '↳'),
          el('span', { class: 'mono ins-trunc' }, `@${n.ref}`),
          n.status === 'ok' ? null : el('span', { class: n.status === 'outside-repo' ? 'ins-muted' : 'ins-tone-error', title: IMPORT_STATUS[n.status] }, icon(IMPORT_ICON[n.status]), el('span', { class: 'ins-sr' }, IMPORT_STATUS[n.status])),
        );
        s.addEventListener('click', () => open(f.path, n.ref));
        return s;
      });
      return [b, ...subs];
    };
    const cards = noClaudeFolder(data) ? [] : claudeCards(data);
    nav.replaceChildren(
      el('div', { class: 'eyebrow ins-eyebrow' }, 'Arquivos de instrução'),
      ...roots.flatMap((f) => item(f, f.path)),
      ...folders.flatMap((g) => [el('div', { class: 'ins-folder', title: g.folder }, icon('folder'), el('span', { class: 'ins-trunc' }, `${g.folder}/`)), ...g.files.flatMap((f) => item(f, basename(f.path)))]),
      ...(cards.length
        ? [
            el('div', { class: 'eyebrow ins-eyebrow' }, '.claude'),
            ...cards.map((c) => {
              const b = el('button', { type: 'button', class: 'ins-nav-item' }, icon(c.icon), el('span', { class: 'ins-trunc' }, c.title === 'Plugins habilitados' ? 'Plugins' : c.title), el('span', { class: 'mono ins-count' }, String(c.rows.length)));
              b.addEventListener('click', () => side.querySelector(`[data-card="${c.id}"]`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }));
              return b;
            }),
          ]
        : []),
    );
  }

  // ---------- o que .claude/ traz ----------
  function drawSide(standalone = false) {
    if (noClaudeFolder(data)) {
      side.replaceChildren(el('div', { class: 'eyebrow ins-eyebrow' }, icon('folder'), 'O que .claude/ traz'), el('p', { class: 'card ins-none' }, 'Sem .claude/ nem .mcp.json neste repositório.'));
      return side;
    }
    side.replaceChildren(
      el('div', { class: 'eyebrow ins-eyebrow' }, icon('folder'), 'O que .claude/ traz'),
      el(
        'div',
        { class: standalone ? 'ins-cards ins-cards-wide' : 'ins-cards' },
        ...claudeCards(data).map((c) =>
          el(
            'section',
            { class: 'card ins-card', 'data-card': c.id },
            el('h2', { class: 'ins-ttl' }, icon(c.icon), c.title, el('span', { class: 'ins-ttl-r' }, c.count)),
            ...(c.rows.length
              ? c.rows.map(([a, b]) => el('div', { class: 'ins-row' }, el('span', { class: 'mono ins-row-name', title: a }, a), b ? el('span', { class: 'ins-row-desc', title: b }, b) : null))
              : [el('span', { class: 'ins-muted' }, c.none)]),
          ),
        ),
      ),
    );
    return side;
  }

  // ---------- o visor ----------
  function drawViewer() {
    if (!data || data.state !== 'ready' || !data.files.length) return;
    if (query.length >= SEARCH_MIN) return drawSearch();
    const f = data.files.find((x) => x.path === openPath);
    if (!f) return;
    const seg = el(
      'div',
      { class: 'ins-seg', role: 'group', 'aria-label': 'Como mostrar o arquivo' },
      ...[
        ['rendered', 'Renderizado'],
        ['markdown', 'Markdown'],
      ].map(([v, label]) => {
        const b = el('button', { type: 'button', 'aria-pressed': String(mode === v) }, label);
        b.addEventListener('click', () => {
          mode = v;
          drawViewer();
        });
        return b;
      }),
    );
    const github = blobUrl(data.repo, data.commit, f.path);
    const head = el(
      'header',
      { class: 'ins-viewer-head' },
      el('span', { class: 'ins-accent' }, icon('file-text')),
      el('b', { class: 'mono ins-viewer-path' }, f.path),
      el('span', { class: 'ins-viewer-role' }, fileRole(f)),
      el('span', { class: 'ins-viewer-actions' }, seg, github ? el('a', { class: 'btn outline ins-icon-btn', href: github, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Abrir ${f.path} no GitHub`, title: 'Abrir no GitHub' }, icon('external')) : null),
    );
    const content = el('div', { class: 'ins-viewer-body' });
    viewer.replaceChildren(head, content);
    const state = views.get(f.path);
    if (!state || state.promise) {
      content.replaceChildren(el('p', { class: 'ins-muted' }, 'Abrindo o arquivo…'));
      const path = f.path;
      loadFile(path)
        .then(() => {
          if (openPath === path && !query) drawViewer();
        })
        .catch(() => {});
      return;
    }
    if (state.failure) {
      content.replaceChildren(
        el('p', { class: 'ins-muted', role: 'alert' }, `O arquivo não abriu: ${state.failure.message}.`),
        el('button', { type: 'button', class: 'btn outline', onClick: () => (views.delete(f.path), drawViewer()) }, icon('refresh'), 'Tentar de novo'),
      );
      return;
    }
    const v = state.view;
    if (mode === 'markdown') content.replaceChildren(el('pre', { class: 'ins-raw' }, el('code', {}, v.text)));
    else content.replaceChildren(renderMarkdown(v.text, { repo: data.repo, commit: data.commit, from: v.path, imports: v.tree?.imports ?? [] }));
    if (pendingRef && mode === 'rendered') {
      // Abre em sequência os blocos do caminho (`via` da busca), cada um dentro do anterior.
      let scope = content;
      let block = null;
      for (const ref of [].concat(pendingRef)) {
        const next = Array.from(scope.querySelectorAll('.ins-import')).find((b) => b.getAttribute('data-ref') === ref);
        if (!next) break;
        next.open?.(true);
        block = scope = next;
      }
      block?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
    pendingRef = null;
  }

  function drawSearch() {
    const q = query;
    const head = el('header', { class: 'ins-viewer-head' }, el('span', { class: 'ins-accent' }, icon('search')), el('b', {}, `Busca: "${q}"`), el('span', { class: 'ins-viewer-role' }, 'nos arquivos de instrução e nos imports deles'));
    const content = el('div', { class: 'ins-viewer-body' }, el('p', { class: 'ins-muted' }, 'Procurando…'));
    viewer.replaceChildren(head, content);
    const files = fileGroups(data.files);
    const ordered = [...files.roots, ...files.folders.flatMap((g) => g.files)];
    Promise.all(ordered.map((f) => loadFile(f.path).catch(() => {}))).then(() => {
      if (query !== q) return;
      const groups = ordered.map((f) => ({ f, hits: views.get(f.path)?.view ? searchFile(views.get(f.path).view, q) : [] })).filter((g) => g.hits.length);
      if (!groups.length) return content.replaceChildren(el('p', { class: 'ins-muted' }, 'Nada casa com essa busca nas instruções deste repositório.'));
      let left = SEARCH_MAX;
      content.replaceChildren(
        ...groups.map(({ f, hits }) => {
          const shown = hits.slice(0, Math.max(0, left));
          left -= shown.length;
          const title = el('button', { type: 'button', class: 'ins-hit-file' }, icon('file-text'), el('span', { class: 'mono' }, f.path), el('span', { class: 'ins-muted' }, plural(hits.length, 'trecho', 'trechos')));
          title.addEventListener('click', () => open(f.path));
          return el(
            'div',
            { class: 'ins-hits' },
            title,
            ...shown.map((h) => {
              const b = el('button', { type: 'button', class: 'ins-hit' }, el('span', { class: 'mono ins-hit-where' }, `${h.via.length ? `@${h.via.at(-1)} · ` : ''}${h.line}`), el('span', { class: 'ins-hit-text' }, ...highlighted(h.text.trim(), q)));
              b.addEventListener('click', () => open(f.path, h.via.length ? h.via : null));
              return b;
            }),
          );
        }),
      );
    });
  }

  // ---------- ao vivo ----------
  ctx.onChange((changes) => {
    if (instructionsChangeMatters(changes, key) || connectionChanged(changes)) {
      views.clear();
      read();
    }
    if (installChangeMatters(changes, key)) {
      readInstall();
      flow?.live();
    }
  });
  ctx.onRestart(() => {
    views.clear();
    read();
    readInstall();
    flow?.live();
  });

  body.replaceChildren(loading());
  await Promise.all([read(), readInstall()]);
  return () => {
    clearTimeout(timer);
    clearTimeout(searchTimer);
    clearTimeout(installTimer);
    timer = null;
    request++;
    installRequest++;
    flow?.leave();
    flow = null;
  };
}
