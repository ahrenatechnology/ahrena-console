// The screen registry: the route, the sidebar item and the file of each screen (see README.md).
//
// - `route`: the path in the browser; `:id` matches one segment.
// - `item`: the sidebar item, `{ label, icon, section }`. `section` is the id of a `SECTIONS` entry
//   and says which block of the sidebar the item goes in; inside the block, the order of this
//   registry holds. Without `item`, the screen is not in the sidebar and `highlights` says which
//   item stays lit while it is open (the session detail lights Sessions, as in A5).
// - `file`: the screen module in `ui/screens/`. Without it, the shell shows the header and the empty state.
// - `title`, `sub` and `icon`: the header of the empty state and the window title.

// The sidebar blocks: the everyday screens (no title), then Delivery, Decisions, Machines and
// Control. A block without items does not show. Decisions holds the session decisions ("Das sessões")
// and the architecture (ADR) and product (PDR) records of the repositories (issue 174).
export const SECTIONS = [
  { id: 'main', label: null },
  { id: 'delivery', label: 'Entrega' },
  { id: 'decisions', label: 'Decisões' },
  { id: 'machines', label: 'Máquinas' },
  { id: 'control', label: 'Controle' },
];

export const SCREENS = [
  {
    id: 'dashboard',
    route: '/ui',
    item: { label: 'Dashboard', icon: 'dashboard', section: 'main' },
    title: 'Dashboard',
    sub: 'O agora das suas sessões',
    icon: 'dashboard',
    file: '/ui/screens/dashboard.js',
  },
  {
    id: 'wall',
    route: '/ui/wall',
    item: { label: 'Mural ao vivo', icon: 'wall', section: 'main' },
    title: 'Mural ao vivo',
    sub: 'Um card por sessão aberta nesta máquina',
    icon: 'wall',
    file: '/ui/screens/wall.js', // #34
  },
  {
    id: 'sessions',
    route: '/ui/sessions',
    item: { label: 'Sessões', icon: 'sessions', section: 'main' },
    title: 'Sessões',
    sub: 'As sessões registradas nesta máquina',
    icon: 'sessions',
    file: '/ui/screens/sessions.js', // #28
  },
  {
    id: 'feed',
    route: '/ui/feed',
    item: { label: 'Feed de atividade', icon: 'activity', section: 'main' },
    title: 'Feed de atividade',
    sub: 'Todos os eventos das sessões, ao vivo',
    icon: 'activity',
    file: '/ui/screens/feed.js', // #94
  },
  {
    id: 'kanban',
    route: '/ui/kanban',
    item: { label: 'Kanban', icon: 'kanban', section: 'main' },
    title: 'Kanban',
    sub: 'As sessões por status, só leitura',
    icon: 'kanban',
    file: '/ui/screens/kanban.js', // #31
  },
  {
    id: 'session-detail',
    route: '/ui/sessions/:id',
    highlights: 'sessions',
    title: 'Sessão',
    sub: null,
    icon: 'sessions',
    file: '/ui/screens/session-detail.js', // #29 and #30
  },
  {
    id: 'repos',
    route: '/ui/repos',
    item: { label: 'Repositórios', icon: 'repos', section: 'delivery' },
    title: 'Repositórios',
    sub: 'Organizações e repositórios da sua conta do GitHub',
    icon: 'repos',
    file: '/ui/screens/repos.js', // C22
  },
  {
    id: 'repo',
    route: '/ui/repos/:owner/:repo',
    highlights: 'repos',
    title: 'Repositório',
    sub: null,
    icon: 'repos',
    file: '/ui/screens/repo.js', // C23
  },
  {
    // The tabs of a repository with their own URL (/ui/repos/<owner>/<repo>/instructions, C32 and issue 183):
    // the same screen, which reads the tab from `params.tab`; an unknown tab shows "Aba não encontrada".
    id: 'repo-tab',
    route: '/ui/repos/:owner/:repo/:tab',
    highlights: 'repos',
    title: 'Repositório',
    sub: null,
    icon: 'repos',
    file: '/ui/screens/repo.js',
  },
  {
    id: 'project',
    route: '/ui/project',
    item: { label: 'Kanban do projeto', icon: 'github', section: 'delivery' },
    title: 'Kanban do projeto',
    sub: 'O GitHub Project por Status',
    icon: 'github',
    file: '/ui/screens/project.js', // #80 (C11)
  },
  {
    id: 'dev-console',
    route: '/ui/dev-console',
    item: { label: 'Dev Console', icon: 'gauge', section: 'delivery' },
    title: 'Dev Console',
    sub: 'PRs, issues e sessões dos repositórios do contexto',
    icon: 'gauge',
    file: '/ui/screens/dev-console.js', // C27, issue 179
  },
  {
    id: 'analytics',
    route: '/ui/analytics',
    item: { label: 'Analytics', icon: 'analytics', section: 'main' },
    title: 'Analytics',
    sub: 'Uso, custo e produtividade das sessões',
    icon: 'analytics',
    file: '/ui/screens/analytics.js', // #95 and #32
  },
  {
    // The Cost tab (/ui/analytics/cost): the same screen, which reads the tab from `params.tab`.
    id: 'analytics-tab',
    route: '/ui/analytics/:tab',
    highlights: 'analytics',
    title: 'Analytics',
    sub: null,
    icon: 'analytics',
    file: '/ui/screens/analytics.js',
  },
  {
    id: 'workflows',
    route: '/ui/workflows',
    item: { label: 'Workflows', icon: 'workflows', section: 'main' },
    title: 'Workflows',
    sub: 'Como os agentes se orquestram: delegação, rodadas de review e resultado',
    icon: 'workflows',
    file: '/ui/screens/workflows.js', // #96
  },
  {
    id: 'history',
    route: '/ui/history',
    item: { label: 'Histórico', icon: 'history', section: 'main' },
    title: 'Histórico',
    sub: 'Sessões encerradas, por dia',
    icon: 'history',
    file: '/ui/screens/history.js', // #33
  },
  {
    id: 'decisions',
    route: '/ui/decisions',
    item: { label: 'Das sessões', icon: 'decision', section: 'decisions' },
    title: 'Decisões',
    sub: 'O que você e os agentes decidiram, em todas as sessões',
    icon: 'decision',
    file: '/ui/screens/decisions.js', // issue 103
  },
  {
    // As decisões de arquitetura dos repositórios da conta (C28, issue 174).
    id: 'adrs',
    route: '/ui/adrs',
    item: { label: 'ADR', icon: 'scroll-text', section: 'decisions' },
    title: 'ADR',
    sub: 'Decisões de arquitetura dos repositórios da sua conta',
    icon: 'scroll-text',
    file: '/ui/screens/adrs.js',
  },
  {
    // As decisões de produto (C38): a mesma tela, com outro rótulo.
    id: 'pdrs',
    route: '/ui/pdrs',
    item: { label: 'PDR', icon: 'lightbulb', section: 'decisions' },
    title: 'PDR',
    sub: 'Decisões de produto dos repositórios da sua conta',
    icon: 'lightbulb',
    file: '/ui/screens/adrs.js',
  },
  {
    // Um registro aberto (C30): /ui/adrs/<owner>/<repo>/<id>; acende ADR.
    id: 'adr',
    route: '/ui/adrs/:owner/:repo/:id',
    // O id é o nome do arquivo: acento e espaço valem (`0004-decisão de fila`).
    params: { id: 'record' },
    highlights: 'adrs',
    title: 'ADR',
    sub: null,
    icon: 'scroll-text',
    file: '/ui/screens/adr-record.js',
  },
  {
    id: 'pdr',
    route: '/ui/pdrs/:owner/:repo/:id',
    params: { id: 'record' },
    highlights: 'pdrs',
    title: 'PDR',
    sub: null,
    icon: 'lightbulb',
    file: '/ui/screens/adr-record.js',
  },
  {
    // This machine (C24, issue 178): always in the sidebar, before the remote ones.
    id: 'this-machine',
    route: '/ui/machines/local',
    item: { label: 'Esta máquina', icon: 'monitor', section: 'machines' },
    title: 'Esta máquina',
    sub: 'A telemetria medida pelo núcleo daqui',
    icon: 'monitor',
    file: '/ui/screens/machine.js',
  },
  {
    // A remote machine (C25, C26): one sidebar item per machine of `GET /api/machines`, which the
    // shell adds with `machineItems()` (below); the open one stays lit through `highlights(params)`.
    id: 'machine',
    route: '/ui/machines/:id',
    highlights: (params) => machineItemId(params.id),
    title: 'Máquina',
    sub: null,
    icon: 'server',
    file: '/ui/screens/machine.js',
  },
  { id: 'agent-config', route: '/ui/agent-config', item: { label: 'Agent Config', icon: 'bot', section: 'control' }, title: 'Agent Config', sub: 'Seu Claude Code: skills, subagentes, comandos, MCP, hooks e memória', icon: 'bot', file: '/ui/screens/agent-config.js' }, // #63
  {
    // Ferramentas (C72 to C76, issue 280, decision 0014): the CLIs, platforms, containers and MCP
    // servers of this machine and of each remote, with install and update from the core's catalog.
    id: 'tools',
    route: '/ui/tools',
    item: { label: 'Ferramentas', icon: 'wrench', section: 'control' },
    title: 'Ferramentas',
    sub: 'CLIs, plataformas, containers e servidores MCP das suas máquinas',
    icon: 'wrench',
    file: '/ui/screens/tools.js',
  },
];

// ---------- The remote machines in the sidebar (issue 178) ----------
//
// The registry is static; the remote machines come from `machines.json`, which only the core reads.
// So the shell reads `GET /api/machines` and passes `[...SCREENS, ...machineItems(list)]` to
// `sidebarSections`: each remote becomes an item of the `machines` block, after "Esta máquina", in
// the core's order, with its state for the dot. Without remotes, the list adds nothing.

/** The core route the shell reads for the remote items. */
export const MACHINES_ROUTE = '/api/machines';

/** The sidebar id of a remote machine's item. */
export const machineItemId = (id) => `machine-${id}`;

// The machine id of the core (src/telemetry/model.ts `MACHINE_ID`).
const MACHINE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MACHINE_STATES = new Set(['connected', 'unreachable', 'incompatible-version', 'not-configured']);

/** The sidebar entries of the remote machines in `GET /api/machines` (this machine is in SCREENS). */
export function machineItems(machines) {
  if (!Array.isArray(machines)) return [];
  const seen = new Set();
  const out = [];
  for (const m of machines.slice(0, 50)) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !MACHINE_ID.test(m.id) || m.id === 'local' || seen.has(m.id)) continue;
    seen.add(m.id);
    const label = typeof m.label === 'string' && m.label.trim() ? m.label.slice(0, 40) : m.id;
    out.push({
      id: machineItemId(m.id),
      route: `/ui/machines/${m.id}`,
      item: { label, icon: 'server', section: 'machines' },
      state: MACHINE_STATES.has(m.state) ? m.state : 'unreachable',
      title: label,
      icon: 'server',
    });
  }
  return out;
}

/** The item a screen lights: its own, or the one its `highlights` names (a function of the params). */
export function litItem(screen, params = {}) {
  if (screen.item) return screen.id;
  return typeof screen.highlights === 'function' ? screen.highlights(params) : (screen.highlights ?? null);
}

/**
 * The sidebar blocks with their items, in `SECTIONS` order; empty blocks are left out. An item
 * without a known `section` falls in the first block, so a screen never disappears from the sidebar
 * (the registry test refuses such an item).
 */
export function sidebarSections(screens = SCREENS, sections = SECTIONS) {
  const known = new Set(sections.map((s) => s.id));
  const sectionOf = (t) => (known.has(t.item.section) ? t.item.section : sections[0].id);
  return sections.map((s) => ({ ...s, items: screens.filter((t) => t.item && sectionOf(t) === s.id) })).filter((s) => s.items.length);
}

// A session id or a GitHub name (dot, hyphen and underscore); `.` and `..` never.
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
// The other parameter shapes a screen may ask for in `params` (issue 174: o id de um registro de
// decisão é o nome do arquivo, com acento e espaço; nunca barra nem caractere de controle).
const PARAM_SHAPES = { record: /^[^/\u0000-\u001f]{1,200}$/u };

/** The screen and the parameters of a path, or `null` when none matches. */
export function findScreen(path, screens = SCREENS) {
  const parts = path.replace(/\/+$/, '').split('/');
  for (const screen of screens) {
    const pattern = screen.route.split('/');
    if (pattern.length !== parts.length) continue;
    const params = {};
    let matches = true;
    for (let i = 0; i < pattern.length && matches; i++) {
      if (pattern[i].startsWith(':')) {
        let value = '';
        try {
          value = decodeURIComponent(parts[i]);
        } catch {}
        const name = pattern[i].slice(1);
        const shape = PARAM_SHAPES[screen.params?.[name]] ?? ID;
        if (shape.test(value) && value !== '.' && value !== '..') params[name] = value;
        else matches = false;
      } else matches = pattern[i] === parts[i];
    }
    if (matches) return { screen, params };
  }
  return null;
}
