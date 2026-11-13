// The Atualizar button of the remote núcleo on the machine screen (issue 462, decision 0022, wireframes 462-1 to
// 462-6): the button on the yellow band, the confirmation that runs the --check first, the progress by phase and every
// ending. Decision 0024 (issue 484, wireframes 484-1 and 484-2): the Mac updates the remote núcleo by itself, so the
// band has four modes: `busy` (a run goes on, the automatic one says so and names the phase), `retry` (the last job
// failed or was refused: its reason and Tentar de novo), `ready` (Atualizar agora) and `setup` (no command can be
// built: only what is missing, no button). The card with the block to paste is gone; an invalid `connection.update`
// shows the derived command to compare. The card with the command to paste (449) shows only in `retry` and `setup`,
// collapsed. The confirmation never opens for a run the Mac started (`automatic`).
//
// - Nothing here runs a command: the writes take only the machine id (`POST …/update/check`, `POST …/update`,
//   `DELETE …/update`) and the core runs the `connection.update` the person declared.
// - The screen writes no sentence of a result or of a state: it is `update.message.text`, rendered by the core from the
//   table of decision 0022 section 7. What is here is static: labels (button, titles, phase names) and the explanatory
//   copy the approved wireframes 462-1 to 462-3 carry (what the click will do, that the swap cannot be cancelled).
// - machine.js mounts it once (`machineUpdate(ctx, id, …)`), calls `parts(machine, …)` in every paint (`null` means
//   "not mine": an older core without `update`, the owner proof pending, or no credential command, and the 449 flow
//   draws), `tick(area)` once a second and `active(machine)` to re-read fast while a run goes on.

import { el, icon } from '../dom.js';
import { runButtonAction, setDisabled } from '../button-action.js';
import { band, updateCard } from './machine-core.js';
import { coreOutdated, outdatedBand } from './machine-core-format.js';
import { canRetry, checkRoute, elapsed, isBusy, normalizeUpdate, phaseLabel, phaseName, pointsToCommand, resultLook, runKey, showsResult, stepRows, updateRoute, updatingNow } from './machine-update-format.js';

/** One button: `data-up-action` names it for the focus and the tests; busy keeps the focus (never `disabled`). */
function button({ label, iconName = null, filled = false, action, busy = false, why = null, onClick = null }) {
  const node = el('button', { type: 'button', class: `btn ${filled ? 'filled' : 'outline'}`, 'data-up-action': action, 'aria-busy': busy ? 'true' : null, 'aria-disabled': busy ? 'true' : null }, iconName ? icon(iconName) : null, label);
  if (why) setDisabled(node, why);
  node.addEventListener('click', () => {
    if (node.getAttribute('aria-disabled') === 'true' || node.getAttribute('aria-busy') === 'true') return;
    onClick?.();
  });
  return node;
}

function stepsNode(rows) {
  const marks = { done: 'check-circle-2', now: 'wall-loader', next: 'circle' };
  return el('ol', { class: 'tm-up-steps', 'aria-label': 'Andamento da atualização' }, ...rows.map((r) => el('li', { class: `tm-up-${r.tone}`, 'data-phase': r.key, 'aria-current': r.tone === 'now' ? 'step' : null }, icon(marks[r.tone]), el('span', {}, r.label))));
}

// The problems with which no command can be built: the band says what is missing and has no button.
const SETUP_PROBLEMS = new Set(['missing', 'invalid', 'invalid-file']);

const note = (text) => el('p', { class: 'tm-muted tm-up-note' }, text);
const problemNote = (text) => (text ? el('p', { class: 'tm-up-problem', role: 'alert' }, `Não deu certo: ${text}`) : null);

/**
 * `ctx` is the screen's; `opts.area` the node the screen draws in, `opts.repaint()` paints the last read again,
 * `opts.reread()` reads the core again and `opts.patch(update)` puts the answer of a write into the last read.
 */
export function machineUpdate(ctx, id, { area, repaint, reread, patch }) {
  let dialogOpen = false;
  let focusDialog = false;
  let dialogMode = null;
  let focusProgress = false;
  let problemAt = null;
  let focusBand = false;
  let pending = null;
  let problem = null;
  let fallbackOpen = false;
  const closed = new Set();

  async function call(what, route, method) {
    if (pending || ctx.signal.aborted) return false;
    pending = what;
    problem = null;
    repaint();
    let ok = true;
    try {
      const answer = await ctx.write(route, method === 'DELETE' ? null : {}, method === 'DELETE' ? { method } : undefined);
      const next = normalizeUpdate(answer?.update);
      if (next) patch(next);
    } catch (e) {
      ok = false;
      if (e?.name === 'AbortError' || ctx.signal.aborted) return false;
      problem = e?.message || 'o núcleo não respondeu';
      problemAt = 'now';
      // A check that did not even start has no dialog to show: the band says why.
      if (what === 'check') dialogOpen = false;
    } finally {
      pending = null;
    }
    if (ctx.signal.aborted) return false;
    repaint();
    reread();
    return ok;
  }

  function close() {
    dialogOpen = false;
    focusDialog = false;
    focusBand = true;
    problem = null;
    repaint();
  }

  function open(u) {
    dialogOpen = true;
    focusDialog = false;
    // A good check of the last 5 minutes is not repeated: the dialog goes straight to the question.
    if (u.state === 'ready' && Date.parse(u.readyUntil ?? '') > Date.now()) return repaint();
    return call('check', checkRoute(id));
  }

  async function confirm() {
    if (await call('update', updateRoute(id))) {
      dialogOpen = false;
      focusProgress = true;
      repaint();
    }
  }

  const dismiss = (u) => {
    closed.add(runKey(u));
    repaint();
  };

  // ---------- the pieces ----------

  function retry(u) {
    if (u.kind === 'update') dismiss(u);
    open({ ...u, state: 'idle' });
  }

  function bandNode(machine, u, core, mode) {
    const label = machine.label;
    const target = core?.expectedVersion ?? u.targetVersion ?? '?';
    const view = core ? outdatedBand(core, label) : null;
    const lead = 'O Console de lá roda um código mais antigo que o deste Mac';
    const now = u.phase === 'rollback' ? phaseName(u) : `${phaseName(u)} (${phaseLabel(u)})`;
    const look = mode === 'retry' ? resultLook(u) : null;
    const texts = {
      busy: u.automatic
        ? `Este Mac começou sozinho a atualização para a ${target}, porque o app foi atualizado. Agora: ${now}. A ${label} fica sem conexão por cerca de um minuto; isso é esperado e não gera alerta.`
        : `A atualização para a ${target} está em andamento. A ${label} fica sem conexão por cerca de um minuto; isso é esperado e não gera alerta.`,
      retry: u.message?.text ?? '',
      setup: `${lead}. ${u.message?.text ?? ''}`.trim(),
      ready: `${lead}, e as correções das versões novas não chegam até ele. Atualizar agora atualiza para a ${target}: faz o backup do banco, troca o código e sobe o núcleo de novo, e tenta voltar ao código de antes se ele não responder.`,
    };
    const actions = {
      busy: () => button({ label: 'Atualizando…', iconName: 'wall-loader', filled: true, action: 'busy', busy: true }),
      retry: () => button({ label: 'Tentar de novo', iconName: 'rotate-cw', filled: true, action: 'retry', onClick: () => retry(u) }),
      setup: () => null,
      ready: () => button({ label: 'Atualizar agora', iconName: 'arrow-up-circle', filled: true, action: 'open', busy: u.state === 'checking', onClick: () => open(u) }),
    };
    const icons = { busy: 'wall-loader', retry: 'alert', setup: 'arrow-up-circle', ready: 'arrow-up-circle' };
    const title = look ? `${look.title}.` : (view?.title ?? `O núcleo da ${label} precisa da versão ${target}.`);
    const node = band({ icon: icons[mode], title, text: texts[mode], from: view?.from ?? '' });
    node.setAttribute('data-mode', mode);
    if (mode === 'busy') node.querySelector('.tm-rc-ic')?.classList.add('tm-rc-spin');
    const action = actions[mode]();
    if (action) node.append(el('div', { class: 'tm-rc-actions' }, action));
    return node;
  }

  function copyButton(value, label, action, filled) {
    const node = el('button', { type: 'button', class: `btn ${filled ? 'filled' : 'outline'}`, 'data-up-action': action }, icon('copy'), label);
    node.addEventListener('click', () => runButtonAction(node, () => globalThis.navigator.clipboard.writeText(value), { doneLabel: 'Copiado' }));
    return node;
  }

  // The confirmation: first the --check, then the go / no-go (462-2). It sits under the band like the Parar one.
  function dialogNode(machine, u, core) {
    // A run the Mac started is never confirmed by the person (decision 0024 section 3). While the person's own click
    // is on its way the last read may still be the Mac's run: the answer replaces it.
    if (u.automatic && !pending) return null;
    const label = machine.label;
    const target = core?.expectedVersion ?? u.targetVersion ?? '?';
    let mode = null;
    if (pending === 'check' || (u.kind === 'check' && u.state === 'checking')) mode = 'checking';
    else if (pending === 'update' || u.state === 'ready') mode = 'ready';
    else if (u.kind === 'check' && resultLook(u)) mode = 'result';
    if (!mode) return null;
    const attrs = { class: 'card tm-up-dialog', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tm-up-dialog-title', 'data-part': 'update-dialog', 'data-mode': mode };
    let body;
    if (mode === 'checking') {
      body = [
        el('h2', { id: 'tm-up-dialog-title' }, icon('search'), `Atualizar o núcleo da ${label}`),
        el('p', {}, `Conferindo, sem mudar nada, se a ${label} continuaria conectada a este Mac depois de ir para a ${target}…`),
        stepsNode(stepRows({ phase: 'check' })),
        problemNote(problem),
        el('div', { class: 'tm-up-acts' }, button({ label: 'Cancelar', iconName: 'x', action: 'cancel', why: u.canCancel && pending !== 'check' ? null : 'A conferência ainda não começou', onClick: () => call('cancel', updateRoute(id), 'DELETE') })),
      ];
    } else if (mode === 'ready') {
      body = [
        el('h2', { id: 'tm-up-dialog-title' }, icon('arrow-up-circle'), `Atualizar o núcleo da ${label} para a ${target}?`),
        el('p', {}, u.message?.text ?? ''),
        el('ul', { class: 'tm-up-causes' }, el('li', {}, 'faz o backup do banco de lá, antes de parar qualquer coisa;'), el('li', {}, 'se o núcleo novo não responder, volta ao código de antes (e ao banco do backup, se ele chegou a subir).')),
        el('p', { class: 'tm-muted' }, 'Depois que a troca começa, não dá para cancelar. Nada acontece neste Mac.'),
        problemNote(problem),
        el('div', { class: 'tm-up-acts' }, button({ label: 'Voltar', iconName: 'back', action: 'back', onClick: close }), button({ label: 'Atualizar agora', iconName: 'arrow-up-circle', filled: true, action: 'confirm', busy: pending === 'update', onClick: confirm })),
      ];
    } else {
      const look = resultLook(u);
      attrs['data-tone'] = look.tone;
      body = [
        el('h2', { id: 'tm-up-dialog-title', class: `tm-up-${look.tone}` }, icon(look.icon), look.title),
        u.message ? el('p', {}, u.message.text) : null,
        problemNote(problem),
        el('div', { class: 'tm-up-acts' }, button({ label: 'Entendi', filled: !canRetry(u), action: 'dismiss', onClick: close }), pointsToCommand(u) ? commandButton() : null, canRetry(u) ? button({ label: 'Tentar de novo', iconName: 'rotate-cw', filled: true, action: 'retry', onClick: () => open({ ...u, state: 'idle' }) }) : null),
      ];
    }
    const node = el('section', attrs, ...body);
    node.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || pending) return;
      // Closing the dialog must not leave a --check running unseen: while it runs, Escape is the Cancelar.
      if (mode === 'checking') {
        if (u.canCancel) call('cancel', updateRoute(id), 'DELETE');
      } else close();
    });
    return node;
  }

  function commandButton() {
    return button({
      label: 'Mostrar o comando',
      iconName: 'terminal',
      action: 'show-command',
      onClick: () => {
        dialogOpen = false;
        fallbackOpen = true;
        repaint();
      },
    });
  }

  // The run going on (462-3). The Cancelar is on only while the --check runs: the swap cannot be stopped.
  function progressNode(machine, u, core) {
    const label = machine.label;
    const target = core?.expectedVersion ?? u.targetVersion ?? '?';
    const confirming = u.kind === 'update' && u.state === 'succeeded';
    const rows = confirming ? stepRows(u, { allDone: true }) : stepRows(u);
    const since = u.startedAt ?? '';
    const title = confirming ? 'Conferindo a versão' : u.kind === 'check' ? `Conferindo a ${label}` : `Atualizando a ${label} para a ${target}`;
    const head = el('h2', { class: 'tm-up-title' }, icon('wall-loader'), title, confirming ? null : el('span', { class: 'tm-up-code' }, `${phaseLabel(u)} · há `, el('span', { 'data-up-elapsed': '', 'data-since': since }, elapsed(since, Date.now()))));
    return el(
      'section',
      { class: 'card tm-up-result tm-up-progress', tabindex: '-1', 'data-part': 'update-progress', 'data-phase': u.phase ?? '', role: 'status' },
      head,
      stepsNode(rows),
      u.message && confirming ? el('p', {}, u.message.text) : null,
      confirming ? null : note(u.canCancel ? 'Só a conferência pode ser cancelada: ela não muda nada.' : 'Depois da conferência Cancelar fica desligado, e o script de lá termina sozinho, com sucesso ou voltando ao código de antes. A queda de conexão agora é esperada e não gera alerta.'),
      problemNote(problem),
      confirming ? null : el('div', { class: 'tm-up-acts' }, button({ label: 'Cancelar', iconName: 'x', action: 'cancel', busy: pending === 'cancel', why: u.canCancel ? null : 'Não dá para cancelar a troca', onClick: () => call('cancel', updateRoute(id), 'DELETE') })),
    );
  }

  // How a finished update ended (462-4, 462-5): the title is a label, the sentence is the core's. Tentar de novo lives
  // on the band (484-2); a rollback that failed keeps its card for the backup path, its sentence already on the band.
  function resultNode(u, onBand) {
    const look = resultLook(u);
    const acts = [button({ label: 'Fechar', filled: u.state === 'succeeded', action: 'close-result', onClick: () => dismiss(u) })];
    if (u.state === 'rollback-failed' && u.backupPath) acts.unshift(copyButton(u.backupPath, 'Copiar o caminho do backup', 'copy-backup', false));
    if (pointsToCommand(u)) acts.push(commandButton());
    return el(
      'section',
      { class: `card tm-up-result tm-up-${look.tone}`, role: look.tone === 'bad' ? 'alert' : 'status', 'data-part': 'update-result', 'data-state': u.state },
      el('h2', { class: 'tm-up-title' }, icon(look.icon), look.title, u.exitCode === null ? null : el('span', { class: 'tm-up-code' }, `saída ${u.exitCode}`)),
      u.message && !onBand ? el('p', {}, u.message.text) : null,
      u.state === 'succeeded' && u.confirmation === 'confirmed' ? stepsNode(stepRows(u, { allDone: true })) : null,
      u.state === 'rollback-failed' && u.backupPath ? el('div', { class: 'tm-up-path mono', 'data-field': 'backup-path' }, u.backupPath) : null,
      el('div', { class: 'tm-up-acts' }, ...acts),
    );
  }

  // 462-6 as decision 0024 left it: an invalid connection.update does not fall back to the derived command, which is
  // shown here only to compare with what the person wrote.
  function setupNode(u) {
    return el(
      'section',
      { class: 'card tm-card tm-rc-setup', 'data-part': 'update-setup', 'data-problem': u.problem },
      el('h2', { class: 'tm-title' }, icon('settings'), el('span', {}, 'O connection.update está inválido'), el('small', { class: 'tm-muted' }, 'decisão 0024')),
      u.message ? el('p', {}, u.message.text) : null,
      el('p', { class: 'tm-muted' }, 'Um ', el('code', {}, 'connection.update'), ' inválido não cai no comando derivado: o que você escreveu vence. Para comparar, este é o comando que o Console montaria a partir do seu ', el('code', {}, 'connection.credential'), '.'),
      el('pre', { class: 'tm-config', 'data-field': 'update-block' }, u.block),
      el('div', { class: 'tm-rc-actions' }, copyButton(u.block, 'Copiar o bloco', 'copy-block', false)),
    );
  }

  function fallbackNode(machine, core) {
    if (fallbackOpen) {
      const card = updateCard(core, machine.label, { step: false });
      card.append(el('div', { class: 'tm-rc-actions' }, button({ label: 'Recolher o comando', iconName: 'chevron-down', action: 'hide-command', onClick: () => ((fallbackOpen = false), repaint()) })));
      return card;
    }
    return el(
      'section',
      { class: 'card tm-card tm-rc-setup tm-up-fallback', 'data-part': 'update-fallback' },
      el('h2', { class: 'tm-title' }, icon('terminal'), el('span', {}, 'Prefere rodar à mão?'), el('small', { class: 'tm-muted' }, 'decisão 0021')),
      el('p', { class: 'tm-muted' }, `O comando para colar no terminal da ${machine.label} continua disponível.`),
      el('div', { class: 'tm-rc-actions' }, commandButton()),
    );
  }

  return {
    /** Whether a run goes on (or a write is on its way): the screen re-reads every 2 s instead of every 30 s. */
    active: (machine) => pending !== null || Boolean(machine?.update && isBusy(machine.update)),

    /** The elapsed time of the progress card, once a second, without repainting. */
    tick(root) {
      for (const n of root.querySelectorAll('[data-up-elapsed]')) n.textContent = elapsed(n.getAttribute('data-since'), Date.now());
    },

    /** What goes above the reading for this machine; `null` when the 449 flow draws it. */
    parts(machine, { ownerAuth = null, now = Date.now() } = {}) {
      const u = machine?.update;
      if (!u || ownerAuth || u.problem === 'credential-missing') return null;
      const core = machine.core;
      // A confirmed update is the end of the banner, even if this read of the núcleo still carries the old version.
      const outdated = coreOutdated(core) && !(u.kind === 'update' && u.state === 'succeeded' && u.confirmation === 'confirmed');
      if (problemAt && problemAt !== 'now' && problemAt !== `${u.state}|${u.endedAt}`) problem = null;
      if (problemAt === 'now') problemAt = `${u.state}|${u.endedAt}`;
      const busy = isBusy(u);
      // The confirmation is the person's: never for a run the Mac started, and gone once the swap runs.
      if ((u.automatic && !pending) || (u.kind === 'update' && u.state === 'running')) dialogOpen = false;
      const dialog = dialogOpen ? dialogNode(machine, u, core) : null;
      if (dialogOpen && !dialog) dialogOpen = false;
      // The band's mode (decision 0024 section 4). A manual --check changes nothing: its band stays `ready`, the button waits.
      const mode = SETUP_PROBLEMS.has(u.problem) ? 'setup' : busy && updatingNow(u) ? 'busy' : outdated && !busy && !dialog && u.kind && canRetry(u) ? 'retry' : 'ready';
      // Each failure shows the command card collapsed first.
      if (mode === 'busy') fallbackOpen = false;
      const keepResult = mode !== 'retry' || u.state === 'rollback-failed';
      const result = !dialog && !busy && keepResult && showsResult(u, now) && !closed.has(runKey(u)) ? resultNode(u, mode === 'retry') : null;
      if (!outdated && !busy && !dialog && !result) return [];
      const out = [];
      if (outdated || busy) out.push(bandNode(machine, u, core, mode));
      if (!dialog && problem) out.push(problemNote(problem));
      if (dialog) out.push(dialog);
      else if (busy) out.push(progressNode(machine, u, core));
      if (result) out.push(result);
      if (outdated && u.problem === 'invalid' && u.block) out.push(setupNode(u));
      // The command to paste is the way out after a failure or when no command can be built; a click on Mostrar o
      // comando (exit 22, a version that did not arrive) opens it too.
      if (outdated && !busy && !dialog && (mode === 'retry' || mode === 'setup' || (fallbackOpen && pointsToCommand(u)))) out.push(fallbackNode(machine, core));
      const modeNow = dialog?.getAttribute('data-mode') ?? null;
      if (modeNow !== dialogMode) {
        dialogMode = modeNow;
        focusDialog = false;
      }
      if (dialog && focusDialog === false) {
        focusDialog = true;
        setTimeout(() => area.querySelector('[data-part="update-dialog"] [data-up-action]')?.focus?.(), 0);
      }
      if (!dialog && focusProgress && busy) {
        focusProgress = false;
        setTimeout(() => area.querySelector('[data-part="update-progress"]')?.focus?.(), 0);
      }
      if (!dialog && focusBand) {
        focusBand = false;
        setTimeout(() => (area.querySelector('[data-up-action="open"]') ?? area.querySelector('[data-up-action="retry"]'))?.focus?.(), 0);
      }
      return out;
    },
  };
}
