// What the screen says when it hands a saturation alert to a Claude session (issue 568, wireframe 566-17 and 566-18),
// with no DOM: the targets, the labels of the dialog's buttons, the note of each state, the "aberto" line and the
// size hint. The words of the drawing are kept; where the drawing and the contract of POST /api/delegations differ
// (the terminal and the SSH session do not pre-fill the prompt: it goes to the clipboard), the contract wins.
// A response never becomes text: a refusal's `reason` picks a sentence written here, the core's own `error` is not shown.

export const DELEGATE_LABEL = 'Delegar ao Claude';

/** The targets of the machine that is not "Esta máquina" are one: the SSH session there (the core fixes the host). */
export const VIA = { desktop: 'desktop', terminal: 'terminal', ssh: 'ssh' };

/** The `via` the dialog starts on: Claude Desktop on "Esta máquina", the SSH session on a remote machine. */
export const defaultVia = ({ remote = false } = {}) => (remote ? VIA.ssh : VIA.desktop);

/** Primary (cheio) when the probable cause is not obvious, secondary (contorno) when it is (Q15, Q16). */
export const delegateEmphasis = (cause) => (cause && cause.obvious === false ? 'primary' : 'secondary');

export const OFFER_TITLE = { primary: 'Aqui o caminho é delegar ao Claude', secondary: 'Prefere que o Claude analise?' };

const OFFER_TEXT = 'Abre uma sessão do Claude com este alerta e o diagnóstico no prompt. Você lê e envia; matar processo ou apagar dado só com o seu ok lá.';

/** The line under the offer's title: the Workstation one says where the session runs (566-5). */
export function offerText({ remote = false, host = null } = {}) {
  if (!remote) return OFFER_TEXT;
  return `A sessão roda na própria Workstation${host ? ` (SSH ${host})` : ''}, onde o processo está. Você lê o prompt e envia.`;
}

/** `{ via, title, text, host, tag }`; `host` is a mono span in the text and comes from the view, never from a constant. */
export function targetsFor({ remote = false, host = null } = {}) {
  if (remote) {
    return [{ via: VIA.ssh, title: 'Sessão do Claude na Workstation', text: 'O Mac abre um terminal e entra por SSH em', host, tail: 'onde roda o claude. O prompt fica na área de transferência, para você colar.', tag: 'recomendado' }];
  }
  return [
    { via: VIA.desktop, title: 'Claude Desktop', text: 'Abre uma sessão nova, com o prompt preenchido, na sua pasta pessoal.', tag: 'recomendado' },
    { via: VIA.terminal, title: 'Terminal', text: 'Abre um terminal com o claude na sua pasta pessoal. O prompt fica na área de transferência, para você colar.' },
  ];
}

const OPEN_LABEL = { desktop: 'Abrir no Claude Desktop', terminal: 'Abrir no Terminal', ssh: 'Abrir a sessão na Workstation' };
export const RETRY_LABEL = 'Tentar de novo';
export const OPENING_LABEL = 'Abrindo…';

/** The primary button of the dialog: the target's label, "Abrindo…" while the POST is out, "Tentar de novo" after a 502. */
export function openLabel(state, via) {
  if (state === 'opening') return OPENING_LABEL;
  if (state === 'failed') return RETRY_LABEL;
  return OPEN_LABEL[via] ?? OPEN_LABEL.desktop;
}

/** The dialog states: `loading` (reading the preview), `ready`, `opening`, and the five the answers draw (566-18). */
export const DIALOG_STATES = ['loading', 'ready', 'opening', 'closed', 'changed', 'too-large', 'unsupported', 'failed'];

/** The note's own state: the busy states keep the "não é enviado" note. */
export const noteState = (state) => (['closed', 'changed', 'too-large', 'unsupported', 'failed'].includes(state) ? state : 'ready');

/** The refusals the person has to act on are announced (`role="alert"`); a closed alert and a new prompt are calm. */
export const noteIsAlert = (state) => ['too-large', 'unsupported', 'failed'].includes(state);

const COPY_OUT = 'Copie o prompt e cole numa sessão sua';

/** The sentence of a 502 from its stable `reason`: only the SSH one names the host (from the view), the rest stay generic. */
export function failedText({ reason = null, host = null } = {}) {
  const why = reason === 'ssh-unreachable' ? `Não deu para abrir a sessão: o SSH para ${host || 'a Workstation'} não respondeu.` : 'Não deu para abrir a sessão.';
  return { before: why, host: reason === 'ssh-unreachable' && host ? host : null, text: `Nada foi aberto. ${COPY_OUT}, ou tente de novo.` };
}

/** What the note says in each state; `null` text parts are skipped. The ready note depends on how the target hands the prompt over. */
export function noteText(state, { via = VIA.desktop } = {}) {
  switch (state) {
    case 'closed':
      return 'Este alerta já fechou. Nada foi aberto; Copiar o prompt continua valendo.';
    case 'changed':
      return 'O diagnóstico mudou. O prompt abaixo é o novo e nada foi aberto com o antigo: leia e abra de novo.';
    case 'too-large':
      return `O prompt é longo demais para abrir no Claude Desktop. Nada foi aberto. ${COPY_OUT}.`;
    case 'unsupported':
      return `Não deu para abrir. Nada foi aberto. ${COPY_OUT}.`;
    default:
      return via === VIA.desktop ? 'O prompt abre preenchido e não é enviado: você lê e envia. Nada roda antes disso.' : 'O prompt vai para a área de transferência e não é enviado: você cola, lê e envia. Nada roda antes disso.';
  }
}

/** The size line under the prompt: the preview's `size` is the address length, shown as characters like the drawing. */
export function sizeLine({ size, noDiagnosis = false, via = VIA.desktop } = {}) {
  if (noDiagnosis) return 'sem diagnóstico · o prompt diz isso';
  if (!Number.isFinite(size) || size < 0) return null;
  const n = size >= 1000 ? `${(Math.round(size / 100) / 10).toLocaleString('pt-BR')} mil caracteres` : `${size} caracteres`;
  return via === VIA.desktop ? `${n} · cabe na URL do Desktop` : n;
}

export const SIZE_NOTE = 'o alerta e o diagnóstico vão só dentro do bloco de dados, e o prompt diz que o bloco são dados, não instruções.';

const OPENED = {
  desktop: 'Aberto no Claude Desktop: o prompt está na caixa de mensagem, falta você enviar.',
  terminal: 'Aberto no Terminal: o prompt está na área de transferência, cole e envie.',
  ssh: 'Sessão aberta na Workstation: o prompt está na área de transferência, cole e envie.',
};

/** The "aberto" line beside the alert's button. */
export const openedText = (via) => OPENED[via] ?? OPENED.desktop;

const DATA_OPEN = '<console-data>';
const DATA_CLOSE = '</console-data>';

/**
 * The prompt cut in the text and the data block, so the block can be drawn apart; the pieces joined are the prompt, byte for byte.
 * The fixed text names the tags too, so the block is the last opening tag before the last closing one.
 */
export function promptParts(prompt) {
  const text = String(prompt ?? '');
  const end = text.lastIndexOf(DATA_CLOSE);
  const start = end < 0 ? -1 : text.lastIndexOf(DATA_OPEN, end);
  if (start < 0) return [{ kind: 'text', text }];
  const head = text.slice(0, start);
  const tail = text.slice(end + DATA_CLOSE.length);
  return [head ? { kind: 'text', text: head } : null, { kind: 'tag', text: DATA_OPEN }, { kind: 'data', text: text.slice(start + DATA_OPEN.length, end) }, { kind: 'tag', text: DATA_CLOSE }, tail ? { kind: 'text', text: tail } : null].filter(Boolean);
}
