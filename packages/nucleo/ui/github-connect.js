// The console's GitHub connection on every screen (issue 241, wireframe C39 to C44): the shared "Conectar ao
// GitHub" empty state (C42), the sidebar footer (`ghFooter`), the pt-BR phrasing of the connection's
// machine codes and the helpers the screens use to follow the connection live.
//
// - A GitHub-backed route answers 409 `{ error: "github-not-connected" }` when the console has no
//   credential (src/api/server.ts). The screen shows `connectEmpty({ what, navigate })` instead of its
//   content: one button that opens Conexões and starts the device flow (`/ui/connections?start=1`).
// - Every status transition of the connection is a `connections` change (key `github`) in
//   `/api/changes`: `connectionChanged(changes)` tells a screen to read again.
// - Nothing from GitHub becomes HTML: logins and organization names go in through `textContent`, and
//   a link from the core is used only when it is https on github.com (`githubHttpsUrl`).

import { el, icon } from './dom.js';

export const CONNECTIONS_ROUTE = '/api/connections';
/** The Conexões screen. */
export const CONNECTIONS_UI = '/ui/connections';
/** Conexões starting the device flow at once (the C42 button). */
export const CONNECT_UI = '/ui/connections?start=1';
export const GITHUB_NOT_CONNECTED = 'github-not-connected';

/** The read or write failed because the console is not connected to GitHub (409 `github-not-connected`). */
export const isGithubNotConnected = (e) => e?.status === 409 && e?.body?.error === GITHUB_NOT_CONNECTED;

/** A live batch with a transition of the GitHub connection. */
export const connectionChanged = (changes) => Array.isArray(changes) && changes.some((c) => c?.type === 'connections');

/** A link from the core, only when it is https on github.com; anything else is `null` (no link). */
export function githubHttpsUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname.endsWith('.github.com')) && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

// ---------- C42: the shared empty state ----------

/** What each screen would do, said in its empty state (the wireframe's sentences). */
export const CONNECT_TEXT = {
  repos: 'Repositórios lê as organizações e os repositórios da sua conta: atividade, issues, PRs, CI e as sessões que mexem em cada um.',
  repo: 'O repositório mostra as métricas do GitHub: commits, issues, PRs, CI, linguagens e contribuidores, num período que você escolhe.',
  project: 'O Kanban do projeto mostra um GitHub Project por Status, e arrastar um card muda o Status lá. Depois de conectar, você escolhe o Project.',
  'dev-console': 'O Dev Console junta PRs, CI e issues dos repositórios do contexto com as sessões que trabalham neles.',
  instructions: 'As instruções dos agentes, as ADRs e as PDRs são lidas do repositório no GitHub. As sessões deste repositório continuam aqui, sem GitHub.',
  adrs: 'ADR lê as decisões de arquitetura das pastas de decisão dos repositórios da sua conta no GitHub.',
  pdrs: 'PDR lê as decisões de produto das pastas de decisão dos repositórios da sua conta no GitHub.',
  record: 'O registro de decisão é lido do repositório no GitHub, com o histórico e os links do arquivo.',
  delivery: 'Entregas conta PRs e issues dos repositórios das suas sessões, com as horas e o custo do Claude de cada entrega.',
  'framework-install': 'O instalador lê o repositório no GitHub para montar o plano e abre o PR com o Ahrena Framework.',
};

/**
 * C42: "Conecte o console ao GitHub", with what the screen would do and one button that opens Conexões
 * already with the code. `navigate` is the shell's (`ctx.navigate`).
 */
export function connectEmpty({ what, navigate }) {
  const go = () => navigate(CONNECT_UI);
  return el(
    'section',
    { class: 'card state center ghc-empty', 'data-github': 'not-connected' },
    el('div', { class: 'seal' }, icon('github')),
    el('h2', {}, 'Conecte o console ao GitHub'),
    el('p', { class: 'ghc-what' }, what ?? ''),
    el('button', { type: 'button', class: 'btn filled', 'data-action': 'connect', onClick: go }, icon('github'), 'Conectar ao GitHub'),
    el('p', { class: 'ghc-note' }, 'Uma vez para todas as telas. Abre Conexões já com o código; a credencial fica no cofre do sistema.'),
  );
}

/** The C42 empty state for a screen id of `CONNECT_TEXT`. */
export const connectEmptyFor = (screen, navigate) => connectEmpty({ what: CONNECT_TEXT[screen] ?? '', navigate });

// ---------- the sidebar footer (ghFooter, C39 to C42) ----------

/** What the footer says for a connection status: `{ name, label, tone }`. */
export function footerState(github) {
  if (!github || typeof github !== 'object') return null;
  const login = typeof github.login === 'string' && github.login ? github.login : null;
  if (github.state === 'connected') return { name: login ?? 'GitHub', label: 'conectado', tone: 'on' };
  if (github.state === 'pending') return { name: 'GitHub', label: 'esperando', tone: 'pending' };
  if (github.state === 'unavailable') return { name: 'GitHub', label: 'indisponível', tone: 'off' };
  return { name: 'GitHub', label: 'conectar', tone: 'off' };
}

/**
 * The footer card: a link to Conexões with the GitHub state. `read` is the shell's read layer; call
 * `refresh()` on start, on every `connections` change and when the core restarts.
 */
export function createGithubFooter({ node, read }) {
  let last = null;
  node.setAttribute('href', CONNECTIONS_UI);
  function draw(github) {
    const s = footerState(github);
    if (!s) {
      node.setAttribute('hidden', '');
      return;
    }
    const key = JSON.stringify(s);
    node.removeAttribute('hidden');
    if (key === last) return;
    last = key;
    node.dataset.state = s.tone;
    node.setAttribute('aria-label', `GitHub: ${s.label}${s.tone === 'on' && s.name !== 'GitHub' ? ` como ${s.name}` : ''}`);
    node.replaceChildren(
      icon('github'),
      el('span', { class: 'cc-gh-name' }, s.name),
      el('span', { class: 'cc-gh-state' }, s.tone === 'pending' ? icon('wall-loader') : null, s.label),
    );
  }
  async function refresh() {
    try {
      const r = await read(CONNECTIONS_ROUTE);
      draw(r?.github ?? null);
    } catch {
      // A core without the route (an older core, --no-github before issue 241): the card stays as it was.
    }
  }
  return { refresh, draw };
}

// ---------- the pt-BR of the connection's codes ----------

/** Why the connection is unavailable (`reason`): `{ title, text }`. */
export const UNAVAILABLE = {
  'no-client-id': {
    title: 'Este console não tem o aplicativo do GitHub',
    text: 'Acontece num console montado do código antes do aplicativo da Ahrena existir. Quem montou define AHRENA_CONSOLE_GITHUB_CLIENT_ID com o Client ID de um OAuth App com device flow.',
  },
  'no-vault': {
    title: 'Não há onde guardar a credencial com segurança',
    text: 'Esta máquina não tem o Keychain do macOS nem o Secret Service do Linux. O console não guarda a credencial em arquivo, então não conecta.',
  },
  'gh-not-installed': {
    title: 'O gh não está instalado nesta máquina',
    text: 'A fonte escolhida é o login do gh, mas o gh não está no PATH. Volte ao padrão para conectar pelo console, ou instale o gh e entre com gh auth login.',
  },
  'gh-not-authenticated': {
    title: 'O gh desta máquina não tem login',
    text: 'A fonte escolhida é o login do gh, e ele não está autenticado. Rode gh auth login no terminal, ou volte ao padrão para conectar pelo console.',
  },
  'github-off': {
    title: 'O núcleo subiu sem o GitHub',
    text: 'Ele foi iniciado com --no-github: nenhuma tela lê o GitHub. Reinicie o núcleo sem essa opção para conectar.',
  },
};

/** Why the last device flow ended without a credential (`lastError`): `{ title, text }`. */
export const LAST_ERROR = {
  expired: { title: 'O código expirou antes da autorização', text: 'Os 15 minutos passaram sem autorizar no GitHub, e nada foi guardado. Gere outro código para tentar de novo.' },
  denied: { title: 'Você recusou no GitHub', text: 'A autorização foi recusada na página do GitHub, e nada foi guardado. Gere outro código se quiser conectar.' },
  'github-error': { title: 'O GitHub não completou a conexão', text: 'O GitHub respondeu com erro enquanto esperávamos a autorização. Nada foi guardado; gere outro código.' },
  'vault-error': { title: 'Não deu para guardar a credencial', text: 'O cofre do sistema recusou a gravação, então a conexão não ficou. Confira se o cofre está desbloqueado e gere outro código.' },
};

/** A refused connection write in pt-BR (never the raw code). */
export function writeErrorText(e) {
  const code = e?.body?.error;
  const status = e?.status;
  if (code === 'github-unavailable') return UNAVAILABLE[e?.body?.reason]?.title ? `${UNAVAILABLE[e.body.reason].title}.` : 'A conexão com o GitHub não está disponível nesta máquina.';
  if (code === 'source-is-gh') return 'A fonte é o login do gh: conectar e desconectar ficam com o gh. Volte ao padrão para usar a conexão do console.';
  if (code === 'github-error') return 'O GitHub recusou o pedido do código. Tente de novo em instantes.';
  if (code === 'gh-not-installed') return 'O gh não está instalado nesta máquina.';
  if (code === 'invalid') return 'O núcleo recusou o pedido.';
  if (code === 'forbidden') return 'O núcleo só aceita esse pedido da própria janela do console.';
  if (code === 'too-large' || code === 'unsupported-media-type' || code === 'method-not-allowed') return 'O núcleo recusou o pedido.';
  if (status === 0 || status === undefined) return 'O núcleo não respondeu.';
  return `O núcleo respondeu ${status}.`;
}
