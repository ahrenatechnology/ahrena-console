// The screen registry: the route, the sidebar item and the file of each screen (see README.md).
//
// - `route`: the path in the browser; `:id` matches one segment.
// - `item`: the sidebar item, `{ label, icon, section }`. `section` is the id of a `SECTIONS` entry
//   and says which block of the sidebar the item goes in; inside the block, the order of this
//   registry holds. Without `item`, the screen is not in the sidebar and `highlights` says which
//   item stays lit while it is open (the session detail lights Sessions, as in A5).
// - `file`: the screen module in `ui/screens/`. Without it, the shell shows the header and the empty state.
// - `title`, `sub` and `icon`: the header of the empty state and the window title.

// The sidebar blocks, in C24 order: the everyday screens (no title), Machines and Control. A block
// without items does not show.
export const SECTIONS = [
  { id: 'main', label: null },
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
    item: { label: 'Mural ao vivo', icon: 'mural', section: 'main' },
    title: 'Mural ao vivo',
    sub: 'Um card por sessão aberta nesta máquina',
    icon: 'mural',
    file: '/ui/screens/wall.js', // #34
  },
  {
    id: 'sessions',
    route: '/ui/sessions',
    item: { label: 'Sessões', icon: 'sessoes', section: 'main' },
    title: 'Sessões',
    sub: 'As sessões registradas nesta máquina',
    icon: 'sessoes',
    file: '/ui/screens/sessions.js', // #28
  },
  {
    id: 'feed',
    route: '/ui/feed',
    item: { label: 'Feed de atividade', icon: 'atividade', section: 'main' },
    title: 'Feed de atividade',
    sub: 'Todos os eventos das sessões, ao vivo',
    icon: 'atividade',
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
    icon: 'sessoes',
    file: '/ui/screens/session-detail.js', // #29 and #30
  },
  {
    id: 'project',
    route: '/ui/project',
    item: { label: 'Kanban do projeto', icon: 'github', section: 'main' },
    title: 'Kanban do projeto',
    sub: 'O GitHub Project por Status',
    icon: 'github',
    file: '/ui/screens/project.js', // #80 (C11)
  },
  {
    id: 'repos',
    route: '/ui/repos',
    item: { label: 'Repositórios', icon: 'repos', section: 'main' },
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
    item: { label: 'Histórico', icon: 'historico', section: 'main' },
    title: 'Histórico',
    sub: 'Sessões encerradas, por dia',
    icon: 'historico',
    file: '/ui/screens/history.js', // #33
  },
  {
    id: 'decisions',
    route: '/ui/decisions',
    item: { label: 'Decisões', icon: 'decisao', section: 'main' },
    title: 'Decisões',
    sub: 'O que você e os agentes decidiram, em todas as sessões',
    icon: 'decisao',
    file: '/ui/screens/decisions.js', // issue 103
  },
  { id: 'agent-config', route: '/ui/agent-config', item: { label: 'Agent Config', icon: 'bot', section: 'control' }, title: 'Agent Config', sub: 'Seu Claude Code: skills, subagentes, comandos, MCP, hooks e memória', icon: 'bot', file: '/ui/screens/agent-config.js' }, // #63
];

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
        if (ID.test(value) && value !== '.' && value !== '..') params[pattern[i].slice(1)] = value;
        else matches = false;
      } else matches = pattern[i] === parts[i];
    }
    if (matches) return { screen, params };
  }
  return null;
}

// ---------- The old /ui URLs (decision 0009, issue 173) ----------
//
// Old links, bookmarks, the app and the published mod still open `/ui/sessoes/<id>` and the other
// Portuguese URLs. The shell swaps them for the new one (`history.replaceState`) before routing.
// This table is the only place that knows them; it leaves with the other aliases in the last phase.

const LEGACY_PATHS = [
  ['/ui/sessoes', '/ui/sessions'],
  ['/ui/historico', '/ui/history'],
  ['/ui/mural', '/ui/wall'],
  ['/ui/projeto', '/ui/project'],
  ['/ui/decisoes', '/ui/decisions'],
  ['/ui/analytics/custo', '/ui/analytics/cost'],
];

// Query parameters of each screen: old name → new name, and old value → new value.
const LEGACY_QUERY = {
  sessions: { keys: { busca: 'search', ordem: 'order', sentido: 'direction', pagina: 'page' } },
  kanban: { keys: { visao: 'view' }, values: { view: { agentes: 'agents', sessoes: 'sessions' } } },
  repo: { keys: { periodo: 'period' }, values: { period: { '1a': '1y' } } },
};

// The tabs of the session detail, in the hash.
const LEGACY_DETAIL_TABS = { agentes: 'agents', conversa: 'conversation', tempo: 'timeline', decisoes: 'decisions' };

/**
 * The new URL for an old /ui URL (`{ pathname, search, hash }`), as `path + query + hash`, or `null`
 * when the URL is already the new one.
 */
export function legacyUrl({ pathname, search = '', hash = '' }) {
  let path = pathname;
  for (const [old, next] of LEGACY_PATHS) {
    if (path === old || path.startsWith(`${old}/`)) {
      path = next + path.slice(old.length);
      break;
    }
  }
  const found = findScreen(path);
  const rules = found ? LEGACY_QUERY[found.screen.id] : null;
  let query = search;
  if (rules && search) {
    const old = new URLSearchParams(search);
    const next = new URLSearchParams();
    let changed = false;
    for (const [k, v] of old) {
      const key = rules.keys[k] ?? k;
      const value = rules.values?.[key]?.[v] ?? v;
      changed ||= key !== k || value !== v;
      if (key !== k && old.has(key)) continue; // the new name wins
      next.append(key, value);
    }
    const s = next.toString();
    if (changed) query = s ? `?${s}` : '';
  }
  let tab = hash;
  if (found?.screen.id === 'session-detail' && LEGACY_DETAIL_TABS[hash.slice(1)]) tab = `#${LEGACY_DETAIL_TABS[hash.slice(1)]}`;
  if (path === pathname && query === search && tab === hash) return null;
  return `${path}${query}${tab}`;
}
