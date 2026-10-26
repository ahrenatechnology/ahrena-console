// Choosing the Project of the project kanban (wireframe C43, issue 241, decision 0011 §7), with no
// environment variable: the Projects the account sees, from `GET /api/project/options`, and the choice
// saved by `POST /api/project/selection` `{ owner, number, field }` in the installation's settings.
//
// - `mountPicker` is the C43 1100 list (search, owner filter, closed hidden, the field that becomes the
//   columns, Usar). `createSwitch` is the C43 1440 "Trocar de Project" popover of the board's header.
// - Options errors: 409 `github-not-connected` goes back to the caller (the shared C42 empty state),
//   429 `rate-limited` waits, 502 `github-down` (no answer) or `github-refused` (GitHub's message),
//   401 `no-scope`, 503 `off`; a stale list shows a band.
// - `owners` (issue 340): an organization (or the person) whose Projects GitHub refused shows in a band with
//   the reason and the link that fixes it, and the other owners keep their Projects.
// - With `AHRENA_CONSOLE_PROJECT` set (`envOverride`), the board follows the variable and the choice on
//   screen is not editable: the caller shows `envBand` instead of the switch.
// - Project titles and owners come from GitHub: `textContent` only.

import { el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { isGithubNotConnected } from '../github-connect.js';

export const OPTIONS_ROUTE = '/api/project/options';
const STYLE = '/ui/screens/project-picker.css';
export const SELECTION_ROUTE = '/api/project/selection';
const DEFAULT_FIELD = 'Status';
const FIELD = /^[^\u0000-\u001f]{1,100}$/u;

const valid = (p) => p && typeof p.owner === 'string' && Number.isInteger(p.number) && p.number > 0;
export const projectKey = (p) => (p ? `${String(p.owner).toLowerCase()}/${p.number}` : '');

/** The owner filter of the list: everyone, the person's own and one per organization. */
export function ownerFilters(projects) {
  const shown = projects.filter(valid);
  const orgs = [...new Set(shown.filter((p) => p.ownerType === 'organization').map((p) => p.owner))].sort((a, b) => a.localeCompare(b));
  const out = [{ id: 'all', label: `Todos · ${shown.length}` }];
  if (shown.some((p) => p.ownerType !== 'organization')) out.push({ id: 'mine', label: 'Seus' });
  for (const o of orgs) out.push({ id: `org:${o}`, label: o });
  return out;
}

/** The Projects that pass the search, the owner filter and the closed toggle. */
export function filterProjects(projects, { query = '', owner = 'all', showClosed = false } = {}) {
  const q = query.trim().toLowerCase();
  return projects.filter(valid).filter((p) => {
    if (!showClosed && p.closed) return false;
    if (owner === 'mine' && p.ownerType === 'organization') return false;
    if (owner.startsWith('org:') && p.owner !== owner.slice(4)) return false;
    if (!q) return true;
    return `${p.title ?? ''} ${p.owner} #${p.number}`.toLowerCase().includes(q);
  });
}

/** The field the columns come from: the typed name, or `Status`; `null` when it is not a valid name. */
export function fieldOf(text) {
  const t = String(text ?? '').trim() || DEFAULT_FIELD;
  return FIELD.test(t) ? t : null;
}

/** An options or selection failure in pt-BR: `{ title, text }`. */
export function optionsErrorText(e) {
  const code = e?.body?.code ?? e?.body?.error;
  const wait = e?.retryIn ? ` Tente de novo em ${Math.ceil(e.retryIn / 1000)} s.` : ' Tente de novo em instantes.';
  if (e?.status === 429 || code === 'rate-limited') return { title: 'O GitHub limitou as chamadas', text: `A lista dos Projects volta quando o limite passar.${wait}` };
  if (code === 'github-refused') return { title: 'O GitHub recusou a lista', text: e?.body?.error ? `${e.body.error}.` : 'Não deu para ler os seus Projects.' };
  if (code === 'no-scope') return { title: 'Falta permissão no GitHub', text: e?.body?.error ? `${e.body.error}.` : 'Reconecte o GitHub em Conexões.' };
  if (e?.status === 502 || code === 'github-down') return { title: 'O GitHub não respondeu', text: 'Não deu para ler os seus Projects, e não há lista guardada.' };
  if (e?.status === 503 || code === 'off') return { title: 'O núcleo subiu sem o GitHub', text: 'Ele foi iniciado com --no-github: não há Projects para escolher. Reinicie o núcleo sem essa opção.' };
  if (e?.status === 400 || code === 'invalid') return { title: 'O núcleo recusou essa escolha', text: 'Confira o Project e o nome do campo que vira colunas.' };
  if (e?.status === 403) return { title: 'O núcleo recusou o pedido', text: 'Só a própria janela do console escolhe o Project.' };
  if (!e?.status) return { title: 'Sem conexão com o núcleo', text: e?.message ?? 'O núcleo não respondeu.' };
  return { title: 'Não deu certo', text: `O núcleo respondeu ${e.status}.` };
}

/** What blocks an owner, in pt-BR, and the label of the link that fixes it. */
export function blockedText(owner) {
  const reason = owner?.blocked?.reason;
  if (reason === 'oauth-restricted')
    return { text: 'restringe apps OAuth e ainda não aprovou o Ahrena Console. Na página do app no GitHub, em Organization access, peça (Request) ou conceda (Grant) o acesso a ela e atualize.', link: 'Abrir o app no GitHub' };
  if (reason === 'saml') return { text: 'exige login pelo SSO (SAML) da organização. Entre pelo SSO no GitHub e atualize.', link: 'Entrar pelo SSO' };
  return { text: `o GitHub recusou: ${owner?.blocked?.message ?? 'sem motivo informado'}`, link: null };
}

/** Issue 340: the owners whose Projects GitHub refused, each with the reason and the fix; `null` when none. */
export function blockedBand(owners, onRefresh) {
  const blocked = (Array.isArray(owners) ? owners : []).filter((o) => o && typeof o.login === 'string' && o.blocked);
  if (!blocked.length) return null;
  const rows = blocked.map((o) => {
    const t = blockedText(o);
    const count = Number.isInteger(o.projects) && o.projects > 0 ? ` (${o.projects} ${o.projects === 1 ? 'Project' : 'Projects'})` : '';
    const link = t.link && typeof o.fixUrl === 'string' && /^https:\/\/github\.com\//.test(o.fixUrl) ? el('a', { href: o.fixUrl, target: '_blank', rel: 'noopener noreferrer', class: 'pp-link' }, t.link, ' ', icon('external')) : null;
    return el('li', { 'data-owner': o.login, 'data-reason': o.blocked.reason }, el('b', {}, o.login), count, ' ', t.text, link ? ' ' : null, link);
  });
  const action = el('button', { type: 'button', class: 'btn outline', 'data-action': 'refresh-owners' }, 'Atualizar');
  action.addEventListener('click', () => onRefresh?.());
  return el(
    'div',
    { class: 'pp-band', role: 'status', 'data-band': 'blocked-owners' },
    el('span', { class: 'pp-band-ic' }, icon('info')),
    el(
      'div',
      { class: 'pp-band-body' },
      el('p', {}, el('b', {}, blocked.length === 1 ? 'Uma organização não mostrou os Projects dela.' : `${blocked.length} donos não mostraram os Projects deles.`), ' As outras aparecem abaixo.'),
      el('ul', { class: 'pp-blocked' }, ...rows),
      el('p', { class: 'pp-muted' }, 'Organizações privadas que não aprovaram o app nem aparecem aqui: o GitHub as esconde. Veja Conexões › GitHub.'),
    ),
    action,
  );
}

/** The `AHRENA_CONSOLE_PROJECT` band (C44): the board follows the variable; the screen's choice waits. */
export function envBand(envOverride) {
  return el(
    'div',
    { class: 'pp-band', role: 'status', 'data-band': 'env-override' },
    el('span', { class: 'pp-band-ic' }, icon('info')),
    el('p', {}, el('b', {}, `${envOverride?.variable ?? 'AHRENA_CONSOLE_PROJECT'} está definida. `), `O Kanban do projeto mostra ${envOverride?.value ?? 'o Project dela'} por ela, e a escolha da tela fica guardada para quando a variável sair.`),
  );
}

/** The picker's CSS, once per page (it stays loaded when the screen changes, like every screen's). */
export function loadPickerStyle() {
  const doc = globalThis.document;
  if (!doc?.head || typeof doc.querySelector !== 'function' || doc.querySelector('link[data-screen="project-picker"]')) return;
  doc.head.append(el('link', { rel: 'stylesheet', href: STYLE, 'data-screen': 'project-picker' }));
}

async function save(ctx, project, field) {
  return ctx.write(SELECTION_ROUTE, { owner: project.owner, number: project.number, field });
}

/**
 * C43 1100: the list to choose from. Calls `onSaved(answer)` after the core keeps the choice, and
 * `onNotConnected()` on 409 `github-not-connected`. Returns `{ reload }`.
 */
export function mountPicker(box, ctx, { onSaved, onNotConnected }) {
  let data = null;
  let failure = null;
  let query = '';
  let owner = 'all';
  let showClosed = false;
  let chosen = null; // projectKey
  const fields = new Map(); // projectKey → the typed field
  let saving = false;
  let saveFailure = null;
  let request = 0;

  const search = el('input', { type: 'search', class: 'pp-search-input', placeholder: 'Buscar Projects…', 'aria-label': 'Buscar Projects' });
  search.addEventListener('input', () => {
    query = search.value;
    drawList();
  });
  const seg = el('div', { class: 'pp-seg', role: 'group', 'aria-label': 'Dono do Project' });
  const closedToggle = el('button', { type: 'button', class: 'pp-chip', 'aria-pressed': 'false' });
  closedToggle.addEventListener('click', () => {
    showClosed = !showClosed;
    drawFilters();
    drawList();
  });
  const filtersCard = el('div', { class: 'card pp-filters' }, el('label', { class: 'pp-search' }, icon('search'), search), seg, closedToggle);
  const band = el('div', { class: 'pp-bands' });
  const listBox = el('div', { class: 'pp-list' });
  const footer = el('div', { class: 'pp-foot' });

  async function reload({ refresh = false } = {}) {
    const n = ++request;
    if (!data) box.replaceChildren(loading({ label: 'Lendo os seus Projects' }));
    try {
      const d = await ctx.read(refresh ? `${OPTIONS_ROUTE}?refresh=1` : OPTIONS_ROUTE);
      if (n !== request) return;
      data = d;
      failure = null;
      const sel = d?.selection;
      if (!chosen && sel && valid(sel)) {
        chosen = projectKey(sel);
        if (sel.field) fields.set(chosen, sel.field);
      }
    } catch (e) {
      if (e?.name === 'AbortError' || n !== request) return;
      if (isGithubNotConnected(e)) return onNotConnected?.();
      failure = e;
    }
    draw();
  }

  function draw() {
    if (!data) {
      const t = optionsErrorText(failure);
      return box.replaceChildren(error({ title: t.title, text: t.text, retry: () => reload({ refresh: true }) }));
    }
    band.replaceChildren();
    if (data.envOverride) band.append(envBand(data.envOverride));
    if (failure) {
      const t = optionsErrorText(failure);
      band.append(errorBand({ title: `${t.title}.`, text: `${t.text} Mostrando a última lista.`, action: { label: 'Tentar de novo', onClick: () => reload({ refresh: true }) } }));
    } else if (data.stale) band.append(errorBand({ title: 'GitHub indisponível.', text: `Mostrando a lista em cache.${data.reason ? ` ${data.reason}` : ''}`, action: { label: 'Tentar agora', onClick: () => reload({ refresh: true }) } }));
    const blocked = blockedBand(data.owners, () => reload({ refresh: true }));
    if (blocked) band.append(blocked);
    if (saveFailure) {
      const t = optionsErrorText(saveFailure);
      band.append(errorBand({ title: `${t.title}.`, text: t.text }));
    }
    if (band.firstChild) band.removeAttribute('hidden');
    else band.setAttribute('hidden', '');
    const projects = Array.isArray(data.projects) ? data.projects : [];
    if (!projects.filter(valid).length) {
      return box.replaceChildren(
        band,
        blocked
          ? empty({ icon: 'kanban', title: 'Nenhum GitHub Project liberado', text: 'Os Projects que a conta enxerga estão nas organizações acima, que não liberaram o acesso. Libere uma delas e atualize.' })
          : empty({ icon: 'kanban', title: 'Nenhum GitHub Project na conta', text: 'A conta conectada não enxerga nenhum Project, nem seu nem das organizações. Crie um Project no GitHub e atualize.', action: { label: 'Atualizar', icon: 'refresh', onClick: () => reload({ refresh: true }) } }),
      );
    }
    drawFilters();
    drawList();
    if (!box.contains(filtersCard)) box.replaceChildren(band, filtersCard, listBox, footer);
  }

  function drawFilters() {
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    const opts = ownerFilters(projects);
    if (!opts.some((o) => o.id === owner)) owner = 'all';
    seg.replaceChildren(
      ...opts.map((o) => {
        const b = el('button', { type: 'button', class: `pp-seg-option${o.id === owner ? ' on' : ''}`, 'aria-pressed': o.id === owner ? 'true' : 'false', 'data-owner': o.id }, o.label);
        b.addEventListener('click', () => {
          owner = o.id;
          drawFilters();
          drawList();
        });
        return b;
      }),
    );
    closedToggle.setAttribute('aria-pressed', showClosed ? 'true' : 'false');
    closedToggle.replaceChildren(icon(showClosed ? 'eye' : 'circle-dashed'), showClosed ? 'fechados visíveis' : 'fechados ocultos');
  }

  function drawList() {
    const projects = filterProjects(Array.isArray(data?.projects) ? data.projects : [], { query, owner, showClosed });
    if (!projects.length) {
      listBox.replaceChildren(empty({ icon: 'search', title: 'Nenhum Project com esse filtro', text: 'Mude a busca, o dono ou mostre os fechados.' }));
    } else {
      listBox.replaceChildren(
        el(
          'section',
          { class: 'card pp-table-card' },
          el(
            'table',
            { class: 'pp-table' },
            el('colgroup', {}, el('col', { class: 'pp-c-radio' }), el('col', { class: 'pp-c-name' }), el('col', { class: 'pp-c-items' }), el('col', { class: 'pp-c-field' })),
            el('thead', {}, el('tr', {}, el('th', { scope: 'col', 'aria-label': 'Escolhido' }), el('th', { scope: 'col' }, 'Project'), el('th', { scope: 'col' }, 'Itens'), el('th', { scope: 'col' }, 'Colunas por'))),
            el('tbody', {}, ...projects.map(projectRow)),
          ),
        ),
      );
    }
    drawFooter();
  }

  function projectRow(p) {
    const key = projectKey(p);
    const on = key === chosen;
    const radio = el('input', { type: 'radio', name: 'pp-project', class: 'pp-radio', value: key, 'aria-label': `${p.title || `${p.owner} #${p.number}`}`, checked: on });
    radio.addEventListener('change', () => pick(key));
    const fieldInput = el('input', { type: 'text', class: 'pp-field', value: fields.get(key) ?? (p.hasStatusField ? DEFAULT_FIELD : ''), placeholder: 'Nome do campo', 'aria-label': `Campo que vira colunas em ${p.title || p.owner}`, maxlength: '100' });
    fieldInput.value = fields.get(key) ?? (p.hasStatusField ? DEFAULT_FIELD : '');
    fieldInput.addEventListener('input', () => {
      fields.set(key, fieldInput.value);
      if (chosen !== key) pick(key, { keepFocus: true });
      else drawFooter();
    });
    const tr = el(
      'tr',
      { class: on ? 'pp-row on' : 'pp-row', 'data-project': key },
      el('td', {}, radio),
      el('td', { class: 'pp-name' }, el('b', {}, p.title || 'Sem título'), el('small', { class: 'mono' }, `${p.owner} · #${p.number}`, p.closed ? ' · fechado' : '')),
      el('td', { class: 'mono' }, String(Number.isFinite(p.items) ? p.items : 0)),
      el('td', {}, fieldInput, p.hasStatusField ? null : el('span', { class: 'pp-nofield' }, 'sem campo Status')),
    );
    tr.addEventListener('click', (ev) => {
      if (ev.target && typeof ev.target.closest === 'function' && ev.target.closest('input')) return;
      pick(key);
    });
    return tr;
  }

  function pick(key, { keepFocus = false } = {}) {
    chosen = key;
    saveFailure = null;
    if (keepFocus) {
      for (const tr of listBox.querySelectorAll('tr[data-project]')) {
        const on = tr.getAttribute('data-project') === key;
        tr.classList.toggle('on', on);
        const radio = tr.querySelector('input');
        if (radio) radio.checked = on;
      }
      drawFooter();
    } else drawList();
  }

  function drawFooter() {
    const p = (Array.isArray(data?.projects) ? data.projects : []).find((x) => valid(x) && projectKey(x) === chosen);
    const field = p ? fieldOf(fields.get(chosen) ?? (p.hasStatusField ? DEFAULT_FIELD : '')) : null;
    const typed = p ? String(fields.get(chosen) ?? (p.hasStatusField ? DEFAULT_FIELD : '')).trim() : '';
    const ready = Boolean(p && field && typed) && !data?.envOverride;
    const use = el('button', { type: 'button', class: 'btn filled', 'data-action': 'use-project', disabled: !ready || saving, 'aria-busy': saving ? 'true' : null }, icon('done'), p ? `Usar “${p.title || `${p.owner} #${p.number}`}”` : 'Usar');
    use.addEventListener('click', async () => {
      if (!ready || saving) return;
      saving = true;
      saveFailure = null;
      drawFooter();
      try {
        const r = await save(ctx, p, field);
        saving = false;
        onSaved?.(r);
      } catch (e) {
        if (e?.name === 'AbortError') return;
        saving = false;
        if (isGithubNotConnected(e)) return onNotConnected?.();
        saveFailure = e;
        draw();
      }
    });
    const hint = !p ? 'Escolha um Project da lista.' : typed ? 'Fica nas preferências deste console. Você troca quando quiser, no cabeçalho do quadro.' : 'Esse Project não tem campo Status: escreva o nome do campo de seleção que vira colunas.';
    footer.replaceChildren(el('span', { class: 'pp-hint' }, icon('info'), hint), use);
  }

  reload();
  return { reload };
}

/**
 * C43 1440: "Trocar de Project" in the board's header, a popover with the search, the Projects and the
 * field. `current()` is the board's selection; `onSaved(answer)` runs after the core keeps the choice.
 */
export function createSwitch(ctx, { current, onSaved, onNotConnected }) {
  let open = false;
  let data = null;
  let failure = null;
  let query = '';
  let busy = false;
  let fieldText = null;

  const button = el('button', { type: 'button', class: 'btn outline', 'aria-expanded': 'false', 'aria-haspopup': 'dialog', 'data-action': 'switch-project' }, icon('repeat'), 'Trocar de Project', icon('chevron-down'));
  const pop = el('div', { class: 'card pp-pop', role: 'dialog', 'aria-label': 'Trocar de Project', hidden: true });
  const search = el('input', { type: 'search', class: 'pp-search-input', placeholder: 'Buscar Projects…', 'aria-label': 'Buscar Projects' });
  search.addEventListener('input', () => {
    query = search.value;
    drawItems();
  });
  const items = el('div', { class: 'pp-pop-items' });
  const field = el('input', { type: 'text', class: 'pp-field', 'aria-label': 'Campo que vira colunas', maxlength: '100' });
  field.addEventListener('input', () => (fieldText = field.value));
  const message = el('div', { class: 'pp-pop-msg' });
  pop.append(el('label', { class: 'pp-search' }, icon('search'), search), items, message, el('label', { class: 'pp-pop-field' }, el('span', {}, 'Colunas por'), field));
  const node = el('span', { class: 'pp-switch' }, button, pop);

  button.addEventListener('click', () => toggle(!open));
  pop.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    toggle(false);
    button.focus();
  });
  const outside = (ev) => {
    if (!open || !ev?.target || typeof node.contains !== 'function' || node.contains(ev.target)) return;
    toggle(false);
  };
  globalThis.document?.addEventListener?.('click', outside);
  ctx.signal?.addEventListener?.('abort', () => globalThis.document?.removeEventListener?.('click', outside));

  function toggle(next) {
    open = next;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) pop.removeAttribute('hidden');
    else pop.setAttribute('hidden', '');
    if (!open) return;
    if (fieldText === null) field.value = current()?.field ?? DEFAULT_FIELD;
    drawItems();
    search.focus?.();
    load();
  }

  async function load() {
    try {
      data = await ctx.read(OPTIONS_ROUTE);
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      if (isGithubNotConnected(e)) {
        toggle(false);
        return onNotConnected?.();
      }
      failure = e;
    }
    drawItems();
  }

  function drawItems() {
    message.replaceChildren();
    if (failure) {
      const t = optionsErrorText(failure);
      message.append(el('p', { class: 'pp-pop-error', role: 'alert' }, el('b', {}, `${t.title}. `), t.text));
    } else if (data?.stale) message.append(el('p', { class: 'pp-hint' }, 'Lista em cache: o GitHub não respondeu.'));
    if (!data) {
      if (!failure) items.replaceChildren(el('p', { class: 'pp-hint' }, 'Lendo os seus Projects…'));
      else items.replaceChildren();
      return;
    }
    const cur = projectKey(current());
    const list = filterProjects(Array.isArray(data.projects) ? data.projects : [], { query });
    if (!list.length) return items.replaceChildren(el('p', { class: 'pp-hint' }, 'Nenhum Project com essa busca.'));
    items.replaceChildren(
      ...list.map((p) => {
        const on = projectKey(p) === cur;
        const b = el(
          'button',
          { type: 'button', class: `pp-pop-item${on ? ' on' : ''}`, 'aria-current': on ? 'true' : null, 'data-project': projectKey(p), disabled: busy },
          el('span', { class: on ? 'pp-accent' : 'pp-muted' }, icon(on ? 'done' : 'kanban')),
          el('span', { class: 'pp-trunc' }, p.title || 'Sem título'),
          el('span', { class: 'pp-muted mono pp-pop-owner' }, `${p.owner} #${p.number}`),
        );
        b.addEventListener('click', () => choose(p));
        return b;
      }),
    );
  }

  async function choose(p) {
    const f = fieldOf(field.value);
    if (!f) {
      message.replaceChildren(el('p', { class: 'pp-pop-error', role: 'alert' }, 'Escreva o nome do campo que vira colunas.'));
      return;
    }
    busy = true;
    drawItems();
    try {
      const r = await save(ctx, p, f);
      busy = false;
      toggle(false);
      onSaved?.(r);
    } catch (e) {
      busy = false;
      if (e?.name === 'AbortError') return;
      if (isGithubNotConnected(e)) {
        toggle(false);
        return onNotConnected?.();
      }
      failure = e;
      drawItems();
    }
  }

  return { node, close: () => toggle(false) };
}
