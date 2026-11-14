import { el, header, icon } from '../dom.js';
import { empty } from '../states.js';
import { connectEmptyFor, connectionChanged, GITHUB_NOT_CONNECTED } from '../github-connect.js';
import {
  FILTER_FIELDS,
  SWITCH_PROJECT_HREF,
  boardColumns,
  boardPath,
  emptyProject,
  filterBar,
  firstReadFailure,
  githubDownReason,
  levelSwitch,
  noResult,
  staleBand,
  workBoardError,
  workBoardHeader,
} from './work-board-parts.js';
import { createIssueLayer } from './work-board-issue.js';
import { createRunLayer } from './work-board-run-layer.js';
import { boardUrl, clearFilters, drill, initialState, loadFailed, loadSucceeded, selectPath, setFilter, setLevel, startLoad } from './work-board-state.js';

const STYLE = '/ui/work-board.css';
const LIVE_WAIT = 1000;
const TITLE = 'Quadro do trabalho';
const DEFAULT_URL = boardUrl({ level: 'item' });
const PLAIN_VIEWS = new Set(['no-project', 'off', GITHUB_NOT_CONNECTED]);

const codeOf = (error) => error?.error ?? null;
const fieldLabel = (param) => (param === 'level' ? 'Nível' : (FILTER_FIELDS.find((f) => f.param === param)?.label ?? param));

/**
 * The pt-BR of a GET /api/work failure (issue 465): `{ title, text }` from the error body the core sends with
 * codes only (`bad-filter` + `param`, `no-project`, `off`, `github-not-connected`, `github-unavailable` +
 * `reason`) and the HTTP `status` (0 when the core did not answer).
 */
export function errorMessage(error) {
  const code = codeOf(error);
  if (code === 'bad-filter') return { title: 'Este link tem um filtro inválido.', text: `O valor de ${fieldLabel(error.param)} não é um que o quadro conhece.` };
  if (code === 'no-project') return { title: 'Nenhum GitHub Project escolhido.', text: 'O quadro mostra o mesmo Project do Kanban do projeto: escolha um lá e volte aqui.' };
  if (code === 'off') return { title: 'O núcleo subiu sem GitHub.', text: 'Ele foi iniciado com --no-github, então não há quadro para mostrar. Reinicie o núcleo sem essa opção para ver o Quadro do trabalho.' };
  if (code === GITHUB_NOT_CONNECTED) return { title: 'O console não está conectado ao GitHub.', text: 'Conecte em Conexões para ver o quadro.' };
  if (code === 'github-unavailable') return { title: 'O GitHub não respondeu.', text: error.reason ? `Motivo: ${githubDownReason(error.reason)}.` : null };
  if (!error?.status) return { title: 'Sem conexão com o núcleo.', text: 'O núcleo não respondeu. Veja se ele está rodando e tente de novo.' };
  return { title: 'Não deu para ler o quadro.', text: `O núcleo respondeu ${error.status}.` };
}

function errorOf(e) {
  const body = e?.body && typeof e.body === 'object' ? e.body : {};
  return { ...body, status: e?.status ?? 0 };
}

function attachSheet() {
  const already = globalThis.document?.head?.querySelector?.('link[data-screen="work"]');
  if (already) return already;
  const link = el('link', { rel: 'stylesheet', href: STYLE, 'data-screen': 'work' });
  globalThis.document?.head?.append(link);
  return link;
}

function focusKey(node) {
  if (!node?.getAttribute) return null;
  const action = node.getAttribute('data-action');
  if (action) return `action:${action}:${node.getAttribute('data-key') ?? node.getAttribute('data-param') ?? ''}`;
  const level = node.getAttribute('data-level');
  if (level) return `level:${level}`;
  const param = node.getAttribute('data-param');
  if (param && node.tagName === 'SELECT') return `select:${param}`;
  const card = node.tagName === 'A' ? node.closest?.('article') : null;
  return card ? `link:${card.getAttribute('data-key')}:${node.getAttribute('class') ?? ''}` : null;
}

const retryAction = (band) => (band.querySelector('button')?.setAttribute('data-action', 'retry'), band);

/** The work board (issues 465 and 466): GET /api/work on the agent lifecycle columns, its slice kept in the URL. */
export async function mount(area, ctx) {
  const sheet = attachSheet();
  let state = null;
  let alive = true;
  let drawn = null;
  let liveTimer = null;
  let quiet = 0;
  let pendingFocus = null;
  const boardCards = () => (state?.data?.columns ?? []).flatMap((c) => c.cards ?? []);
  const execution = createRunLayer({ ctx, area, cards: boardCards, redraw: () => draw(), reread: () => quietRead(), onAsk: () => layer.closeConfirmation() });
  const layer = createIssueLayer({ ctx, area, cards: boardCards, options: () => state?.data?.options ?? {}, redraw: () => draw(), reread: () => quietRead(), run: execution.seam, onAsk: () => execution.closeConfirmation() });

  function follow(s) {
    const target = s.url;
    const current = `${globalThis.location?.pathname ?? ''}${globalThis.location?.search ?? ''}`;
    if (!s.navigation || target === current) return;
    if (s.navigation === 'push') globalThis.history?.pushState(null, '', target);
    else globalThis.history?.replaceState(null, '', target);
  }

  async function run(next) {
    if (!alive || !next || next === state) return;
    const before = state?.request;
    state = next;
    follow(state);
    draw();
    if (state.request === before) return;
    const { request, api } = state;
    try {
      const payload = await ctx.read(api);
      if (!alive) return;
      state = loadSucceeded(state, payload, request);
    } catch (e) {
      if (!alive || e?.name === 'AbortError') return;
      state = loadFailed(state, errorOf(e), request);
    }
    draw();
  }

  async function quietRead() {
    if (!alive || !state?.data || state.busy || state.error) return;
    const mine = ++quiet;
    const { request, api } = state;
    try {
      const payload = await ctx.read(api);
      if (!alive || mine !== quiet) return;
      state = loadSucceeded(state, payload, request);
    } catch (e) {
      if (!alive || mine !== quiet || e?.name === 'AbortError') return;
      state = loadFailed(state, errorOf(e), request);
    }
    draw();
  }

  const refresh = () => run(startLoad(state, { refresh: true }));
  const filterTo = (param, value) => run(setFilter(state, param, value));

  async function copyLink(button) {
    let said;
    try {
      await globalThis.navigator.clipboard.writeText(`${globalThis.location?.origin ?? ''}${state.url}`);
      said = 'Copiado';
    } catch {
      said = 'Não deu para copiar';
    }
    if (alive && button) button.replaceChildren(icon(said === 'Copiado' ? 'check-circle-2' : 'error'), said);
  }

  function boardHeader(now) {
    const data = state.data;
    return workBoardHeader({ project: data?.project ?? null, fetchedAt: data?.fetchedAt ?? null, now, stale: state.stale, reading: state.phase === 'loading', busy: state.busy, onRefresh: refresh });
  }

  function levels(off) {
    const options = state.data?.options ?? {};
    return levelSwitch({
      levels: state.data?.levels ?? undefined,
      level: state.filters.level,
      path: boardPath(state.filters, options),
      disabled: off,
      onLevelChange: (level) => run(setLevel(state, level)),
      onPathSelect: (step) => run(selectPath(state, step)),
    });
  }

  function filters(off) {
    const bar = filterBar({
      filters: state.filters,
      options: state.data?.options ?? {},
      link: state.url === DEFAULT_URL ? null : state.url,
      disabled: off,
      onFilterChange: filterTo,
      onClear: () => run(clearFilters(state)),
      onCopyLink: () => copyLink(bar.querySelector('.wb-link button')),
    });
    return bar;
  }

  function band(now) {
    if (state.data && state.error) {
      const { title } = errorMessage(state.error);
      return retryAction(workBoardError({ title: 'Não deu para reler o quadro.', text: `${title} Mostrando a última leitura.`, retryLabel: 'Tentar agora', onRetry: refresh }));
    }
    if (state.stale) return staleBand({ fetchedAt: state.data.fetchedAt, now, reason: state.staleReason, retryAt: state.retryAt, busy: state.busy, onRetry: refresh });
    return null;
  }

  function columns(mode, extra = {}) {
    const data = state.data;
    return boardColumns({
      columns: execution.columns(data?.columns ?? null),
      level: state.dataFilters?.level ?? state.filters.level,
      chainMode: state.chainMode,
      primaryRepo: data?.project?.primaryRepo ?? null,
      now: Date.now(),
      queueAvailable: data?.queue?.available ?? true,
      doneWindowDays: data?.doneWindowDays ?? undefined,
      stale: state.stale,
      mode,
      onDrill: (card) => run(drill(state, card)),
      renderCard: layer.renderCard,
      ...extra,
    });
  }

  function plainView(code) {
    const plain = header({ icon: 'columns-3', title: TITLE, sub: null });
    if (code === GITHUB_NOT_CONNECTED) return [plain, connectEmptyFor('work', ctx.navigate)];
    const { title, text } = errorMessage(state.error);
    const box = empty({ icon: 'github', title: title.replace(/\.$/, ''), text });
    if (code === 'no-project') box.append(el('a', { class: 'btn filled', href: SWITCH_PROJECT_HREF }, icon('github'), 'Escolher o Project'));
    return [plain, box];
  }

  function failureView(now) {
    const code = codeOf(state.error);
    if (PLAIN_VIEWS.has(code)) return plainView(code);
    const blank = columns('blank', { columns: null, counts: '–' });
    if (code === 'github-unavailable') return [boardHeader(now), firstReadFailure({ reason: state.error.reason ?? null, busy: state.busy, onRetry: refresh }), blank];
    const { title, text } = errorMessage(state.error);
    const param = code === 'bad-filter' ? state.error.param : null;
    const fix = param === 'level' ? ['Voltar ao nível Item', () => run(setLevel(state, 'item'))] : param ? [`Tirar o filtro ${fieldLabel(param)}`, () => filterTo(param, null)] : ['Tentar de novo', () => run(startLoad(state))];
    return [boardHeader(now), levels(false), filters(false), retryAction(workBoardError({ title, text, retryLabel: fix[0], onRetry: fix[1] })), blank];
  }

  function nodes() {
    const now = Date.now();
    if (codeOf(state.error) === GITHUB_NOT_CONNECTED) return plainView(GITHUB_NOT_CONNECTED);
    const { view } = state;
    if (view === 'skeleton') return [boardHeader(now), levels(true), filters(true), columns('skeleton', { columns: null, counts: '…' })];
    if (view === 'failure') return failureView(now);
    const top = [boardHeader(now), band(now), levels(false)].filter(Boolean);
    if (view === 'empty') return [...top, filters(true), emptyProject({ project: state.data.project }), columns('blank')];
    if (view === 'no-result') {
      const result = noResult({
        suggestion: state.busy ? null : state.suggestion,
        filters: state.dataFilters,
        options: state.data.options ?? {},
        onClear: () => run(clearFilters(state)),
        onFilterChange: filterTo,
      });
      return [...top, filters(false), result, columns('blank')];
    }
    return [...top, filters(false), columns('cards')];
  }

  function draw() {
    if (!alive) return;
    layer.learn();
    execution.learn();
    const shown = JSON.stringify([state.view, state.phase, state.busy, state.error, state.filters, state.dataFilters, state.suggestion, state.data, layer.signature(), execution.signature()]);
    if (shown === drawn) return;
    drawn = shown;
    const active = globalThis.document?.activeElement;
    const nowhere = !active || active === globalThis.document?.body;
    const key = active && area.contains(active) ? focusKey(active) : nowhere ? pendingFocus : null;
    area.replaceChildren(...layer.wrap([...execution.notices(), ...nodes()]));
    restoreFocus(key);
    layer.afterDraw();
    execution.afterDraw();
  }

  function restoreFocus(key) {
    pendingFocus = null;
    if (!key) return;
    const focusable = [...area.querySelectorAll('button'), ...area.querySelectorAll('a'), ...area.querySelectorAll('select')];
    const hit = focusable.find((n) => focusKey(n) === key);
    if (hit?.hasAttribute('disabled')) pendingFocus = key;
    else if (hit) hit.focus();
    else area.querySelector('button.wb-level[aria-pressed="true"]')?.focus();
  }

  ctx.onRestart(() => run(startLoad(state)));
  ctx.onChange((changes) => {
    if (connectionChanged(changes)) return run(startLoad(state));
    clearTimeout(liveTimer);
    liveTimer = setTimeout(quietRead, LIVE_WAIT);
  });

  const cleanup = () => {
    alive = false;
    layer.stop();
    execution.stop();
    clearTimeout(liveTimer);
    sheet?.remove();
  };
  ctx.signal?.addEventListener('abort', cleanup);

  await run(initialState(globalThis.location?.search ?? ''));
  return cleanup;
}
