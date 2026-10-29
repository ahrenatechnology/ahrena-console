// Liberar uma porta (issue 286, decision 0016; wireframes C81 to C84): the confirmation flow of the
// action in the "Portas em escuta" card. A modal, its own, over the machine screen:
//
//   preview (what the núcleo would act on) → [tunnel warning] → confirm → SIGTERM → waiting
//   → released, or still listening → second confirmation → SIGKILL.
//
// The screen sends the pid and the port, never a command. Every step the núcleo can refuse (the pid
// no longer owns the port, the núcleo or the app, another user, a container's proxy) shows its reason
// and sends nothing.

import { el, icon } from '../dom.js';
import { LOCAL_ID, RELEASE_REFUSAL, releasePreviewRoute, releaseProblem, releaseRoute } from './machine-format.js';

const button = (label, { kind = 'outline', iconName = null, onClick, action }) =>
  el('button', { type: 'button', class: `btn ${kind === 'danger' ? 'filled tm-rp-danger' : kind}`, 'data-rp-action': action, onClick }, iconName ? icon(iconName) : null, label);

const kv = (rows) => el('dl', { class: 'tm-rp-kv' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));

/** The process the person saw: "node · pid 7741". */
const who = (process, pid) => el('span', {}, el('b', {}, process ?? 'processo sem nome'), ' · pid ', el('span', { class: 'mono' }, String(pid)));

/**
 * Opens the flow for one row. `onDone({ port, pid, process, signal })` runs when the port closed;
 * `onRefresh()` when the screen should read again (the owner changed). Returns `close`.
 */
export function openRelease(ctx, { machineId, machineLabel, row, warn = false, tunnelMachineId = null, onDone = () => {}, onRefresh = () => {} }) {
  const port = row.ports[0];
  const pid = row.pid;
  const remote = machineId !== LOCAL_ID;
  const where = remote ? `na ${machineLabel}` : null;
  const veil = el('div', { class: 'tm-rp-veil', 'data-part': 'release-dialog' });
  let closed = false;
  let preview = null;

  const onKey = (e) => e.key === 'Escape' && close();
  function close() {
    if (closed) return;
    closed = true;
    veil.remove();
    globalThis.document?.removeEventListener?.('keydown', onKey);
  }
  globalThis.document?.addEventListener?.('keydown', onKey);
  ctx.signal?.addEventListener?.('abort', close);

  function show({ title, iconName = 'power', lead = null, rows = null, extra = null, note = null, actions }) {
    const card = el(
      'div',
      { class: 'card tm-rp-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rp-title' },
      el('h2', { id: 'rp-title' }, icon(iconName), el('span', {}, title)),
      lead ? el('p', { class: 'tm-rp-lead' }, lead) : null,
      rows ? kv(rows) : null,
      extra,
      note ? el('p', { class: 'tm-rp-note' }, icon('shield-check'), el('span', {}, note)) : null,
      el('div', { class: 'tm-rp-actions' }, ...actions),
    );
    veil.replaceChildren(card);
    card.querySelector('button')?.focus?.();
  }

  const closeButton = (label = 'Fechar') => button(label, { action: 'close', onClick: close });

  function refused(reason, now = null, message = null) {
    const text = message ?? RELEASE_REFUSAL[reason] ?? 'Não deu para liberar.';
    const moved = reason === 'owner-changed';
    show({
      title: moved ? `A ${port} mudou de dono` : `Não foi possível liberar a ${port}`,
      iconName: moved ? 'info' : 'alert',
      lead: text,
      rows: moved && now ? [['Quando você abriu', who(row.process, pid)], ['Agora', who(now.process, now.pid)]] : null,
      actions: moved || reason === 'already-free' ? [closeButton(), button('Atualizar a lista', { kind: 'filled', iconName: 'refresh', action: 'refresh', onClick: () => (close(), onRefresh()) })] : [closeButton()],
    });
  }

  function failed(err) {
    if (err?.name === 'AbortError' || closed) return;
    const reason = err?.body?.reason;
    refused(typeof reason === 'string' ? reason : 'unknown', err?.body?.now ?? null, typeof reason === 'string' && RELEASE_REFUSAL[reason] ? null : releaseProblem(err));
  }

  async function send(signal) {
    show({ title: `Esperando ${row.process ?? 'o processo'} sair`, iconName: 'power', lead: `${signal === 'TERM' ? 'SIGTERM' : 'SIGKILL'} enviado. Esperando a porta ${port} fechar…`, rows: [['Processo', who(row.process, pid)]], note: 'Fechar só esconde esta janela: o sinal já foi enviado e a linha some quando a porta fechar.', actions: [closeButton()] });
    try {
      const answer = await ctx.write(releaseRoute(machineId), { port, pid, signal });
      if (closed) {
        if (answer?.result === 'released') onDone({ port, pid, process: row.process, signal });
        return;
      }
      if (answer?.result === 'released') {
        close();
        onDone({ port, pid, process: row.process, signal });
      } else if (signal === 'TERM') stuck();
      else refused('unavailable', null, `Mesmo com SIGKILL o processo ainda segura a ${port}. Ele pode estar preso no sistema.`);
    } catch (err) {
      failed(err);
    }
  }

  function stuck() {
    show({
      title: `${row.process ?? 'O processo'} não saiu`,
      iconName: 'alert',
      lead: `Passaram alguns segundos e ele ainda segura a ${port}.`,
      rows: [['Processo', who(row.process, pid)]],
      note: 'SIGKILL encerra na hora, sem deixar o processo salvar nada nem fechar arquivos. É a segunda confirmação: o núcleo confere o pid e a porta mais uma vez antes de enviar.',
      actions: [closeButton('Deixar como está'), button('Forçar com SIGKILL', { kind: 'danger', iconName: 'power', action: 'kill', onClick: () => send('KILL') })],
    });
  }

  function confirm() {
    const ports = preview.ports.length > 1 ? preview.ports.join(', ') : String(port);
    show({
      title: `Liberar a porta ${port}${where ? ` ${where}` : ''}`,
      lead: remote ? 'O Mac manda só o pid e a porta. Quem confere o dono e envia o SIGTERM é o núcleo de lá.' : 'Isto pede ao processo que encerre: o que depende dele perde a conexão.',
      rows: [
        ...(remote ? [['Onde', el('span', {}, el('b', {}, `Na ${machineLabel}`), ' · pelo núcleo de lá · como o seu usuário de lá')]] : []),
        ['Processo', who(preview.process ?? row.process, pid)],
        ['Portas dele', el('span', { class: 'mono' }, ports)],
        ['Escuta em', preview.interface === 'all' ? 'todas as interfaces' : preview.interface === 'loopback' ? 'só loopback' : 'um endereço'],
        ['De quem', row.owner ?? 'o seu usuário'],
      ],
      extra: preview.command ? el('div', { class: 'tm-rp-cmd' }, el('span', { class: 'eyebrow' }, 'Comando do processo, resumido'), el('code', {}, preview.command)) : null,
      note: `O console envia SIGTERM ao pid ${pid}. Nada digitado aqui vira comando: a tela manda o pid e a porta, e o núcleo confere de novo que o pid ainda é o dono. Se não sair, ele pergunta antes de forçar.`,
      actions: [closeButton('Cancelar'), button(remote ? 'Liberar lá' : `Liberar a ${port}`, { kind: 'filled', iconName: 'power', action: 'release', onClick: () => send('TERM') })],
    });
  }

  function tunnelWarning() {
    show({
      title: 'Liberar derruba o túnel',
      iconName: 'alert',
      lead: 'Este ssh é o túnel de uma máquina remota. Sem ele, o console perde a leitura de lá e as portas encaminhadas caem.',
      rows: [['Processo', who(row.process, pid)], ['Portas do Mac', el('span', { class: 'mono' }, preview.ports.join(', '))]],
      note: 'Subir o túnel de novo continua com a ferramenta que você já usa (decisão 0008). A conexão da máquina está na tela dela, em Nuvens e SSM.',
      actions: [
        tunnelMachineId ? button('Ver a conexão', { action: 'see-connection', onClick: () => (close(), ctx.navigate(`/ui/machines/${tunnelMachineId}`)) }) : closeButton('Cancelar'),
        button('Liberar mesmo assim', { kind: 'danger', iconName: 'power', action: 'continue', onClick: confirm }),
      ],
    });
  }

  show({ title: `Liberar a porta ${port}`, lead: 'Lendo o processo…', actions: [closeButton('Cancelar')] });
  globalThis.document?.body?.append(veil);
  ctx
    .read(releasePreviewRoute(machineId, port, pid))
    .then((p) => {
      if (closed) return;
      preview = p;
      if (warn) tunnelWarning();
      else confirm();
    })
    .catch((err) => {
      if (err?.name === 'AbortError' || closed) return;
      const reason = err?.body?.reason;
      refused(typeof reason === 'string' ? reason : 'unknown', err?.body?.now ?? null, typeof reason === 'string' && RELEASE_REFUSAL[reason] ? null : releaseProblem(err));
    });
  return close;
}
