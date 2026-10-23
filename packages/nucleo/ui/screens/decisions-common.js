// O que a página Decisões (C21) e a aba Decisões do Detalhe (C20) têm em comum (issue 103): o card de uma
// decisão, as pílulas, o "há X min", o Confirmar e o Descartar, o alternador e o diálogo do
// "Promover a registro".
//
// Tudo o que vem do núcleo é conteúdo não confiável: entra por `textContent` (`el()`), nunca como HTML.
// As escritas passam por `escrever()` (api.js); nada aqui chama `fetch`.

import { el, icon } from '../dom.js';
import { write } from '../api.js';

// ---------- Estilo ----------

let cssLoaded = false;
/** As duas telas usam o mesmo `ui/decisions.css` (na raiz, como o das outras telas); a primeira que abrir o põe no `<head>`. */
export function loadDecisionsCss() {
  if (cssLoaded || typeof document === 'undefined' || document.querySelector('link[data-screen="decisions"]')) return;
  cssLoaded = true;
  document.head.append(el('link', { rel: 'stylesheet', href: '/ui/decisions.css', 'data-screen': 'decisions' }));
}

// ---------- Rótulos (funções puras) ----------

// The decision card's values are the API's, English since issue 173, phase 2b (origin, state, scope…).
const TYPES = {
  suggested: { label: 'Sugerida', icon: 'suggested' },
  correction: { label: 'Correção sua', icon: 'continued' },
  permission: { label: 'Permissão', icon: 'permission' },
  question: { label: 'Pergunta', icon: 'question' },
  plan: { label: 'Plano', icon: 'plan' },
};

/** A pílula de tipo: "Sugerida", "Correção sua", "Permissão", "Pergunta", "Plano". */
export const typeLabel = (origin) => TYPES[origin]?.label ?? 'Decisão';
export const typeIcon = (origin) => TYPES[origin]?.icon ?? 'decision';

/** Quem decidiu, como o card escreve. */
export function whoDecided(d) {
  if (d.origin === 'suggested') return 'agente propôs';
  if (d.origin === 'correction') return 'você corrigiu';
  if (d.origin === 'plan') return 'você aprovou';
  return d.decidedBy === 'agent' ? 'agente' : 'você';
}

const STATES = { current: 'Vigente', to_confirm: 'A confirmar', superseded: 'Substituída', dismissed: 'Descartada' };
export const stateLabel = (state) => STATES[state] ?? state;

const SCOPE_OPTIONS = { session: 'sessão', family: 'família', branch: 'branch' };
const SOURCES = { parent: 'da sessão mãe', family: 'de outra sessão da família', branch: 'de outra sessão do branch' };

/** "escopo: família · da sessão mãe". A origem só aparece quando a decisão não é desta sessão. */
export function scopeLabel(d) {
  const from = SOURCES[d.session];
  return `escopo: ${SCOPE_OPTIONS[d.scope] ?? d.scope}${from ? ` · ${from}` : ''}`;
}

/** "agora", "há 14 min", "há 3 h", "ontem", "há 4 d". */
export function howLongAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h} h`;
  if (h < 48) return 'ontem';
  return `há ${Math.floor(h / 24)} d`;
}

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** The actions of the screen, each the last segment of its route (`/api/decisions/<id>/<action>`). */
const ACTIONS = new Set(['confirm', 'dismiss', 'promote']);

/**
 * O pedido de uma escrita: a rota e o corpo JSON (`{ route, body }`). Id ou ação estranhos são
 * recusados aqui. Every body names the session: `{ session, … }`.
 */
export function actionRequest(id, action, body) {
  if (!ID.test(String(id))) throw new Error(`id de decisão inválido: ${id}`);
  if (!ACTIONS.has(action)) throw new Error(`ação desconhecida: ${action}`);
  if (typeof body?.session !== 'string' || !ID.test(body.session)) throw new Error('a escrita precisa da sessão');
  return { route: `/api/decisions/${id}/${action}`, body };
}

/**
 * O rascunho (`{ session }`) e a gravação (`{ session, confirm: true, path, hash }`) do Promover.
 * O `hash` é o do rascunho que a pessoa leu: se o registro mudou desde então, a API recusa (409).
 */
export function promoteRequest(id, session, save = null) {
  if (!save) return actionRequest(id, 'promote', { session });
  return actionRequest(id, 'promote', { session, confirm: true, path: save.path, ...(save.hash ? { hash: save.hash } : {}) });
}

/** O "Ver na conversa" só vira link quando é uma rota da própria interface. */
export const conversationLink = (d) => (typeof d.conversation === 'string' && /^\/ui\/sessions\/[A-Za-z0-9_.:%-]{1,200}$/.test(d.conversation) ? d.conversation : null);

// ---------- Peças ----------

// The class of each decision state (the API value stays as it comes): `dec-e-<state>`.
const STATE_CLASS = { to_confirm: 'to-confirm', current: 'current', dismissed: 'dismissed', superseded: 'superseded' };
export const stateClass = (state) => `dec-e-${STATE_CLASS[state] ?? state}`;

export function statePill(state) {
  return el('span', { class: `dec-pill ${stateClass(state)}` }, stateLabel(state));
}

/** Alternador em segmentos (Sessão/Família/Branch, Todas/Vigentes/A confirmar). */
export function toggle({ label, options, current, onSwitch }) {
  const group = el('div', { class: 'dec-seg', role: 'group', 'aria-label': label });
  const draw = (value) => {
    group.replaceChildren(
      ...options.map(([v, r]) =>
        el('button', { type: 'button', class: v === value ? 'dec-on' : null, 'aria-pressed': v === value ? 'true' : 'false', onClick: () => v !== value && (draw(v), onSwitch(v)) }, r),
      ),
    );
  };
  draw(current);
  return group;
}

/** O campo de busca, com espera: só chama `onSearch` quando a pessoa para de digitar. */
export function searchField({ placeholder, onSearch, wait = 250 }) {
  const field = el('input', { type: 'search', placeholder, 'aria-label': 'Buscar nas decisões', maxlength: '200', autocomplete: 'off' });
  let t = null;
  field.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => onSearch(field.value.trim()), wait);
  });
  return el('label', { class: 'dec-search' }, icon('search'), field);
}

/**
 * O card de uma decisão. `session` é a sessão em nome de quem a escrita vai (na página, a dona da
 * decisão; na aba, a sessão aberta). `onChange()` é chamado depois de uma escrita que deu certo.
 */
export function decisionCard(d, { session = d.sessionId, onChange = () => {}, now = Date.now(), readOnly = null, machine = null } = {}) {
  const notice = el('span', { class: 'dec-notice', role: 'status' });
  const trail = [
    d.rejected?.length ? `Descartado: ${d.rejected.join('; ')}` : null,
    d.supersededBy ? ['substituída por ', el('b', {}, d.supersededBy)] : d.supersedes ? ['substitui ', el('b', {}, d.supersedes)] : null,
  ].filter(Boolean);

  const actions = el('div', { class: 'dec-actions' });
  if (d.state === 'to_confirm') {
    // `readOnly` (issue 243: a remote session's decision) keeps the buttons, off, with the reason.
    const confirm = el('button', { type: 'button', class: 'btn filled', disabled: Boolean(readOnly), title: readOnly }, 'Confirmar');
    const dismiss = el('button', { type: 'button', class: 'btn outline', disabled: Boolean(readOnly), title: readOnly }, 'Descartar');
    const act = (action) => async () => {
      if (readOnly) return;
      confirm.disabled = dismiss.disabled = true;
      notice.textContent = '';
      try {
        const { route, body } = actionRequest(d.id, action, { session });
        await write(route, body);
        onChange();
      } catch (e) {
        notice.textContent = e.message;
        confirm.disabled = dismiss.disabled = false;
      }
    };
    confirm.addEventListener('click', act('confirm'));
    dismiss.addEventListener('click', act('dismiss'));
    actions.append(confirm, dismiss);
  } else {
    const link = conversationLink(d);
    // The conversation of a remote session's decision is read through the tunnel too.
    const conversation = link && machine && machine !== 'local' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(machine) ? `${link}?machine=${machine}` : link;
    if (conversation) actions.append(el('a', { class: 'dec-link', href: conversation }, 'Ver na conversa'));
    if (d.state === 'current') {
      if (d.promotedTo) actions.append(el('span', { class: 'dec-promoted mono', title: d.promotedTo }, icon('promote'), 'Promovida'));
      else if (readOnly) actions.append(el('button', { type: 'button', class: 'dec-link', disabled: true, title: readOnly, 'aria-label': `Promover a registro: ${readOnly}` }, 'Promover a registro'));
      else actions.append(el('button', { type: 'button', class: 'dec-link', onClick: () => openPromote(d, session, { onSave: onChange }) }, 'Promover a registro'));
    }
  }

  return el(
    'article',
    { class: `card dec-card ${stateClass(d.state)}`, 'data-decision': d.id },
    el('span', { class: 'dec-ico' }, icon(typeIcon(d.origin))),
    el('div', { class: 'dec-l1' }, el('span', { class: 'mono dec-label' }, d.label), el('b', { class: 'dec-title', title: d.title }, d.title), statePill(d.state)),
    el('time', { class: 'dec-when', datetime: d.decidedAt, title: new Date(d.decidedAt).toLocaleString('pt-BR') }, howLongAgo(d.decidedAt, now)),
    el('div', { class: 'dec-l2' }, ...trail.flatMap((r, i) => (i ? [' · ', r] : [r]))),
    el('div', { class: 'dec-l3' }, el('span', { class: 'dec-type' }, typeLabel(d.origin)), el('span', {}, whoDecided(d)), el('span', {}, scopeLabel(d)), notice),
    actions,
  );
}

// ---------- Promover a registro ----------

/**
 * O rascunho do registro: lê `POST …/promote { session }` (nada é gravado), mostra o markdown e o
 * caminho, e só grava com a confirmação explícita (a caixa "Confirmo" e o botão).
 */
export function openPromote(d, session, { onSave = () => {} } = {}) {
  const body = el('div', { class: 'dec-dlg-body' }, el('p', { class: 'dec-dlg-note' }, 'Gerando o rascunho…'));
  const close = el('button', { type: 'button', class: 'btn outline', value: 'fechar' }, 'Fechar');
  const dialog = el(
    'dialog',
    { class: 'dec-dlg', 'aria-label': `Promover ${d.label} a registro` },
    el('header', {}, icon('promote'), el('h2', {}, `Promover ${d.label} a registro de decisão`)),
    body,
    el('footer', {}, close),
  );
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();

  (async () => {
    let draft;
    try {
      const { route, body: request } = promoteRequest(d.id, session);
      draft = (await write(route, request)).draft;
    } catch (e) {
      body.replaceChildren(el('p', { class: 'dec-error', role: 'alert' }, `Não deu para gerar o rascunho: ${e.message}`));
      return;
    }
    const notice = el('p', { class: 'dec-dlg-note', role: 'status' });
    const copy = el('button', { type: 'button', class: 'btn outline' }, icon('copy'), 'Copiar');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(draft.markdown);
        notice.textContent = 'Copiado.';
      } catch {
        notice.textContent = 'Não deu para copiar.';
      }
    });
    const can = !!draft.canWrite;
    const confirmBox = el('input', { type: 'checkbox', disabled: !can });
    const save = el('button', { type: 'button', class: 'btn filled dec-save', disabled: true, title: can ? null : draft.reason ?? 'Não dá para gravar daqui' }, `Gravar em ${draft.path}`);
    confirmBox.addEventListener('change', () => (save.disabled = !confirmBox.checked));
    save.addEventListener('click', async () => {
      if (!confirmBox.checked) return;
      save.disabled = confirmBox.disabled = true;
      notice.textContent = 'Gravando…';
      try {
        const { route, body: request } = promoteRequest(d.id, session, { path: draft.path, hash: draft.hash });
        const r = await write(route, request);
        notice.textContent = `Gravado em ${r.path ?? draft.path}.`;
        save.hidden = true;
        onSave(r);
      } catch (e) {
        notice.textContent = `Não gravou: ${e.message}`;
        confirmBox.disabled = false;
        confirmBox.checked = false;
      }
    });
    body.replaceChildren(
      el('div', { class: 'dec-dlg-path' }, el('span', { class: 'eyebrow' }, 'Rascunho'), el('span', { class: 'mono' }, draft.path), draft.repo ? el('span', { class: 'mono dec-repo' }, `em ${draft.repo}`) : null),
      el('pre', { class: 'mono dec-md' }, draft.markdown),
      el('div', { class: 'dec-dlg-actions' }, copy),
      el(
        'div',
        { class: 'dec-dlg-save' },
        el('label', { class: can ? null : 'dec-off' }, confirmBox, el('span', {}, can ? `Confirmo: gravar ${draft.path} no repositório.` : `Não dá para gravar: ${draft.reason ?? 'sem motivo informado'}.`)),
        save,
      ),
      notice,
    );
  })();
  return dialog;
}
