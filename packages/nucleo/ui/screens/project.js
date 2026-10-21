// Kanban do projeto (C11): o GitHub Project por Status, ao vivo; arrastar um card muda o Status no GitHub.
//
// - Lê `GET /api/project` (o botão Atualizar manda `?refresh=1`) e relê a cada novidade do "Ao vivo":
//   o núcleo guarda o quadro em cache, reler é barato.
// - Arrastar (ou Alt+← / Alt+→ no card focado) é otimista: o card muda de raia na hora e vai
//   `POST /api/project/move`. Se o GitHub recusar, o card volta e a faixa diz por quê. Deu certo, o
//   toast oferece Desfazer, que é outro POST com a raia de antes.
// - A raia "Sem status" (id null) não recebe card: o GitHub não tem como voltar um item para lá.
// - Enquanto um movimento ou um arrasto está em curso, a releitura espera: um quadro lido antes do
//   movimento não pode desfazê-lo na tela.

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import { connectEmptyFor, connectionChanged, isGithubNotConnected } from '../github-connect.js';
import { createSwitch, envBand, loadPickerStyle, mountPicker } from './project-picker.js';

const ROUTE = '/api/project';
const STYLE = '/ui/project.css';
const MOVE_ROUTE = '/api/project/move';
const TOAST_MS = 8000;
const LIVE_WAIT = 1000;
const SCOPE_COMMAND = 'gh auth refresh -s project';

// O tipo da issue no GitHub vira o rótulo do wireframe; a cor vem da classe.
const TYPES = new Map([
  ['story', ['História', 'story']],
  ['user story', ['História', 'story']],
  ['tech task', ['Tarefa técnica', 'task']],
  ['task', ['Tarefa técnica', 'task']],
  ['spike', ['Spike', 'spike']],
  ['bug', ['Bug', 'bug']],
]);

/** `{ label, className }` do tipo de um card. Tipo desconhecido sai com o nome cru. */
export function cardType(card) {
  const raw = typeof card?.issueType === 'string' ? card.issueType.trim() : '';
  if (raw) {
    const [label, className] = TYPES.get(raw.toLowerCase()) ?? [raw, 'other'];
    return { label, className };
  }
  if (card?.type === 'PullRequest') return { label: 'Pull request', className: 'other' };
  if (card?.type === 'DraftIssue') return { label: 'Rascunho', className: 'other' };
  return { label: 'Issue', className: 'other' };
}

// The PR's CI and review are the API's values (English since issue 173, phase 2b) → the pill's text and class.
const CI = new Map([
  ['ok', ['CI ✓', 'ok']],
  ['failed', ['CI ✕', 'failed']],
  ['running', ['CI …', 'running']],
]);
const REVIEW = new Map([
  ['approved', ['aprovado', 'ok']],
  ['changes-requested', ['ajustes', 'failed']],
  ['pending', ['review', 'running']],
]);

/** Os cards de uma raia que passam no filtro de marco (`''` = todos). */
export function filter(cards, milestone) {
  return milestone ? cards.filter((c) => c.milestone === milestone) : cards;
}

const hour = (ms) => {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
};

const codeOf = (e) => e?.body?.code ?? null;
const commandOf = (e) => e?.body?.command ?? (codeOf(e) === 'no-scope' ? SCOPE_COMMAND : null);
const cardName = (card) => (card.number != null ? `#${card.number}` : `“${card.title}”`);
const waitOf = (e) => (e?.retryIn ? ` Tente de novo em ${Math.ceil(e.retryIn / 1000)} s.` : '');
const withCommand = (node, command) => (command ? (node.querySelector('p')?.append(' ', el('code', { class: 'prj-command mono' }, command)), node) : node);

const setHidden = (node, hidden) => (hidden ? node.setAttribute('hidden', '') : node.removeAttribute('hidden'));

/** O CSS da tela, uma vez por página (fica carregado quando se troca de tela). */
function loadStyle() {
  const doc = globalThis.document;
  if (!doc?.head || typeof doc.querySelector !== 'function' || doc.querySelector(`link[href="${STYLE}"]`)) return;
  doc.head.append(el('link', { rel: 'stylesheet', href: STYLE }));
}

export async function mount(area, ctx) {
  loadStyle();
  loadPickerStyle();
  let board = null; // o último quadro (do núcleo ou com o movimento otimista aplicado)
  let milestone = '';
  let readFailure = null; // leitura que falhou com um quadro já na tela
  let notice = null; // movimento recusado: { title, text, command }
  let toast = null; // { card, name, from }
  let dragging = null; // { card, from }
  let pendingRedraw = false; // redesenho que esperou o arrasto terminar
  let inFlight = 0; // movimentos sem resposta
  let pendingReads = 0; // leituras sem resposta
  let latestRead = 0; // a leitura mais nova; as outras são descartadas
  let deferred = null; // releitura que esperou um movimento ou arrasto: { force }
  let toastTimer = null;
  let liveTimer = null;
  let focus = null; // itemId que recebe o foco no próximo desenho (movimento pelo teclado)
  let bandsKey = '';
  let mode = 'loading'; // 'board', 'picker' (C43), 'connect' (C42), 'saving' or 'other'

  // ---------- a estrutura (fica de pé entre os redesenhos) ----------

  const selector = el('select', { class: 'prj-sel', 'aria-label': 'Filtrar por marco' });
  selector.addEventListener('change', () => {
    milestone = selector.value;
    drawBoard();
  });
  const refreshButton = el('button', { type: 'button', class: 'btn', onClick: () => draw({ force: true }) }, icon('refresh'), 'Atualizar');
  // issue 241 (C43 1440): "Trocar de Project" in the header; hidden while AHRENA_CONSOLE_PROJECT decides.
  const projectSwitch = createSwitch(ctx, {
    current: () => board?.selection ?? board?.project ?? null,
    onSaved: () => {
      board = null;
      draw();
    },
    onNotConnected: () => showConnect(),
  });
  // O cabeçalho fica: a pílula "Ao vivo" é dele, e a moldura a mantém em dia.
  const head = header({
    icon: 'github',
    title: 'Kanban do projeto',
    sub: 'GitHub Project · por Status · arraste para mudar',
    actions: [projectSwitch.node, el('label', { class: 'prj-milestone' }, el('span', {}, 'Marco:'), selector, icon('chevron-down')), refreshButton],
  });
  const sub = head.querySelector('.sub');
  const actionsBox = head.querySelector('.actions');
  // O toast mora numa região viva fixa, logo depois do cabeçalho: o leitor de tela anuncia o que entra
  // nela, e o Tab chega ao Desfazer sem atravessar o quadro. Foco ou mouse em cima seguram o tempo.
  const toastBox = el('div', { class: 'prj-toast-box', role: 'status', 'aria-live': 'polite' });
  toastBox.addEventListener('focusin', () => clearTimeout(toastTimer));
  toastBox.addEventListener('mouseenter', () => clearTimeout(toastTimer));
  toastBox.addEventListener('focusout', () => armToast());
  toastBox.addEventListener('mouseleave', () => armToast());
  const bandsBox = el('div', { class: 'prj-bands', hidden: true });
  const boardBox = el('div', { class: 'prj-board' });
  let screenShape = false;

  function drawHeader() {
    const p = board.project ?? {};
    const where = p.owner && p.number ? ` · ${p.owner} #${p.number}` : '';
    if (sub) sub.textContent = `GitHub Project “${p.title ?? ''}”${where} · por ${p.field || 'Status'} · arraste para mudar`;
    if (actionsBox) setHidden(actionsBox, false);
    setHidden(projectSwitch.node, Boolean(board.envOverride));
    const milestones = Array.isArray(board.milestones) ? board.milestones : [];
    if (milestone && !milestones.includes(milestone)) milestone = '';
    selector.replaceChildren(el('option', { value: '' }, 'Todos os marcos'), ...milestones.map((m) => el('option', { value: m }, m)));
    selector.value = milestone;
  }

  function switchArea(...nodes) {
    screenShape = false;
    area.replaceChildren(head, ...nodes);
  }

  /** A screen without a board (the picker, "Conectar ao GitHub", an error): the board's actions go away. */
  function boardless(subText, ...nodes) {
    mode = 'other';
    projectSwitch.close();
    if (actionsBox) setHidden(actionsBox, true);
    if (sub && subText) sub.textContent = subText;
    switchArea(...nodes);
  }

  /** C42: the console is not connected to GitHub (409 `github-not-connected`). */
  function showConnect() {
    board = null;
    boardless('Um GitHub Project por Status', connectEmptyFor('project', ctx.navigate));
    mode = 'connect';
  }

  /** C43 1100: no Project chosen yet (503 `no-project`): the list to choose from. */
  function showPicker() {
    board = null;
    if (mode === 'picker') return; // already choosing: a re-read must not wipe the choice in progress
    const box = el('div', { class: 'pp-picker' });
    boardless('Escolha o GitHub Project que este quadro mostra', box);
    mode = 'picker';
    mountPicker(box, ctx, {
      onSaved: () => {
        mode = 'saving';
        draw();
      },
      onNotConnected: () => showConnect(),
    });
  }

  // ---------- leitura ----------

  async function draw({ force = false } = {}) {
    // Com um movimento sem resposta ou um card no ar, ler agora traria o quadro de antes: fica para depois.
    if (inFlight || dragging) {
      deferred = { force: force || Boolean(deferred?.force) };
      return;
    }
    const mine = ++latestRead;
    pendingReads++;
    if (!board && mode !== 'picker' && mode !== 'connect') switchArea(loading({ label: 'Lendo o GitHub Project' }));
    if (force) refreshButton.setAttribute('aria-busy', 'true');
    try {
      const fresh = await ctx.read(force ? `${ROUTE}?refresh=1` : ROUTE);
      if (mine !== latestRead) return;
      board = fresh;
      readFailure = null;
      mode = 'board';
      drawBoard();
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== latestRead) return;
      // Disconnected while the board was open: what is on screen came with the old credential.
      if (isGithubNotConnected(e)) return showConnect();
      if (board) {
        readFailure = e;
        drawBoard();
      } else drawFailure(e);
    } finally {
      if (--pendingReads === 0) refreshButton.removeAttribute('aria-busy');
    }
  }

  /** O arrasto acabou (soltou fora de uma raia, ou na mesma): o redesenho e a leitura que esperaram. */
  function dragEnd() {
    if (!dragging && !pendingRedraw) return deferredRead();
    dragging = null;
    if (pendingRedraw) drawBoard();
    deferredRead();
  }

  // Rede de segurança: o fim do arrasto também é ouvido no documento.
  const doc = globalThis.document;
  doc?.addEventListener?.('dragend', dragEnd);
  doc?.addEventListener?.('drop', dragEnd);

  /** Lê de novo o que ficou adiado, quando nada mais segura a leitura. */
  function deferredRead() {
    if (!deferred || inFlight || dragging) return;
    const { force } = deferred;
    deferred = null;
    draw({ force });
  }

  function drawFailure(e) {
    const code = codeOf(e);
    if (isGithubNotConnected(e)) return showConnect();
    if (code === 'no-project') return showPicker();
    if (e?.status === 503 || code === 'off') {
      boardless(
        null,
        empty({
          icon: 'github',
          title: 'O núcleo subiu sem GitHub',
          text: 'Ele foi iniciado com --no-github, então não há quadro para mostrar. Reinicie o núcleo sem essa opção para ver o Kanban do projeto.',
        }),
      );
      return;
    }
    if (e?.status === 401 || code === 'no-scope') {
      const box = error({ title: 'Falta o escopo project no gh', text: `${e.message} Rode o comando abaixo e tente de novo.`, retry: () => draw({ force: true }) });
      box.insertBefore(el('code', { class: 'prj-command mono' }, commandOf(e)), box.lastChild);
      switchArea(box);
      return;
    }
    const title = e?.status === 0 || e?.status === undefined ? undefined : 'GitHub indisponível';
    switchArea(error({ title, text: `${e?.message ?? String(e)}${waitOf(e)}`, retry: () => draw({ force: true }) }));
  }

  // ---------- o quadro ----------

  /** As faixas de cima. Só são refeitas quando o que dizem muda: um alerta é anunciado uma vez. */
  function drawBands() {
    const bands = [];
    if (notice) bands.push({ title: notice.title, text: notice.text, command: notice.command, action: { label: 'Fechar', onClick: () => ((notice = null), drawBoard()) } });
    if (readFailure) {
      bands.push({
        title: 'Não deu para reler o quadro.',
        text: `${readFailure.message} Mostrando a última leitura.${waitOf(readFailure)}`,
        command: codeOf(readFailure) === 'no-scope' ? commandOf(readFailure) : null,
        action: { label: 'Tentar agora', onClick: () => draw({ force: true }) },
      });
    } else if (board.stale) {
      const when = hour(board.fetchedAt);
      bands.push({
        title: 'GitHub indisponível.',
        text: `Mostrando o quadro em cache${when ? `, de ${when}` : ''}.${board.reason ? ` ${board.reason}` : ''}`,
        action: { label: 'Tentar agora', onClick: () => draw({ force: true }) },
      });
    }
    const env = board.envOverride ?? null;
    const key = JSON.stringify([env, bands.map(({ title, text, command }) => [title, text, command])]);
    if (key === bandsKey) return;
    bandsKey = key;
    if (bands.length || env) bandsBox.removeAttribute('hidden');
    else bandsBox.setAttribute('hidden', '');
    // issue 241 (C44): AHRENA_CONSOLE_PROJECT decides the Project; the choice on screen waits for it to go.
    bandsBox.replaceChildren(...(env ? [envBand(env)] : []), ...bands.map((f) => withCommand(errorBand(f), f.command)));
  }

  function drawBoard() {
    if (!board) return;
    // Trocar os cards no meio de um arrasto tira do DOM o card que está no ar, e o `dragend` dele
    // pode não chegar (Firefox): o redesenho espera o arrasto acabar.
    if (dragging) {
      pendingRedraw = true;
      return;
    }
    pendingRedraw = false;
    // Quem estava num card continua nele depois do redesenho (ou no card que acabou de mover).
    const active = globalThis.document?.activeElement;
    const activeItem = focus ?? active?.getAttribute?.('data-item') ?? null;
    drawHeader();
    if (!screenShape) {
      bandsKey = null;
      area.replaceChildren(head, toastBox, bandsBox, boardBox);
      screenShape = true;
    }
    drawBands();

    const lanes = Array.isArray(board.lanes) ? board.lanes : [];
    const nodes = new Map();
    boardBox.replaceChildren(
      lanes.length
        ? el('div', { class: 'prj-columns' }, ...lanes.map((lane, i) => column(lane, i, lanes, nodes)))
        : empty({ icon: 'github', title: 'O projeto não tem raias', text: `O campo ${board.project?.field ?? 'Status'} do GitHub Project não tem opções.` }),
    );
    if (activeItem && nodes.has(activeItem)) nodes.get(activeItem).focus();
  }

  function column(lane, index, lanes, nodes) {
    const cards = filter(Array.isArray(lane.cards) ? lane.cards : [], milestone);
    const accepts = lane.id !== null && lane.id !== undefined;
    const col = el(
      'section',
      { class: 'prj-col', 'data-lane': accepts ? lane.id : 'no-status', 'aria-label': `${lane.name}: ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}` },
      el('div', { class: 'head' }, el('span', { class: 'dot' }), el('span', { class: 'name' }, lane.name), el('span', { class: 'n' }, String(cards.length))),
      ...cards.map((card) => {
        const node = cardEl(card, lane, index, lanes);
        nodes.set(card.itemId, node);
        return node;
      }),
    );
    if (accepts) {
      col.addEventListener('dragover', (ev) => {
        if (!dragging || dragging.from === lane.id) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        col.classList.add('target');
      });
      col.addEventListener('dragleave', (ev) => {
        // Passar de um card para outro dentro da raia não é sair dela.
        if (ev.relatedTarget && typeof col.contains === 'function' && col.contains(ev.relatedTarget)) return;
        col.classList.remove('target');
      });
      col.addEventListener('drop', (ev) => {
        ev.preventDefault();
        col.classList.remove('target');
        const going = dragging;
        dragging = null;
        if (going && going.from !== lane.id) move(going.card.itemId, lane.id);
        else dragEnd();
      });
    }
    return col;
  }

  function cardEl(card, lane, index, lanes) {
    const { label, className } = cardType(card);
    const foot = [];
    if (card.subIssues && card.subIssues.total) foot.push(el('span', { title: 'Sub-issues feitas' }, icon('list-checks'), `${card.subIssues.done}/${card.subIssues.total}`));
    if (card.pr) {
      foot.push(el('span', { title: 'Pull request' }, icon('git-pull-request'), `#${card.pr.number}`));
      const ci = CI.get(card.pr.ci);
      const review = REVIEW.get(card.pr.review);
      if (ci) foot.push(el('span', { class: `prj-pill ${ci[1]}` }, ci[0]));
      if (review) foot.push(el('span', { class: `prj-pill ${review[1]}` }, review[0]));
    }
    const node = el(
      'article',
      {
        class: 'card prj-card',
        draggable: 'true',
        tabindex: '0',
        'data-item': card.itemId,
        'aria-label': `${label} ${card.number != null ? `#${card.number} ` : ''}${card.title}, em ${lane.name}`,
        'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight',
      },
      el(
        'div',
        { class: 'type' },
        el('b', { class: `prj-type ${className}` }, label),
        card.number != null ? el('span', { class: 'num mono' }, `#${card.number}`) : null,
        el('span', { class: 'grip', title: 'Arraste para outra raia (ou Alt+← / Alt+→)' }, icon('grip-vertical')),
      ),
      el('div', { class: 'tt' }, card.title),
      foot.length ? el('div', { class: 'foot' }, ...foot) : null,
    );
    node.addEventListener('dragstart', (ev) => {
      dragging = { card, from: lane.id ?? null };
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', card.itemId);
      }
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', () => {
      node.classList.remove('dragging');
      dragEnd();
    });
    node.addEventListener('keydown', (ev) => {
      if (!ev.altKey || (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft')) return;
      const step = ev.key === 'ArrowRight' ? 1 : -1;
      for (let i = index + step; i >= 0 && i < lanes.length; i += step) {
        if (lanes[i].id === null || lanes[i].id === undefined) continue;
        ev.preventDefault();
        move(card.itemId, lanes[i].id, { keyboard: true });
        return;
      }
    });
    return node;
  }

  // ---------- mover ----------

  function findCard(itemId) {
    for (const lane of board?.lanes ?? []) {
      const i = (lane.cards ?? []).findIndex((c) => c.itemId === itemId);
      if (i >= 0) return { lane, i, card: lane.cards[i] };
    }
    return null;
  }

  /** Muda o card de raia aqui na tela: no fim da raia, ou na posição `onde` (a de antes, ao voltar). */
  function moveHere(itemId, to, where = null) {
    const found = findCard(itemId);
    const target = board?.lanes?.find((r) => r.id === to);
    if (!found || !target) return;
    found.lane.cards.splice(found.i, 1);
    found.card.laneId = to;
    const cards = (target.cards ??= []);
    cards.splice(where ?? cards.length, 0, found.card);
  }

  const laneName = (id) => board?.lanes?.find((r) => r.id === id)?.name ?? 'Sem status';

  async function move(itemId, to, { keyboard = false } = {}) {
    const before = findCard(itemId);
    if (to === null || to === undefined || !before || before.lane.id === to) return deferredRead();
    // Uma leitura em voo saiu antes deste movimento: o que ela trouxer não vale, e relê-se depois.
    if (pendingReads) {
      latestRead++;
      deferred = { force: Boolean(deferred?.force) };
    }
    // O movimento otimista mexe numa cópia: o quadro que veio da leitura fica como veio.
    board = structuredClone(board);
    const { card, i: wasAt, lane } = findCard(itemId);
    const from = lane.id ?? null;
    moveHere(itemId, to);
    notice = null;
    showToast(null);
    inFlight++;
    focus = keyboard ? itemId : null;
    drawBoard();
    try {
      const r = await ctx.write(MOVE_ROUTE, { itemId, optionId: to });
      // Só o último movimento em voo pode trocar o quadro inteiro; os de antes já estão na tela.
      if (r?.board && inFlight === 1) board = r.board;
      else if (inFlight > 1) deferred = { force: Boolean(deferred?.force) };
      showToast({ card, name: laneName(to), from: r?.moved && r.moved.from !== undefined ? r.moved.from : from });
    } catch (e) {
      if (e?.name === 'AbortError') return;
      moveHere(itemId, from, wasAt);
      const command = codeOf(e) === 'no-scope' ? commandOf(e) : null;
      notice = {
        title: `O GitHub não aceitou mover ${cardName(card)}.`,
        text: `${e?.message ?? String(e)}${waitOf(e)} O card voltou para ${laneName(from)}.${command ? ' Rode:' : ''}`,
        command,
      };
      // O quadro mudou por fora (404, 422) ou outro movimento está em voo: só a releitura acerta a tela.
      if (e?.status === 404 || e?.status === 422 || inFlight > 1) deferred = { force: Boolean(deferred?.force) };
    } finally {
      inFlight--;
    }
    drawBoard();
    focus = null;
    deferredRead();
  }

  // ---------- toast ----------

  function armToast() {
    clearTimeout(toastTimer);
    if (toast) toastTimer = setTimeout(() => showToast(null), TOAST_MS);
  }

  /** Troca o conteúdo da região viva do toast, sem redesenhar o quadro. */
  function showToast(fresh) {
    toast = fresh;
    if (!toast) {
      clearTimeout(toastTimer);
      toastBox.replaceChildren();
      return;
    }
    const { card, from, name } = toast;
    toastBox.replaceChildren(
      el(
        'div',
        { class: 'prj-toast' },
        icon('check-circle-2'),
        el('span', {}, el('b', {}, cardName(card)), ' movido para ', el('b', {}, name), ' no GitHub'),
        from !== null && from !== undefined ? el('button', { type: 'button', class: 'prj-undo', onClick: () => move(card.itemId, from, { keyboard: true }) }, 'Desfazer') : null,
      ),
    );
    armToast();
  }

  // ---------- ao vivo ----------

  ctx.onRestart(() => draw());
  ctx.onChange((changes) => {
    // While choosing the Project only the connection matters: the list is the picker's.
    if (mode === 'picker' && !connectionChanged(changes)) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => draw(), LIVE_WAIT);
  });

  await draw();

  return () => {
    doc?.removeEventListener?.('dragend', dragEnd);
    doc?.removeEventListener?.('drop', dragEnd);
    clearTimeout(toastTimer);
    clearTimeout(liveTimer);
    latestRead++;
  };
}
