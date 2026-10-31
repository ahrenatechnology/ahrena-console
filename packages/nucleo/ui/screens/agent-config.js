import { mountCodexConfig } from './codex-config.js';
import { mountClaudeConfig } from './claude-config.js';
// The Agent Config screen (#63, wireframes C16 and C17): what Claude Code has configured on this
// machine and in the chosen project, and editing a skill with backup.
//
// - The tab and the project live in the URL: `/ui/agent-config?tab=skills&project=<abs>`. Switching
//   tabs is a `pushState` inside the screen (no re-read); the browser's Back remounts the screen,
//   which draws right away with what it already read and re-reads behind.
// - The scope (All, User, Project) and the search filter on the client.
// - Reading through `ctx.ler('/api/agent-config…')`; writing through
//   `ctx.escrever('/api/agent-config/skill', …)`. With the `p` root (the project's `.claude`), the
//   request always carries the `project`.
// - Deleting a skill is out of scope (owner's decision): there is no button.

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';

// ---------- Pure functions (tested in test/api/ui.test.ts) ----------

/** The same name pattern as the core (src/agent-config/skills.ts). */
export const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const TABS = [
  { id: 'overview', label: 'Visão geral', icon: 'wall' },
  { id: 'settings', label: 'Configurações do Claude', icon: 'settings' },
  { id: 'skills', label: 'Skills', icon: 'suggested', summary: 'skills' },
  { id: 'subagents', label: 'Subagentes', icon: 'users', summary: 'subagents' },
  { id: 'commands', label: 'Comandos', icon: 'slash', summary: 'commands' },
  { id: 'memory', label: 'Memória', icon: 'book-open', summary: 'memory' },
  { id: 'plugins', label: 'Plugins', icon: 'plug', summary: 'plugins' },
  { id: 'mcp', label: 'MCP', icon: 'server', summary: 'mcp' },
  { id: 'hooks', label: 'Hooks', icon: 'webhook', summary: 'hooks' },
];

const SUMMARY = [
  ['skills', 'suggested', 'Skills'],
  ['subagents', 'users', 'Subagentes'],
  ['commands', 'slash', 'Comandos'],
  ['mcp', 'server', 'Servidores MCP'],
  ['plugins', 'plug', 'Plugins'],
  ['hooks', 'webhook', 'Hooks'],
  ['memory', 'book-open', 'Memória'],
  ['settings', 'settings', 'Configurações'],
];

export const SCOPES = [
  ['all', 'Todos os escopos'],
  ['user', 'Usuário'],
  ['project', 'Projeto'],
];
const SCOPE_LABEL = { user: 'Usuário', project: 'Projeto' };

/** The tab and the project of a query (`?tab=skills&project=/x`); an unknown tab becomes the overview. */
export function readUrl(search) {
  const q = new URLSearchParams(search);
  const tab = q.get('tab');
  return { tab: TABS.some((t) => t.id === tab) ? tab : 'overview', project: q.get('project') || null };
}

/** The screen's path for a tab and a project. */
export function urlFor({ tab = 'overview', project = null } = {}) {
  const q = new URLSearchParams();
  if (tab && tab !== 'overview') q.set('tab', tab);
  if (project) q.set('project', project);
  const s = q.toString();
  return `/ui/agent-config${s ? `?${s}` : ''}`;
}

/** The items of a scope (`all` returns the list as it came). */
export function inScope(items, scope) {
  return scope === 'user' || scope === 'project' ? items.filter((i) => i.scope === scope) : items;
}

const withoutAccents = (t) => String(t ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The skill search: in the folder name, the frontmatter `name` and the description, ignoring case and accents. */
export function searchSkills(skills, term) {
  const t = withoutAccents(term).trim();
  if (!t) return skills;
  return skills.filter((s) => [s.name, s.declaredName, s.description].some((c) => withoutAccents(c).includes(t)));
}

/** "editado há 3 dias", from `editedAt` (ms). */
export function editedAgo(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'editado agora';
  const min = Math.floor(s / 60);
  if (min < 60) return `editado há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `editado há ${h} h`;
  const d = Math.floor(h / 24);
  return `editado há ${d} ${d === 1 ? 'dia' : 'dias'}`;
}

/** The error message for a new skill's name, or `null` if it is fine. */
export function validateSkillName(name, existing = new Set()) {
  if (!name) return 'Dê um nome à skill.';
  if (!SKILL_NAME.test(name)) return 'Use minúsculas, números, ponto, hífen ou sublinhado, começando por letra ou número (até 64).';
  if (existing.has(name)) return 'Já existe uma skill com esse nome nessa pasta.';
  return null;
}

/** The SKILL.md a new skill starts with. */
export function skillTemplate(name) {
  return `---\nname: ${name}\ndescription: O que a skill faz e quando o Claude deve usá-la.\n---\n\n# ${name}\n\n`;
}

/** The big number of a summary card, in the chosen scope. */
export function countFor(count, scope) {
  if (!count) return 0;
  return scope === 'user' ? count.user : scope === 'project' ? count.project : count.total;
}

/** The caption of a summary card: "18 do usuário · 6 do projeto", or just the filtered scope. */
export function captionFor(count, scope) {
  if (scope === 'user') return 'do usuário';
  if (scope === 'project') return 'do projeto';
  return `${count?.user ?? 0} do usuário · ${count?.project ?? 0} do projeto`;
}

// ---------- Screen state (survives Back: the screen remounts and draws with what it has) ----------

const state = {
  scope: 'all',
  search: '',
  /** The last `/api/agent-config` response and the `?project=` that asked for it. */
  data: null,
  requested: undefined,
  /** The open editor: `{ root, name, scope, path, mode: 'view'|'edit'|'new', content, text, version, editedAt, project, loading, saving, error, notice }`. */
  editor: null,
  /** The new skill being named: `{ name, root, error }`. */
  creating: null,
  backupsOpen: false,
  /** The backups made by this window, most recent first. */
  windowBackups: [],
};

const SUB = 'Seu Claude Code: skills, subagentes, comandos, MCP, hooks e memória';

/** The screen's CSS, once in `<head>`; waits for it to load so it does not flash unstyled. */
function ensureCss() {
  let link = document.querySelector('link[data-screen="agent-config"]');
  if (link) return Promise.resolve();
  link = el('link', { rel: 'stylesheet', 'data-screen': 'agent-config', href: '/ui/agent-config.css' });
  const ready = new Promise((resolve) => {
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
    setTimeout(resolve, 1500);
  });
  document.head.append(link);
  return ready;
}

const dirty = (ed) => !!ed && ((ed.mode === 'new' && ed.text !== skillTemplate(ed.name)) || (ed.mode === 'edit' && ed.text !== ed.content));
/** Can save: the skill was read (has a `version`) or is new. Without it, a POST without `version` would replace the file blindly. */
const canSave = (ed) => !!ed && !ed.loading && !ed.saving && (ed.mode === 'new' || (ed.mode === 'edit' && !!ed.version && ed.text !== ed.content));

// Closing or reloading the window with unsaved text asks first.
globalThis.addEventListener?.('beforeunload', (ev) => {
  if (dirty(state.editor)) ev.preventDefault();
});

export async function mount(area, ctx) {
  if (new URLSearchParams(location.search).get('provider') === 'codex') {
    await ensureCss();
    return mountCodexConfig(area, ctx);
  }
  if (new URLSearchParams(location.search).get('tab') === 'settings') {
    await ensureCss();
    return mountClaudeConfig(area, ctx);
  }
  let url = readUrl(location.search);
  const signal = ctx.signal;
  await ensureCss();
  if (signal.aborted) return;
  /** The `data-focus` to focus after the next draw (New's Cancel goes back to the New button…). */
  let pendingFocus = null;
  /** Only the last `/api/agent-config` read counts: a late response for another project is dropped. */
  let readSeq = 0;

  // ---------- Header ----------
  const projectSlot = el('span', { class: 'ac-project' });
  const seg = el('div', { class: 'ac-seg', role: 'group', 'aria-label': 'Escopo' });
  const refreshButton = el('button', { type: 'button', class: 'btn', onClick: () => load({ quiet: true, withSkill: true }) }, icon('refresh'), 'Atualizar');
  const pageHeader = header({ icon: 'bot', title: 'Agent Config', sub: SUB, actions: [el('a', { class: 'btn outline', href: '/ui/agent-config?provider=codex' }, 'Codex · somente leitura'), projectSlot, seg, refreshButton] });

  function drawSeg() {
    seg.replaceChildren(
      ...SCOPES.map(([id, label]) =>
        el('button', { type: 'button', 'data-focus': `scope:${id}`, 'aria-pressed': String(state.scope === id), onClick: () => ((state.scope = id), draw()) }, label),
      ),
    );
  }

  function drawProject() {
    const d = state.data;
    if (!d || d.projects.length < 2) return projectSlot.replaceChildren();
    const select = el(
      'select',
      { class: 'ac-select', 'data-focus': 'project', 'aria-label': 'Projeto', title: d.project ?? '' },
      ...d.projects.map((p) => el('option', { value: p, selected: p === d.project }, shortName(p))),
    );
    select.addEventListener('change', () => {
      if (dirty(state.editor) && !confirm('Descartar as alterações da skill aberta?')) return void (select.value = d.project);
      state.editor = null;
      state.creating = null;
      goTo({ tab: url.tab, project: select.value });
      load();
    });
    projectSlot.replaceChildren(el('label', { class: 'ac-project-label' }, icon('folder'), select));
  }

  // ---------- Navigation inside the screen ----------
  function goTo(target) {
    const route = urlFor(target);
    if (route !== location.pathname + location.search) history.pushState(null, '', route);
    url = readUrl(location.search);
  }

  function tabs() {
    const d = state.data;
    return el(
      'nav',
      { class: 'ac-tabs', 'aria-label': 'Partes da configuração' },
      ...TABS.map((t) => {
        const n = t.summary ? countFor(d?.summary?.[t.summary], state.scope) : null;
        const link = el(
          'a',
          { href: urlFor({ tab: t.id, project: url.project }), 'data-focus': `tab:${t.id}`, class: t.id === url.tab ? 'on' : null, 'aria-current': t.id === url.tab ? 'page' : null },
          icon(t.icon),
          t.label,
          n === null ? null : el('span', { class: 'ac-chip' }, String(n)),
        );
        link.addEventListener('click', (ev) => {
          if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
          if (t.id === 'settings') return;
          ev.preventDefault();
          goTo({ tab: t.id, project: url.project });
          draw();
        });
        return link;
      }),
    );
  }

  // ---------- Reading ----------
  let readBanner = null;

  async function load({ quiet = false, withSkill = false } = {}) {
    const requested = url.project;
    const mine = ++readSeq;
    const stillValid = () => !signal.aborted && mine === readSeq && requested === url.project;
    if (!quiet || !state.data) area.replaceChildren(pageHeader, loading({ label: 'Lendo as pastas de configuração' }));
    try {
      const data = await ctx.read(`/api/agent-config${requested ? `?project=${encodeURIComponent(requested)}` : ''}`);
      if (!stillValid()) return;
      state.data = data;
      state.requested = requested;
      readBanner = null;
      draw();
      if (withSkill && state.editor && !dirty(state.editor) && state.editor.mode !== 'new') openSkill(state.editor, state.editor.mode);
    } catch (e) {
      if (e?.name === 'AbortError' || !stillValid()) return;
      if (e?.status === 400 && requested) {
        area.replaceChildren(
          pageHeader,
          empty({
            icon: 'folder',
            title: 'Projeto desconhecido',
            text: `${requested} não está entre os projetos das sessões desta máquina.`,
            action: { label: 'Abrir o projeto mais recente', onClick: () => (goTo({ tab: url.tab }), load()) },
          }),
        );
        return;
      }
      if (quiet && state.data) {
        readBanner = errorBand({ title: 'Não releu.', text: e?.message ?? String(e), action: { label: 'Tentar de novo', onClick: () => load({ quiet: true }) } });
        draw();
        return;
      }
      area.replaceChildren(pageHeader, error({ text: e?.message ?? String(e), retry: () => load() }));
    }
  }

  // ---------- Drawing ----------
  function draw() {
    if (signal.aborted) return;
    const d = state.data;
    if (!d) return;
    // Redrawing does not take the focus (nor the caret) away from a keyboard user: the equivalent
    // control, found by `data-focus`, gets the focus back. `pendingFocus` says where to go when the control disappears.
    const active = document.activeElement;
    const key = pendingFocus ?? (area.contains(active) ? active?.dataset?.focus : null);
    const selection = !pendingFocus && active && 'selectionStart' in active && area.contains(active) ? { from: active.selectionStart, to: active.selectionEnd, scroll: active.scrollTop } : null;
    pendingFocus = null;
    const tab = TABS.find((t) => t.id === url.tab);
    ctx.title(url.tab === 'overview' ? 'Agent Config' : `Agent Config · ${tab.label}`);
    drawSeg();
    drawProject();
    const parts = [pageHeader, readBanner];
    if (url.tab === 'overview') parts.push(...overview(d));
    else parts.push(tabs(), url.tab === 'skills' ? skills(d) : simpleList(d, url.tab));
    area.replaceChildren(...parts.filter(Boolean));
    const next = key ? area.querySelector(`[data-focus="${CSS.escape(key)}"]`) : null;
    if (next && !next.disabled) {
      next.focus();
      if (selection && 'selectionStart' in next) {
        try {
          next.setSelectionRange(selection.from, selection.to);
        } catch {}
        next.scrollTop = selection.scroll;
      }
    }
  }

  // ---------- C16 · Overview ----------
  function overview(d) {
    const roots = inScope(d.roots, state.scope);
    const backupsButton = el(
      'button',
      { type: 'button', class: 'btn outline', 'data-focus': 'backups', 'aria-expanded': String(state.backupsOpen), 'aria-controls': state.backupsOpen ? 'ac-backups' : null },
      icon('history'),
      'Backups',
    );
    backupsButton.addEventListener('click', () => ((state.backupsOpen = !state.backupsOpen), draw()));
    const banner = el(
      'div',
      { class: 'ac-banner' },
      el('span', { class: 'ac-banner-icon' }, icon('shield-check')),
      el(
        'p',
        {},
        el('b', {}, 'Edição ligada.'),
        ' Ver é livre. Ao salvar uma skill, o núcleo guarda o SKILL.md anterior na pasta de backups antes de gravar o novo.',
      ),
      backupsButton,
    );
    const backups = state.backupsOpen
      ? el(
          'section',
          { class: 'card ac-panel', id: 'ac-backups' },
          el('div', { class: 'eyebrow' }, 'Backups'),
          d.backups ? pathCard('Pasta dos backups', d.backups, 'history') : el('p', { class: 'ac-muted' }, 'O núcleo não informou a pasta dos backups.'),
          state.windowBackups.length
            ? el('ul', { class: 'ac-backups' }, ...state.windowBackups.map((b) => el('li', { class: 'mono' }, b)))
            : el('p', { class: 'ac-muted' }, 'Nenhuma gravação com backup nesta janela ainda.'),
        )
      : null;
    return [
      banner,
      backups,
      tabs(),
      el(
        'section',
        { class: 'card ac-panel' },
        el('div', { class: 'eyebrow' }, 'Raízes'),
        roots.length
          ? el('div', { class: 'ac-roots' }, ...roots.map((r) => pathCard(r.label, r.path, 'folder-tree')))
          : el('p', { class: 'ac-muted' }, 'Nenhuma raiz neste escopo.'),
        el('div', { class: 'eyebrow' }, 'Resumo'),
        el(
          'div',
          { class: 'ac-summary' },
          ...SUMMARY.map(([key, ic, label]) =>
            el(
              'div',
              { class: 'ac-stat' },
              el('div', { class: 'eyebrow' }, el('span', { class: 'ac-accent' }, icon(ic)), label),
              el('div', { class: 'ac-stat-line' }, el('span', { class: 'mono ac-big' }, String(countFor(d.summary[key], state.scope))), el('span', { class: 'ac-muted' }, captionFor(d.summary[key], state.scope))),
            ),
          ),
        ),
      ),
    ];
  }

  function pathCard(label, path, ic) {
    const text = el('div', { class: 'mono ac-trunc ac-path ac-clip-start', title: path }, el('bdi', { dir: 'ltr' }, path));
    const copy = el('button', { type: 'button', class: 'ac-copy', title: `Copiar ${path}`, 'aria-label': `Copiar o caminho de ${label}` }, icon('copy'));
    copy.addEventListener('click', () => copyText(path, copy, text));
    return el(
      'div',
      { class: 'ac-root' },
      el('span', { class: 'ac-accent' }, icon(ic)),
      el('div', { class: 'ac-trunc ac-grow' }, el('div', { class: 'eyebrow ac-eyebrow-sm' }, label), text),
      copy,
    );
  }

  // ---------- C17 · Skills ----------
  function skillRoots(d) {
    return d.roots.filter((r) => r.kind === 'home' || r.kind === 'project-claude');
  }

  function skills(d) {
    const list = el('div', { class: 'ac-list' });
    const drawList = () => {
      const found = searchSkills(inScope(d.skills, state.scope), state.search);
      list.replaceChildren(
        ...(found.length
          ? found.map(skillCard)
          : [
              empty({
                icon: 'suggested',
                title: state.search ? 'Nenhuma skill com essa busca' : 'Nenhuma skill neste escopo',
                text: state.search ? `Nada em ${d.skills.length} skill(s) bate com “${state.search}”.` : `Há ${d.summary.skills.total} skill(s) em todos os escopos.`,
              }),
            ]),
      );
    };
    const search = el('input', { type: 'search', 'data-focus': 'search', class: 'ac-input', placeholder: 'Buscar skills…', 'aria-label': 'Buscar skills', value: state.search, autocomplete: 'off', spellcheck: 'false' });
    search.addEventListener('input', () => ((state.search = search.value), drawList()));
    const newButton = el('button', { type: 'button', class: 'btn filled ac-action', 'data-focus': 'new', 'aria-expanded': String(!!state.creating) }, icon('plus'), 'Nova');
    newButton.addEventListener('click', () => {
      const first = skillRoots(d)[0];
      state.creating = state.creating ? null : { name: '', root: first?.id ?? null, error: null };
      pendingFocus = state.creating ? 'new-name' : 'new';
      draw();
    });
    drawList();
    return el(
      'div',
      { class: 'ac-skills' },
      el('div', { class: 'ac-column' }, el('div', { class: 'ac-search-row' }, el('label', { class: 'ac-field' }, icon('search'), search), newButton), state.creating ? newForm(d) : null, list),
      editor(),
    );
  }

  function skillCard(s) {
    const ed = state.editor;
    const open = ed && ed.root === s.root && ed.name === s.name;
    return el(
      'article',
      { class: `card ac-item${open ? ' sel' : ''}` },
      el(
        'div',
        { class: 'ac-item-row' },
        el('span', { class: 'ac-accent' }, icon('suggested')),
        el('b', { class: 'ac-trunc' }, s.name),
        el('span', { class: 'ac-chip' }, SCOPE_LABEL[s.scope] ?? s.scope),
        s.declaredName && s.declaredName !== s.name ? el('span', { class: 'mono ac-muted ac-trunc', title: 'O name do frontmatter' }, `name: ${s.declaredName}`) : null,
      ),
      el('span', { class: `ac-trunc ${s.description ? 'ac-muted' : 'ac-muted ac-italic'}` }, s.description ?? 'Sem descrição no frontmatter'),
      el(
        'div',
        { class: 'ac-item-row ac-item-foot' },
        pathEl(s.path, 'ac-grow'),
        el('button', { type: 'button', class: 'ac-link', 'data-focus': `view:${s.root}/${s.name}`, 'aria-label': `Ver ${s.name}`, onClick: () => switchTo(s, 'view') }, 'Ver'),
        s.editable ? el('button', { type: 'button', class: 'ac-link', 'data-focus': `edit:${s.root}/${s.name}`, 'aria-label': `Editar ${s.name}`, onClick: () => switchTo(s, 'edit') }, 'Editar') : null,
      ),
    );
  }

  function switchTo(s, mode) {
    const ed = state.editor;
    if (ed && ed.root === s.root && ed.name === s.name && !ed.loading && ed.mode !== 'new') {
      if (mode === 'edit' && ed.mode === 'view') {
        ed.mode = 'edit';
        ed.notice = null;
        pendingFocus = 'text';
        draw();
      }
      return;
    }
    if (dirty(ed) && !confirm('Descartar as alterações da skill aberta?')) return;
    openSkill(s, mode);
  }

  async function openSkill(s, mode) {
    const d = state.data;
    const ed = { root: s.root, name: s.name, scope: s.scope, path: s.path, mode, content: '', text: '', version: null, editedAt: s.editedAt ?? null, project: d.project ?? null, loading: true, saving: false, error: null, notice: null };
    state.editor = ed;
    state.creating = null;
    draw();
    const q = new URLSearchParams({ root: s.root, name: s.name });
    if (d.project) q.set('project', d.project);
    try {
      const r = await ctx.read(`/api/agent-config/skill?${q}`);
      if (signal.aborted || state.editor !== ed) return;
      Object.assign(ed, { content: r.content, text: r.content, version: r.version, editedAt: r.editedAt, path: r.path, loading: false });
    } catch (e) {
      if (e?.name === 'AbortError' || signal.aborted || state.editor !== ed) return;
      // Without the read there is no `version`: it stays read-only, without Save (a POST without version would replace the file).
      Object.assign(ed, { loading: false, mode: 'view', error: { title: 'Não abriu.', text: e?.message ?? String(e), action: { label: 'Tentar de novo', onClick: () => openSkill(ed, mode) } } });
    }
    if (mode === 'edit' && !ed.error) pendingFocus = 'text';
    draw();
  }

  function newForm(d) {
    const creating = state.creating;
    const options = skillRoots(d);
    const severalProfiles = options.filter((r) => r.kind === 'home').length > 1;
    const input = el('input', { type: 'text', class: 'ac-input mono', id: 'ac-new-name', 'data-focus': 'new-name', value: creating.name, autocomplete: 'off', spellcheck: 'false', maxlength: '64', placeholder: 'minha-skill', 'aria-describedby': 'ac-new-msg', 'aria-invalid': creating.error ? 'true' : null });
    const msg = el('p', { class: `ac-new-msg${creating.error ? ' error' : ''}`, id: 'ac-new-msg', 'aria-live': 'polite' }, creating.error ?? 'Minúsculas, números, ponto, hífen ou sublinhado.');
    const existing = () => new Set(d.skills.filter((s) => s.root === creating.root).map((s) => s.name));
    input.addEventListener('input', () => {
      creating.name = input.value.trim();
      creating.error = creating.name ? validateSkillName(creating.name, existing()) : null;
      msg.textContent = creating.error ?? 'Minúsculas, números, ponto, hífen ou sublinhado.';
      msg.classList.toggle('error', !!creating.error);
      if (creating.error) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    });
    const choice = el(
      'div',
      { class: 'ac-seg', role: 'group', 'aria-label': 'Onde criar' },
      ...options.map((r) =>
        el(
          'button',
          { type: 'button', 'data-focus': `new-root:${r.id}`, 'aria-pressed': String(creating.root === r.id), title: r.path, onClick: () => ((creating.root = r.id), (creating.error = creating.name ? validateSkillName(creating.name, existing()) : null), draw()) },
          r.kind === 'home' ? (severalProfiles ? `Usuário · ${r.label}` : 'Usuário') : 'Projeto',
        ),
      ),
    );
    const form = el(
      'form',
      { class: 'card ac-new', novalidate: true, 'aria-label': 'Nova skill' },
      el('label', { class: 'eyebrow', for: 'ac-new-name' }, 'Nome da skill'),
      input,
      msg,
      el('div', { class: 'eyebrow' }, 'Escopo'),
      options.length ? choice : el('p', { class: 'ac-muted' }, 'Nenhuma pasta recebe skill aqui.'),
      el(
        'div',
        { class: 'ac-foot' },
        el('button', { type: 'button', class: 'btn outline ac-push', onClick: () => ((state.creating = null), (pendingFocus = 'new'), draw()) }, 'Cancelar'),
        el('button', { type: 'submit', class: 'btn filled ac-action', disabled: !options.length }, icon('plus'), 'Criar'),
      ),
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      creating.name = input.value.trim();
      creating.error = validateSkillName(creating.name, existing());
      const root = options.find((r) => r.id === creating.root);
      if (!creating.error && !root) creating.error = 'Escolha onde criar.';
      if (creating.error) {
        pendingFocus = 'new-name';
        draw();
        return;
      }
      if (dirty(state.editor) && !confirm('Descartar as alterações da skill aberta?')) return;
      state.editor = {
        root: root.id,
        name: creating.name,
        scope: root.scope,
        path: `${root.path}/skills/${creating.name}/SKILL.md`,
        mode: 'new',
        content: '',
        text: skillTemplate(creating.name),
        version: null,
        editedAt: null,
        project: d.project ?? null,
        loading: false,
        saving: false,
        error: null,
        notice: null,
      };
      state.creating = null;
      pendingFocus = 'text';
      draw();
    });
    return form;
  }

  function editor() {
    const ed = state.editor;
    if (!ed) {
      return el(
        'section',
        { class: 'card ac-editor ac-editor-empty' },
        el('div', { class: 'seal' }, icon('file-text')),
        el('p', { class: 'ac-muted' }, 'Escolha uma skill para ver ou editar o SKILL.md, ou crie uma com Nova.'),
      );
    }
    const when = ed.mode === 'new' ? 'nova' : ed.loading ? 'abrindo…' : editedAgo(ed.editedAt);
    const textarea = el('textarea', {
      class: 'ac-text mono',
      'data-focus': 'text',
      'aria-label': `${ed.name} / SKILL.md`,
      spellcheck: 'false',
      readonly: ed.mode === 'view' || ed.loading || ed.saving,
      'aria-busy': ed.loading ? 'true' : null,
    });
    textarea.value = ed.text;
    const footStatus = el('span', { class: 'ac-muted ac-foot-status', 'aria-live': 'polite' });
    const save = el('button', { type: 'button', class: 'btn filled ac-action' }, icon('save'), ed.saving ? 'Salvando…' : 'Salvar com backup');
    const updateFoot = () => {
      save.disabled = !canSave(ed);
      footStatus.replaceChildren(
        ...(ed.mode === 'view'
          ? [icon('lock'), ' Só leitura']
          : dirty(ed) && ed.mode !== 'new'
            ? ['Alterações não salvas']
            : [icon('shield-check'), ed.mode === 'new' ? ' Cria a pasta e o SKILL.md' : ' Toda gravação faz backup antes']),
      );
    };
    textarea.addEventListener('input', () => {
      ed.text = textarea.value;
      if (ed.notice) {
        ed.notice = null;
        area.querySelector('.ac-ok')?.remove();
      }
      updateFoot();
    });
    save.addEventListener('click', () => write(ed));
    const close = el('button', { type: 'button', class: 'btn outline', 'data-focus': 'close' }, ed.mode === 'view' ? 'Fechar' : 'Cancelar');
    close.addEventListener('click', () => {
      if (dirty(ed) && !confirm('Descartar as alterações?')) return;
      if (ed.mode === 'edit') {
        // Cancelling the edit goes back to the text that was read, in read mode.
        Object.assign(ed, { mode: 'view', text: ed.content, error: null, notice: null });
      } else {
        state.editor = null;
        pendingFocus = ed.mode === 'new' ? 'new' : `view:${ed.root}/${ed.name}`;
      }
      draw();
    });
    const editable = state.data?.skills.find((s) => s.root === ed.root && s.name === ed.name)?.editable;
    updateFoot();
    return el(
      'section',
      { class: 'card ac-editor', 'aria-label': `Editor de ${ed.name}` },
      el('div', { class: 'ac-ttl' }, icon('file-text'), el('span', { class: 'ac-trunc' }, `${ed.name} / SKILL.md`), el('span', { class: 'ac-ttl-r' }, `${SCOPE_LABEL[ed.scope] ?? ed.scope} · ${when}`)),
      pathEl(ed.path),
      ed.error ? errorBand(ed.error) : null,
      ed.notice ? el('div', { class: 'ac-ok', role: 'status' }, icon('done'), el('p', {}, ed.notice)) : null,
      textarea,
      el(
        'div',
        { class: 'ac-foot' },
        footStatus,
        close,
        ed.mode === 'view'
          ? editable
            ? el('button', { type: 'button', class: 'btn filled ac-action', 'data-focus': 'edit', disabled: ed.loading || !ed.version, onClick: () => switchTo(ed, 'edit') }, icon('pencil'), 'Editar')
            : null
          : save,
      ),
    );
  }

  async function write(ed) {
    if (!canSave(ed)) return;
    ed.saving = true;
    ed.error = null;
    ed.notice = null;
    draw();
    const body = { root: ed.root, name: ed.name, content: ed.text };
    if (ed.version) body.version = ed.version;
    if (ed.project) body.project = ed.project;
    // New only creates: if the folder already has the skill (another process created it), the core gives 409 instead of replacing.
    if (ed.mode === 'new') body.create = true;
    try {
      // Without the screen's `signal`: leaving midway does not undo the write, and the response still
      // updates the editor (which lives in the module and reappears when the person comes back).
      const r = await ctx.write('/api/agent-config/skill', body, { signal: undefined });
      const created = ed.mode === 'new';
      Object.assign(ed, { content: body.content, version: r.version, editedAt: r.editedAt, path: r.path, mode: 'edit', saving: false });
      ed.notice = r.backup ? `Salvo. O anterior ficou em ${r.backup}` : created ? `Criada em ${r.path}` : `Salvo em ${r.path}`;
      if (r.backup) state.windowBackups.unshift(r.backup);
      if (signal.aborted) return;
      draw();
      load({ quiet: true });
    } catch (e) {
      ed.saving = false;
      ed.error =
        e?.status === 409 && body.create
          ? { titulo: 'Essa skill já existe.', texto: `Alguém criou ${ed.name} nessa pasta depois da última leitura. Feche e abra a que existe, ou use outro nome.` }
          : e?.status === 409
          ? {
              titulo: 'A skill mudou por fora.',
              texto: 'Recarregue para ver a versão do disco. O seu texto continua aqui até você recarregar: copie o que quiser guardar.',
              acao: { rotulo: 'Recarregar', onClick: () => openSkill(ed, 'edit') },
            }
          : { titulo: 'Não salvou.', texto: e?.message ?? String(e) };
      if (signal.aborted) return;
      draw();
    }
  }

  // ---------- Other tabs: read-only lists ----------
  const LISTS = {
    subagents: { key: 'subagents', ic: 'users', none: 'Nenhum subagente', title: (i) => i.name, desc: (i) => i.description, path: (i) => i.path },
    commands: { key: 'commands', ic: 'slash', none: 'Nenhum comando', title: (i) => `/${i.name}`, path: (i) => i.path },
    memory: { key: 'memory', ic: 'book-open', none: 'Nenhuma memória', title: (i) => i.name, extra: (i) => (i.kind === 'auto' ? 'Memória automática' : 'Instruções'), path: (i) => i.path },
    plugins: { key: 'plugins', ic: 'plug', none: 'Nenhum plugin', title: (i) => i.name },
    mcp: { key: 'mcp', ic: 'server', none: 'Nenhum servidor MCP', title: (i) => i.name, extra: (i) => i.source },
    hooks: { key: 'hooks', ic: 'webhook', none: 'Nenhum hook', title: (i) => i.event, desc: (i) => `${i.count} ${i.count === 1 ? 'hook' : 'hooks'}` },
  };

  function simpleList(d, tab) {
    const t = LISTS[tab];
    const items = inScope(d[t.key] ?? [], state.scope);
    if (!items.length) {
      const total = d.summary?.[t.key]?.total ?? 0;
      return empty({
        icon: t.ic,
        title: `${t.none}${state.scope === 'all' ? '' : state.scope === 'user' ? ' do usuário' : ' do projeto'}`,
        text: total ? `Há ${total} em todos os escopos.` : 'Nada configurado nas pastas lidas.',
      });
    }
    return el(
      'div',
      { class: 'ac-list ac-list-wide' },
      ...items.map((i) =>
        el(
          'article',
          { class: 'card ac-item' },
          el(
            'div',
            { class: 'ac-item-row' },
            el('span', { class: 'ac-accent' }, icon(t.ic)),
            el('b', { class: 'ac-trunc' }, t.title(i)),
            el('span', { class: 'ac-chip' }, SCOPE_LABEL[i.scope] ?? i.scope),
            t.extra ? el('span', { class: 'ac-chip' }, t.extra(i)) : null,
          ),
          t.desc?.(i) ? el('span', { class: 'ac-muted ac-trunc' }, t.desc(i)) : null,
          t.path ? pathEl(t.path(i)) : null,
        ),
      ),
    );
  }

  // ---------- Start ----------
  ctx.onRestart(() => load({ quiet: true }));
  // A skill read cut short by leaving the screen starts over (the write is not cut: see `write`).
  const resume = () => state.editor?.loading && state.data && openSkill(state.editor, state.editor.mode);
  if (state.data && state.requested === url.project) {
    draw();
    resume();
    load({ quiet: true });
  } else {
    // Another project: a clean editor goes away; a dirty one stays (it writes to its own project, `ed.project`).
    if (!dirty(state.editor)) state.editor = null;
    state.creating = null;
    await load();
  }
}

/** A path on one line, clipped at the start (the end is what tells them apart), whole in `title`. */
function pathEl(path, extra = '') {
  return el('span', { class: `mono ac-muted ac-trunc ac-small ac-clip-start ${extra}`.trim(), title: path }, el('bdi', { dir: 'ltr' }, path));
}

/** The last two parts of a project path, for the selector. */
function shortName(path) {
  const parts = String(path).split('/').filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

/** Copies `text`; shows "Copiado" on the button. Without a clipboard, selects the path to copy by hand. */
function copyText(text, button, target) {
  const originalLabel = button.getAttribute('aria-label');
  const restore = () => {
    button.classList.remove('ok');
    button.setAttribute('aria-label', originalLabel);
    button.replaceChildren(icon('copy'));
  };
  const show = (label, ok) => {
    button.setAttribute('aria-label', label);
    button.classList.toggle('ok', ok);
    button.replaceChildren(icon(ok ? 'done' : 'copy'), el('span', {}, label));
    setTimeout(restore, 1600);
  };
  const select = () => {
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    show('Copie com ⌘C', false);
  };
  if (!navigator.clipboard?.writeText) return select();
  navigator.clipboard.writeText(text).then(() => show('Copiado', true), select);
}
