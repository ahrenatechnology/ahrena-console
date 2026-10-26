// Conexões (wireframe C39 to C41 and C44, issue 241, decision 0011): the console's own GitHub connection.
//
// - Reads `GET /api/connections` (`{ github }`) and draws the state: disconnected (the scopes the console
//   will ask for and why), pending (the device-flow code, the link to github.com and the countdown),
//   connected (account, scopes, the organizations and the ones pending approval) and unavailable (why, and what to do).
// - Writes `POST /api/connections/github/start | cancel | disconnect | source | orgs`, each answering
//   `{ github }`; a refusal is phrased in pt-BR (`writeErrorText`), never the raw code.
// - Live: every transition is a `connections` change in `/api/changes`; while a code waits, the screen
//   also re-reads every `interval` seconds, so it advances by itself when the person authorizes.
// - `?start=1` (the "Conectar ao GitHub" of the other screens, C42) starts the device flow on arrival.
// - Data from GitHub (login, organizations) goes in through `textContent`; a link from the core is used
//   only when it is https on github.com.
// - Issue 277: with the cloud routes in the core, `/ui/connections` is the catalog of connectors
//   (cloud-connections.js) and this GitHub detail opens at `/ui/connections/github`; a core without them
//   (404) keeps this detail at `/ui/connections`, and `?start=1` always lands here.

import { el, header, icon } from '../dom.js';
import { loading, error, errorBand } from '../states.js';
import { CONNECTIONS_ROUTE, CONNECTIONS_UI, connectionChanged, githubHttpsUrl, LAST_ERROR, UNAVAILABLE, writeErrorText } from '../github-connect.js';
import { tryCatalog } from './cloud-connections.js';

const STYLE = '/ui/screens/connections.css';
export const START_ROUTE = '/api/connections/github/start';
export const CANCEL_ROUTE = '/api/connections/github/cancel';
export const DISCONNECT_ROUTE = '/api/connections/github/disconnect';
export const SOURCE_ROUTE = '/api/connections/github/source';
export const ORGS_ROUTE = '/api/connections/github/orgs';

/** The device-flow documentation, for "Como configurar" when the OAuth App is missing. */
const HOW_TO_CONFIGURE = 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow';

const DEFAULT_SCOPES = ['repo', 'read:org', 'project'];
/** Why the console asks for each scope (C39). */
export const SCOPE_REASONS = {
  repo: 'Ler os repositórios privados: issues, PRs, conteúdo, CI, tráfego e alertas. Abrir o PR do instalador.',
  'read:org': 'Listar as suas organizações, os repositórios e os Projects delas.',
  project: 'Ler os Projects e mover um card no Kanban do projeto.',
};
/** What stops working without a scope (C44, "Falta um escopo"). */
const SCOPE_LOSS = {
  repo: 'Os repositórios privados não aparecem e o instalador não abre o PR.',
  'read:org': 'As organizações e os Projects delas não aparecem.',
  project: 'O Kanban do projeto não lê nem move cards.',
};
const VAULTS = { keychain: 'Keychain do macOS', 'secret-service': 'Secret Service do Linux', memory: 'Memória (só enquanto o núcleo roda)' };
/** The screens that use GitHub (C39, C41): icon, label, route. */
const USED_BY = [
  ['repos', 'Repositórios', '/ui/repos'],
  ['github', 'Kanban do projeto', '/ui/project'],
  ['gauge', 'Dev Console', '/ui/dev-console'],
  ['book-open', 'Instruções, ADRs e PDRs', '/ui/adrs'],
];
const COUNT = { 1: 'o', 2: 'os dois', 3: 'os três', 4: 'os quatro' };
const POLL_MIN_S = 2;
const POLL_MAX_S = 10;

/** `repo`, `read:org` e `project`, as code. */
const scopeCodes = (scopes) => scopes.flatMap((s, i) => [i === 0 ? '' : i === scopes.length - 1 ? ' e ' : ', ', el('code', { class: 'mono conn-code' }, s)]).filter((x) => x !== '');
const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`);

/** The scopes the console asks for, from the status (`requiredScopes`) or the default three. */
export const requiredScopes = (github) => (Array.isArray(github?.requiredScopes) && github.requiredScopes.length ? github.requiredScopes.filter((s) => typeof s === 'string') : DEFAULT_SCOPES);

/** The pill next to "GitHub": `{ label, tone }`, tone one of `completed`, `waiting`, `error`. */
export function providerPill(github) {
  if (github?.state === 'connected') return (github.missingScopes ?? []).length ? { label: 'conectado, incompleto', tone: 'waiting' } : { label: 'conectado', tone: 'completed' };
  if (github?.state === 'pending') return { label: 'esperando a autorização', tone: 'waiting', busy: true };
  if (github?.state === 'unavailable') return { label: 'indisponível', tone: 'waiting' };
  return github?.lastError ? { label: 'não conectado', tone: 'error' } : { label: 'não conectado', tone: 'waiting' };
}

/** `mm:ss` until `expiresAt` (ISO), never below zero; `null` without a valid date. */
export function countdown(expiresAt, now = Date.now()) {
  const end = Date.parse(expiresAt ?? '');
  if (!Number.isFinite(end)) return null;
  const s = Math.max(0, Math.ceil((end - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** How long to wait before re-reading a pending flow, in ms: the core's `interval`, between 2 and 10 s. */
export const pollDelay = (github) => Math.min(POLL_MAX_S, Math.max(POLL_MIN_S, Number(github?.interval) || 5)) * 1000;

/** The verification link: https on github.com only; `{ href, label }` or `null`. */
export function verificationLink(github) {
  const href = githubHttpsUrl(github?.verificationUri);
  if (!href) return null;
  const u = new URL(href);
  return { href, label: `Abrir ${u.host}${u.pathname.replace(/\/$/, '')}` };
}

function loadStyle() {
  const doc = globalThis.document;
  if (!doc?.head || doc.querySelector('link[data-screen="connections"]')) return;
  doc.head.append(el('link', { rel: 'stylesheet', href: STYLE, 'data-screen': 'connections' }));
}

const eyebrow = (iconName, text) => el('div', { class: 'eyebrow conn-eyebrow' }, icon(iconName), text);
const muted = (text, extra = '') => el('p', { class: `conn-muted ${extra}`.trim() }, text);
const code = (text) => el('code', { class: 'mono conn-code' }, text);
const pill = ({ label, tone, busy }) => el('span', { class: `conn-pill conn-pill-${tone}` }, busy ? icon('wall-loader') : null, label);
const row = (k, v) => [el('span', { class: 'conn-k' }, k), el('span', { class: 'conn-v' }, v)];
const external = (href, label, cls = 'conn-link') => el('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' }, label, ' ', icon('external'));

export async function mount(area, ctx) {
  if (globalThis.location?.pathname === CONNECTIONS_UI && new URLSearchParams(globalThis.location?.search ?? '').get('start') !== '1') {
    const catalog = await tryCatalog(area, ctx);
    if (catalog) return catalog;
  }
  loadStyle();
  const head = header({ icon: 'plug', title: 'Conexões', sub: 'As contas de fora que o console usa. A credencial nunca sai do cofre do sistema.' });
  let github = null;
  let failure = null;
  let notice = null; // a refused write, in pt-BR
  let busy = null; // the route of the write in flight
  let confirming = false; // the Disconnect dialog
  let request = 0;
  let pollTimer = null;
  let tick = null;
  let countdownNode = null;

  // ---------- reading ----------

  async function read() {
    const n = ++request;
    try {
      const r = await ctx.read(CONNECTIONS_ROUTE);
      if (n !== request) return;
      github = r?.github ?? null;
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError' || n !== request) return;
      failure = e;
    }
    draw();
  }

  async function act(route, body = {}) {
    if (busy) return;
    busy = route;
    notice = null;
    draw();
    try {
      const r = await ctx.write(route, body);
      request++;
      if (r?.github) github = r.github;
      confirming = false;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      notice = writeErrorText(e);
      busy = null;
      return read();
    }
    busy = null;
    draw();
  }

  const start = () => act(START_ROUTE);
  const cancel = () => act(CANCEL_ROUTE);
  const disconnect = () => act(DISCONNECT_ROUTE);
  const setSource = (source) => act(SOURCE_ROUTE, { source });
  const recheckOrgs = () => act(ORGS_ROUTE);

  // ---------- timers: the countdown and the poll while a code waits ----------

  function schedule() {
    clearTimeout(pollTimer);
    clearInterval(tick);
    pollTimer = null;
    tick = null;
    if (github?.state !== 'pending' || ctx.signal.aborted) return;
    pollTimer = setTimeout(read, pollDelay(github));
    tick = setInterval(() => {
      const left = countdown(github?.expiresAt);
      if (countdownNode && left) countdownNode.textContent = `expira em ${left}`;
      if (left === '0:00') {
        clearInterval(tick);
        tick = null;
        read();
      }
    }, 1000);
  }

  // ---------- pieces ----------

  function button(label, { iconName = null, filled = false, action, onClick, disabled = false, route = null, danger = false }) {
    const working = route && busy === route;
    const b = el(
      'button',
      { type: 'button', class: `btn ${filled ? 'filled' : 'outline'}${danger ? ' conn-danger' : ''}`, 'data-action': action, disabled: disabled || Boolean(busy), 'aria-busy': working ? 'true' : null, onClick },
      iconName ? icon(working ? 'refresh' : iconName) : null,
      label,
    );
    return b;
  }

  function providerHead(actions) {
    return el(
      'div',
      { class: 'conn-head' },
      el('div', { class: 'conn-logo' }, icon('github')),
      el('div', { class: 'conn-name' }, el('div', { class: 'conn-title' }, el('b', {}, 'GitHub'), pill(providerPill(github))), muted('Repositórios, Kanban do projeto, Dev Console, Instruções, ADRs e PDRs')),
      actions.length ? el('div', { class: 'conn-actions' }, ...actions) : null,
    );
  }

  function scopeList({ granted = null } = {}) {
    const missing = new Set(github?.missingScopes ?? []);
    return el(
      'ul',
      { class: 'conn-scopes', 'aria-label': 'Escopos' },
      ...requiredScopes(github).map((s) => {
        const ok = granted === null ? true : !missing.has(s);
        return el(
          'li',
          { class: 'conn-scope', 'data-scope': s, 'data-ok': ok ? 'true' : 'false' },
          el('span', { class: ok ? 'conn-ok' : 'conn-bad', role: 'img', 'aria-label': ok ? 'concedido' : 'falta' }, icon(ok ? 'done' : 'x')),
          code(s),
          el('span', { class: 'conn-muted' }, ok ? null : el('b', { class: 'conn-bad' }, 'falta'), ok ? null : ' · ', SCOPE_REASONS[s] ?? ''),
        );
      }),
    );
  }

  function scopesSection(title = 'O que o console vai pedir ao GitHub', options = {}) {
    return el('div', { class: 'conn-section' }, eyebrow('shield-check', title), scopeList(options), options.note ? muted(options.note, 'conn-small') : null);
  }

  function howItWorks() {
    return el(
      'div',
      { class: 'conn-section conn-wide-only' },
      eyebrow('list', 'Como funciona'),
      el(
        'ol',
        { class: 'conn-steps-list' },
        el('li', {}, 'O console mostra um código de 8 letras.'),
        el('li', {}, 'Você abre ', el('b', {}, 'github.com/login/device'), ', cola o código e autoriza o ', el('b', {}, 'Ahrena Console'), '.'),
        el('li', {}, 'A credencial vai direto para o cofre do sistema. Ninguém digita nem vê.'),
      ),
    );
  }

  /** A titled message inside the provider card (C44): title, text and buttons. */
  function message({ title, text, buttons = [], extra = null }) {
    return el('div', { class: 'conn-message' }, el('b', { class: 'conn-message-title' }, title), text ? muted(text) : null, extra, buttons.length ? el('div', { class: 'conn-buttons' }, ...buttons) : null);
  }

  function providerCard() {
    const g = github;
    const consoleSource = g.source !== 'gh';
    if (g.state === 'pending') return pendingCard();
    if (g.state === 'connected') return connectedCard();
    if (g.state === 'unavailable') {
      const why = UNAVAILABLE[g.reason] ?? { title: 'A conexão com o GitHub não está disponível', text: 'O núcleo não consegue usar o GitHub nesta máquina agora.' };
      const buttons = [];
      let text = why.text;
      if (g.reason === 'no-client-id') {
        buttons.push(button('Conectar ao GitHub', { iconName: 'github', filled: true, action: 'connect', disabled: true }), external(HOW_TO_CONFIGURE, 'Como configurar (para quem monta o console)', 'btn outline conn-link-btn'));
      } else if (g.reason === 'no-vault') {
        if (g.ghInstalled) {
          text = `${why.text} O gh está instalado: dá para usar o login dele.`;
          buttons.push(button('Usar o login do gh', { iconName: 'terminal', action: 'use-gh', route: SOURCE_ROUTE, onClick: () => setSource('gh'), disabled: g.sourceFrom === 'env' }));
        }
      } else if ((g.reason === 'gh-not-installed' || g.reason === 'gh-not-authenticated') && g.sourceFrom !== 'env') {
        buttons.push(button('Voltar ao padrão', { action: 'source-console', route: SOURCE_ROUTE, onClick: () => setSource('console') }));
      }
      return el('section', { class: 'card conn-card', 'data-state': 'unavailable', 'data-reason': g.reason ?? '' }, providerHead([]), el('div', { class: 'conn-body' }, message({ title: why.title, text, buttons }), g.reason === 'no-client-id' ? scopesSection() : null));
    }
    // disconnected
    const failed = LAST_ERROR[g.lastError];
    const actions = failed || !consoleSource ? [] : [button('Conectar ao GitHub', { iconName: 'github', filled: true, action: 'connect', route: START_ROUTE, onClick: start })];
    const parts = [];
    if (failed) parts.push(message({ title: failed.title, text: failed.text, buttons: [button('Gerar outro código', { iconName: 'refresh', filled: true, action: 'connect', route: START_ROUTE, onClick: start })] }));
    parts.push(el('div', { class: 'conn-split' }, scopesSection(undefined, { note: 'O console só escreve no GitHub em dois casos, sempre por um clique seu: mover um card e abrir o PR do instalador.' }), howItWorks()));
    return el('section', { class: 'card conn-card', 'data-state': 'disconnected', 'data-last-error': g.lastError ?? '' }, providerHead(actions), el('div', { class: 'conn-body' }, ...parts));
  }

  function pendingCard() {
    const g = github;
    const link = verificationLink(g);
    const left = countdown(g.expiresAt);
    countdownNode = el('span', { class: 'mono conn-muted conn-expires', 'aria-live': 'off' }, left ? `expira em ${left}` : '');
    const step = (n, title, ...body) => el('li', { class: 'conn-step' }, el('span', { class: 'conn-step-n', 'aria-hidden': 'true' }, String(n)), el('div', { class: 'conn-step-body' }, el('b', {}, title), ...body));
    const copyButton = el('button', { type: 'button', class: 'btn outline', 'data-action': 'copy' }, icon('copy'), 'Copiar código');
    copyButton.addEventListener('click', () => copy(g.userCode, copyButton));
    const codeBox = el('span', { class: 'mono conn-user-code', 'aria-label': `Código ${g.userCode ?? ''}` }, g.userCode ?? '');
    const steps = el(
      'ol',
      { class: 'conn-steps' },
      step(1, 'Copie este código', el('div', { class: 'conn-row' }, codeBox, copyButton)),
      step(
        2,
        'Abra o GitHub e cole o código',
        el(
          'div',
          { class: 'conn-row' },
          link ? el('a', { class: 'btn filled', href: link.href, target: '_blank', rel: 'noopener noreferrer', 'data-action': 'open-github' }, icon('external'), link.label) : muted('Abra github.com/login/device no navegador.'),
          el('span', { class: 'conn-muted conn-small' }, 'abre no seu navegador, com a sua sessão do GitHub'),
        ),
      ),
      step(3, 'Autorize o Ahrena Console', el('p', { class: 'conn-muted' }, 'O GitHub mostra o aplicativo ', el('b', { class: 'conn-strong' }, 'Ahrena Console'), ' e os escopos ', ...scopeCodes(requiredScopes(g)), '.')),
    );
    const waiting = el('div', { class: 'conn-waiting', role: 'status' }, el('span', { class: 'conn-spin' }, icon('wall-loader')), el('span', {}, 'Esperando a autorização no GitHub. Esta tela muda sozinha.'), countdownNode);
    const side = el(
      'div',
      { class: 'conn-side conn-wide-only' },
      el(
        'div',
        { class: 'conn-inset' },
        eyebrow('shield', 'Antes de colar'),
        el('ul', { class: 'conn-steps-list' }, el('li', {}, 'Confira que o endereço é ', el('b', {}, 'github.com'), '.'), el('li', {}, 'O código serve só para isto e vale 15 minutos.'), el('li', {}, 'Ninguém do console pede esse código por mensagem. Se alguém pedir, não mande.')),
      ),
      vaultCard({ inset: true }),
    );
    return el(
      'section',
      { class: 'card conn-card', 'data-state': 'pending' },
      providerHead([button('Cancelar', { action: 'cancel', route: CANCEL_ROUTE, onClick: cancel })]),
      el('div', { class: 'conn-body conn-split conn-split-pending' }, el('div', { class: 'conn-section' }, steps, waiting), side),
    );
  }

  // The orgs the token sees, and the ones that restrict the app (issue 336). GitHub hides the private
  // memberships of an org that has not approved the app, so the note says where to approve them.
  function orgsList() {
    const g = github;
    const orgs = Array.isArray(g.orgs) ? g.orgs.filter((o) => o && typeof o.login === 'string') : [];
    const rows = orgs.map((o) => {
      const pending = o.access === 'pending';
      const approve = pending ? githubHttpsUrl(o.approvalUrl) : null;
      const request = pending ? githubHttpsUrl(o.requestUrl) : null;
      const state = pending
        ? el('span', { class: 'conn-org-state' }, 'acesso pendente', approve ? ' · ' : null, approve ? external(approve, 'aprovar (dono)') : null, request ? ' · ' : null, request ? external(request, 'pedir') : null)
        : el('span', { class: 'conn-org-state conn-org-granted' }, icon('done'), 'liberada');
      return el('li', { class: 'conn-org', 'data-org': o.login, 'data-access': pending ? 'pending' : 'granted' }, el('span', { class: 'conn-muted' }, icon('organization')), el('span', { class: 'conn-trunc' }, o.login), state);
    });
    const status = !g.orgsChecked ? 'Conferindo as organizações…' : orgs.length ? null : 'O token não enxerga nenhuma organização.';
    const app = githubHttpsUrl(g.revokeUrl);
    const recheck = g.orgsChecked ? button('Conferir de novo', { iconName: 'refresh', action: 'recheck-orgs', route: ORGS_ROUTE, onClick: recheckOrgs }) : null;
    return [
      rows.length ? el('ul', { class: 'conn-orgs' }, ...rows) : null,
      status ? muted(status) : null,
      el(
        'p',
        { class: 'conn-muted conn-small' },
        'Falta alguma? O GitHub esconde as organizações que ainda não aprovaram o Ahrena Console. O dono aprova uma vez, em Settings › Third-party access › OAuth app policy da organização',
        app ? ['; ou ', external(app, 'abra o aplicativo no GitHub'), ' e use Grant (se você é dono) ou Request (pede ao dono).'] : '.',
      ),
      recheck ? el('div', { class: 'conn-actions' }, recheck) : null,
    ];
  }

  function connectedCard() {
    const g = github;
    const consoleSource = g.source !== 'gh';
    const missing = (g.missingScopes ?? []).filter((s) => typeof s === 'string');
    const actions = consoleSource
      ? [button('Reconectar', { iconName: 'refresh', action: 'reconnect', route: START_ROUTE, onClick: start }), button('Desconectar', { iconName: 'log-out', action: 'disconnect', onClick: () => ((confirming = true), draw()) })]
      : [];
    const account = el(
      'div',
      { class: 'conn-section' },
      eyebrow('person', 'Conta'),
      el(
        'div',
        { class: 'conn-account' },
        el('span', { class: 'conn-avatar' }, icon('person')),
        el('div', { class: 'conn-account-name' }, el('b', { class: 'conn-trunc' }, g.login ?? 'conta do GitHub'), muted(consoleSource ? 'pelo device flow do console' : 'pelo login do gh desta máquina', 'conn-small')),
      ),
    );
    const scopes = el('div', { class: 'conn-section' }, eyebrow('shield-check', 'Escopos concedidos'), g.scopesChecked === false ? muted('Conferindo os escopos no GitHub…') : scopeList({ granted: g.scopes ?? [] }));
    // The gh source is another OAuth App: the core checks organizations only for the console's own.
    const orgs = consoleSource ? el('div', { class: 'conn-section conn-wide-only' }, eyebrow('organization', 'Organizações'), ...orgsList()) : null;
    const body = [el('div', { class: 'conn-three' }, account, scopes, orgs)];
    if (missing.length) {
      body.push(
        message({
          title: missing.length === 1 ? `Falta o escopo ${missing[0]}` : `Faltam os escopos ${list(missing)}`,
          text: `${missing.map((s) => SCOPE_LOSS[s]).filter(Boolean).join(' ')} Reconectar pede ${COUNT[requiredScopes(g).length] ?? `os ${requiredScopes(g).length}`} escopos de novo.`,
          buttons: consoleSource ? [button('Reconectar', { iconName: 'refresh', filled: true, action: 'reconnect-scopes', route: START_ROUTE, onClick: start })] : [],
        }),
      );
    }
    return el('section', { class: 'card conn-card', 'data-state': 'connected' }, providerHead(actions), el('div', { class: 'conn-body' }, ...body));
  }

  function vaultCard({ inset = false } = {}) {
    const g = github;
    const rows = [...row('Cofre', g.vault ? VAULTS[g.vault] ?? g.vault : 'Nenhum nesta máquina'), ...row('Item', code('dev.ahrena.console.github'))];
    if (g.state === 'connected' && g.login && g.source !== 'gh') rows.push(...row('Conta', code(g.login)));
    const text = g.source === 'gh' ? 'Com a fonte gh, a credencial é a do gh auth: o console não guarda nenhuma.' : 'Nunca vai para arquivo, banco, log ou tela. Os núcleos do app e do terminal usam a mesma entrada.';
    return el('section', { class: inset ? 'conn-inset' : 'card conn-small-card', 'data-card': 'vault' }, eyebrow('key', 'Onde fica a credencial'), el('div', { class: 'conn-kv' }, ...rows), muted(text, 'conn-small'));
  }

  function sourceCard() {
    const g = github;
    const gh = g.source === 'gh';
    const fromEnv = g.sourceFrom === 'env';
    const option = (value, label) => {
      const on = (value === 'gh') === gh;
      return el(
        'button',
        { type: 'button', class: `conn-seg-option${on ? ' on' : ''}`, 'aria-pressed': on ? 'true' : 'false', 'data-source': value, disabled: on || fromEnv || Boolean(busy) || (value === 'gh' && !g.ghInstalled), onClick: () => setSource(value) },
        ...label,
      );
    };
    const text = fromEnv
      ? 'Definida por AHRENA_CONSOLE_GITHUB_SOURCE no ambiente do núcleo: a tela não troca.'
      : gh
        ? 'Usando o token do gh auth. Para quem já usa o gh; o app não depende dele.'
        : g.ghInstalled
          ? 'O padrão. O gh é opcional e só vale se você escolher.'
          : 'O padrão. O gh não está instalado nesta máquina.';
    return el(
      'section',
      { class: 'card conn-small-card', 'data-card': 'source' },
      eyebrow('repeat', 'Fonte da credencial'),
      el('div', { class: 'conn-seg', role: 'group', 'aria-label': 'Fonte da credencial' }, option('console', ['Ahrena Console']), option('gh', ['Login do ', code('gh'), ' desta máquina'])),
      muted(text, 'conn-small'),
    );
  }

  function usedByCard() {
    const on = github.state === 'connected';
    return el(
      'section',
      { class: 'card conn-small-card conn-used', 'data-card': 'used-by' },
      eyebrow('layers', 'Telas que usam o GitHub'),
      el('ul', { class: 'conn-used-list' }, ...USED_BY.map(([i, label, href]) => el('li', {}, el('a', { href, class: 'conn-used-link' }, el('span', { class: 'conn-muted' }, icon(i)), label), el('span', { class: on ? 'conn-ok' : 'conn-muted' }, on ? 'funcionando' : 'esperando a conexão')))),
    );
  }

  function ghBand() {
    if (github.source !== 'gh') return null;
    const fromEnv = github.sourceFrom === 'env';
    return el(
      'div',
      { class: 'conn-band', role: 'status', 'data-band': 'gh' },
      el('span', { class: 'conn-band-ic' }, icon('terminal')),
      el('p', {}, el('b', {}, 'Usando o login do gh. '), `A fonte desta máquina é o gh auth, escolhida ${fromEnv ? 'por AHRENA_CONSOLE_GITHUB_SOURCE=gh' : 'em Conexões'}. Desconectar aqui não mexe no gh.`),
      fromEnv ? null : button('Voltar ao padrão', { action: 'source-console', route: SOURCE_ROUTE, onClick: () => setSource('console') }),
    );
  }

  function dialog() {
    const g = github;
    const revoke = g.source !== 'gh' ? githubHttpsUrl(g.revokeUrl) : null;
    const cancelButton = el('button', { type: 'button', class: 'btn outline', 'data-action': 'dialog-cancel', onClick: () => ((confirming = false), draw()) }, 'Cancelar');
    const box = el(
      'div',
      { class: 'conn-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'conn-dialog-title' },
      el('b', { class: 'conn-dialog-title', id: 'conn-dialog-title' }, `Desconectar ${g.login ?? 'a conta do GitHub'}?`),
      muted('Apagamos a credencial do cofre e o que o console guardou do GitHub. Repositórios, Kanban do projeto, Dev Console e Instruções voltam a pedir a conexão.'),
      el(
        'div',
        { class: 'conn-inset conn-dialog-note' },
        el('span', { class: 'conn-warn' }, icon('info')),
        el('span', {}, 'O Ahrena Console continua autorizado na sua conta do GitHub até você revogar lá. ', revoke ? external(revoke, 'Revogar no GitHub') : null),
      ),
      el('div', { class: 'conn-buttons conn-dialog-buttons' }, cancelButton, button('Desconectar', { iconName: 'log-out', filled: true, danger: true, action: 'confirm-disconnect', route: DISCONNECT_ROUTE, onClick: disconnect })),
    );
    const overlay = el('div', { class: 'conn-overlay' }, box);
    overlay.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      confirming = false;
      draw();
    });
    overlay.addEventListener('click', (ev) => {
      if (ev.target !== overlay) return;
      confirming = false;
      draw();
    });
    return { overlay, focus: cancelButton };
  }

  // ---------- drawing ----------

  function draw() {
    const active = globalThis.document?.activeElement;
    const focusAction = active && typeof area.contains === 'function' && area.contains(active) ? active.getAttribute?.('data-action') ?? null : null;
    countdownNode = null;
    if (!github) {
      schedule();
      if (failure) return area.replaceChildren(head, error({ text: failure.message, retry: () => (area.replaceChildren(head, loading()), read()) }));
      return area.replaceChildren(head, loading({ label: 'Lendo a conexão' }));
    }
    if (github.state !== 'connected') confirming = false;
    const vault = github.vault === 'secret-service' ? 'do Secret Service' : github.vault === 'keychain' ? 'do Keychain' : 'do cofre do sistema';
    const sub = head.querySelector('.sub');
    if (sub) sub.textContent = `As contas de fora que o console usa. A credencial nunca sai ${vault}.`;
    const bands = [];
    if (notice) bands.push(errorBand({ title: 'Não deu certo.', text: notice, action: { label: 'Fechar', onClick: () => ((notice = null), draw()) } }));
    if (failure) bands.push(errorBand({ title: 'Sem conexão com o núcleo.', text: `${failure.message}. Mostrando a última leitura.`, action: { label: 'Tentar de novo', onClick: () => read() } }));
    const band = ghBand();
    if (band) bands.push(band);
    const grid = [vaultCard(), sourceCard(), usedByCard()];
    const orgsCard = github.state === 'connected' && github.source !== 'gh' ? el('section', { class: 'card conn-small-card conn-narrow-only', 'data-card': 'orgs' }, eyebrow('organization', 'Organizações'), ...orgsList()) : null;
    const pendingNote = github.state === 'pending' ? el('p', { class: 'conn-muted conn-small conn-narrow-only conn-pending-note' }, icon('shield'), 'Confira que o endereço é github.com. O código vale 15 minutos e serve só para isto.') : null;
    const nodes = [head, ...bands, providerCard()];
    if (github.state === 'pending') nodes.push(pendingNote);
    else nodes.push(...[orgsCard, el('div', { class: 'conn-grid' }, ...grid)].filter(Boolean));
    let focusTarget = null;
    if (confirming) {
      const d = dialog();
      nodes.push(d.overlay);
      focusTarget = d.focus;
    }
    area.replaceChildren(...nodes.filter(Boolean));
    if (focusTarget) focusTarget.focus();
    else if (focusAction) area.querySelector(`[data-action="${focusAction}"]`)?.focus?.();
    schedule();
  }

  async function copy(text, node) {
    try {
      await globalThis.navigator?.clipboard?.writeText(String(text ?? ''));
      node.replaceChildren(icon('done'), 'Copiado');
    } catch {
      node.replaceChildren(icon('copy'), 'Selecione e copie');
    }
    setTimeout(() => node.replaceChildren(icon('copy'), 'Copiar código'), 2000);
  }

  // ---------- live ----------

  ctx.onChange((changes) => {
    if (connectionChanged(changes)) read();
  });
  ctx.onRestart(() => read());

  area.replaceChildren(head, loading({ label: 'Lendo a conexão' }));
  await read();

  // The C42 button lands here with `?start=1` and its history state: start the flow once, and take the
  // flag out of the URL. A cold load with the flag (a link another site opened) only shows the screen.
  const query = new URLSearchParams(globalThis.location?.search ?? '');
  if (query.get('start') === '1') {
    const fromButton = globalThis.history?.state?.startConnect === true;
    globalThis.history?.replaceState?.(null, '', CONNECTIONS_UI);
    if (fromButton && github?.state === 'disconnected' && github.source !== 'gh') await start();
  }

  return () => {
    request++;
    clearTimeout(pollTimer);
    clearInterval(tick);
  };
}
