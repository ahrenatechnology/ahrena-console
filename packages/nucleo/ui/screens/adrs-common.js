// O que as telas de registros de decisão dividem (issue 174): as listas de ADR e PDR (C28, C38), o
// registro aberto (C30) e a aba ADRs de um repositório (C29, C31). Rótulos em pt-BR; rotas e chaves em inglês.
//
// O texto do repositório é dado: tudo entra por `el` (`textContent`); o Markdown de uma seção passa pelo
// renderizador seguro da aba Instruções (agent-instructions-markdown.js), sem HTML.

import { el, icon } from '../dom.js';

/** Os dois tipos, com o que muda entre as telas deles: rótulo, ícone e rotas. */
export const KINDS = {
  adr: { kind: 'adr', label: 'ADR', plural: 'ADRs', icon: 'scroll-text', ui: '/ui/adrs', api: '/api/adrs', what: 'arquitetura' },
  pdr: { kind: 'pdr', label: 'PDR', plural: 'PDRs', icon: 'lightbulb', ui: '/ui/pdrs', api: '/api/pdrs', what: 'produto' },
};

/** O tipo da tela, pelo caminho (`/ui/pdrs…` é PDR; o resto, ADR). */
export const kindOfPath = (pathname) => (String(pathname).startsWith('/ui/pdrs') ? KINDS.pdr : KINDS.adr);

export const STATUS_LABEL = { accepted: 'Aceita', proposed: 'Proposta', superseded: 'Substituída', deprecated: 'Obsoleta', rejected: 'Rejeitada', unknown: 'Sem status' };
/** Os rótulos do segmentado de status, no plural. */
export const STATUS_FILTERS = [
  ['', 'Todas', 'all'],
  ['accepted', 'Aceitas', 'accepted'],
  ['proposed', 'Propostas', 'proposed'],
  ['superseded', 'Substituídas', 'superseded'],
  ['deprecated', 'Obsoletas', 'deprecated'],
  ['rejected', 'Rejeitadas', 'rejected'],
  ['unknown', 'Sem status', 'unknown'],
];

export const FORMAT_LABEL = { madr4: 'MADR 4', madr3: 'MADR 3', madr2: 'MADR 2', madr: 'MADR', nygard: 'Nygard', 'adr-tools': 'adr-tools', 'y-statement': 'Y-statement', free: 'livre' };
export const KIND_REASON = { 'type-field': 'tipo pelo campo de tipo', prefix: 'tipo pelo prefixo', folder: 'tipo pela pasta', default: 'tipo pelo padrão' };
export const MISSING_LABEL = { status: 'sem status', date: 'sem data', context: 'sem contexto', decision: 'sem decisão', options: 'sem alternativas', consequences: 'sem consequências' };

const LINK_LABEL = {
  supersedes: 'substitui',
  'superseded-by': 'substituída por',
  amends: 'emenda',
  'amended-by': 'emendada por',
  clarifies: 'esclarece',
  'clarified-by': 'esclarecida por',
  related: 'relacionada a',
};
export const linkLabel = (kind) => LINK_LABEL[kind] ?? kind;

/** As pastas de ADR e de PDR, na ordem em que o núcleo procura (src/adrs/parse.ts). */
export const ADR_FOLDERS = ['docs/adr', 'docs/adrs', 'docs/decisions', 'docs/decisoes', 'docs/architecture/decisions', 'docs/architecture/adr', 'docs/arch/adr', 'doc/adr', 'doc/architecture/decisions', 'doc/decisions', 'adr', 'adrs', 'decisions', 'architecture/decisions'];
export const PDR_FOLDERS = ['docs/pdr', 'docs/pdrs', 'docs/product-decisions', 'docs/product/decisions', 'docs/decisoes-de-produto', 'doc/pdr', 'pdr', 'pdrs', 'product-decisions'];

/** Como escrever uma (página externa, em inglês). */
export const HOW_TO_WRITE = 'https://adr.github.io/';

export function loadDecisionsStyle() {
  if (!document.querySelector('link[data-screen="adrs"]')) document.head.append(el('link', { rel: 'stylesheet', href: '/ui/screens/adrs.css', 'data-screen': 'adrs' }));
  // O Markdown das seções usa o renderizador seguro da aba Instruções, e os estilos dele.
  if (!document.querySelector('link[data-screen="agent-instructions"]')) document.head.append(el('link', { rel: 'stylesheet', href: '/ui/screens/agent-instructions.css', 'data-screen': 'agent-instructions' }));
}

/** A mudança ao vivo diz respeito a esta lista (`list`) ou a este repositório (`<owner>/<repo>`). */
export const decisionsChangeMatters = (changes, key) => (changes ?? []).some((c) => c?.type === 'adrs' && String(c.key).toLowerCase() === String(key).toLowerCase());

/** `0008`, ou `—` sem número. */
export const recordNumber = (n) => (typeof n === 'number' ? String(n).padStart(4, '0') : '—');

/** `2026-09-30` → `30/09/2026`; sem data, `null`. */
export function dateBr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** A URL de um registro na tela: pelo tipo dele, não pelo da lista. */
export function recordHref(kind, repo, id) {
  const [owner, name] = String(repo).split('/');
  return `${KINDS[kind]?.ui ?? KINDS.adr.ui}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(id)}`;
}

/** A aba ADRs de um repositório. */
export function repoTabHref(repo, kind = null) {
  const [owner, name] = String(repo).split('/');
  return `/ui/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/adrs${kind ? `?kind=${kind}` : ''}`;
}

/** O selo do status: a cor e a palavra; "Sem status" sem cor. */
export function statusPill(status) {
  const s = STATUS_LABEL[status] ? status : 'unknown';
  return el('span', { class: 'adr-pill', 'data-status': s }, STATUS_LABEL[s]);
}

/** "substitui 0007 · sem consequências": a segunda linha da linha. */
export function rowNote(r) {
  const links = (r.links ?? []).filter((l) => l.kind !== 'related').map((l) => `${linkLabel(l.kind)} ${recordNumber(l.number)}`);
  const missing = (r.missing ?? []).filter((m) => m !== 'status').map((m) => MISSING_LABEL[m]);
  return { links: links.join(' · '), missing: missing.join(' · ') };
}

/** Uma linha da lista: número, título (com a nota embaixo), status, data e a seta. */
export function recordRow(r, { listKind = null } = {}) {
  const { links, missing } = rowNote(r);
  const note = [links, missing].filter(Boolean).join(' · ');
  const old = r.status === 'superseded' || r.status === 'deprecated';
  return el(
    'a',
    { class: 'adr-row', href: recordHref(r.kind, r.repo, r.id), 'data-id': r.id },
    el('span', { class: 'adr-row-n mono' }, recordNumber(r.number)),
    el(
      'span',
      { class: 'adr-row-t' },
      el('b', { class: old ? 'adr-trunc adr-old' : 'adr-trunc', title: r.title }, r.title),
      note ? el('small', { class: 'adr-row-note adr-trunc' }, note) : null,
    ),
    el('span', { class: 'adr-row-s' }, statusPill(r.status), listKind === 'all' ? el('span', { class: 'adr-kind', 'data-kind': r.kind }, KINDS[r.kind]?.label ?? r.kind) : null),
    el('span', { class: 'adr-row-wide adr-trunc' }, links ? el('span', { class: 'adr-accent' }, icon('git-compare')) : null, links ? ` ${links}` : null, links && missing ? ' · ' : null, missing || null),
    el('span', { class: 'adr-row-d mono' }, dateBr(r.date) ?? '—'),
    el('span', { class: 'adr-row-go' }, icon('chevron-right')),
  );
}

/** Um nó da cadeia de substituição: número e status em cima, título embaixo; `here` acende o aberto. */
export function chainNode(n, repo, { here = false, label = null } = {}) {
  return el(
    'a',
    { class: here ? 'adr-node adr-node-here' : 'adr-node', href: recordHref(n.kind, repo, n.id), 'aria-current': here ? 'true' : null },
    el('span', { class: 'adr-node-top' }, el('span', { class: 'mono adr-muted' }, recordNumber(n.number)), label ? el('span', { class: 'adr-muted' }, label) : null, el('span', { class: 'adr-node-pill' }, statusPill(n.status))),
    el('span', { class: 'adr-trunc adr-node-title', title: n.title }, n.title),
  );
}

/** A cadeia, da mais antiga à que vale hoje, com "substituída por" entre elas. */
export function chainList(nodes, repo, { here = null } = {}) {
  const out = [];
  nodes.forEach((n, i) => {
    if (i) out.push(el('span', { class: 'adr-chain-by' }, icon('arrow-down'), 'substituída por'));
    const last = i === nodes.length - 1;
    out.push(chainNode(n, repo, { here: here === n.id, label: here === n.id ? 'esta' : last && n.status !== 'superseded' ? 'vale hoje' : null }));
  });
  return el('div', { class: 'adr-chain' }, ...out);
}

/** "há 3 min", "há 2 h", a partir de um ISO. */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
}

const hhmm = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
};

/**
 * A faixa do GitHub limitando ou falhando (C31): o cache com a hora dele e quando tenta de novo. Não é
 * a faixa vermelha de erro: a tela continua mostrando tudo, do cache.
 */
export function limitedBand({ error, readAt, retryAt, plural, onRetry }) {
  const limited = /limit/i.test(error ?? '');
  const when = hhmm(readAt);
  const wait = retryAt ? Math.max(1, Math.round((Date.parse(retryAt) - Date.now()) / 60_000)) : null;
  return el(
    'div',
    { class: 'adr-band', role: 'status' },
    icon('clock'),
    el(
      'p',
      {},
      el('b', {}, limited ? 'GitHub limitou as leituras.' : 'GitHub com problema.'),
      ` Mostrando as ${plural} em cache${when ? `, de ${when}` : ''}.`,
      wait ? ` Tentamos de novo em ${wait} min.` : '',
      limited ? null : el('span', { class: 'adr-muted' }, ` ${error}`),
    ),
    onRetry ? el('button', { type: 'button', class: 'btn outline', onClick: onRetry }, 'Tentar agora') : null,
  );
}

/** Um segmentado de botões simples, com `aria-pressed` no escolhido. */
export function segmented(label, options, current, onPick) {
  return el(
    'div',
    { class: 'adr-seg', role: 'group', 'aria-label': label },
    ...options.map(([value, text, iconName]) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(value === current), 'data-value': value }, iconName ? icon(iconName) : null, text);
      b.addEventListener('click', () => onPick(value));
      return b;
    }),
  );
}

/**
 * O texto do vazio (C31) com as pastas em `<code>`: "Procuramos em docs/adr, … e mais 9 pastas." O
 * `empty()` de states.js só aceita texto; quem chama põe este trecho dentro do parágrafo dele.
 */
export function foldersText(folders, { shown = 5, after = '' } = {}) {
  const head = folders.slice(0, shown);
  return el('span', {}, 'Procuramos em ', ...head.flatMap((f, i) => [i ? ', ' : '', el('code', {}, f)]), folders.length > shown ? ` e mais ${folders.length - shown} pastas` : '', `${after}. Uma pasta com arquivos `, el('code', {}, '0001-titulo.md'), ' já aparece aqui.');
}

/** "a, b e c". */
export function joinPt(list) {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
}

/** Sem acento e sem caixa, para a busca local. */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
