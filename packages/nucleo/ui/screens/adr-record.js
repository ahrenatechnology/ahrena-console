// A ADR (ou PDR) aberta (C30, issue 174): o registro estruturado, nunca o texto puro por padrão.
// `/ui/adrs/<owner>/<repo>/<id>` e `/ui/pdrs/<owner>/<repo>/<id>` (o tipo vem do caminho).
//
// - Lê `GET /api/adrs/<owner>/<repo>/<id>` (src/adrs/model.ts `DecisionRecordView`). A rota espera a
//   leitura do repositório; abrir um registro não chama o GitHub (o texto veio no lote).
// - Cabeçalho: número, título, status, data, repositório, arquivo e formato. As ligações (substitui,
//   substituída por, relacionadas), com a volta que o núcleo completa.
// - Seções: contexto, motivadores, decisão com a opção escolhida, alternativas (com prós e contras
//   quando o texto traz), consequências boas e ruins, confirmação e as outras seções, fechadas. O que
//   falta aparece tracejado, "não está no texto", em vez de sumir.
// - À direita: o card Registro (status original, decisores, consultados, informados e formato), a
//   cadeia de substituição e o índice "Nesta ADR".
// - "Markdown" mostra o arquivo como está, pelo renderizador seguro (sem HTML embutido).

import { el, icon } from '../dom.js';
import { loading, error, empty } from '../states.js';
import { blobUrl, renderMarkdown } from './agent-instructions-markdown.js';
import { FORMAT_LABEL, KIND_REASON, KINDS, STATUS_LABEL, chainList, dateBr, decisionsChangeMatters, kindOfPath, linkLabel, loadDecisionsStyle, recordHref, recordNumber, repoTabHref, segmented, statusPill } from './adrs-common.js';
import { connectEmptyFor, connectionChanged, isGithubNotConnected } from '../github-connect.js';

/** As seções estruturadas, na ordem da tela: id, título, ícone e se pode faltar. */
export const SECTIONS = [
  ['context', 'Contexto', 'question'],
  ['drivers', 'Motivadores', 'list-checks'],
  ['decision', 'Decisão', 'check-circle-2'],
  ['options', 'Alternativas', 'git-fork'],
  ['consequences', 'Consequências', 'scale'],
  ['confirmation', 'Confirmação', 'shield-check'],
];

/** O que o texto traz de cada seção; as que nunca são obrigatórias (motivadores, confirmação) somem sem texto. */
export function presentSections(r) {
  return {
    context: Boolean(r.context),
    drivers: r.drivers.length > 0,
    decision: Boolean(r.decision || r.chosen),
    options: r.options.length > 0,
    consequences: Boolean(r.consequences || r.consequencesGood.length || r.consequencesBad.length),
    confirmation: Boolean(r.confirmation),
  };
}

const OPTIONAL = new Set(['drivers', 'confirmation']);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function mount(area, ctx) {
  loadDecisionsStyle();
  const K = kindOfPath(location.pathname);
  const { owner, repo, id } = ctx.params;
  const key = `${owner}/${repo}`;
  const route = `${K.api}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(id)}`;
  let data = null;
  let failure = null;
  let mode = 'structured';
  let request = 0;

  const root = el('div', { class: 'adr-record' });
  area.replaceChildren(root);

  async function read() {
    const n = ++request;
    try {
      const d = await ctx.read(route);
      if (n !== request) return;
      data = d;
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError' || n !== request) return;
      failure = e instanceof Error ? e : new Error(String(e));
    }
    draw();
  }

  const md = (text) => renderMarkdown(text ?? '', { repo: data.repo, commit: data.commit, from: data.path });
  const card = (sec, title, iconName, extra, ...children) =>
    el('section', { class: 'card adr-sec', id: `adr-sec-${sec}`, 'data-section': sec }, el('h2', { class: 'adr-sec-ttl' }, icon(iconName), title, extra ? el('span', { class: 'adr-sec-r' }, extra) : null), ...children);
  const missingCard = (sec, title, iconName) => el('section', { class: 'card adr-sec adr-missing', id: `adr-sec-${sec}`, 'data-section': sec }, el('h2', { class: 'adr-sec-ttl' }, icon(iconName), title), el('p', { class: 'adr-missing-text' }, 'não está no texto'));
  const items = (list) => el('ul', { class: 'adr-ul' }, ...list.map((x) => el('li', {}, x)));

  function header() {
    const r = data;
    const url = blobUrl(r.repo, r.commit, r.path);
    const toggle = segmented('Modo', [['structured', 'Estruturada'], ['markdown', 'Markdown']], mode, (v) => {
      mode = v;
      draw();
    });
    const chips = [
      el('a', { class: 'adr-chip mono', href: repoTabHref(r.repo, r.kind) }, icon('repos'), r.repo),
      el('span', { class: 'adr-chip mono', title: r.dateRaw ?? '' }, icon('calendar'), dateBr(r.date) ?? 'sem data'),
      el('span', { class: 'adr-chip mono adr-trunc', title: r.path }, icon('file-text'), r.path),
      el('span', { class: 'adr-chip' }, FORMAT_LABEL[r.format] ?? r.format),
      el('span', { class: 'adr-chip', title: 'De onde veio o tipo ADR ou PDR' }, KIND_REASON[r.kindReason] ?? r.kindReason),
    ];
    return el(
      'header',
      { class: 'adr-head' },
      el(
        'div',
        { class: 'adr-head-l1' },
        el('a', { class: 'adr-back', href: K.ui, 'aria-label': `Voltar para ${K.label}` }, icon('back')),
        el('span', { class: 'mono adr-head-n' }, recordNumber(r.number)),
        el('h1', { class: 'adr-trunc', title: r.title }, r.title),
        statusPill(r.status),
        el('span', { class: 'adr-head-r' }, toggle, url ? el('a', { class: 'btn outline', href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), el('span', { class: 'adr-gh-long' }, 'Abrir no'), 'GitHub') : null),
      ),
      el('div', { class: 'adr-chips' }, ...chips),
    );
  }

  function linksCard() {
    const r = data;
    const link = (l) =>
      el(
        'a',
        { class: 'adr-link', href: recordHref(l.targetKind, r.repo, l.target) },
        el('span', { class: 'adr-muted adr-link-kind' }, capital(linkLabel(l.kind))),
        el('span', { class: 'mono adr-accent' }, recordNumber(l.number)),
        el('span', { class: 'adr-trunc' }, l.title),
        statusPill(l.status),
      );
    const order = ['supersedes', 'superseded-by', 'amends', 'amended-by', 'clarifies', 'clarified-by', 'related'];
    const links = [...r.links].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const parts = links.map(link);
    if (!links.some((l) => l.kind === 'superseded-by')) parts.push(el('span', { class: 'adr-muted' }, 'Substituída por: nenhuma'));
    const conflict = r.statusConflict ? el('span', { class: 'adr-conflict' }, icon('alert'), `O status diz "${STATUS_LABEL[r.status]}", mas outra ${KINDS[r.kind].label} a substitui.`) : null;
    return el('section', { class: 'card adr-links', 'aria-label': 'Ligações' }, icon('git-compare'), ...parts, conflict);
  }

  function decisionCard() {
    const r = data;
    const chosen = r.chosen ? el('div', { class: 'adr-chosen' }, el('span', { class: 'adr-muted' }, 'Opção escolhida'), el('b', {}, r.chosen)) : null;
    // No MADR, o texto da decisão é "Chosen option: …, because …": mostra o porquê, não a frase repetida.
    const text = r.chosen && r.chosenReason ? el('p', { class: 'adr-p' }, capital(r.chosenReason)) : r.decision ? md(r.decision) : null;
    return el('section', { class: 'card adr-sec adr-decision', id: 'adr-sec-decision', 'data-section': 'decision' }, el('h2', { class: 'adr-sec-ttl' }, icon('check-circle-2'), 'Decisão'), chosen, text);
  }

  function optionsCard() {
    const rows = data.options.map((o) => {
      const counts = o.pros.length || o.cons.length ? `${plural(o.pros.length, 'pró', 'prós')} · ${plural(o.cons.length, 'contra', 'contras')}` : null;
      const line = el('span', { class: 'adr-opt-line' }, el('span', { class: o.chosen ? 'adr-tone-ok' : 'adr-muted' }, icon(o.chosen ? 'done' : 'x')), el('span', { class: o.chosen ? 'adr-trunc adr-opt-chosen' : 'adr-trunc adr-muted' }, o.name), counts ? el('span', { class: 'adr-opt-count' }, counts, icon('chevron-down')) : null);
      if (!counts) return el('div', { class: 'adr-opt' }, line);
      return el(
        'details',
        { class: 'adr-opt' },
        el('summary', {}, line),
        el('div', { class: 'adr-two' }, el('div', {}, el('div', { class: 'eyebrow adr-tone-ok' }, 'Prós'), items(o.pros)), el('div', {}, el('div', { class: 'eyebrow adr-tone-error' }, 'Contras'), items(o.cons))),
      );
    });
    return card('options', 'Alternativas', 'git-fork', plural(data.options.length, 'considerada', 'consideradas'), el('div', { class: 'adr-opts' }, ...rows));
  }

  function consequencesCard() {
    const r = data;
    if (r.consequencesGood.length || r.consequencesBad.length) {
      return card(
        'consequences',
        'Consequências',
        'scale',
        null,
        el(
          'div',
          { class: 'adr-two' },
          el('div', {}, el('div', { class: 'eyebrow adr-tone-ok' }, 'Boas'), r.consequencesGood.length ? items(r.consequencesGood) : el('p', { class: 'adr-muted adr-p' }, 'nenhuma no texto')),
          el('div', {}, el('div', { class: 'eyebrow adr-tone-error' }, 'Ruins'), r.consequencesBad.length ? items(r.consequencesBad) : el('p', { class: 'adr-muted adr-p' }, 'nenhuma no texto')),
        ),
      );
    }
    return card('consequences', 'Consequências', 'scale', null, md(r.consequences));
  }

  function otherCard() {
    if (!data.other.length) return null;
    return el(
      'details',
      { class: 'card adr-other' },
      el('summary', {}, icon('chevron-right'), 'Outras seções do texto', ...data.other.map((s) => el('span', { class: 'adr-chip' }, s.heading))),
      ...data.other.map((s) => el('section', { class: 'adr-other-sec' }, el('h3', {}, s.heading), md(s.text))),
    );
  }

  function sections() {
    const r = data;
    const has = presentSections(r);
    const out = [];
    for (const [sec, title, iconName] of SECTIONS) {
      if (!has[sec]) {
        if (!OPTIONAL.has(sec)) out.push(missingCard(sec, title, iconName));
        continue;
      }
      if (sec === 'context') out.push(card(sec, title, iconName, null, md(r.context)));
      if (sec === 'drivers') out.push(card(sec, title, iconName, null, items(r.drivers)));
      if (sec === 'decision') out.push(decisionCard());
      if (sec === 'options') out.push(optionsCard());
      if (sec === 'consequences') out.push(consequencesCard());
      if (sec === 'confirmation') out.push(card(sec, title, iconName, null, md(r.confirmation)));
    }
    const other = otherCard();
    if (other) out.push(other);
    return out;
  }

  function side() {
    const r = data;
    const row = (label, value, opts = {}) => [el('span', { class: 'adr-muted' }, label), value === null || value === '' ? el('span', { class: 'adr-dash' }, 'não está no texto') : el('span', { class: opts.mono ? 'mono adr-trunc' : 'adr-trunc', title: typeof value === 'string' ? value : null }, value)];
    const people = (list) => (list.length ? list.join(', ') : null);
    const registry = el(
      'section',
      { class: 'card adr-side-card', 'aria-label': 'Registro', 'data-card': 'registry' },
      el('h2', { class: 'adr-sec-ttl' }, icon('info'), 'Registro'),
      el(
        'div',
        { class: 'adr-dl' },
        ...row('Status', r.statusRaw ? el('span', { class: 'adr-status-raw' }, statusPill(r.status), el('span', { class: 'mono adr-muted', title: r.statusRaw }, r.statusRaw)) : null),
        ...row('Data', dateBr(r.date) ?? r.dateRaw, { mono: true }),
        ...row('Decidiram', people(r.deciders)),
        ...(r.consulted.length || r.format === 'madr4' ? row('Consultados', people(r.consulted)) : []),
        ...(r.informed.length || r.format === 'madr4' ? row('Informados', people(r.informed)) : []),
        ...row('Formato', FORMAT_LABEL[r.format] ?? r.format),
        ...row('Tipo', `${KINDS[r.kind].label} · ${KIND_REASON[r.kindReason] ?? r.kindReason}`),
      ),
    );
    const chain = r.chain.length > 1 ? el('section', { class: 'card adr-side-card', 'aria-label': 'Cadeia de substituição', 'data-card': 'chain' }, el('h2', { class: 'adr-sec-ttl' }, icon('git-compare'), 'Cadeia'), chainList(r.chain, r.repo, { here: r.id })) : null;
    const has = presentSections(r);
    const toc = el(
      'nav',
      { class: 'card adr-side-card adr-toc', 'aria-label': `Nesta ${K.label}` },
      el('h2', { class: 'adr-sec-ttl' }, icon('list'), `Nesta ${KINDS[r.kind].label}`),
      ...SECTIONS.filter(([sec]) => has[sec] || !OPTIONAL.has(sec)).map(([sec, title]) => el('a', { href: `#adr-sec-${sec}`, class: has[sec] ? null : 'adr-toc-missing' }, title)),
    );
    toc.addEventListener('click', (ev) => {
      const a = ev.target instanceof Element ? ev.target.closest('a[href^="#"]') : null;
      if (!a) return;
      ev.preventDefault();
      root.querySelector(a.getAttribute('href'))?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
    return el('aside', { class: 'adr-side' }, registry, chain, toc);
  }

  function draw() {
    if (isGithubNotConnected(failure)) return root.replaceChildren(connectEmptyFor('record', ctx.navigate));
    if (failure && !data) return root.replaceChildren(error({ text: failure.message, retry: () => (root.replaceChildren(loading()), read()) }));
    if (!data) return root.replaceChildren(loading());
    ctx.title(`${recordNumber(data.number)} ${data.title}`);
    if (mode === 'markdown') {
      return root.replaceChildren(header(), el('section', { class: 'card adr-markdown', 'aria-label': 'Markdown do arquivo' }, md(data.markdown)));
    }
    root.replaceChildren(header(), linksCard(), el('div', { class: 'adr-body' }, el('div', { class: 'adr-main' }, ...sections()), side()));
  }

  ctx.onChange((changes) => {
    if (decisionsChangeMatters(changes, key) || connectionChanged(changes)) read();
  });
  ctx.onRestart(() => read());

  root.replaceChildren(loading());
  const n = ++request;
  try {
    data = await ctx.read(route);
  } catch (e) {
    if (e?.name === 'AbortError' || n !== request) return () => request++;
    // 404 e 400 vêm com a mensagem do núcleo: o registro não existe, ou é do outro tipo.
    const status = e?.status;
    const message = e instanceof Error ? e.message : String(e);
    // Um registro do outro tipo (uma PDR aberta pela rota de ADR): o 404 diz o tipo, e a tela vai para a rota certa.
    const other = status === 404 ? e?.body?.kind : null;
    if (KINDS[other] && other !== K.kind) {
      ctx.navigate(recordHref(other, key, id));
      return () => request++;
    }
    if (status === 404 || status === 400) {
      root.replaceChildren(empty({ icon: K.icon, title: `${K.label} não encontrada`, text: message, action: { label: `Voltar para ${K.label}`, icon: 'back', onClick: () => ctx.navigate(K.ui) } }));
      return () => request++;
    }
    failure = e instanceof Error ? e : new Error(message);
  }
  draw();
  return () => request++;
}

const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
