// Ferramentas (C72 to C76, issue 280, decision 0014), in Controle: the CLIs, platforms, containers and
// MCP servers of this machine and, with the selector, of each remote (`?machine=<id>`).
//
// Reads `GET /api/tools?machine=<id>` and `GET /api/machines` (the selector shows only when there is
// a remote). Writes, all through `ctx.write`:
// - `POST /api/tools/checks { machine }` (Verificar agora, Rodei, verificar de novo);
// - `POST /api/tools/mcp/checks { machine }` (Verificar conexões);
// - `POST /api/tools/<toolId>/actions/<actionId> { planDigest, machine }`, only after the confirm
//   dialog showed every step the core sent ("Vai rodar, exatamente"); a 409 brings the new plan,
//   which the dialog shows and asks again. "Atualizar N" confirms the whole list once, then POSTs one
//   item at a time, in order;
// - `DELETE /api/tools/jobs/<id>` (Cancelar).
// The screen never builds a command: what it copies or shows is the core's argv, joined by spaces.
// Live: re-reads on `/api/changes` type `tools`, on a restart, and every 2 s while a job runs or a
// first check is reading. What each part shows comes from tools-format.js (no DOM there).

import { header, el, icon } from '../dom.js';
import { loading, error } from '../states.js';
import {
  CHECKS_ROUTE,
  DASH,
  FILTERS,
  LOCAL_ID,
  MACHINES_ROUTE,
  MCP_CHECKS_ROUTE,
  POLL_MS,
  actionFromPlan,
  actionLabel,
  argvLine,
  bulkConfirmView,
  confirmView,
  containerBadge,
  containerDisk,
  containerRows,
  filterCounts,
  filterItems,
  isRemote,
  itemBadge,
  jobBand,
  jobClock,
  jobOf,
  jobRoute,
  jobSteps,
  machineBand,
  machineFromSearch,
  mainAction,
  mcpAction,
  mcpBadge,
  mcpNote,
  mcpScope,
  mcpSource,
  normalizeOverview,
  queueLine,
  remotesOf,
  rowAction,
  runtimeLabel,
  screenUrl,
  statCards,
  subtitleOf,
  timeOfDay,
  toolsRoute,
  actionRoute,
  updatable,
  busy,
} from './tools-format.js';

const STYLE = '/ui/screens/tools.css';

function attachSheet() {
  const already = document.head.querySelector('link[data-screen="tools"]');
  if (already) return already;
  const link = el('link', { rel: 'stylesheet', href: STYLE, 'data-screen': 'tools' });
  document.head.append(link);
  return link;
}

const badge = ([tone, label]) => el('span', { class: `badge ${tone}` }, el('span', { class: 'p' }), label);
const version = (v, cls = '') => (v ? el('span', { class: `mono tl-ver ${cls}`.trim(), title: v }, v) : el('span', { class: 'tl-muted' }, DASH));
const button = (cls, iconName, label, onClick, attrs = {}) => el('button', { type: 'button', class: `btn ${cls}`, onClick, ...attrs }, iconName ? icon(iconName) : null, label);

/** Copies `text`; the button says "Copiado" for a moment. Without a clipboard, says how to copy. */
function copy(text, btn) {
  const original = [...btn.childNodes];
  const show = (label, ok) => {
    btn.replaceChildren(icon(ok ? 'done' : 'copy'), label);
    setTimeout(() => btn.replaceChildren(...original), 1600);
  };
  const clipboard = globalThis.navigator?.clipboard;
  if (!clipboard?.writeText) return show('Selecione e copie', false);
  clipboard.writeText(text).then(
    () => show('Copiado', true),
    () => show('Não deu para copiar', false),
  );
}

function card(iconName, title, small, body, cls = '') {
  return el('section', { class: `card tl-card ${cls}`.trim() }, el('h2', { class: 'tl-title' }, icon(iconName), el('span', {}, title), small ? el('span', { class: 'tl-small' }, ...[small].flat()) : null), ...[body].flat());
}

const kv = (rows) => el('div', { class: 'tl-kv' }, ...rows.flatMap(([k, v]) => [el('span', {}, k), el('span', {}, v)]));

export async function mount(area, ctx) {
  const sheet = attachSheet();
  ctx.signal.addEventListener('abort', () => sheet.remove());

  let machine = machineFromSearch(globalThis.location?.search);
  let remotes = [];
  let data = null;
  let failure = null;
  let filter = 'all';
  const openSudo = new Set();
  const closedBands = new Set();
  let notice = null; // { tone, text }: the result of a write that has no other place
  let dialog = null; // the open confirm (a node kept across redraws)
  let pollTimer = null;
  let reading = null;
  let checking = false;
  let mcpChecking = false;

  const now = () => Date.now();
  const content = el('div', { class: 'tl-screen' });
  area.replaceChildren(header({ icon: 'wrench', title: 'Ferramentas', sub: 'Lendo as ferramentas…' }), loading({ label: 'Lendo as ferramentas' }));

  async function load() {
    if (reading) return reading;
    reading = (async () => {
      try {
        const [machines, body] = await Promise.all([ctx.read(MACHINES_ROUTE).catch(() => []), ctx.read(toolsRoute(machine))]);
        remotes = remotesOf(machines);
        const o = normalizeOverview(body);
        if (!o) throw new Error('A resposta do núcleo não tem o formato de /api/tools.');
        data = o;
        failure = null;
      } catch (e) {
        if (e?.name === 'AbortError') return;
        failure = e;
      } finally {
        reading = null;
      }
      draw();
      schedule();
    })();
    return reading;
  }

  function schedule() {
    clearTimeout(pollTimer);
    if (ctx.signal.aborted || !busy(data)) return;
    pollTimer = setTimeout(load, POLL_MS);
  }
  ctx.signal.addEventListener('abort', () => clearTimeout(pollTimer));

  function switchMachine(id) {
    if (id === machine) return;
    machine = id;
    data = null;
    filter = 'all';
    openSudo.clear();
    notice = null;
    globalThis.history?.replaceState?.(null, '', screenUrl(id));
    area.replaceChildren(head(), loading({ label: 'Lendo as ferramentas' }));
    load();
  }

  // ---------- writes ----------

  async function post(route, body, options) {
    try {
      return { ok: true, answer: await ctx.write(route, body, options) };
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      return { ok: false, error: e };
    }
  }

  async function runChecks() {
    checking = true;
    draw();
    const r = await post(CHECKS_ROUTE, { machine });
    checking = false;
    notice = r.ok ? null : { tone: 'error', text: `Não verificou: ${r.error.message}` };
    await load();
  }

  async function runMcpChecks() {
    mcpChecking = true;
    draw();
    const r = await post(MCP_CHECKS_ROUTE, { machine });
    mcpChecking = false;
    notice = r.ok ? null : { tone: 'error', text: `Não verificou as conexões: ${r.error.message}` };
    await load();
  }

  async function cancelJob(job) {
    const r = await post(jobRoute(job.id), undefined, { method: 'DELETE' });
    if (!r.ok) notice = { tone: 'error', text: `Não cancelou: ${r.error.message}` };
    await load();
  }

  /**
   * POSTs one action. A 409 brings the plan the core would build now: the dialog shows it and asks
   * again (`retry` decides). Returns true when the job went to the queue.
   */
  async function postAction(target, action, retry) {
    const toolId = target.toolId ?? target.id;
    const r = await post(actionRoute(toolId, action.id), { planDigest: action.planDigest, machine });
    if (r.ok) return true;
    if (r.error?.status === 409) {
      const fresh = actionFromPlan(action, r.error.body?.plan);
      if (fresh) return retry(fresh);
    }
    notice = { tone: 'error', text: `Não rodou ${target.label ?? target.name ?? runtimeLabel(target.runtime)}: ${r.error.message}` };
    return false;
  }

  function confirmOne(target, action, { changed = false } = {}) {
    const view = confirmView(data, target, action, { changed });
    openDialog(view, async () => {
      const ok = await postAction(target, action, (fresh) => (confirmOne({ ...target, actions: [fresh] }, fresh, { changed: true }), false));
      if (ok) notice = null;
      await load();
    });
  }

  function confirmAll() {
    const list = updatable(data);
    if (!list.length) return;
    openDialog(bulkConfirmView(data, list), () => runSequence(list));
  }

  /** "Atualizar N": one POST per item, in order; a 409 stops to ask about that item, then goes on. */
  async function runSequence(list) {
    for (let i = 0; i < list.length; i++) {
      const { item, action } = list[i];
      const rest = list.slice(i + 1);
      let resumed = false;
      const ok = await postAction(item, action, (fresh) => {
        resumed = true;
        const view = confirmView(data, item, fresh, { changed: true });
        openDialog(view, async () => {
          if (await postAction(item, fresh, () => false)) await runSequence(rest);
          else await load();
        });
        return false;
      });
      if (resumed) return load();
      if (!ok) break;
    }
    await load();
  }

  // ---------- the confirm dialog ----------

  function openDialog(view, onConfirm) {
    const close = () => {
      dialog = null;
      draw();
    };
    const ok = button('filled', 'resume', view.ok, async () => {
      ok.disabled = true;
      ok.setAttribute('aria-busy', 'true');
      dialog = null;
      draw();
      await onConfirm();
    });
    const box = el(
      'div',
      { class: 'tl-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': view.title },
      el('div', { class: 'tl-dialog-head' }, icon('arrow-up-circle'), el('b', {}, view.title), button('tl-icon-btn', 'x', '', close, { 'aria-label': 'Fechar' })),
      view.changed ? el('p', { class: 'tl-changed', role: 'alert' }, icon('info'), 'O plano mudou desde que a tela leu (o cache foi refeito). Confira o comando novo antes de rodar.') : null,
      kv(view.rows),
      el(
        'div',
        { class: 'tl-dialog-cmd' },
        el('div', { class: 'eyebrow' }, 'Vai rodar, exatamente'),
        ...view.steps.map((s, i) => el('code', { class: 'mono' }, view.labels ? el('span', { class: 'tl-cmd-label' }, `${i + 1}. ${view.labels[i]}`) : null, s)),
      ),
      el('div', { class: 'tl-dialog-note' }, icon('shield-check'), el('span', {}, view.note)),
      el('div', { class: 'tl-dialog-actions' }, button('outline', null, 'Cancelar', close), ok),
    );
    box.addEventListener('keydown', (ev) => ev.key === 'Escape' && close());
    dialog = el('div', { class: 'tl-veil' }, box);
    draw();
    ok.focus?.();
  }

  // ---------- pieces ----------

  function head() {
    const actions = [];
    if (remotes.length) {
      const choices = [{ id: LOCAL_ID, label: 'Esta máquina', icon: 'monitor' }, ...remotes.map((r) => ({ ...r, icon: 'server' }))];
      actions.push(el('div', { class: 'tl-seg', role: 'group', 'aria-label': 'Máquina' }, ...choices.map((c) => el('button', { type: 'button', 'aria-pressed': String(c.id === machine), onClick: () => switchMachine(c.id) }, icon(c.icon), c.label))));
    }
    if (data && !data.stale) {
      actions.push(button('outline', 'refresh', checking ? 'Verificando…' : 'Verificar agora', runChecks, { disabled: checking || null, 'aria-busy': checking ? 'true' : null, 'data-action': 'check' }));
      const n = updatable(data).length;
      const running = data.jobs.current ? 1 + data.jobs.queue.length : 0;
      if (running) actions.push(button('filled tl-off', 'wall-loader', `Atualizando · ${running} na fila`, null, { disabled: true, 'aria-busy': 'true' }));
      else if (n) actions.push(button('filled', 'arrow-up-circle', `Atualizar ${n}${isRemote(data) ? ' lá' : ''}`, confirmAll, { 'data-action': 'update-all' }));
    }
    return header({ icon: 'wrench', title: 'Ferramentas', sub: data ? subtitleOf(data, now()) : null, actions });
  }

  function stats() {
    const cards = statCards(data);
    return el(
      'div',
      { class: `tl-stats${cards.length === 3 ? ' tl-stats-3' : ''}` },
      ...cards.map((c) =>
        el(
          'div',
          { class: 'card tl-stat', 'data-card': c.id },
          el('span', { class: 'tl-stat-label' }, c.label),
          el('span', { class: `tl-stat-ic tl-tone-${c.tone}` }, icon(c.icon)),
          el('span', { class: 'tl-stat-v' }, c.value),
          el('span', { class: 'tl-stat-s' }, c.sub),
        ),
      ),
    );
  }

  function band(b) {
    const ICON = { stale: 'offline', offline: 'offline', 'no-homebrew': 'package-x', 'no-winget': 'package-x', 'read-only': 'eye', 'remote-actions': 'server', 'all-ok': 'ok' };
    const TONE = { stale: 'tl-band-error', 'all-ok': 'tl-band-ok', 'no-homebrew': 'tl-band-warn', 'no-winget': 'tl-band-warn' };
    const actions = [];
    const extra = [];
    if (b.kind === 'stale') actions.push(el('a', { class: 'btn outline', href: `/ui/machines/${encodeURIComponent(data.machine.id)}` }, icon('server'), `Abrir a ${data.machine.label}`));
    if (b.kind === 'offline') actions.push(button('outline', 'refresh', 'Tentar agora', load));
    if (b.kind === 'no-homebrew') {
      if (b.command) {
        const code = el('code', { class: 'mono' }, b.command);
        const btn = button('outline', 'copy', 'Copiar', () => copy(b.command, btn));
        extra.push(el('div', { class: 'tl-copy' }, code, btn), el('p', { class: 'tl-hint' }, 'É o comando oficial do Homebrew. Leia antes de rodar.'));
      }
      actions.push(button('outline', 'refresh', 'Rodei, verificar de novo', runChecks));
    }
    if (b.kind === 'no-winget') actions.push(button('outline', 'refresh', 'Verificar de novo', runChecks));
    return el(
      'div',
      { class: `tl-band ${TONE[b.kind] ?? ''}`.trim(), 'data-band': b.kind, role: b.kind === 'stale' ? 'alert' : null },
      el('span', { class: 'tl-band-ic' }, icon(ICON[b.kind] ?? 'info')),
      el('div', { class: 'tl-band-text' }, el('p', {}, el('b', {}, b.title), ' ', b.text), ...extra),
      actions.length ? el('div', { class: 'tl-band-actions' }, ...actions) : null,
    );
  }

  function jobBandNode(b) {
    const actions = [];
    const closeBtn = button('tl-icon-btn', 'x', '', () => (closedBands.add(b.job.id), draw()), { 'aria-label': 'Fechar o aviso' });
    if (b.kind === 'failed') {
      const out = [...b.job.output.slice(-40)].join('\n');
      const copyBtn = button('outline', 'copy', 'Copiar a saída', () => copy(out, copyBtn));
      actions.push(copyBtn);
      const target = findTarget(b.job.toolId);
      const action = target?.actions.find((a) => a.id === b.job.actionId);
      if (action?.runnable && !data.stale) actions.push(button('filled', 'refresh', 'Tentar de novo', () => confirmOne(target, action), { 'data-action': 'retry' }));
    }
    actions.push(closeBtn);
    const tone = { done: 'tl-band-ok', failed: 'tl-band-error', canceled: '' }[b.kind];
    return el(
      'div',
      { class: `tl-band ${tone}`.trim(), 'data-band': `job-${b.kind}`, role: b.kind === 'failed' ? 'alert' : 'status' },
      el('span', { class: 'tl-band-ic' }, icon(b.kind === 'done' ? 'ok' : b.kind === 'failed' ? 'error' : 'info')),
      el(
        'div',
        { class: 'tl-band-text' },
        el('p', {}, el('b', {}, b.title), ' ', b.text, b.kind === 'done' && b.log ? ` ${b.log}` : ''),
        b.lines?.length ? el('div', { class: 'tl-out tl-out-error mono' }, ...b.lines.map((l) => el('span', {}, l))) : null,
        b.kind === 'failed' ? el('p', { class: 'tl-hint mono' }, b.log) : null,
      ),
      el('div', { class: 'tl-band-actions' }, ...actions),
    );
  }

  function findTarget(toolId) {
    const item = data.items.find((i) => i.id === toolId);
    if (item) return item;
    if (data.containers?.toolId === toolId) return data.containers;
    return data.mcp.servers.find((s) => s.id === toolId) ?? null;
  }

  /** The action cell of a row (the kinds of `rowAction`). */
  function actionCell(target, a, toggleKey) {
    const remote = isRemote(data);
    switch (a.kind) {
      case 'busy':
        return button('outline tl-act tl-off', 'wall-loader', a.job.actionId === 'install' ? 'Instalando…' : 'Atualizando…', null, { disabled: true, 'aria-busy': 'true' });
      case 'queued':
        return button('outline tl-act tl-off', 'clock', 'Na fila', null, { disabled: true });
      case 'done':
        return el('span', { class: 'tl-none tl-done' }, icon('done'), 'agora');
      case 'run':
        return button('outline tl-act', a.action.id === 'install' ? 'an-download' : 'arrow-up-circle', actionLabel(a.action.id, remote), () => confirmOne(target, a.action), { 'data-action': a.action.id });
      case 'off':
        return button('outline tl-act tl-off', a.action.id === 'install' ? 'an-download' : 'arrow-up-circle', actionLabel(a.action.id, remote), null, { disabled: true, title: a.reason });
      case 'sudo':
        return button('outline tl-act tl-sudo', 'lock', 'Precisa de sudo', () => (openSudo.has(toggleKey) ? openSudo.delete(toggleKey) : openSudo.add(toggleKey), draw()), { 'aria-expanded': String(openSudo.has(toggleKey)), 'data-action': 'sudo' });
      case 'copy': {
        const text = a.action.steps.map(argvLine).join('\n');
        const btn = button('outline tl-act', 'copy', 'Copiar comando', () => copy(text, btn), { title: text, 'data-action': 'copy' });
        return btn;
      }
      case 'login': {
        const btn = button('outline tl-act', 'external', 'Entrar pelo /mcp', () => copy('/mcp', btn), { title: 'O login é do Claude Code: rode /mcp numa sessão. Copia /mcp.' });
        return btn;
      }
      case 'config':
        return el('a', { class: 'btn outline tl-act', href: '/ui/agent-config?tab=mcp' }, icon('bot'), 'Ver no Agent Config');
      default:
        return el('span', { class: 'tl-none tl-muted' }, DASH);
    }
  }

  /** The row under an item: the running job, or the sudo commands to copy. */
  function extraRow(target, a, cols, toggleKey) {
    if (a.kind === 'busy') return el('tr', { class: 'tl-run' }, el('td', { colspan: String(cols) }, runBox(a.job)));
    if (a.kind === 'sudo' && openSudo.has(toggleKey)) return el('tr', { class: 'tl-run' }, el('td', { colspan: String(cols) }, sudoBox(target, a.action)));
    return null;
  }

  function runBox(job) {
    const t = jobClock(job, now());
    const bar = el('span', { class: 'tl-stack' }, el('i', {}));
    bar.firstChild.style.setProperty('--w', `${t.pct.toFixed(1)}%`);
    const current = job.steps[Math.min(job.step, job.steps.length - 1)];
    return el(
      'div',
      { class: 'tl-run-box', 'data-job': job.id },
      el(
        'div',
        { class: 'tl-run-top' },
        el('div', { class: 'tl-steps' }, ...jobSteps(job).map((s) => el('span', { class: `tl-step-${s.state}` }, icon(s.state === 'done' ? 'done' : s.state === 'on' ? 'wall-loader' : 'circle'), s.label))),
        button('outline tl-cancel', 'x', 'Cancelar', () => cancelJob(job), { 'data-action': 'cancel' }),
      ),
      el('div', { class: 'tl-out mono', 'aria-live': 'polite' }, ...job.output.slice(-8).map((l) => el('span', {}, l)), el('span', { class: 'tl-caret' }, '▍')),
      el('div', { class: 'tl-run-foot' }, bar, el('span', { class: 'mono' }, `${t.elapsed} de ${t.total}`), current ? el('span', { class: 'mono tl-muted' }, argvLine(current)) : null, queueLine(data) ? el('span', { class: 'tl-queue' }, queueLine(data)) : null),
    );
  }

  function sudoBox(target, action) {
    const text = action.steps.map(argvLine).join('\n');
    const code = el('code', { class: 'mono' }, ...action.steps.map((s, i) => [i ? el('br', {}) : null, argvLine(s)]).flat().filter(Boolean));
    const copyBtn = button('outline', 'copy', 'Copiar', () => copy(text, copyBtn));
    const where = isRemote(data) ? `num terminal da ${data.machine.label}` : 'no Terminal';
    return el(
      'div',
      { class: 'tl-run-box tl-sudo-box', 'data-sudo': target.id ?? target.toolId },
      el('p', {}, el('b', {}, 'O console não roda este.'), ` ${target.note ? `${target.label ?? runtimeLabel(target.runtime)}: ${target.note}; ` : ''}o comando pede a sua senha de administrador. Rode ${where}:`),
      el('div', { class: 'tl-copy' }, code, copyBtn),
      el('div', {}, button('outline', 'refresh', 'Rodei, verificar de novo', runChecks, { 'data-action': 'recheck' })),
    );
  }

  function itemTable(items, { columns, cells, cls }) {
    const frozen = data.stale;
    const rows = [];
    for (const item of items) {
      const a = rowAction(data, item, now(), { frozen });
      const key = `item:${item.id}`;
      rows.push(el('tr', { class: item.state === 'na' ? 'tl-dim' : null, 'data-tool': item.id }, ...cells(item).map((c) => el('td', { class: c.cls ?? null }, c.node)), el('td', { class: 'tl-r' }, actionCell(item, a, key))));
      const extra = extraRow(item, a, columns.length, key);
      if (extra) rows.push(extra);
    }
    return el('table', { class: `tl-table ${cls}` }, el('thead', {}, el('tr', {}, ...columns.map(([label, c]) => el('th', { class: c ?? null }, label)))), el('tbody', {}, ...rows));
  }

  const nameCell = (item, small) => ({ cls: 'tl-name', node: el('div', {}, el('b', {}, item.label), el('small', { class: 'mono' }, small)) });
  const latestCell = (item) => {
    if (item.state === 'checking' && !item.latest) return el('span', { class: 'tl-skel', 'aria-label': 'lendo' });
    return version(item.latest, item.latest && item.installed && item.latest !== item.installed ? 'tl-new' : '');
  };
  const installedCell = (item) => (item.state === 'checking' && !item.installed && !item.manager ? el('span', { class: 'tl-skel', 'aria-label': 'lendo' }) : version(item.installed));
  const sourceCell = (item) => (item.state === 'checking' && !item.manager ? el('span', { class: 'tl-skel', 'aria-label': 'lendo' }) : el('span', {}, item.manager ?? (item.state === 'na' ? item.note ?? DASH : item.source === 'manual' ? 'instalada à mão' : DASH)));

  function cliCard() {
    const items = data.items.filter((i) => i.group === 'cli');
    const counts = filterCounts(items);
    const firstCheck = !data.checkedAt;
    const seg = firstCheck
      ? `lendo as versões · ${items.filter((i) => i.installed).length} de ${items.length}`
      : el('div', { class: 'tl-seg tl-seg-small', role: 'group', 'aria-label': 'Filtro' }, ...FILTERS.map(([id, label]) => el('button', { type: 'button', 'aria-pressed': String(filter === id), onClick: () => ((filter = id), draw()) }, `${label} `, el('b', {}, String(counts[id])))));
    const shown = filterItems(items, firstCheck ? 'all' : filter);
    const table = itemTable(shown, {
      cls: 'tl-cols-cli',
      columns: [['Ferramenta'], ['Instalada'], ['Mais recente'], ['De onde veio'], ['Estado'], ['Ação', 'tl-r']],
      cells: (i) => [nameCell(i, i.id), { node: installedCell(i) }, { node: latestCell(i) }, { cls: 'tl-src', node: sourceCell(i) }, { node: badge(itemBadge(data, i, now())) }],
    });
    const body = [shown.length ? table : el('p', { class: 'tl-muted' }, filter === 'action' ? 'Nada pede ação agora.' : 'Nenhuma CLI neste filtro.')];
    if (firstCheck) body.push(el('p', { class: 'tl-hint' }, 'Instaladas vêm em segundos (é só a sonda local). As mais recentes esperam o gerenciador; até lá, a coluna fica vazia, nunca "em dia".'));
    return card('terminal', 'CLIs', seg, body, 'tl-span-full');
  }

  function runtimeCard() {
    const items = data.items.filter((i) => i.group === 'runtime');
    const table = itemTable(items, {
      cls: 'tl-cols-runtime',
      columns: [['Plataforma'], ['Quem gerencia'], ['Instalada'], ['Mais recente'], ['Estado'], ['Ação', 'tl-r']],
      cells: (i) => [nameCell(i, [i.binary ?? i.id, i.note].filter(Boolean).join(' · ')), { cls: 'tl-src', node: sourceCell(i) }, { node: installedCell(i) }, { node: latestCell(i) }, { node: badge(itemBadge(data, i, now())) }],
    });
    return card('layers', 'Plataformas', isRemote(data) ? null : 'a versão em uso no shell de login', items.length ? table : el('p', { class: 'tl-muted' }, 'Nenhuma plataforma no catálogo desta máquina.'), 'tl-platforms');
  }

  function containersCard() {
    const c = data.containers;
    if (!c) return card('container', 'Containers', null, el('p', { class: 'tl-muted' }, 'Esta leitura não trouxe os containers.'), 'tl-containers');
    const job = c.toolId ? jobOf(data, c.toolId) : null;
    const running = job && (job.state === 'running' || job.state === 'queued') ? job : null;
    const a = c.actions[0] ?? null;
    let btn = null;
    const key = `containers:${c.toolId}`;
    if (data.stale || c.readOnly) btn = null;
    else if (running || c.state === 'starting') btn = button('outline tl-off', 'wall-loader', c.state === 'stopped' || running?.actionId === 'start' || c.state === 'starting' ? 'Iniciando…' : 'Parando…', null, { disabled: true, 'aria-busy': 'true' });
    else if (a) {
      const r = rowAction(data, { ...c, id: c.toolId, actions: [a] }, now());
      if (r.kind === 'run') btn = button(a.id === 'start' ? 'filled' : 'outline', a.id === 'stop' ? 'square' : a.id === 'start' ? 'resume' : 'an-download', a.id === 'install' ? (c.runtime === null && c.toolId === 'container-colima' ? 'Instalar o Colima' : 'Instalar') : actionLabel(a.id, isRemote(data)), () => confirmOne(c, a), { 'data-action': a.id });
      else btn = actionCell(c, r, key);
    }
    const body = [el('div', { class: 'tl-ct-head' }, icon('container'), el('b', {}, c.runtime ? runtimeLabel(c.runtime) : c.state === 'missing' && c.toolId === 'container-podman' ? 'Podman Desktop' : 'Sem runtime'), badge(containerBadge(running?.actionId === 'start' ? 'starting' : c.state)), btn ? el('span', { class: 'tl-ct-btn' }, btn) : null)];
    if (running?.state === 'running') body.push(runBox(running));
    else {
      const rows = containerRows(c, data);
      const disk = containerDisk(c);
      if (disk) {
        const bar = el('progress', { class: 'tl-bar', max: '100', value: String(Math.round(disk.pct)), 'aria-label': `Disco da VM: ${disk.text}` });
        rows.splice(rows.findIndex(([k]) => k === 'VM') + 1, 0, ['Disco da VM', el('span', { class: 'tl-meter' }, bar, el('span', { class: 'mono' }, disk.text))]);
      }
      if (rows.length) body.push(kv(rows));
      if (a && !c.readOnly && !data.stale) {
        if (a.admin && openSudo.has(key)) body.push(sudoBox({ ...c, label: runtimeLabel(c.runtime), note: null }, a));
        else if (a.admin) {
          const text = a.steps.map(argvLine).join('\n');
          const copyBtn = button('outline', 'copy', 'Copiar', () => copy(text, copyBtn));
          body.push(el('div', { class: 'tl-copy' }, el('code', { class: 'mono' }, a.steps.map(argvLine).join(' · ')), copyBtn));
        } else body.push(el('div', { class: 'tl-cmdline mono' }, `${actionLabel(a.id, false)} roda: ${a.steps.map(argvLine).join(' e depois ')} · sem senha`));
      }
    }
    if (c.note) body.push(el('p', { class: 'tl-hint' }, c.note));
    const where = data.machine.id === LOCAL_ID ? 'local' : data.machine.id;
    body.push(el('a', { class: 'tl-link', href: `/ui/machines/${encodeURIComponent(where)}` }, `Uso de disco por imagem e as stacks: ${data.machine.id === LOCAL_ID ? 'Esta máquina' : data.machine.label}`, icon('chevron-right')));
    return card('container', 'Containers', null, body, 'tl-containers');
  }

  function mcpCard() {
    const servers = data.mcp.servers;
    const frozen = data.stale;
    const remote = isRemote(data);
    const small = [];
    small.push(remote ? 'escopo usuário de lá' : 'escopos usuário e projeto');
    small.push(data.mcp.statusCheckedAt ? `estado lido às ${timeOfDay(data.mcp.statusCheckedAt)}` : 'estado ainda não verificado');
    const parts = [small.join(' · ')];
    if (!frozen && !remote) parts.push(' · ', button('tl-inline-btn', 'refresh', mcpChecking ? 'Verificando…' : 'Verificar conexões', runMcpChecks, { disabled: mcpChecking || null, 'aria-busy': mcpChecking ? 'true' : null, 'data-action': 'mcp-check' }));
    const rows = [];
    for (const s of servers) {
      const a = mcpAction(data, s, now(), { frozen });
      const key = `mcp:${s.id}`;
      if (remote) {
        // The remote's list is short and sits in one column at 1100 (C75): name, a line, the state.
        const cell = a.kind === 'none' ? null : actionCell(s, a, key);
        rows.push(el('tr', { 'data-mcp': s.id }, el('td', { class: 'tl-name' }, el('div', {}, el('b', {}, s.name), el('small', {}, [s.transport, mcpSource(s)].join(' · ')))), el('td', { class: 'tl-r' }, el('div', { class: 'tl-cell-end' }, badge(mcpBadge(s)), cell))));
        const extra = extraRow(s, a, 2, key);
        if (extra) rows.push(extra);
        continue;
      }
      rows.push(
        el(
          'tr',
          { 'data-mcp': s.id },
          el('td', { class: 'tl-name' }, el('div', {}, el('b', {}, s.name), el('small', {}, mcpNote(s)))),
          el('td', { class: 'tl-src' }, `${mcpScope(s)} · `, el('span', { class: 'mono' }, s.transport)),
          el('td', { class: 'tl-src' }, mcpSource(s), s.latest && s.version && s.latest !== s.version ? el('span', { class: 'mono tl-new' }, ` → ${s.latest}`) : null),
          el('td', {}, badge(mcpBadge(s))),
          el('td', { class: 'tl-r' }, actionCell(s, a, key)),
        ),
      );
      const extra = extraRow(s, a, 5, key);
      if (extra) rows.push(extra);
    }
    const table = remote ? el('table', { class: 'tl-table tl-cols-mcp-remote' }, el('tbody', {}, ...rows)) : el('table', { class: 'tl-table tl-cols-mcp' }, el('thead', {}, el('tr', {}, ...['Servidor', 'Escopo · transporte', 'De onde', 'Estado'].map((h) => el('th', {}, h)), el('th', { class: 'tl-r' }, 'Ação'))), el('tbody', {}, ...rows));
    return card('plug', remote ? 'Servidores MCP lá' : 'Servidores MCP do Claude Code', parts, servers.length ? table : el('p', { class: 'tl-muted' }, 'Nenhum servidor MCP configurado no Claude Code.'), remote ? 'tl-mcp tl-mcp-remote' : 'tl-mcp tl-span-full');
  }

  function howCard() {
    const li = (title, ...rest) => el('li', {}, el('b', {}, title), ' ', ...rest);
    return card(
      'info',
      'Como verificamos',
      null,
      el(
        'ul',
        { class: 'tl-how' },
        li('Instalada:', 'cada item tem uma sonda fixa no catálogo (', el('code', {}, 'gh --version'), '). O caminho do binário diz de onde veio: ', el('code', {}, '/opt/homebrew'), ' é Homebrew, ', el('code', {}, '~/.local/share/fnm'), ' é fnm.'),
        li('Mais recente:', 'dos metadados do gerenciador, sem baixar nada: o cache da API do Homebrew, ', el('code', {}, 'npm view'), ', ', el('code', {}, 'rustup check'), ', ', el('code', {}, 'uv python list'), '; para o que veio de instalador oficial, a lista de versões pública do fornecedor.'),
        li('Cache:', 'guardado no banco do núcleo, com a hora, e refeito a cada 6 h ou em Verificar agora. Sem rede, a tela mostra o cache.'),
      ),
      'tl-how-card',
    );
  }

  function draw() {
    if (ctx.signal.aborted) return;
    if (!data) {
      if (failure) area.replaceChildren(head(), error({ title: 'Não deu para ler as ferramentas', text: failure.message, retry: load }));
      return;
    }
    const parts = [];
    if (failure) parts.push(el('div', { class: 'tl-band tl-band-error', role: 'alert' }, el('span', { class: 'tl-band-ic' }, icon('offline')), el('div', { class: 'tl-band-text' }, el('p', {}, el('b', {}, 'A última leitura falhou.'), ` ${failure.message} Abaixo, a leitura anterior.`))));
    if (notice) parts.push(el('div', { class: `tl-band ${notice.tone === 'error' ? 'tl-band-error' : ''}`, role: 'alert', 'data-band': 'notice' }, el('span', { class: 'tl-band-ic' }, icon('error')), el('div', { class: 'tl-band-text' }, el('p', {}, notice.text)), el('div', { class: 'tl-band-actions' }, button('tl-icon-btn', 'x', '', () => ((notice = null), draw()), { 'aria-label': 'Fechar o aviso' }))));
    const jb = jobBand(data, now(), closedBands);
    if (jb) parts.push(jobBandNode(jb));
    const mb = machineBand(data, now());
    if (mb) parts.push(band(mb));
    const grid = el('div', { class: `tl-grid${isRemote(data) ? ' tl-grid-remote' : ''}` }, cliCard(), runtimeCard(), containersCard(), ...(isRemote(data) ? [mcpCard()] : [howCard(), mcpCard()]));
    const body = el('div', { class: data.stale ? 'tl-faded' : 'tl-body' }, stats(), grid);
    content.replaceChildren(...parts, body);
    const children = [head(), content];
    if (dialog) children.push(dialog);
    area.replaceChildren(...children);
  }

  ctx.onRestart(load);
  ctx.onChange((changes) => {
    if (changes.some((c) => c.type === 'tools' && (!c.key || c.key === machine))) load();
  });
  await load();
  return () => clearTimeout(pollTimer);
}
