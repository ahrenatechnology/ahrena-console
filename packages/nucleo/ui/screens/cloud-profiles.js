// The "Perfis de nuvem" card of a machine screen (issue 277, wireframes C66 and C67): each core reads its own
// machine's ~/.aws/config, so Esta máquina shows this Mac's SSO sessions and a remote machine shows its own,
// read by this Mac's core through the tunnel (`GET /api/machines/<id>/connectors`).
//
// - machine.js mounts it with one hook: `cloudProfiles(ctx, id)` once, then `card.node(label)` in every
//   paint. The node is the same element across repaints; it starts reading on the first paint, so an id
//   the machine screen refuses never reads here.
// - A core without the routes (404), or any failure on the first read, hides the card: nothing else breaks.
// - This Mac re-reads on a `connector` change; a remote is polled every 30 s (no change events cross the
//   tunnel), every 3 s while a login runs there, so the device code shows up as soon as the CLI prints it.
// - Entrar on this Mac opens the browser here (C59); on a remote it asks the core over there for a device
//   code, shown big with "Abrir a página de login" and "Copiar o código" (C67). A remote core without the
//   login route answers 404 without a reason: the card shows the command to run over there, with Copiar.
// - A remote that does not answer keeps the last reading, faded, without Entrar.

import { el, icon } from '../dom.js';
import { clockTime } from './machine-format.js';
import { anyRunning, createLogins, loadCloudStyle, loginBandFor, pill, sessionAction, tickClocks } from './cloud-parts.js';
import { CONNECTORS_ROUTE, LOCAL_ID, REMOTE_POLL_MS, RUNNING_POLL_MS, normalizeConnectors, normalizeRemote, profilesText, remoteConnectorsRoute, sessionPill } from './cloud-format.js';

/** What the card shows for one reading: `'hidden'`, `'table'`, or a message kind. Exported for the test. */
export function profilesView({ local, status, aws, hasReading }) {
  if (status === 'hidden') return 'hidden';
  if (status === 'unsupported') return 'unsupported';
  if (status === 'unreachable' && !hasReading) return 'unreachable';
  if (!aws || aws.state === 'not-configured') return 'not-configured';
  if (aws.state === 'missing-cli') return 'missing-cli';
  if (aws.state === 'unsupported-cli') return 'unsupported-cli';
  return local || aws.sessions.length ? 'table' : 'not-configured';
}

const MESSAGES = {
  unsupported: (where) => `O núcleo da ${where} é de uma versão sem os perfis de nuvem. Atualize o núcleo de lá para ver os perfis dela.`,
  unreachable: (where) => `Sem conexão com a ${where}. Os perfis de lá aparecem quando ela responder.`,
  'missing-cli': (where, local) => `A aws CLI não está no PATH do shell de login ${local ? 'deste Mac' : `da ${where}`}. Instale a v2 e o console acha sozinho.`,
  'unsupported-cli': (where, local) => `A aws CLI ${local ? 'deste Mac' : `da ${where}`} é a v1, que não tem o login do IAM Identity Center. Atualize para a v2.`,
  'not-configured': (where, local) => `O ~/.aws/config ${local ? 'deste Mac' : `da ${where}`} não tem nenhum perfil com SSO. Para criar um, num terminal ${local ? 'daqui' : 'de lá'}: aws configure sso`,
};

export function cloudProfiles(ctx, machineId = LOCAL_ID) {
  const local = machineId === LOCAL_ID;
  const route = local ? CONNECTORS_ROUTE : remoteConnectorsRoute(machineId);
  const node = el('section', { class: 'card cl-sess cl-profiles', 'data-part': 'cloud-profiles', hidden: true });
  let label = local ? 'Esta máquina' : machineId;
  let status = 'loading'; // 'loading' | 'hidden' | 'ok' | 'unreachable' | 'unsupported'
  let aws = null;
  let readAt = null;
  let hasReading = false;
  let started = false;
  let request = 0;
  let timer = null;
  let ticker = null;

  const logins = createLogins({
    ctx,
    onUpdate: ({ name, login }) => {
      const s = aws?.sessions.find((x) => x.name === name);
      if (s && login && typeof login === 'object' && typeof login.state === 'string') s.login = { ...s.login, ...login, deviceCode: login.deviceCode ?? null };
      paint();
      if (login !== undefined) read();
    },
  });

  async function read() {
    if (ctx.signal.aborted) return;
    const n = ++request;
    try {
      const body = await ctx.read(route);
      if (n !== request || ctx.signal.aborted) return;
      if (local) {
        const c = normalizeConnectors(body);
        if (!c) status = 'hidden';
        else ((status = 'ok'), (aws = c.aws), (readAt = new Date().toISOString()), (hasReading = true));
      } else {
        const r = normalizeRemote(body);
        if (!r) status = 'hidden';
        else if (r.status === 'ok') ((status = 'ok'), (aws = r.connectors?.aws ?? null), (readAt = new Date().toISOString()), (hasReading = true));
        else status = r.status;
      }
    } catch (e) {
      if (e?.name === 'AbortError' || n !== request || ctx.signal.aborted) return;
      // A core without the routes (404), or nothing read yet: no card. Later, the last reading stays.
      if (e?.status === 404 || !hasReading) status = 'hidden';
    }
    paint();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    clearInterval(ticker);
    timer = ticker = null;
    if (ctx.signal.aborted || status === 'hidden') return;
    const running = aws ? anyRunning(aws.sessions) : false;
    if (running) ticker = setInterval(() => tickClocks(node), 1000);
    if (!local || running) timer = setTimeout(read, running ? RUNNING_POLL_MS : REMOTE_POLL_MS);
  }

  function paint() {
    const now = Date.now();
    const view = profilesView({ local, status, aws, hasReading });
    if (view === 'hidden' || status === 'loading') {
      node.setAttribute('hidden', '');
      return node.replaceChildren();
    }
    node.removeAttribute('hidden');
    const offline = status === 'unreachable';
    node.classList.toggle('cl-faded', offline);
    const where = local ? 'deste Mac · lidos do ~/.aws/config daqui' : `da ${label} · lidos pelo núcleo de lá, pelo túnel`;
    const head = el(
      'div',
      { class: 'cl-sh' },
      el('span', { class: 'cl-accent' }, icon('cloud')),
      el('div', { class: 'cl-sn' }, el('b', {}, 'Perfis de nuvem'), el('small', {}, where)),
      el('div', { class: 'cl-act' }, el('a', { class: 'cl-link', href: '/ui/connections' }, 'ver todas as máquinas em Conexões ›')),
    );
    const parts = [head];
    if (view !== 'table') {
      parts.push(el('p', { class: 'cl-message' }, MESSAGES[view](label, local)));
    } else {
      const sessions = aws.sessions;
      for (const s of sessions) {
        const b = offline ? null : loginBandFor(machineId, s, aws, logins, { where: local ? null : label, now });
        if (b) parts.push(b);
      }
      parts.push(
        el(
          'table',
          { class: 'cl-table' },
          el('thead', {}, el('tr', {}, ...['Nuvem', 'Sessão', 'Perfis', 'Estado', ''].map((h) => el('th', {}, h)))),
          el(
            'tbody',
            {},
            ...sessions.map((s) =>
              el(
                'tr',
                { 'data-session': s.name },
                el('td', {}, 'AWS'),
                el('td', { class: 'mono cl-name' }, s.name),
                el('td', {}, profilesText(s)),
                el('td', {}, pill(sessionPill(s, now))),
                el('td', { class: 'cl-right' }, sessionAction(machineId, s, aws, logins, { offline })),
              ),
            ),
          ),
        ),
      );
    }
    let foot;
    if (offline) foot = [icon('offline'), hasReading ? `Sem conexão: estes são os de ${clockTime(readAt)}. Entrar volta quando a ${label} responder.` : `Entrar volta quando a ${label} responder.`];
    else if (view !== 'table') foot = null;
    else if (local) foot = [icon('info'), 'Entrar abre o navegador deste Mac e roda o login da aws CLI daqui.'];
    else foot = [icon('info'), 'O túnel usa um perfil ', el('b', {}, 'deste Mac'), `; estes são os perfis que a ${label} usa para ela mesma. Entrar mostra aqui o código para confirmar no navegador deste Mac.`];
    if (foot) parts.push(el('div', { class: 'cl-sf' }, foot[0], el('span', {}, ...foot.slice(1))));
    node.replaceChildren(...parts);
  }

  ctx.onChange((changes) => {
    if (local && started && changes.some((c) => c?.type === 'connector')) read();
  });
  ctx.onRestart(() => started && read());
  const stop = () => {
    clearTimeout(timer);
    clearInterval(ticker);
  };
  if (ctx.signal.aborted) stop();
  else ctx.signal.addEventListener('abort', stop);

  return {
    /** The card, the same element every time; the first call starts reading. */
    node(machineLabel) {
      if (machineLabel && machineLabel !== label) {
        label = machineLabel;
        if (!node.hasAttribute('hidden')) paint();
      }
      if (!started && !ctx.signal.aborted) {
        started = true;
        loadCloudStyle(ctx.signal);
        read();
      }
      return node;
    },
  };
}
