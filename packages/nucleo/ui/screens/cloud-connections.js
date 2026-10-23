// Conexões as a catalog of connectors, and the AWS detail (issue 277, decision 0013, wireframes C57 to C61).
//
// - `tryCatalog(area, ctx)`: what `/ui/connections` shows when the core has the cloud routes. One card per
//   connector (GitHub from issue 241, AWS, then the "Em breve" ones the core lists), split into "Conectadas" and
//   "Adicionar uma conexão"; with remote machines, the list of every cloud session of every machine, the
//   closest to expiring first. It answers `null` when `GET /api/connectors` is not there (an older core):
//   connections.js then shows the GitHub detail as before.
// - `mount(area, ctx)`: `/ui/connections/aws` (`?machine=<id>` for a remote): the SSO sessions of the
//   machine with their profiles, the state, Entrar and Cancelar, the login while it runs (waiting for the
//   browser here, the device code for a remote), the states that are not the happy path, and the profiles
//   out of scope. "Este Mac" and each remote machine are a selector in the header.
// - Live: this Mac re-reads on a `connector` change; the remote machines are polled every 30 s (every 3 s
//   while a login runs), since no change event crosses the tunnel; GitHub re-reads on `connections`.
// - Entrar on the catalog opens the AWS screen of that machine, which starts the login (only when the click
//   came from this page: the history state carries it, like the GitHub `?start=1`).

import { el, header, icon } from '../dom.js';
import { loading, empty, errorBand } from '../states.js';
import { CONNECTIONS_ROUTE, connectionChanged } from '../github-connect.js';
import { MACHINES_ROUTE, ago, normalizeMachines } from './machine-format.js';
import { anyRunning, createLogins, loadCloudStyle, loginBandFor, pill, sessionAction, tickClocks } from './cloud-parts.js';
import {
  CONNECTORS_ROUTE,
  LOCAL_ID,
  REMOTE_POLL_MS,
  RUNNING_POLL_MS,
  allSessions,
  awsCardLines,
  awsConnected,
  awsProblems,
  awsScreenRoute,
  awsStats,
  canLogin,
  cliLine,
  connectorPill,
  isRemoteId,
  machineFromSearch,
  normalizeConnectors,
  normalizeRemote,
  outOfScopeText,
  profilesText,
  remoteConnectorsRoute,
  sessionFoot,
  sessionMeta,
  sessionPill,
} from './cloud-format.js';

const SUB = 'As contas de fora que o console usa. As credenciais ficam com as CLIs de cada nuvem e com o cofre do sistema: o console nunca as guarda nem mostra.';
const GITHUB_DETAIL = '/ui/connections/github';
const SOON = {
  gcp: { name: 'Google Cloud', sub: 'gcloud · configurações', text: 'Fase 2: as configurações do gcloud, a conta de cada uma e o gcloud auth login.' },
  azure: { name: 'Azure', sub: 'az · assinaturas', text: 'Depois do GCP: as assinaturas do az account list e o az login.' },
};

/** The GitHub card's pill, from `GET /api/connections`. Exported for the test. */
export function githubPill(github) {
  if (github?.state === 'connected') return { tone: 'b-completed', label: 'Conectado' };
  if (github?.state === 'pending') return { tone: 'b-waiting', label: 'Esperando a autorização' };
  if (github?.state === 'unavailable') return { tone: 'b-waiting', label: 'Indisponível' };
  return { tone: 'b-abandoned', label: 'Não conectado' };
}

const eyebrow = (text) => el('div', { class: 'eyebrow cl-eyebrow' }, text);
const lockLine = (text) => el('p', { class: 'cl-lock' }, icon('lock'), text);
const linkButton = (href, label, { filled = false, iconName = null, action = null } = {}) => el('a', { class: `btn ${filled ? 'filled' : 'outline'}`, href, 'data-cl-action': action }, iconName ? icon(iconName) : null, label);
const lineNode = (parts) => el('span', {}, ...parts.map((p) => (typeof p === 'string' ? p : p.strong ? el('b', {}, p.strong) : el('code', { class: 'mono cl-mono' }, p.mono))));

function connCard({ id, logo, name, sub, pillNode, lines, foot, soon = false }) {
  return el(
    'section',
    { class: `card cl-conn${soon ? ' cl-soon' : ''}`, 'data-connector': id },
    el('div', { class: 'cl-top' }, el('span', { class: 'cl-logo' }, icon(logo)), el('div', { class: 'cl-title' }, el('b', {}, name), el('small', {}, sub)), pillNode),
    el('div', { class: 'cl-lines' }, ...lines),
    el('div', { class: 'cl-foot' }, ...foot),
  );
}

// ---------- the catalog (C57, C60, C61) ----------

/** Mounts the catalog when the core has the cloud routes; `null` otherwise (connections.js falls back). */
export async function tryCatalog(area, ctx) {
  let first;
  try {
    first = normalizeConnectors(await ctx.read(CONNECTORS_ROUTE));
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return null;
  }
  if (!first || ctx.signal.aborted) return null;
  return mountCatalog(area, ctx, first);
}

async function mountCatalog(area, ctx, first) {
  loadCloudStyle(ctx.signal);
  const head = header({ icon: 'plug', title: 'Conexões', sub: SUB });
  let local = first;
  let github = null;
  let machines = [];
  const remotes = new Map(); // id → { status, aws, readAt }
  let failure = null;
  let timer = null;

  async function readLocal() {
    try {
      local = normalizeConnectors(await ctx.read(CONNECTORS_ROUTE)) ?? local;
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      failure = e;
    }
  }
  async function readGithub() {
    try {
      github = (await ctx.read(CONNECTIONS_ROUTE))?.github ?? null;
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
  }
  async function readRemotes() {
    try {
      machines = normalizeMachines(await ctx.read(MACHINES_ROUTE)).filter((m) => isRemoteId(m.id));
    } catch (e) {
      if (e?.name === 'AbortError') return;
      machines = [];
    }
    await Promise.all(
      machines.map(async (m) => {
        try {
          const r = normalizeRemote(await ctx.read(remoteConnectorsRoute(m.id)));
          const prev = remotes.get(m.id);
          if (!r) remotes.delete(m.id);
          else if (r.status === 'ok') remotes.set(m.id, { status: 'ok', aws: r.connectors?.aws ?? null, readAt: new Date().toISOString() });
          else remotes.set(m.id, { status: r.status, aws: prev?.aws ?? null, readAt: prev?.readAt ?? null });
        } catch (e) {
          if (e?.name === 'AbortError') return;
          remotes.delete(m.id);
        }
      }),
    );
  }

  function schedule() {
    clearTimeout(timer);
    if (ctx.signal.aborted || !machines.length) return;
    timer = setTimeout(async () => {
      await readRemotes();
      draw();
      schedule();
    }, REMOTE_POLL_MS);
  }

  /** Entrar on the catalog: the AWS screen of that machine starts the login. */
  const openLogin = (machineId, session) => ctx.navigate(`${awsScreenRoute(machineId)}${isRemoteId(machineId) ? '&' : '?'}login=${session.name}`, { startLogin: session.name });

  function githubCard() {
    const connected = github?.state === 'connected';
    const scopes = Array.isArray(github?.scopes) ? github.scopes.filter((s) => typeof s === 'string') : [];
    const lines = connected
      ? [lineNode(['Como ', { strong: typeof github.login === 'string' ? github.login : 'conta do GitHub' }]), scopes.length ? lineNode([`Escopos ${scopes.join(', ')}`]) : null]
      : [lineNode(['Repositórios, Kanban do projeto, Dev Console, Instruções, ADRs e PDRs.'])];
    return connCard({
      id: 'github',
      logo: 'github',
      name: 'GitHub',
      sub: 'device flow · cofre do sistema',
      pillNode: pill(githubPill(github)),
      lines,
      foot: [el('span', { class: 'mono cl-foot-note' }, github?.source === 'gh' ? 'login do gh' : 'Ahrena Console'), connected ? linkButton(GITHUB_DETAIL, 'Abrir', { action: 'open-github' }) : linkButton(GITHUB_DETAIL, 'Conectar', { filled: true, iconName: 'github', action: 'open-github' })],
    });
  }

  function awsCard() {
    const aws = local.aws;
    const urgent = aws?.sessions.find((s) => ['expired', 'expiring', 'never'].includes(s.state) && s.login.state !== 'running' && canLogin(aws, s));
    const foot = [el('span', { class: 'mono cl-foot-note' }, cliLine(aws))];
    if (urgent) foot.push(el('button', { type: 'button', class: 'btn filled', 'data-cl-action': 'login', 'data-session': urgent.name, onClick: () => openLogin(LOCAL_ID, urgent) }, icon('log-in'), 'Entrar'));
    foot.push(linkButton(awsScreenRoute(), awsConnected(aws) ? 'Abrir' : 'Como configurar', { action: 'open-aws' }));
    return connCard({ id: 'aws', logo: 'cloud', name: 'AWS', sub: 'IAM Identity Center (SSO) · aws CLI v2', pillNode: pill(connectorPill(aws)), lines: awsCardLines(aws).map(lineNode), foot });
  }

  const soonCard = (kind) =>
    connCard({ id: kind, logo: 'cloud', name: SOON[kind].name, sub: SOON[kind].sub, pillNode: pill({ tone: 'b-abandoned', label: 'Em breve' }), lines: [lineNode([SOON[kind].text])], foot: [el('button', { type: 'button', class: 'btn outline', disabled: true }, 'Adicionar')], soon: true });

  const otherCard = () =>
    connCard({ id: 'other', logo: 'plus', name: 'Outra nuvem', sub: 'um conector é um PR', pillNode: null, lines: [lineNode(['O catálogo é fixo no código: nada de conector de fora rodando comandos. Falta uma? Abra uma issue.'])], foot: [], soon: true });

  function allSessionsCard() {
    if (!machines.length) return null;
    const list = [{ id: LOCAL_ID, label: 'Este Mac', aws: local.aws }];
    const away = [];
    for (const m of machines) {
      const r = remotes.get(m.id);
      if (r?.status === 'ok') list.push({ id: m.id, label: m.label, aws: r.aws });
      else away.push(m.label);
    }
    const rows = allSessions(list);
    if (!rows.length && !away.length) return null;
    const now = Date.now();
    return el(
      'section',
      { class: 'card cl-sess', 'data-card': 'all-sessions' },
      el('div', { class: 'cl-sh' }, el('span', { class: 'cl-accent' }, icon('list')), el('div', { class: 'cl-sn' }, el('b', {}, 'Todas as sessões de nuvem'), el('small', {}, 'de todas as máquinas, a mais perto de expirar primeiro'))),
      rows.length
        ? el(
            'table',
            { class: 'cl-table' },
            el('thead', {}, el('tr', {}, ...['Máquina', 'Nuvem', 'Sessão', 'Contas e perfis', 'Estado', ''].map((h) => el('th', {}, h)))),
            el(
              'tbody',
              {},
              ...rows.map((r) => {
                const s = r.session;
                const action =
                  s.login.state === 'running'
                    ? linkButton(awsScreenRoute(r.machineId), 'Acompanhar', { action: 'follow' })
                    : canLogin(r.aws, s)
                      ? el('button', { type: 'button', class: `btn ${s.state === 'valid' ? 'outline' : 'filled'}`, 'data-cl-action': 'login', 'data-session': s.name, 'data-machine': r.machineId, onClick: () => openLogin(r.machineId, s) }, s.state === 'valid' ? null : icon('log-in'), s.state === 'valid' ? 'Entrar de novo' : 'Entrar')
                      : null;
                return el(
                  'tr',
                  { 'data-machine': r.machineId, 'data-session': s.name },
                  el('td', {}, r.machine),
                  el('td', {}, r.cloud),
                  el('td', { class: 'mono cl-name' }, s.name),
                  el('td', {}, profilesText(s)),
                  el('td', {}, pill(sessionPill(s, now))),
                  el('td', { class: 'cl-right' }, action),
                );
              }),
            ),
          )
        : null,
      away.length ? el('div', { class: 'cl-sf' }, icon('offline'), `Sem leitura de ${away.join(', ')}: os perfis de lá ficam de fora até responder.`) : null,
    );
  }

  function draw() {
    if (ctx.signal.aborted) return;
    const aws = local.aws;
    const githubOn = github?.state === 'connected';
    const awsOn = awsConnected(aws);
    const connected = [githubOn ? githubCard() : null, awsOn ? awsCard() : null].filter(Boolean);
    if (!awsOn) connected.push(el('section', { class: 'card cl-none', 'data-card': 'no-cloud' }, el('span', { class: 'cl-none-ic' }, icon('cloud')), el('b', {}, 'Nenhuma nuvem conectada'), el('span', {}, 'Adicione uma abaixo. O console não aponta para conta de ninguém: ele lê o que a CLI da nuvem já tem nesta máquina.')));
    const toAdd = [githubOn ? null : githubCard(), awsOn ? null : awsCard(), ...local.soon.filter((k) => SOON[k]).map(soonCard), otherCard()].filter(Boolean);
    const count = (githubOn ? 1 : 0) + (awsOn ? 1 : 0);
    area.replaceChildren(
      head,
      ...(failure ? [errorBand({ title: 'Sem conexão com o núcleo.', text: `${failure.message}. Mostrando a última leitura.`, action: { label: 'Tentar de novo', onClick: () => refresh() } })] : []),
      eyebrow(`Conectadas · ${count}`),
      el('div', { class: 'cl-grid', 'data-grid': 'connected' }, ...connected),
      ...[allSessionsCard()].filter(Boolean),
      eyebrow('Adicionar uma conexão'),
      el('div', { class: 'cl-grid cl-grid-add', 'data-grid': 'add' }, ...toAdd),
      lockLine('Entrar roda o login da CLI de cada nuvem, que abre o seu navegador. O console lê a configuração dela e o estado da sessão; nada digitado aqui vira comando.'),
    );
  }

  async function refresh() {
    await Promise.all([readLocal(), readGithub(), readRemotes()]);
    draw();
    schedule();
  }

  ctx.onChange(async (changes) => {
    const cloud = changes.some((c) => c?.type === 'connector');
    const gh = connectionChanged(changes);
    if (!cloud && !gh) return;
    await Promise.all([cloud ? readLocal() : null, gh ? readGithub() : null]);
    draw();
  });
  ctx.onRestart(() => refresh());

  area.replaceChildren(head, loading({ label: 'Lendo as conexões' }));
  await Promise.all([readGithub(), readRemotes()]);
  draw();
  schedule();
  return () => clearTimeout(timer);
}

// ---------- the AWS screen (C58 to C60) ----------

function statCard(s) {
  return el(
    'div',
    { class: 'card cl-stat', 'data-stat': s.id },
    el('span', { class: 'cl-stat-label' }, s.label),
    el('span', { class: `cl-stat-ic cl-tone-${s.tone}` }, icon(s.icon)),
    el('span', { class: 'cl-stat-v' }, s.value),
    el('span', { class: 'cl-stat-s' }, s.sub),
  );
}

function problemCard(p) {
  return el('section', { class: 'card cl-state', 'data-problem': p.id }, el('span', { class: `cl-state-ic cl-tone-${p.tone}` }, icon(p.icon)), el('b', {}, p.title), el('span', { class: 'cl-state-text' }, p.text), p.code ? el('code', { class: 'mono cl-config' }, p.code) : null);
}

export async function mount(area, ctx) {
  loadCloudStyle(ctx.signal);
  let machineId = machineFromSearch(globalThis.location?.search);
  let machines = [];
  let aws = null;
  let status = 'loading'; // 'loading' | 'ok' | 'unreachable' | 'unsupported' | 'missing' | 'not-found'
  let readAt = null;
  let failure = null;
  let request = 0;
  let timer = null;
  let ticker = null;
  let pendingStart = null;

  // The login the catalog asked for (`?login=<name>` and the history state of that click), once.
  const query = new URLSearchParams(globalThis.location?.search ?? '');
  const asked = query.get('login');
  if (asked) {
    if (globalThis.history?.state?.startLogin === asked) pendingStart = asked;
    globalThis.history?.replaceState?.(null, '', awsScreenRoute(machineId));
  }

  const labelOf = (id) => (id === LOCAL_ID ? 'Este Mac' : (machines.find((m) => m.id === id)?.label ?? id));

  const logins = createLogins({
    ctx,
    onUpdate: ({ name, login }) => {
      const s = aws?.sessions.find((x) => x.name === name);
      if (s && login && typeof login === 'object' && typeof login.state === 'string') s.login = { ...s.login, ...login, deviceCode: login.deviceCode ?? null };
      draw();
      if (login !== undefined) read();
    },
  });

  function select(id) {
    if (id === machineId) return;
    machineId = id;
    aws = null;
    status = 'loading';
    readAt = null;
    globalThis.history?.replaceState?.(null, '', awsScreenRoute(id));
    draw();
    read();
  }

  async function readMachines() {
    try {
      machines = normalizeMachines(await ctx.read(MACHINES_ROUTE)).filter((m) => isRemoteId(m.id));
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      machines = [];
    }
  }

  async function read() {
    if (ctx.signal.aborted) return;
    const n = ++request;
    const id = machineId;
    try {
      if (id === LOCAL_ID) {
        const c = normalizeConnectors(await ctx.read(CONNECTORS_ROUTE));
        if (n !== request) return;
        if (!c) status = 'missing';
        else ((status = 'ok'), (aws = c.aws), (readAt = new Date().toISOString()));
      } else {
        const r = normalizeRemote(await ctx.read(remoteConnectorsRoute(id)));
        if (n !== request) return;
        if (!r) status = 'missing';
        else if (r.status === 'ok') ((status = 'ok'), (aws = r.connectors?.aws ?? null), (readAt = new Date().toISOString()));
        else status = r.status;
      }
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError' || n !== request || ctx.signal.aborted) return;
      if (e?.status === 404) status = id === LOCAL_ID ? 'missing' : 'not-found';
      else failure = e;
    }
    if (pendingStart && status === 'ok' && aws) {
      const s = aws.sessions.find((x) => x.name === pendingStart);
      pendingStart = null;
      if (s && canLogin(aws, s) && s.login.state !== 'running') logins.start(machineId, s, aws);
    }
    draw();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    clearInterval(ticker);
    timer = ticker = null;
    if (ctx.signal.aborted) return;
    const running = aws ? anyRunning(aws.sessions) : false;
    if (running) ticker = setInterval(() => tickClocks(area), 1000);
    if (machineId !== LOCAL_ID || running) timer = setTimeout(read, running ? RUNNING_POLL_MS : REMOTE_POLL_MS);
  }

  function screenHeader() {
    const remote = machineId !== LOCAL_ID;
    const sub = status === 'ok' && readAt ? `IAM Identity Center · ${remote ? `lido pelo núcleo da ${labelOf(machineId)}, pelo túnel` : 'lido de ~/.aws/config'} ${ago(readAt)}${aws ? ` · ${cliLine(aws)}` : ''}` : 'IAM Identity Center';
    const actions = [];
    if (machines.length) {
      actions.push(
        el(
          'div',
          { class: 'cl-seg', role: 'group', 'aria-label': 'Máquina' },
          ...[{ id: LOCAL_ID, label: 'Este Mac' }, ...machines].map((m) => el('button', { type: 'button', 'aria-pressed': String(m.id === machineId), 'data-machine': m.id, onClick: () => select(m.id) }, m.label)),
        ),
      );
    }
    if (status === 'ok' && aws && ['expired', 'expiring'].includes(aws.state)) actions.push(pill(connectorPill(aws)));
    actions.push(el('button', { type: 'button', class: 'btn outline', 'data-cl-action': 'refresh', onClick: () => read() }, icon('refresh'), 'Atualizar'));
    return header({ icon: 'cloud', title: 'AWS', sub, actions });
  }

  function sessionCard(s, { offline, now }) {
    const remote = machineId !== LOCAL_ID;
    const action = sessionAction(machineId, s, aws, logins, { offline });
    const b = offline ? null : loginBandFor(machineId, s, aws, logins, { where: remote ? labelOf(machineId) : null, now });
    return el(
      'section',
      { class: `card cl-sess${s.state === 'expired' ? ' cl-bad' : ''}`, 'data-session': s.name, 'data-state': s.state },
      el('div', { class: 'cl-sh' }, el('span', { class: 'cl-accent' }, icon('key')), el('div', { class: 'cl-sn' }, el('b', { class: 'mono' }, s.name), el('small', {}, sessionMeta(s))), el('div', { class: 'cl-act' }, pill(sessionPill(s, now)), action)),
      b,
      s.profiles.length
        ? el(
            'table',
            { class: 'cl-table' },
            el('thead', {}, el('tr', {}, ...['Perfil', 'Conta', 'Papel', 'Região'].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...s.profiles.map((p) => el('tr', {}, el('td', { class: 'mono cl-name' }, p.name), el('td', { class: 'mono' }, p.accountId ?? '—'), el('td', { class: 'mono' }, p.roleName ?? '—'), el('td', { class: 'mono' }, p.region ?? s.region ?? '—')))),
          )
        : null,
      el('div', { class: 'cl-sf' }, icon(s.state === 'valid' || s.state === 'expiring' ? 'clock' : 'info'), sessionFoot(s, now)),
    );
  }

  function body() {
    const now = Date.now();
    const remote = machineId !== LOCAL_ID;
    const label = labelOf(machineId);
    if (status === 'loading') return [loading({ label: 'Lendo os perfis da AWS' })];
    if (status === 'missing') return [empty({ icon: 'cloud', title: 'Este núcleo não tem os conectores de nuvem', text: 'Ele é de uma versão anterior. Atualize o console para ver as sessões da AWS.' })];
    if (status === 'not-found') return [empty({ icon: 'server', title: 'Máquina não encontrada', text: `Nenhuma máquina "${machineId}" no ~/.ahrena-console/machines.json deste núcleo.`, action: { label: 'Ver este Mac', onClick: () => select(LOCAL_ID) } })];
    if (status === 'unsupported') return [empty({ icon: 'git-compare', title: `O núcleo da ${label} não tem os conectores de nuvem`, text: 'Ele é de uma versão anterior. Atualize o núcleo de lá para ver os perfis dela.' })];
    const offline = status === 'unreachable';
    const parts = [];
    if (offline) parts.push(errorBand({ title: `Sem conexão com a ${label}.`, text: aws ? 'Mostrando a última leitura; Entrar volta quando ela responder.' : 'Os perfis de lá aparecem quando ela responder.', action: { label: 'Tentar agora', onClick: () => read() } }));
    if (failure) parts.push(errorBand({ title: 'Sem conexão com o núcleo.', text: `${failure.message}. Mostrando a última leitura.`, action: { label: 'Tentar de novo', onClick: () => read() } }));
    if (!aws) {
      if (!offline) parts.push(empty({ icon: 'cloud', title: 'A AWS não está configurada', text: `O núcleo ${remote ? `da ${label}` : 'deste Mac'} não lê a AWS.` }));
      return parts;
    }
    const content = [];
    const problems = awsProblems(aws);
    if (aws.sessions.length) content.push(el('div', { class: 'cl-stats' }, ...awsStats(aws).map(statCard)));
    if (problems.length) content.push(el('div', { class: 'cl-states' }, ...problems.map(problemCard)));
    if (!aws.sessions.length && aws.cli.found && (aws.cli.version === null || aws.cli.version >= 2)) {
      content.push(
        el(
          'section',
          { class: 'card cl-state cl-state-wide', 'data-problem': 'not-configured' },
          el('span', { class: 'cl-state-ic cl-tone-muted' }, icon('cloud')),
          el('b', {}, 'Nenhum perfil com SSO'),
          el('span', { class: 'cl-state-text' }, `O ~/.aws/config ${remote ? `da ${label}` : 'deste Mac'} não tem nenhuma sso-session. Para criar uma, num terminal ${remote ? 'de lá' : 'daqui'}:`),
          el('code', { class: 'mono cl-config' }, 'aws configure sso'),
          el('span', { class: 'cl-state-text' }, 'O console relê o arquivo sozinho e as sessões aparecem aqui.'),
        ),
      );
    }
    for (const s of aws.sessions) content.push(sessionCard(s, { offline, now }));
    if (aws.outOfScope.length) {
      content.push(
        el(
          'section',
          { class: 'card cl-sess', 'data-card': 'out-of-scope' },
          el('div', { class: 'cl-sh' }, el('span', { class: 'cl-muted' }, icon('key')), el('div', { class: 'cl-sn' }, el('b', {}, 'Fora do escopo'), el('small', {}, 'perfis sem SSO'))),
          el('table', { class: 'cl-table' }, el('tbody', {}, ...aws.outOfScope.map((p) => el('tr', {}, el('td', { class: 'mono cl-name' }, p.name), el('td', { class: 'cl-muted cl-wrap' }, outOfScopeText(p)))))),
        ),
      );
    }
    parts.push(offline ? el('div', { class: 'cl-faded', 'aria-label': 'Última leitura guardada' }, ...content) : el('div', { class: 'cl-column' }, ...content));
    parts.push(lockLine('O console lê o ~/.aws/config e, da sessão, só a hora em que ela expira. Token e chave ficam com a aws CLI; nada disso sai para a tela, o log ou o banco.'));
    return parts;
  }

  function draw() {
    if (ctx.signal.aborted) return;
    const crumb = el('nav', { class: 'cl-crumb', 'aria-label': 'Caminho' }, el('a', { href: '/ui/connections', class: 'cl-link' }, 'Conexões'), icon('chevron-right'), el('b', {}, 'AWS'));
    ctx.title(machineId === LOCAL_ID ? 'AWS' : `AWS · ${labelOf(machineId)}`);
    area.replaceChildren(crumb, screenHeader(), ...body());
  }

  ctx.onChange((changes) => {
    if (machineId === LOCAL_ID && changes.some((c) => c?.type === 'connector')) read();
  });
  ctx.onRestart(async () => {
    await readMachines().catch(() => {});
    read();
  });
  const stop = () => {
    clearTimeout(timer);
    clearInterval(ticker);
  };
  ctx.signal.addEventListener('abort', stop);

  draw();
  try {
    await readMachines();
  } catch (e) {
    if (e?.name === 'AbortError') return stop;
  }
  if (!isRemoteId(machineId) || machines.some((m) => m.id === machineId) || machineId === LOCAL_ID) await read();
  else {
    status = 'not-found';
    draw();
  }
  return stop;
}

