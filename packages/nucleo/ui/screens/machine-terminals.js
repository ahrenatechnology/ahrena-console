// The "Sessões de terminal" card of the machine screens (C90 to C93, issue 350): one row per
// pseudo-terminal, with Interromper o comando and Encerrar a sessão. Each action opens a
// confirmation that shows the process and the signal; the ladder (SIGINT, SIGTERM, SIGKILL with a
// second confirmation; SIGHUP, SIGTERM) is one click per step, never automatic. The write sends ids
// only (`POST /api/terminals/<id>/actions/<action>` with the pid shown); on a remote machine it goes
// through this Mac's core with `machine`, and when the remote does not accept actions the buttons
// become Copiar comando.

import { el, icon } from '../dom.js';
import {
  TERMINAL_ACTION_ROUTE,
  actionProblem,
  ageText,
  claudeLabel,
  confirmation,
  connectionCell,
  copyCommand,
  endState,
  interruptState,
  nextStep,
  shortCommand,
  stateOf,
  STEP,
} from './machine-terminals-format.js';

const SETTLE_MS = 1500;
const SETTLE_REMOTE_MS = 3000;

const pill = ([tone, label]) => el('span', { class: `badge ${tone}` }, el('span', { class: 'p' }), label);

/**
 * The card's state for one machine screen. `repaint()` redraws from the last data; `reread()` reads
 * the machine again; both are the screen's.
 */
export function machineTerminals(ctx, { id, local, label: labelOf, repaint, reread }) {
  const label = () => labelOf();
  // flow: the confirmation open; band: the line above the card (the result, or the next step).
  let flow = null;
  let band = null;
  let sending = false;
  let waiting = null;
  let latest = null;
  let copied = null;

  const ask = (s, step) => {
    const pid = STEP[step].target === 'command' ? s.foreground?.pid : s.end.pid;
    if (pid === null || pid === undefined) return;
    flow = { sessionId: s.id, step, pid };
    band = null;
    repaint();
  };

  async function send() {
    if (!flow || sending) return;
    const { sessionId, step, pid } = flow;
    sending = true;
    repaint();
    try {
      await ctx.write(TERMINAL_ACTION_ROUTE(sessionId, step), { pid, ...(local ? {} : { machine: id }), ...(step === 'kill' ? { confirm: true } : {}) });
      flow = null;
      sending = false;
      waiting = { sessionId, step, pid, readyAt: Date.now() + (local ? SETTLE_MS : SETTLE_REMOTE_MS) };
      band = { tone: 'running', title: 'Enviado', text: `${STEP[step].signal} enviado. Conferindo o terminal…` };
      repaint();
      setTimeout(() => !ctx.signal.aborted && reread(), local ? SETTLE_MS : SETTLE_REMOTE_MS);
    } catch (e) {
      sending = false;
      flow = null;
      if (e?.name === 'AbortError' || ctx.signal.aborted) return;
      band = { tone: 'error', title: 'Nada foi enviado.', text: actionProblem(e, { local, machineLabel: label() }) };
      repaint();
      reread();
    }
  }

  /** Called with each new reading: finishes the wait after an action. */
  function take(terminals, sessions) {
    latest = { terminals, sessions };
    if (!waiting || Date.now() < waiting.readyAt) return;
    const { sessionId, step, pid } = waiting;
    waiting = null;
    const s = terminals?.sessions.find((x) => x.id === sessionId);
    const target = STEP[step].target;
    const stillThere = target === 'command' ? s?.foreground?.pid === pid : s?.end.pid === pid;
    if (!stillThere) {
      band = { tone: 'ok', title: target === 'command' ? `${s?.tty ?? sessionId.replace('-', '/')} voltou ao prompt.` : 'A sessão foi encerrada.', text: `${STEP[step].signal} funcionou e o núcleo leu o terminal de novo.` };
      return;
    }
    const next = nextStep(step);
    band = next
      ? { tone: 'warn', title: `${STEP[step].signal} enviado e o processo continua vivo.`, text: 'Escolha o próximo sinal: nada sobe sozinho.', next: { sessionId, step: next } }
      : { tone: 'error', title: `${STEP[step].signal} enviado e o processo continua vivo.`, text: 'Não há outro sinal para tentar daqui.' };
  }

  function actions(s) {
    const copyMode = !local && !latest?.terminals?.remoteActions;
    const make = (kind, state, labelText, iconName, step) => {
      if (!state.on) return el('div', { class: 'tm-term-action' }, el('button', { type: 'button', class: 'btn outline', disabled: true, 'data-action': kind, title: state.why }, icon(iconName), labelText), el('small', { class: 'tm-muted' }, state.why));
      if (copyMode) {
        const text = copyCommand(s, kind);
        const key = `${s.id}:${kind}`;
        return el('div', { class: 'tm-term-action' }, el('button', { type: 'button', class: 'btn outline', 'data-action': `copy-${kind}`, onClick: () => copy(key, text) }, icon('copy'), copied === key ? 'Copiado' : `Copiar: ${text}`));
      }
      return el('div', { class: 'tm-term-action' }, el('button', { type: 'button', class: 'btn outline', 'data-action': kind, disabled: sending || null, onClick: () => ask(s, step) }, icon(iconName), labelText));
    };
    return el('td', { class: 'tm-term-actions' }, make('command', interruptState(s), 'Interromper o comando', 'square', 'interrupt'), make('session', endState(s), 'Encerrar a sessão', 'power', 'hangup'));
  }

  function copy(key, text) {
    globalThis.navigator?.clipboard?.writeText?.(text).catch(() => {});
    copied = key;
    repaint();
    setTimeout(() => ((copied = null), !ctx.signal.aborted && repaint()), 2000);
  }

  function card(terminals, sessions, { now = Date.now() } = {}) {
    if (!terminals) return null;
    latest = { terminals, sessions };
    const rows = terminals.sessions.map((s) => {
      const [conn, detail] = connectionCell(s);
      const claude = s.stuck ? claudeLabel(s, sessions) : null;
      return el(
        'tr',
        { 'data-terminal': s.tty, class: s.stuck ? 'tm-term-stuck' : null },
        el('td', {}, el('b', { class: 'mono' }, s.tty), el('small', { class: 'mono tm-muted' }, s.shell ? s.shell.args : '')),
        el('td', {}, conn, detail ? el('small', { class: 'tm-muted' }, detail) : null),
        el('td', {}, s.foreground ? el('b', { class: 'mono tm-term-cmd' }, shortCommand(s.foreground.args)) : el('span', { class: 'tm-muted' }, 'só o prompt'), claude ? el('small', { class: 'tm-muted' }, icon('bot'), ` sessão do Claude: ${claude}`) : null),
        el('td', { class: 'mono' }, s.foreground ? ageText(s.foreground.ageSec) : '—'),
        el('td', {}, pill(stateOf(s))),
        actions(s),
      );
    });
    const readOnly =
      !local && !terminals.remoteActions
        ? el('div', { class: 'tm-only-shows', role: 'note' }, icon('info'), el('p', {}, el('b', {}, 'Só leitura.'), ` A ${label()} não aceita ações vindas deste Mac, e cada ação vira Copiar comando, para colar num terminal de lá. Para ligar, na ${label()}, grave `, el('code', {}, '"terminal": { "acceptRemoteActions": true }'), ' no ', el('code', {}, '~/.ahrena-console/config.json'), ' (ou suba o núcleo com ', el('code', {}, 'AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1'), ').'))
        : null;
    const body = rows.length
      ? el(
          'table',
          { class: 'tm-table tm-term-table' },
          el('thead', {}, el('tr', {}, ...['Terminal · shell', 'Conexão', 'Em primeiro plano', 'Há', 'Estado', ''].map((h) => el('th', {}, h)))),
          el('tbody', {}, ...rows),
        )
      : el('p', { class: 'tm-muted' }, 'Nenhum terminal aberto. Sem conexão ssh nem pseudo-terminal nesta máquina; quando uma aba abrir, ela aparece aqui.');
    return el(
      'section',
      { class: 'card tm-card tm-span-full', 'data-part': 'terminals' },
      el('h2', { class: 'tm-title' }, icon('square-terminal'), el('span', {}, 'Sessões de terminal'), el('small', { class: 'tm-note' }, `lido a cada 30 s · limite de “presa”: ${Math.round(terminals.stuckAfterSec / 60)} min`)),
      readOnly,
      body,
    );
  }

  /** The line above the card: the result of the last action, or the next step of the ladder. */
  function bandNode() {
    if (!band) return null;
    const next = band.next;
    const nextSession = next && latest?.terminals?.sessions.find((x) => x.id === next.sessionId);
    return el(
      'div',
      { class: `tm-rc-band tm-term-band tm-rc-${band.tone}`, role: band.tone === 'error' ? 'alert' : 'status', 'data-part': 'terminal-band' },
      el('div', {}, el('b', {}, band.title), ' ', band.text),
      nextSession ? el('button', { type: 'button', class: 'btn filled', 'data-action': 'next-step', onClick: () => ask(nextSession, next.step) }, icon(STEP[next.step].icon), STEP[next.step].ok) : null,
      el('button', { type: 'button', class: 'btn outline', 'aria-label': 'Fechar o aviso', onClick: () => ((band = null), repaint()) }, icon('x')),
    );
  }

  /** The open confirmation, or `null`. Drawn above the faded screen, like the tunnel's. */
  function dialogNode() {
    if (!flow) return null;
    const s = latest?.terminals?.sessions.find((x) => x.id === flow.sessionId);
    if (!s) {
      flow = null;
      return null;
    }
    const c = confirmation(s, flow.step, { machineLabel: label(), local });
    const close = () => ((flow = null), repaint());
    return el(
      'section',
      { class: 'card mc-dialog tm-term-dialog', role: 'dialog', 'aria-labelledby': 'tm-term-dialog-title', 'data-part': 'terminal-dialog', 'data-step': flow.step },
      el('h2', { id: 'tm-term-dialog-title' }, icon('square-terminal'), ' ', c.title),
      el('dl', { class: 'tm-term-kv' }, ...c.rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
      el('div', { class: 'tm-term-sends' }, el('small', { class: 'tm-muted' }, 'Vai enviar, exatamente'), ...c.lines.map((l) => el('code', {}, l))),
      el('p', { class: 'tm-muted' }, icon(c.danger ? 'alert' : 'shield-check'), ' ', 'Antes de enviar, o núcleo confere de novo que o pid ainda é este processo, neste terminal e do seu usuário. ', c.note),
      el(
        'div',
        { class: 'tm-term-dialog-buttons' },
        el('button', { type: 'button', class: 'btn outline', 'data-action': 'dialog-cancel', onClick: close }, 'Cancelar'),
        el('button', { type: 'button', class: `btn filled${c.danger ? ' tm-term-danger' : ''}`, 'data-action': 'dialog-confirm', disabled: sending || null, onClick: send }, icon(c.icon), sending ? 'Enviando…' : c.ok),
      ),
    );
  }

  return { card, take, dialogNode, bandNode, isOpen: () => flow !== null };
}
