// The remote núcleo's version and the update command on the machine screen (issue 449, decision 0021, wireframes
// 449-1 to 449-5): the Versão row (the Conexão card shows it; a machine without a connection gets it as its own
// card), the yellow band when the remote is outdated, and the card with the command to paste over there and a
// Copiar button. Nothing here runs a command on this Mac: the only action is writing the text to the clipboard.
// The text comes from machine-core-format.js, which keeps only validated shapes.

import { el, icon } from '../dom.js';
import { runButtonAction, DONE_MS } from '../button-action.js';
import { bootstrapCommand, coreOutdated, outdatedBand, updateCommand, updateKind, versionCells } from './machine-core-format.js';

const pill = ([tone, label]) => el('span', { class: `badge ${tone}` }, el('span', { class: 'p' }), label);

function cellNode(c) {
  return el(
    'div',
    { class: 'tm-core-tile', 'data-cell': c.key },
    el('span', { class: 'tm-core-k' }, c.label),
    c.pill ? el('b', { class: 'tm-core-v' }, pill(c.pill)) : el('b', { class: `tm-core-v${c.mono ? ' mono' : ''}` }, c.value),
    el('small', { class: 'tm-core-s' }, c.sub),
  );
}

/** The Versão row: the remote's version and commit, the app's, and the status. Inside the Conexão card or alone. */
export function versionNode(core, { card = false } = {}) {
  const row = el(
    'div',
    { class: card ? 'card tm-card tm-core-version' : 'tm-core-version', 'data-part': 'core-version' },
    el('span', { class: 'tm-core-k' }, 'Versão'),
    el('div', { class: 'tm-core-tiles' }, ...versionCells(core).map(cellNode)),
    el('p', { class: 'tm-muted tm-core-src' }, 'Versão e commit vêm do ', el('span', { class: 'mono' }, '/api/overview'), ' do núcleo de lá, que responde sem a prova do dono.'),
  );
  return row;
}

/** The yellow band of the 449 (also the base of the 462 one, which adds its own text and the button). */
export function band(b) {
  return el(
    'div',
    { class: 'tm-rc-band tm-rc-waiting', role: 'status', 'data-part': 'core-outdated' },
    el('span', { class: 'tm-rc-ic' }, icon(b.icon)),
    el('div', { class: 'tm-rc-text' }, el('p', {}, el('b', {}, b.title), ` ${b.text}`), el('p', { class: 'tm-rc-note tm-muted' }, b.from)),
  );
}

const NOTE_READY = 'Nada roda neste Mac.';
const NOTE_COPIED = 'Cole no terminal da Workstation.';

/** The Copiar button (449-5): primary when the command is the next step, secondary while a step comes before it. */
function copyRow(command, label, primary) {
  const button = el('button', { type: 'button', class: `btn ${primary ? 'filled' : 'outline'}`, 'data-action': 'core-update-copy' }, icon('copy'), 'Copiar o comando');
  const note = el('span', { class: 'tm-muted tm-core-note' }, NOTE_READY);
  button.addEventListener('click', async () => {
    const result = await runButtonAction(button, () => globalThis.navigator.clipboard.writeText(command), { doneLabel: 'Copiado' });
    if (!result.ok) return;
    note.textContent = NOTE_COPIED.replace('Workstation', label);
    setTimeout(() => (note.textContent = NOTE_READY), DONE_MS);
  });
  return el('div', { class: 'tm-core-copy' }, button, note);
}

/** The card with the command to paste on the remote (decision 0021); with the 462 button it is the fallback, collapsed until asked for. */
export function updateCard(core, label, { step }) {
  const kind = updateKind(core);
  const yes = core.mac.credentialCommand;
  const command = kind === 'update' ? updateCommand(core) : bootstrapCommand(core);
  const legend =
    kind === 'update'
      ? [
          ['hard-drive', 'Faz o backup do banco antes de parar o núcleo.'],
          ['shield-check', yes ? `Recusa, sem parar nada, se a ${label} ficasse sem conexão com este Mac.` : 'Com no, recusa com o código 21 e não para nada.'],
          ['history', 'Volta ao código de antes se o núcleo novo não responder.'],
        ]
      : [
          ['shield-check', '--check só confere: não para nada e não troca o código.'],
          ['hard-drive', 'Sem o --check, faz o backup do banco antes de parar o núcleo e volta ao código de antes se o novo não responder.'],
        ];
  const intro =
    kind === 'update'
      ? [`Cole no terminal da ${label} (por SSH, pelo VS Code ou como você entra lá) e, se o `, el('code', {}, '<checkout>'), ' ainda aparecer no comando, troque-o pelo caminho do repositório lá. Com ', el('code', {}, 'connection.checkout'), ' no machines.json deste Mac, o caminho já vem preenchido. O comando já leva a versão do app e o que este Mac sabe da conexão: a telemetria na versão ', String(core.mac.telemetryVersion), ' e ', yes ? 'o comando de credencial configurado.' : el('b', { class: 'tm-c-waiting' }, 'sem comando de credencial'), yes ? null : '.']
      : [`A versão do app (${core.expectedVersion}) é anterior à `, el('code', {}, '0.0.17'), `, a primeira que traz o script de atualização, então ainda não há um app-v${core.expectedVersion} com ele. Cole o comando abaixo no terminal da ${label}: ele pega o script da main e só confere (`, el('code', {}, '--check'), '), sem mudar nada. Se a conferência passar, rode o mesmo comando sem o ', el('code', {}, '--check'), '. Se a trava recusar e você aceitar que a máquina pode ficar sem conexão, acrescente ', el('code', {}, '--allow-disconnect'), '. Troque o ', el('code', {}, '<checkout>'), ' pelo caminho do repositório lá, se ele ainda aparecer.'];
  return el(
    'section',
    { class: 'card tm-card tm-rc-setup', 'data-part': 'core-update', 'data-kind': kind },
    el('h2', { class: 'tm-title' }, icon('terminal'), el('span', {}, `${step ? '2 · ' : ''}Atualizar o núcleo da ${label}${kind === 'bootstrap' ? ': a primeira vez' : ''}`), el('small', { class: 'tm-muted' }, 'decisão 0021')),
    el('p', { class: 'tm-muted' }, ...intro.filter((x) => x !== null)),
    el('pre', { class: 'tm-config' }, command),
    el('div', { class: 'tm-legend' }, ...legend.map(([name, text]) => el('span', {}, icon(name), ` ${text}`))),
    copyRow(command, label, yes || !step),
    el('p', { class: 'tm-muted tm-core-foot' }, kind === 'update' && yes ? 'Para só conferir, sem mudar nada, acrescente ' : null, kind === 'update' && yes ? el('span', { class: 'mono' }, '--check') : null, kind === 'update' && yes ? ' ao final. ' : null, `Esta tela relê a ${label} a cada 30 s: quando o núcleo de lá chegar à ${core.expectedVersion}, o aviso sai sozinho.`),
  );
}

/**
 * What goes above the reading when the remote is outdated (449-2 to 449-4); nothing otherwise. The machine's own
 * owner-proof parts (388) come before these and are not repeated: in `owner-auth-required` only the update card is
 * added, as step 2; in `owner-auth-mismatch` nothing (it may be another machine). `credentialSetup(step)` is the
 * 388-1 card with the credential command example, for the Mac without `connection.credential`.
 */
export function updateParts(machine, { ownerAuth = null, credentialSetup }) {
  const core = machine?.core;
  if (!coreOutdated(core) || ownerAuth === 'owner-auth-mismatch') return [];
  const label = machine.label;
  const noCredential = !core.mac.credentialCommand;
  if (ownerAuth) return [updateCard(core, label, { step: noCredential })];
  if (noCredential) return [band(outdatedBand(core, label)), credentialSetup(1), updateCard(core, label, { step: true })];
  return [band(outdatedBand(core, label)), updateCard(core, label, { step: false })];
}
