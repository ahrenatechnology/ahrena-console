// The Docker card of a machine screen (issue 288, decision 0017, wireframes C85 to C88): the stacks and the
// containers the daemon lists, with Parar, Subir, Reiniciar and Remover…, Limpar os parados and Reiniciar o
// Docker. This machine's daemon and, through the tunnel, the remote's: the same card, `?machine=<id>`.
//
// - machine.js mounts it once, `dockerActions(ctx, id)`, and puts `node()` in every paint. It reads by
//   itself: on a `tools` change (the jobs), every 2 s while a job runs and every 15 s otherwise (a remote
//   sends no change events). A núcleo without the route (404) or any failure on the first read hides the
//   card: the screen keeps its read-only stacks card (`available()` is false).
// - Nothing typed becomes a command. A button asks `GET /api/docker/plan`; the dialog shows that plan's
//   argv, the place it runs, what happens and the timeout; Confirmar sends the action id, the target id and
//   the plan's digest. A 409 shows the new plan; a 404 re-reads.
// - Remover a stack never removes volumes: they are a second action (`stack-remove-volumes`), offered on a
//   row of its own once the stack is gone, with its own list, sizes and a checkbox of consent.
// - A plan that needs administrator (the Docker of the system) is shown to copy, never run. A remote that
//   does not take actions through the tunnel (the default) shows Copiar comando instead of the buttons.
// - A job's output is the núcleo's masked tail (200 lines): shown as text, never as HTML.

import { el, icon } from '../dom.js';
import { bytes, DASH } from './machine-format.js';
import {
  ACTION_BUTTONS,
  FILTERS,
  PAGE_SIZE,
  POLL_MS,
  RUNNING_POLL_MS,
  actionRoute,
  commandLines,
  commandText,
  containerFilter,
  dockerRoute,
  filterCounts,
  jobRoute,
  jobRunning,
  normalizeDocker,
  normalizePlan,
  planRoute,
  plural,
  reclaimedFrom,
  refusalText,
  since,
  stackLine,
  timeoutText,
  whatHappens,
} from './docker-format.js';

const STYLE = '/ui/screens/docker.css';
const LOCAL_ID = 'local';

function loadStyle(signal) {
  const doc = globalThis.document;
  if (!doc?.head) return;
  let link = doc.head.querySelector('link[data-screen="docker"]');
  if (!link) {
    link = el('link', { rel: 'stylesheet', href: STYLE, 'data-screen': 'docker' });
    doc.head.append(link);
  }
  signal?.addEventListener('abort', () => link.remove?.());
}

const button = ({ label, iconName = null, kind = 'outline', danger = false, onClick, disabled = false, attrs = {} }) =>
  el('button', { type: 'button', class: `btn ${kind}${danger ? ' dk-danger' : ''}`, disabled, onClick, ...attrs }, iconName ? icon(iconName) : null, label);

/** `el` handles only onClick: other events are attached here. */
const on = (node, type, fn) => (node.addEventListener(type, fn), node);

/** `replaceChildren` turns a `null` into the text "null": the absent pieces are dropped first. */
const fill = (parent, ...children) => parent.replaceChildren(...children.filter(Boolean));

const stateBadge = (running) => el('span', { class: `badge ${running ? 'b-active' : 'b-abandoned'}` }, el('span', { class: 'p' }), running ? 'Rodando' : 'Parado');

export function dockerActions(ctx, machineId = LOCAL_ID, { repaint = () => {} } = {}) {
  const local = machineId === LOCAL_ID;
  const where = local ? 'Esta máquina' : 'Workstation';
  const node = el('section', { class: 'card tm-card tm-span-full dk-card', 'data-part': 'docker-actions', hidden: true });
  let status = 'loading'; // 'loading' | 'hidden' | 'ok' | 'unreachable' | 'unsupported'
  let view = null;
  let filter = 'all';
  let query = '';
  let shown = PAGE_SIZE;
  let request = 0;
  let timer = null;
  let dialog = null;
  let notice = null; // { tone, text } after a refused write
  let dismissed = new Set(); // the ids of the ended jobs the person closed
  let started = false;
  let wasAvailable = false;

  const canRun = () => local || view?.acceptsRemoteActions === true;

  async function read() {
    if (ctx.signal.aborted) return;
    const n = ++request;
    try {
      const d = normalizeDocker(await ctx.read(dockerRoute(machineId)));
      if (n !== request || ctx.signal.aborted) return;
      if (!d) status = 'hidden';
      else if (d.status === 'ok') ((status = 'ok'), (view = d.view));
      else status = view ? 'ok' : d.status;
    } catch (e) {
      if (e?.name === 'AbortError' || n !== request || ctx.signal.aborted) return;
      if (e?.status === 404 || !view) status = 'hidden';
    }
    paint();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (ctx.signal.aborted || status === 'hidden') return;
    timer = setTimeout(read, jobRunning(view?.jobs.current) ? RUNNING_POLL_MS : POLL_MS);
  }

  ctx.onChange?.((changes) => {
    if (started && changes?.some?.((c) => c.type === 'tools')) read();
  });
  ctx.signal.addEventListener('abort', () => {
    clearTimeout(timer);
    closeDialog();
  });

  // ---------- writes ----------

  async function openPlan(action, target) {
    notice = null;
    try {
      const plan = normalizePlan(await ctx.read(planRoute(machineId, action, target)));
      if (!plan) throw new Error('resposta inesperada');
      showDialog({ plan });
    } catch (e) {
      if (e?.name === 'AbortError') return;
      notice = { tone: 'error', text: refusalText(e) };
      paint();
      if (e?.status === 404 || e?.status === 409) read();
    }
  }

  async function confirm(plan) {
    if (!dialog) return;
    dialog.busy = true;
    paintDialog();
    try {
      await ctx.write(actionRoute(plan.actionId), { machine: machineId, target: plan.target ?? undefined, planDigest: plan.planDigest });
      closeDialog();
      dismissed = new Set();
      await read();
    } catch (e) {
      if (e?.name === 'AbortError' || ctx.signal.aborted) return;
      const next = normalizePlan(e?.body);
      if (e?.status === 409 && next) return showDialog({ plan: next, problem: refusalText(e) });
      if (e?.status === 403 && next) return showDialog({ plan: next, problem: null });
      dialog.busy = false;
      dialog.problem = refusalText(e);
      if (e?.status === 403 && e?.body?.reason === 'remote-actions-disabled') view = { ...view, acceptsRemoteActions: false };
      paintDialog();
      if (e?.status === 404) read();
    }
  }

  async function cancelJob(job) {
    try {
      await ctx.write(jobRoute(job.id), { machine: machineId }, { method: 'DELETE' });
    } catch (e) {
      if (e?.name === 'AbortError') return;
      if (e?.status !== 409) notice = { tone: 'error', text: `Não deu para cancelar: ${refusalText(e)}` };
    }
    read();
  }

  const copy = async (text) => {
    try {
      await globalThis.navigator?.clipboard?.writeText?.(text);
    } catch {
      // the text stays on screen to copy by hand
    }
  };

  // ---------- the dialog ----------

  function closeDialog() {
    dialog?.root.remove();
    globalThis.document?.removeEventListener?.('keydown', onKey);
    dialog = null;
  }

  function onKey(e) {
    if (e.key === 'Escape') closeDialog();
  }

  function showDialog({ plan, problem = null }) {
    const root = dialog?.root ?? el('div', { class: 'dk-veil', role: 'presentation' });
    if (!dialog) {
      globalThis.document?.body?.append(root);
      globalThis.document?.addEventListener?.('keydown', onKey);
    }
    dialog = { root, plan, problem, busy: false, consent: false, selected: null };
    paintDialog();
  }

  function paintDialog() {
    if (!dialog) return;
    const { plan, problem, busy } = dialog;
    const danger = plan.actionId === 'container-remove' || plan.actionId === 'stack-remove' || plan.actionId === 'stack-remove-volumes';
    const copyOnly = plan.admin || !canRun();
    const rows = [
      ['Onde', local ? 'Esta máquina · como o seu usuário' : 'Workstation · como o usuário de lá'],
      ['O que acontece', whatHappens(plan)],
      ['Tempo limite', timeoutText(plan.timeoutSeconds)],
    ];
    const needsConsent = plan.actionId === 'stack-remove-volumes';
    const volumes = plan.volumes.length
      ? el(
          'table',
          { class: 'tm-table dk-vols' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Volume'), el('th', {}, 'Tamanho'), el('th', {}, 'Usado por'))),
          el('tbody', {}, ...plan.volumes.map((v) => el('tr', { class: v.keptBy ? 'dk-skip' : null }, el('td', { class: 'mono' }, v.name), el('td', { class: 'mono' }, v.sizeBytes === null ? DASH : bytes(v.sizeBytes)), el('td', {}, v.keptBy ? `fica: usado por ${v.keptBy}` : 'só a stack removida')))),
        )
      : null;
    const kept = plan.volumes.filter((v) => !v.keptBy);
    const body = el(
      'div',
      { class: 'card dk-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': plan.label },
      el('div', { class: 'dk-dialog-head' }, icon(danger ? 'trash' : 'container'), el('b', {}, plan.label), button({ label: '', iconName: 'x', kind: 'dk-ghost', onClick: closeDialog, attrs: { 'aria-label': 'Fechar' } })),
      el('dl', { class: 'dk-kv' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
      volumes,
      el('div', { class: 'eyebrow' }, plan.admin ? 'Rode no Terminal, exatamente' : copyOnly ? 'Para rodar, exatamente' : 'Vai rodar, exatamente'),
      ...commandLines(plan).map((line) => el('code', { class: 'dk-cmd mono' }, line)),
      plan.admin
        ? el('p', { class: 'dk-note' }, icon('lock'), 'O Docker é do sistema: reiniciar pede senha de administrador, e o console não roda sudo. Rode no Terminal e volte aqui.')
        : copyOnly
          ? el('p', { class: 'dk-note' }, icon('lock'), 'A Workstation não aceita ações pelo túnel: quem liga é quem está lá (AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1). Até lá, copie o comando.')
          : el('p', { class: 'dk-note' }, icon('shield-check'), 'Do catálogo Docker do núcleo, revisado no código. Os ids vêm do Docker agora, nunca de texto digitado. Se algo mudar antes do clique, o núcleo recusa e mostra o plano novo.'),
      needsConsent && !copyOnly
        ? el(
            'label',
            { class: 'dk-check' },
            on(el('input', { type: 'checkbox', 'data-dk-consent': '', checked: dialog.consent }), 'change', (e) => ((dialog.consent = e.target.checked), paintDialog())),
            `Entendi: os dados ${plural(kept.length, 'deste volume', 'desses volumes')} somem e não voltam.`,
          )
        : null,
      problem ? el('p', { class: 'dk-problem', role: 'alert' }, problem) : null,
      el(
        'div',
        { class: 'dk-dialog-actions' },
        button({ label: 'Cancelar', onClick: closeDialog }),
        copyOnly ? button({ label: 'Copiar comando', iconName: 'copy', kind: 'filled', onClick: () => copy(commandText(plan)) }) : null,
        plan.admin ? button({ label: 'Rodei, verificar de novo', iconName: 'refresh', onClick: () => (closeDialog(), read()) }) : null,
        copyOnly ? null : button({ label: confirmLabel(plan), iconName: danger ? 'trash' : 'play', kind: 'filled', danger, disabled: busy || (needsConsent && !dialog.consent), attrs: { 'data-dk-confirm': '' }, onClick: () => confirm(plan) }),
      ),
    );
    dialog.root.replaceChildren(body);
    body.querySelector('button')?.focus?.();
  }

  // ---------- the card ----------

  function actionButtons(actions, target, { compact = false } = {}) {
    return actions
      .filter((a) => ACTION_BUTTONS[a])
      .map((a) => {
        const [iconName, label, danger] = ACTION_BUTTONS[a];
        return button({
          label: canRun() ? label : compact ? label : label,
          iconName: canRun() ? iconName : 'copy',
          danger,
          onClick: () => openPlan(a, target),
          attrs: { 'data-dk-action': a, 'data-dk-target': target, title: canRun() ? null : 'Mostra o comando para copiar' },
        });
      });
  }

  function jobBand() {
    const jobs = view.jobs;
    const running = jobs.current;
    if (running) {
      const total = running.steps.length;
      const tail = running.output.slice(-4);
      return el(
        'div',
        { class: 'dk-band dk-running', role: 'status', 'data-part': 'docker-job' },
        el('div', { class: 'dk-band-top' }, icon('refresh'), el('p', {}, el('b', {}, `${running.label}.`), ` ${total > 1 ? `Passo ${running.step + 1} de ${total}. ` : ''}${jobs.queue.length ? `Na fila: ${jobs.queue.map((j) => j.label).join(', ')}.` : 'Um de cada vez nesta máquina: as outras ações esperam na fila.'}`), button({ label: 'Cancelar', iconName: 'x', onClick: () => cancelJob(running), attrs: { 'data-dk-cancel': '' } })),
        tail.length ? el('div', { class: 'dk-out mono' }, ...tail.map((l) => el('span', {}, l))) : null,
      );
    }
    const last = jobs.recent[0];
    if (!last || dismissed.has(last.id) || !['succeeded', 'failed', 'timed-out', 'canceled'].includes(last.state)) return null;
    const ok = last.state === 'succeeded';
    const freed = ok ? reclaimedFrom(last.output) : null;
    const text = ok
      ? `${freed ? `Liberou ${freed}. ` : ''}${last.steps.map((s) => s.join(' ')).join(' e depois ')} saiu com o código 0. O núcleo leu o Docker de novo.`
      : last.state === 'canceled'
        ? 'Cancelada. O que já tinha rodado não volta.'
        : last.state === 'timed-out'
          ? `Passou do tempo limite (${last.timeoutSeconds} s) e o console encerrou o processo.`
          : `Saiu com o código ${last.exitCode ?? '—'}. Nada além do que o log mostra foi alterado.`;
    const daemonDown = !ok && last.output.some((l) => /Cannot connect to the Docker daemon/i.test(l));
    return el(
      'div',
      { class: `dk-band ${ok ? 'dk-ok' : 'dk-fail'}`, role: ok ? 'status' : 'alert', 'data-part': 'docker-job' },
      el('div', { class: 'dk-band-top' }, icon(ok ? 'check-circle-2' : 'error'), el('p', {}, el('b', {}, ok ? `${last.label}: pronto.` : `${last.label}: não terminou.`), ` ${text}`), button({ label: 'Fechar', kind: 'dk-ghost', iconName: 'x', onClick: () => (dismissed.add(last.id), paint()), attrs: { 'aria-label': 'Fechar o aviso' } })),
      !ok && last.output.length ? el('div', { class: 'dk-out mono' }, ...last.output.slice(-4).map((l) => el('span', {}, l))) : null,
      !ok ? el('div', { class: 'dk-band-actions' }, button({ label: 'Copiar a saída', iconName: 'copy', onClick: () => copy(last.output.join('\n')) }), daemonDown && view.daemon.offered ? button({ label: 'Reiniciar o Docker', iconName: 'power', kind: 'filled', onClick: () => openPlan('daemon-restart', null) }) : null) : null,
    );
  }

  function toolbar() {
    const stopped = view.summary.stopped;
    return el(
      'div',
      { class: 'dk-toolbar' },
      view.daemon.offered ? button({ label: 'Reiniciar o Docker', iconName: 'power', onClick: () => openPlan('daemon-restart', null), attrs: { 'data-dk-action': 'daemon-restart' } }) : null,
      view.clean.length && stopped > 0 ? button({ label: `Limpar ${stopped} ${stopped === 1 ? 'parado' : 'parados'}`, iconName: 'trash', kind: 'filled', onClick: openClean, attrs: { 'data-dk-action': 'clean' } }) : view.clean.length ? button({ label: 'Limpar', iconName: 'trash', kind: 'filled', onClick: openClean, attrs: { 'data-dk-action': 'clean' } }) : null,
    );
  }

  // Limpar: the five clean kinds with what each is and may free, then the plan of each selected kind.
  const CLEAN_WHAT = {
    'containers-24h': 'Remove só os containers parados há mais de 24 h. Os de ontem ficam, e as stacks paradas há pouco ainda sobem.',
    containers: 'Remove todo container parado, inclusive os de uma stack parada: Subir depois não acha mais o que subir. Prefira o de cima.',
    images: 'Imagens sem tag, que sobraram de um build novo. Não toca nas que têm nome, mesmo sem uso.',
    networks: 'Redes que nenhum container usa. Libera pouco espaço, mas desentope “pool overlaps” ao subir uma stack.',
    builder: 'O cache que o próximo build refaz sozinho; o primeiro build depois dele demora mais.',
  };
  const CLEAN_COMMANDS = {
    'containers-24h': 'docker container prune --force --filter until=24h',
    containers: 'docker container prune --force',
    images: 'docker image prune --force',
    networks: 'docker network prune --force',
    builder: 'docker builder prune --force',
  };

  function openClean() {
    notice = null;
    const options = view.clean;
    const picked = new Set(options.length ? [options[0].kind] : []);
    const root = el('div', { class: 'dk-veil', role: 'presentation' });
    globalThis.document?.body?.append(root);
    globalThis.document?.addEventListener?.('keydown', onKey);
    dialog = { root, plan: null, problem: null, busy: false, consent: false, selected: picked };
    const draw = () => {
      const chosen = options.filter((o) => picked.has(o.kind));
      const sum = chosen.reduce((a, o) => a + (o.estimateBytes ?? 0), 0);
      root.replaceChildren(
        el(
          'div',
          { class: 'card dk-dialog dk-wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Limpar o Docker' },
          el('div', { class: 'dk-dialog-head' }, icon('trash'), el('b', {}, `Limpar o Docker${local ? '' : ' da Workstation'}`), button({ label: '', iconName: 'x', kind: 'dk-ghost', onClick: closeDialog, attrs: { 'aria-label': 'Fechar' } })),
          el('p', { class: 'dk-note' }, icon('info'), 'Marque o que limpar. Cada item é um comando só, do catálogo, e o espaço é uma estimativa do docker system df: o número real aparece quando termina.'),
          el(
            'div',
            { class: 'dk-opts' },
            ...options.map((o) =>
              el(
                'label',
                { class: `dk-opt${picked.has(o.kind) ? ' on' : ''}`, 'data-dk-clean': o.kind },
                on(el('input', { type: 'checkbox', checked: picked.has(o.kind) }), 'change', (e) => (e.target.checked ? picked.add(o.kind) : picked.delete(o.kind), draw())),
                el(
                  'div',
                  { class: 'dk-opt-body' },
                  el('div', { class: 'dk-opt-title' }, el('b', {}, o.label.replace(/^Limpar (os |as |o |todos os )?/, '').replace(/^./, (c) => c.toUpperCase())), o.count === null ? null : el('span', { class: 'tm-muted' }, String(o.count)), el('span', { class: 'dk-size mono' }, o.estimateBytes === null ? 'tamanho não calculado' : `até ${bytes(o.estimateBytes)}`)),
                  el('p', { class: 'tm-muted' }, CLEAN_WHAT[o.kind] ?? ''),
                  el('code', { class: 'mono' }, CLEAN_COMMANDS[o.kind] ?? ''),
                ),
              ),
            ),
          ),
          el('p', { class: 'dk-note' }, icon('lock'), el('span', {}, el('b', {}, 'Não está aqui: '), 'docker system prune, --all e volume prune. Eles apagam dados ou imagens que você ainda usa; volumes ficam para uma confirmação própria, em outro passo.')),
          el('div', { class: 'dk-sum' }, el('span', {}, `${plural(chosen.length, 'selecionado', 'selecionados')} · ${chosen.length === 1 ? 'roda um comando' : `roda ${chosen.length} comandos, um de cada vez`}`), el('span', { class: 'dk-size mono' }, sum ? `libera até ${bytes(sum)}` : '')),
          el('div', { class: 'dk-dialog-actions' }, button({ label: 'Cancelar', onClick: closeDialog }), button({ label: 'Continuar', iconName: 'play', kind: 'filled', disabled: chosen.length === 0, attrs: { 'data-dk-clean-go': '' }, onClick: () => cleanPlans(chosen.map((o) => o.kind)) })),
        ),
      );
    };
    draw();
  }

  // Each selected kind has its own plan and digest; the confirmation shows them all and sends them in order.
  async function cleanPlans(kinds) {
    try {
      const plans = [];
      for (const kind of kinds) {
        const plan = normalizePlan(await ctx.read(planRoute(machineId, 'clean', kind)));
        if (!plan) throw new Error('resposta inesperada');
        plans.push(plan);
      }
      showCleanConfirm(plans);
    } catch (e) {
      closeDialog();
      if (e?.name === 'AbortError') return;
      notice = { tone: 'error', text: refusalText(e) };
      paint();
      read();
    }
  }

  function showCleanConfirm(plans) {
    if (plans.length === 1) return showDialog({ plan: plans[0] });
    const root = dialog.root;
    dialog = { root, plan: plans[0], problem: null, busy: false, consent: false, selected: null };
    const copyOnly = !canRun();
    const sum = plans.reduce((a, p) => a + (p.estimateBytes ?? 0), 0);
    const draw = (problem = null, busy = false) =>
      root.replaceChildren(
        el(
          'div',
          { class: 'card dk-dialog dk-wide', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Confirmar a limpeza' },
          el('div', { class: 'dk-dialog-head' }, icon('trash'), el('b', {}, 'Confirmar a limpeza'), button({ label: '', iconName: 'x', kind: 'dk-ghost', onClick: closeDialog, attrs: { 'aria-label': 'Fechar' } })),
          el('dl', { class: 'dk-kv' }, el('dt', {}, 'Onde'), el('dd', {}, local ? 'Esta máquina · como o seu usuário' : 'Workstation · como o usuário de lá'), el('dt', {}, 'Ordem'), el('dd', {}, 'um de cada vez, na ordem abaixo'), el('dt', {}, 'Libera'), el('dd', {}, sum ? `até ${bytes(sum)} (estimativa; o número real aparece no fim)` : 'o que houver')),
          el('div', { class: 'eyebrow' }, copyOnly ? 'Para rodar, exatamente' : 'Vai rodar, exatamente'),
          ...plans.flatMap(commandLines).map((line) => el('code', { class: 'dk-cmd mono' }, line)),
          el('p', { class: 'dk-note' }, icon('shield-check'), 'Nenhum destes apaga volume nem container rodando.'),
          problem ? el('p', { class: 'dk-problem', role: 'alert' }, problem) : null,
          el(
            'div',
            { class: 'dk-dialog-actions' },
            button({ label: 'Voltar', onClick: () => (closeDialog(), openClean()) }),
            copyOnly ? button({ label: 'Copiar comandos', iconName: 'copy', kind: 'filled', onClick: () => copy(plans.map(commandText).join('\n')) }) : button({ label: `Confirmar os ${plans.length}`, iconName: 'play', kind: 'filled', disabled: busy, attrs: { 'data-dk-confirm': '' }, onClick: () => run() }),
          ),
        ),
      );
    async function run() {
      draw(null, true);
      try {
        for (const p of plans) await ctx.write(actionRoute('clean'), { machine: machineId, target: p.target, planDigest: p.planDigest });
        closeDialog();
        dismissed = new Set();
        await read();
      } catch (e) {
        if (e?.name === 'AbortError' || ctx.signal.aborted) return;
        draw(refusalText(e), false);
        read();
      }
    }
    draw();
  }

  const confirmLabel = (plan) => ({ 'stack-stop': 'Confirmar e parar', 'stack-start': 'Confirmar e subir', 'stack-remove': 'Remover a stack', 'stack-remove-volumes': `Apagar ${plan.count ?? ''} volumes`.replace('  ', ' '), 'container-stop': 'Confirmar e parar', 'container-restart': 'Confirmar e reiniciar', 'container-remove': 'Remover o container', 'daemon-restart': 'Confirmar e reiniciar' })[plan.actionId] ?? 'Confirmar';

  function stacksTable() {
    const rows = view.stacks.map((s) =>
      el(
        'tr',
        { 'data-stack': s.name },
        el('td', { class: 'mono' }, s.name),
        el('td', {}, el('span', { class: `badge ${s.running && s.stopped ? 'b-waiting' : s.running ? 'b-active' : 'b-abandoned'}` }, el('span', { class: 'p' }), s.running && s.stopped ? 'Parte parada' : s.running ? 'Rodando' : 'Parada')),
        el('td', { class: 'mono' }, stackLine(s)),
        el('td', { class: 'mono dk-ports' }, s.ports.length ? s.ports.join(', ') : DASH),
        el('td', { class: 'dk-acts' }, ...actionButtons(s.actions, s.name)),
      ),
    );
    const leftovers = view.leftovers.map((s) =>
      el('tr', { 'data-leftover': s.name }, el('td', { class: 'mono' }, s.name), el('td', {}, el('span', { class: 'badge b-abandoned' }, el('span', { class: 'p' }), 'Removida')), el('td', { class: 'tm-muted', colspan: '2' }, `${plural(s.volumes, 'volume ficou', 'volumes ficaram')} no disco`), el('td', { class: 'dk-acts' }, ...actionButtons(s.actions, s.name))),
    );
    if (!rows.length && !leftovers.length) return el('p', { class: 'tm-muted' }, 'Nenhuma stack do Compose nesta máquina.');
    return el('table', { class: 'tm-table' }, el('thead', {}, el('tr', {}, ...['Stack', 'Estado', 'Containers', 'Portas', ''].map((h) => el('th', {}, h)))), el('tbody', {}, ...rows, ...leftovers));
  }

  function containersTable() {
    const counts = filterCounts(view.containers);
    const matching = containerFilter(view.containers, filter, query);
    const page = matching.slice(0, shown);
    const segment = el('div', { class: 'tm-seg', role: 'group', 'aria-label': 'Filtrar os containers' }, ...FILTERS.map(([id, label]) => el('button', { type: 'button', 'aria-pressed': String(filter === id), 'data-dk-filter': id, onClick: () => ((filter = id), (shown = PAGE_SIZE), paint()) }, `${label} ${counts[id]}`)));
    const search = on(el('input', { type: 'search', class: 'dk-find', placeholder: 'Buscar por nome ou imagem', 'aria-label': 'Buscar container', value: query }), 'input', (e) => ((query = e.target.value), (shown = PAGE_SIZE), paintKeepingSearch()));
    return el(
      'div',
      { class: 'dk-containers', 'data-part': 'docker-containers' },
      el('div', { class: 'dk-containers-head' }, search, segment),
      matching.length
        ? el(
            'table',
            { class: 'tm-table' },
            el('thead', {}, el('tr', {}, ...['Nome', 'Imagem', 'Estado', 'Stack', 'Criado', ''].map((h) => el('th', {}, h)))),
            el(
              'tbody',
              {},
              ...page.map((c) => el('tr', { 'data-container': c.id }, el('td', { class: 'mono' }, c.name), el('td', { class: 'mono tm-muted dk-image' }, c.image), el('td', {}, stateBadge(c.running)), el('td', { class: 'mono' }, c.stack ?? DASH), el('td', { class: 'tm-muted' }, since(c.createdAt)), el('td', { class: 'dk-acts' }, ...actionButtons(c.actions, c.id)))),
            ),
          )
        : el('p', { class: 'tm-muted' }, view.containers.length ? 'Nenhum container com este filtro.' : 'Nenhum container nesta máquina.'),
      matching.length > shown ? el('p', { class: 'tm-muted tm-small' }, `Mostrando ${shown} de ${matching.length} · `, el('button', { type: 'button', class: 'dk-link', onClick: () => ((shown += PAGE_SIZE), paint()) }, `Ver os próximos ${Math.min(PAGE_SIZE, matching.length - shown)}`)) : matching.length ? el('p', { class: 'tm-muted tm-small' }, `Mostrando ${matching.length} de ${view.containers.length}`) : null,
    );
  }

  // Typing in the search rebuilds the card: the field takes the focus and the caret back.
  function paintKeepingSearch() {
    paint();
    const field = node.querySelector('input.dk-find');
    if (field) {
      field.focus();
      field.setSelectionRange?.(query.length, query.length);
    }
  }

  function downCard() {
    return el(
      'div',
      { class: 'dk-band dk-fail', role: 'alert', 'data-part': 'docker-down' },
      el('div', { class: 'dk-band-top' }, icon('error'), el('p', {}, el('b', {}, 'O Docker não respondeu.'), ' O núcleo pediu a lista de containers e o daemon não respondeu a tempo. Pode estar parado, travado ou sem permissão no socket.'), view.daemon.offered ? button({ label: 'Reiniciar o Docker', iconName: 'power', kind: 'filled', onClick: () => openPlan('daemon-restart', null), attrs: { 'data-dk-action': 'daemon-restart' } }) : null),
    );
  }

  function paint() {
    if (status === 'hidden' || status === 'loading') {
      node.setAttribute('hidden', '');
      return;
    }
    node.removeAttribute('hidden');
    if (status === 'unsupported' || status === 'unreachable' || !view) {
      node.replaceChildren(el('h2', { class: 'tm-title dk-title' }, icon('container'), el('span', {}, 'Docker')), el('p', { class: 'tm-muted' }, status === 'unsupported' ? `O núcleo da ${where} é de uma versão sem as ações do Docker. Atualize o núcleo de lá.` : `Sem conexão com a ${where}. As ações voltam quando ela responder.`));
      return;
    }
    const active = globalThis.document?.activeElement;
    const keep = active && node.contains(active) ? (active.getAttribute?.('data-dk-filter') ? `[data-dk-filter="${active.getAttribute('data-dk-filter')}"]` : null) : null;
    fill(
      node,
      el('h2', { class: 'tm-title dk-title' }, icon('container'), el('span', {}, 'Docker'), el('small', { class: 'tm-note' }, `${view.summary.running} rodando · ${view.summary.stopped} parados · ${plural(view.summary.stacks, 'stack', 'stacks')}`), toolbar()),
      !local && !view.acceptsRemoteActions ? el('div', { class: 'dk-band dk-lock', role: 'note' }, el('div', { class: 'dk-band-top' }, icon('lock'), el('p', {}, el('b', {}, 'As ações na Workstation estão desligadas.'), ' O túnel faz o pedido do Mac parecer local lá, então a Workstation só aceita ações quando ela mesma liga: AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1 no núcleo de lá. Até lá, cada ação mostra o comando para copiar.'))) : null,
      notice ? el('p', { class: notice.tone === 'error' ? 'dk-problem' : 'tm-muted', role: 'alert' }, notice.text) : null,
      view.available ? jobBand() : downCard(),
      view.available ? el('div', { class: 'eyebrow' }, 'Stacks') : null,
      view.available ? stacksTable() : null,
      view.available ? el('div', { class: 'eyebrow' }, 'Containers') : null,
      view.available ? containersTable() : null,
    );
    if (keep) node.querySelector(keep)?.focus?.();
    // machine.js drops its read-only stacks card once this one shows them: repaint it only when that changes.
    const now = status === 'ok' && view.available;
    if (now !== wasAvailable) ((wasAvailable = now), repaint());
  }

  return {
    /** The card's element, the same across repaints; it starts reading on the first call. */
    node() {
      loadStyle(ctx.signal);
      if (!started) {
        started = true;
        read();
      }
      return node;
    },
    /** Whether it shows the stacks (machine.js then drops its read-only stacks card). */
    available: () => status === 'ok' && view !== null && view.available,
  };
}
