// A tela Analytics (#95 e #32, C12 e C13): a Visão geral em /ui/analytics e o Custo em
// /ui/analytics/cost. The two tabs are the same screen; the tab comes from `ctx.params.tab`.
//
// - Lê `GET /api/analytics?tz=` (Visão geral) e `GET /api/analytics/cost?days=&tz=` (Custo),
//   sempre por `ctx.ler`, com o fuso do navegador.
// - Ao vivo: uma mudança relê depois de alguns segundos (uma releitura por rajada); reset relê já.
// - Os gráficos são SVG desenhado aqui, sem biblioteca. Tamanho e posição são atributos SVG; cor só
//   por classe (analytics.css), com as variáveis de marca.css.
// - Custo é estimativa: `usd: null` quer dizer "sem preço" (modelo fora da tabela), nunca US$ 0.
// - Com mais de uma conta, o custo leva a divisão por conta ao lado (decisão 0006).

import { header, el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';

export const OVERVIEW_ROUTE = '/api/analytics';
export const COST_ROUTE = '/api/analytics/cost';
export const PERIODS = [7, 30, 90];
const STYLE = '/ui/analytics.css';
const REREAD_MS = 4000;

const OVERVIEW_SUB = 'Uso, custo e produtividade das sessões';
const COST_SUB = 'Custo estimado pelo transcript, com o preço de cada modelo';

// ---------- Formatação (pt-BR) ----------

const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const oneDigit = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const twoDigits = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** 412, 1.086, 48,1 mil, 2,1 mi, 1,9 B. */
export function quantity(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a < 10_000) return integer.format(n);
  if (a < 1e6) return `${oneDigit.format(n / 1e3)} mil`;
  if (a < 1e9) return `${oneDigit.format(n / 1e6)} mi`;
  return `${oneDigit.format(n / 1e9)} B`;
}

/** Custo estimado: "~US$ 12,40"; `curto` arredonda de 100 para cima ("~US$ 341"); `null` é "sem preço". */
export function usd(v, { curto: short = false } = {}) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'sem preço';
  if (short && Math.abs(v) >= 100) return `~US$ ${integer.format(v)}`;
  return `~US$ ${twoDigits.format(v)}`;
}

/** "71%"; sem dado, traço. */
export function percent(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  return p > 0 && p < 1 ? '<1%' : `${integer.format(p)}%`;
}

/** "2026-10-13" vira "13 out". */
export function shortDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : String(day ?? '');
}

/** Tokens em milhões, como no C12: 1180, 4,2, 0,3. */
export function millions(tokens) {
  const m = tokens / 1e6;
  return m >= 10 ? integer.format(m) : oneDigit.format(m);
}

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
const familyName = (f) => f[0].toUpperCase() + f.slice(1);

/** O nome amigável do modelo: claude-opus-5-5 vira "Opus 5.5". Se não reconhecer, o id como veio. */
export function modelName(id) {
  if (id === null || id === undefined) return null;
  const clean = String(id).replace(/\[1m\]$/, '');
  let m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(clean);
  if (m && FAMILIES.includes(m[1])) return `${familyName(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  m = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(clean);
  if (m && FAMILIES.includes(m[3])) return `${familyName(m[3])} ${m[1]}${m[2] ? `.${m[2]}` : ''}`;
  return String(id);
}

/** A cor de um modelo segue a família, não a posição: a mesma nas duas abas. */
export function modelClass(id) {
  const s = String(id ?? '');
  if (/opus/.test(s)) return 'an-m0';
  if (/sonnet/.test(s)) return 'an-m1';
  if (/haiku/.test(s)) return 'an-m2';
  return 'an-m3';
}

const plural = (n, one, many) => `${integer.format(n)} ${n === 1 ? one : many}`;

// ---------- Cor da conta ----------

// The account color arrives as a value; here it only becomes a class when it is one of the brand
// colors the core gives accounts (profiles/colors.ts). A custom color outside the palette keeps only the label.
const ACCOUNT_COLORS = { 'an-account-pink': '--rose-500', 'an-account-green': '--green-500', 'an-account-yellow': '--yellow-500', 'an-account-gray': '--gray-200' };

export function accountClass(color) {
  if (typeof color !== 'string' || typeof getComputedStyle !== 'function') return null;
  let computed;
  try {
    computed = getComputedStyle(document.documentElement);
  } catch {
    return null;
  }
  const target = color.trim().toLowerCase();
  for (const [className, variable] of Object.entries(ACCOUNT_COLORS)) if (computed.getPropertyValue(variable).trim().toLowerCase() === target) return className;
  return null;
}

function splitByAccount(rows) {
  return el(
    'ul',
    { class: 'an-accounts', 'aria-label': 'Divisão por conta' },
    ...rows.map((l) => {
      const className = accountClass(l.color);
      // Com preço só para parte dos modelos, o valor é parcial: a dica diz quais ficaram de fora.
      const partial = l.usd !== null && l.usd !== undefined && (l.unpriced ?? []).length > 0;
      return el(
        'li',
        { 'data-account': l.account ?? 'no-account', title: partial ? `Parcial: sem preço para ${l.unpriced.map(modelName).join(', ')}` : null },
        el('span', { class: className ? `an-dot ${className}` : 'an-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'an-trunc' }, l.label),
        el('b', {}, usd(l.usd), partial ? el('span', { class: 'an-partial' }, ' · parcial') : null),
      );
    }),
  );
}

/** As linhas da divisão por conta do C12, ou `null` com uma conta só. */
export function overviewAccounts(data) {
  const accounts = data?.accounts ?? [];
  const by = data?.numbers?.cost?.byAccount ?? [];
  if (accounts.length < 2 || by.length < 2) return null;
  return by.map((p) => {
    const c = accounts.find((x) => x.id === p.account);
    return { account: p.account, label: c?.label ?? 'Sem conta', color: c?.color ?? null, usd: p.usd, unpriced: p.unpriced ?? [] };
  });
}

/** As linhas da divisão por conta do C13 (do período, ou de hoje com `por`), ou `null` com uma conta só. */
export function costAccounts(data, by = data?.byAccount ?? []) {
  if ((data?.accounts ?? []).length < 2 || (by ?? []).length < 2) return null;
  return by.map((p) => ({ account: p.account, label: p.label ?? 'Sem conta', color: p.color ?? null, usd: p.usd, unpriced: p.unpriced ?? [] }));
}

// ---------- SVG ----------

const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attributes = {}, ...children) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attributes)) if (v !== null && v !== undefined && v !== false) node.setAttribute(k, String(v));
  for (const f of children.flat()) {
    if (f === null || f === undefined || f === false) continue;
    node.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return node;
}
const tip = (text) => svg('title', {}, text);
const r1 = (n) => Math.round(n * 10) / 10;

/** Uma barra horizontal: o trilho (CSS) e a parte cheia, um SVG com a largura em % por atributo
 *  (sem estilo inline) e as pontas redondas em px. */
function bar(pct, className = 'an-m0', text = null) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return el(
    'div',
    { class: 'an-bar' },
    p > 0 ? svg('svg', { width: `${r1(Math.max(p, 1.5))}%`, height: 6, 'aria-hidden': 'true' }, svg('rect', { class: `an-fill ${className}`, width: '100%', height: '100%', rx: 3 }, text ? tip(text) : null)) : null,
  );
}

/** Heatmap de atividade: uma célula por dia, colunas por semana, linhas de seg a dom. */
export function heatmap(days) {
  const STEP = 13;
  const CELL = 10;
  const LEFT = 30;
  const TOP = 14;
  const dow = (day) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  const shift = days.length ? dow(days[0].day) : 0;
  const columns = Math.max(1, Math.ceil((days.length + shift) / 7));
  const max = Math.max(0, ...days.map((d) => d.events ?? 0));
  const level = (v) => (v > 0 && max > 0 ? Math.min(4, Math.max(1, Math.ceil((v / max) * 4))) : 0);
  const children = [];
  let lastColumnWithMonth = -10;
  days.forEach((d, i) => {
    const p = i + shift;
    const col = Math.floor(p / 7);
    if (d.day.slice(8) === '01' && col - lastColumnWithMonth >= 3) {
      children.push(svg('text', { x: LEFT + col * STEP, y: 9 }, MONTHS[Number(d.day.slice(5, 7)) - 1]));
      lastColumnWithMonth = col;
    }
  });
  ['seg', 'qua', 'sex'].forEach((n, i) => children.push(svg('text', { x: 0, y: TOP + i * 2 * STEP + 8 }, n)));
  days.forEach((d, i) => {
    const p = i + shift;
    children.push(
      svg('rect', { class: `an-cell an-n${level(d.events)}`, x: LEFT + Math.floor(p / 7) * STEP, y: TOP + (p % 7) * STEP, width: CELL, height: CELL, rx: 2 }, tip(`${shortDate(d.day)}: ${plural(d.events ?? 0, 'evento', 'eventos')}`)),
    );
  });
  return [
    svg('svg', { class: 'an-chart', viewBox: `0 0 ${LEFT + columns * STEP} ${TOP + 7 * STEP}`, role: 'img', 'aria-label': `Eventos por dia nas últimas ${Math.round(days.length / 7)} semanas` }, children),
    el('div', { class: 'an-leg' }, el('span', {}, 'menos'), ...[0, 1, 2, 3, 4].map((n) => el('span', { class: `an-sample an-n${n}`, 'aria-hidden': 'true' })), el('span', {}, 'mais')),
  ];
}

/** Colunas dos últimos 30 dias, sessões por dia; o dia de hoje em destaque. A altura vem do CSS
 *  (o SVG estica sem manter a proporção), por isso as datas das pontas ficam fora dele, em HTML. */
export function bars30(days) {
  const W = 300;
  const H = 100;
  const step = W / Math.max(1, days.length);
  const width = r1(step * 0.7);
  const max = Math.max(1, ...days.map((d) => d.sessions ?? 0));
  const children = days.map((d, i) => {
    const h = r1(((d.sessions ?? 0) / max) * (H - 4));
    return svg('rect', { class: `an-col${i === days.length - 1 ? ' an-current' : ''}`, x: r1(i * step), y: r1(H - h), width: width, height: h }, tip(`${shortDate(d.day)}: ${plural(d.sessions ?? 0, 'sessão', 'sessões')}`));
  });
  children.push(svg('line', { class: 'an-axis', x1: 0, x2: W, y1: H, y2: H, 'vector-effect': 'non-scaling-stroke' }));
  return [
    svg('svg', { class: 'an-chart an-columns', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Sessões por dia nos últimos 30 dias' }, children),
    days.length ? el('div', { class: 'an-leg an-tips an-dates' }, el('span', {}, shortDate(days[0].day)), el('span', {}, shortDate(days.at(-1).day))) : null,
  ];
}

/** O topo "redondo" do eixo: 20 para um pico de 18,40. */
export function axisTop(v) {
  if (!(v > 0)) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 4, 5, 10]) if (m * e >= v) return m * e;
  return 10 * e;
}

/** Custo por dia: linha com área, eixo em US$; um dia sem preço interrompe a linha. */
export function costRow(byDay) {
  const W = 600;
  const H = 170;
  const P = 30;
  const n = byDay.length;
  const max = axisTop(Math.max(0, ...byDay.map((d) => d.usd ?? 0)));
  const x = (i) => r1(n > 1 ? P + (i * (W - P - 10)) / (n - 1) : (P + W - 10) / 2);
  const y = (v) => r1(H - 20 - (v / max) * (H - 36));
  const children = [];
  for (let t = 0; t <= 4; t++) {
    const v = (max / 4) * t;
    children.push(svg('line', { class: 'an-grid', x1: P, x2: W - 10, y1: y(v), y2: y(v) }), svg('text', { x: P - 6, y: y(v) + 3, 'text-anchor': 'end' }, oneDigit.format(v)));
  }
  // Trechos contínuos com preço.
  let segment = [];
  const segments = [];
  byDay.forEach((d, i) => {
    if (d.usd === null || d.usd === undefined) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else segment.push([x(i), y(d.usd)]);
  });
  if (segment.length) segments.push(segment);
  for (const t of segments) {
    const pts = t.map(([a, b]) => `${a},${b}`).join(' ');
    children.push(svg('polygon', { class: 'an-area', points: `${t[0][0]},${y(0)} ${pts} ${t.at(-1)[0]},${y(0)}` }), svg('polyline', { class: 'an-row', points: pts }));
  }
  const end = segments.at(-1)?.at(-1);
  if (end) children.push(svg('circle', { class: 'an-tip', cx: end[0], cy: end[1], r: 4 }));
  // Alvos de passar o mouse, um por dia, maiores que a linha.
  const middle = n > 1 ? (W - P - 10) / (n - 1) / 2 : 10;
  byDay.forEach((d, i) => children.push(svg('rect', { class: 'an-target', x: r1(x(i) - middle), y: 8, width: r1(middle * 2), height: H - 28 }, tip(`${shortDate(d.day)}: ${usd(d.usd)}`))));
  if (n) children.push(svg('text', { x: P, y: H - 4 }, shortDate(byDay[0].day)), svg('text', { x: W - 10, y: H - 4, 'text-anchor': 'end' }, shortDate(byDay.at(-1).day)));
  return svg('svg', { class: 'an-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Custo estimado por dia, em dólares' }, children);
}

/** As fatias da rosca: até quatro modelos com preço; o resto vira "Outros". */
export function slicesByModel(byModel) {
  const withValue = byModel.filter((m) => m.usd !== null && m.usd !== undefined);
  const without = byModel.filter((m) => m.usd === null || m.usd === undefined);
  const slices = withValue.slice(0, withValue.length > 4 ? 3 : 4).map((m) => ({ nome: modelName(m.model), classe: modelClass(m.model), usd: m.usd, pct: m.pct }));
  if (withValue.length > 4) {
    const rest = withValue.slice(3);
    slices.push({ nome: `Outros (${rest.length})`, classe: 'an-others', usd: rest.reduce((s, m) => s + m.usd, 0), pct: rest.reduce((s, m) => s + (m.pct ?? 0), 0) });
  }
  return [...slices, ...without.map((m) => ({ nome: modelName(m.model), classe: null, usd: null, pct: null }))];
}

function donut(byModel, total, days) {
  const R = 52;
  const C = 2 * Math.PI * R;
  const slices = slicesByModel(byModel);
  let a = 0;
  const arcs = slices
    .filter((f) => f.pct > 0)
    .map((f) => {
      const length = (C * f.pct) / 100;
      const arc = svg('circle', { class: `an-slice ${f.classe}`, cx: 70, cy: 70, r: R, 'stroke-dasharray': `${r1(Math.max(0, length - 2))} ${r1(C)}`, 'stroke-dashoffset': r1((-C * a) / 100), transform: 'rotate(-90 70 70)' }, tip(`${f.nome}: ${usd(f.usd)} (${percent(f.pct)})`));
      a += f.pct;
      return arc;
    });
  return el(
    'div',
    { class: 'an-donut' },
    svg(
      'svg',
      { class: 'an-chart', width: 140, height: 140, viewBox: '0 0 140 140', role: 'img', 'aria-label': `Custo por modelo nos últimos ${days} dias` },
      svg('circle', { class: 'an-bg', cx: 70, cy: 70, r: R }),
      arcs,
      svg('text', { class: 'an-center', x: 70, y: 68, 'text-anchor': 'middle' }, usd(total, { curto: true })),
      svg('text', { x: 70, y: 84, 'text-anchor': 'middle' }, `${days} dias`),
    ),
    el(
      'ul',
      { class: 'an-legend' },
      ...slices.map((f) => el('li', {}, f.classe ? el('span', { class: `an-dot ${f.classe}`, 'aria-hidden': 'true' }) : el('span', { class: 'an-dot an-empty', 'aria-hidden': 'true' }), el('span', { class: 'an-trunc' }, f.nome), el('span', { class: 'an-q' }, f.pct === null ? 'sem preço' : percent(f.pct)))),
    ),
  );
}

// ---------- Peças ----------

function stat({ id, rotulo: label, valor: value, sub, icone: name, cor: color, contas: accounts = null, dica: title = null }) {
  return el(
    'div',
    { class: 'card an-stat', 'data-card': id, title: title },
    el('span', { class: 'an-label' }, label),
    el('span', { class: `an-ic an-color-${color}` }, icon(name)),
    el('span', { class: 'an-v' }, value),
    el('span', { class: 'an-s' }, sub),
    accounts ? splitByAccount(accounts) : null,
  );
}

function card(title, right, ...body) {
  return el('section', { class: 'card an-card' }, el('div', { class: 'an-ttl' }, el('h2', {}, title), right ? el('span', { class: 'an-r' }, right) : null), ...body);
}

function list(rows, emptyText) {
  if (!rows.length) return el('p', { class: 'an-none' }, emptyText);
  const max = Math.max(...rows.map((l) => l.valor ?? 0), 0) || 1;
  return el(
    'ul',
    { class: 'an-list' },
    ...rows.map((l) => el('li', { class: 'an-list-row' }, el('span', { class: 'an-n an-trunc', title: l.nomeLongo ?? l.nome }, l.nome), bar(((l.valor ?? 0) / max) * 100, l.classe, l.dica), el('span', { class: 'an-q' }, l.texto))),
  );
}

function tabs(current) {
  const tab = (id, label, href) => el('a', { href, class: current === id ? 'an-on' : null, 'aria-current': current === id ? 'page' : null }, label);
  return el('nav', { class: 'an-seg an-tabs', 'aria-label': 'Abas do Analytics' }, tab('overview', 'Visão geral', '/ui/analytics'), tab('cost', 'Custo', '/ui/analytics/cost'));
}

function footer(left, right) {
  return el('div', { class: 'an-leg an-tips' }, el('span', {}, ...left), el('span', {}, ...right));
}

// ---------- Visão geral (C12) ----------

export function overviewScreen(d) {
  const n = d.numbers;
  const noPrice = n.cost.unpriced ?? [];
  const u30 = d.last30 ?? { days: [], peak: null, total: 0 };
  return [
    el(
      'div',
      { class: 'an-stats an-five' },
      stat({ id: 'sessions', rotulo: 'Sessões', valor: quantity(n.sessions.total), sub: plural(n.sessions.active, 'ativa', 'ativas'), icone: 'sessions', cor: 'accent' }),
      stat({ id: 'agents', rotulo: 'Agentes', valor: quantity(n.agents.total), sub: plural(n.agents.active, 'ativo', 'ativos'), icone: 'an-bot', cor: 'active' }),
      stat({ id: 'tokens', rotulo: 'Tokens', valor: quantity(n.tokens.total), sub: n.tokens.cachePct === null ? 'cache sem dado' : `${percent(n.tokens.cachePct)} de cache`, icone: 'port', cor: 'accent' }),
      stat({
        id: 'cost',
        rotulo: 'Custo',
        valor: usd(n.cost.usd, { curto: true }),
        sub: `estimativa · ${n.cost.days ?? 30} dias${noPrice.length ? ` · ${plural(noPrice.length, 'modelo', 'modelos')} sem preço` : ''}`,
        icone: 'an-dollar',
        cor: 'completed',
        contas: overviewAccounts(d),
      }),
      stat({ id: 'events', rotulo: 'Eventos', valor: quantity(n.events.total), sub: n.events.perSession === null ? 'por sessão: —' : `~${quantity(Math.round(n.events.perSession))} por sessão`, icone: 'an-bolt', cor: 'waiting' }),
    ),
    tabs('overview'),
    el(
      'div',
      { class: 'an-grid-2 an-wide' },
      card(`Atividade · últimas ${d.activity?.weeks ?? 52} semanas`, 'eventos por dia', ...heatmap(d.activity?.days ?? [])),
      card(
        'Últimos 30 dias',
        'sessões por dia',
        ...bars30(u30.days),
        footer(u30.peak ? ['Pico ', el('b', {}, integer.format(u30.peak.sessions)), ` em ${shortDate(u30.peak.day)}`] : ['Sem sessões no período'], ['Total ', el('b', {}, integer.format(u30.total ?? 0))]),
      ),
    ),
    el(
      'div',
      { class: 'an-grid-3' },
      card(
        'Tokens por modelo',
        'milhões',
        list(
          (d.tokensByModel ?? []).map((m) => ({ nome: modelName(m.model), nomeLongo: m.model, valor: m.tokens, texto: millions(m.tokens), classe: modelClass(m.model), dica: `${modelName(m.model)}: ${quantity(m.tokens)} tokens` })),
          'Nenhum token no período.',
        ),
      ),
      card(
        'Ferramentas',
        '30 dias',
        list(
          (d.tools ?? []).slice(0, 5).map((f) => ({ nome: f.name, valor: f.uses, texto: integer.format(f.uses), dica: `${f.name}: ${plural(f.uses, 'uso', 'usos')}` })),
          'Nenhuma ferramenta usada no período.',
        ),
      ),
      card(
        'Por dia da semana',
        'sessões',
        list(
          (d.weekday ?? []).map((s) => ({ nome: dayLabel(s.day), valor: s.sessions, texto: integer.format(s.sessions), dica: `${dayLabel(s.day)}: ${plural(s.sessions, 'sessão', 'sessões')}` })),
          'Nenhuma sessão ainda.',
        ),
      ),
    ),
  ];
}

// ---------- Custo (C13) ----------

/** O custo de hoje: `todaySummary` (`today` é o dia, "AAAA-MM-DD"). */
const todayCost = (d) => d.todaySummary ?? { usd: null, sessions: 0 };

export function costScreen(d) {
  const today = todayCost(d);
  const noPrice = d.unpriced?.models ?? [];
  const max = Math.max(0, ...(d.byProject ?? []).map((p) => p.usd ?? 0)) || 1;
  return [
    tabs('cost'),
    el(
      'div',
      { class: 'an-stats an-four' },
      stat({ id: 'today', rotulo: 'Hoje', valor: usd(today.usd), sub: plural(today.sessions ?? 0, 'sessão', 'sessões'), icone: 'an-dollar', cor: 'completed', contas: costAccounts(d, today.byAccount) }),
      stat({
        id: 'period',
        rotulo: `${d.days} dias`,
        valor: usd(d.period?.usd, { curto: true }),
        sub: d.period?.dailyAverage === null || d.period?.dailyAverage === undefined ? 'média: sem preço' : `média ${usd(d.period.dailyAverage)} por dia`,
        icone: 'an-calendar',
        cor: 'accent',
        contas: costAccounts(d),
      }),
      stat({ id: 'cache', rotulo: 'Cache', valor: percent(d.cache?.pct), sub: 'dos tokens de entrada', icone: 'an-layers', cor: 'accent' }),
      stat({
        id: 'no-price',
        rotulo: 'Sem preço',
        valor: integer.format(noPrice.length),
        sub: noPrice.length === 1 ? 'modelo sem tabela' : 'modelos sem tabela',
        icone: 'an-alert',
        cor: noPrice.length ? 'waiting' : 'muted',
        dica: noPrice.length ? `Sem tabela de preço: ${noPrice.map(modelName).join(', ')}` : 'Todos os modelos têm preço',
      }),
    ),
    el(
      'div',
      { class: 'an-grid-2 an-mean' },
      card(
        'Custo por dia',
        'US$',
        costRow(d.byDay ?? []),
        footer(d.peak ? ['Pico ', el('b', {}, usd(d.peak.usd)), ` em ${shortDate(d.peak.day)}`] : ['Sem custo no período'], ['Total ', el('b', {}, usd(d.period?.usd, { curto: true }))]),
      ),
      card('Por modelo', null, donut(d.byModel ?? [], d.period?.usd, d.days)),
    ),
    card(
      'Por projeto',
      `${d.days} dias`,
      (d.byProject ?? []).length
        ? el(
            'ul',
            { class: 'an-list an-projects' },
            ...d.byProject.map((p) => el('li', { class: 'an-list-row' }, el('span', { class: 'an-n an-trunc', title: p.project }, p.project), bar(((p.usd ?? 0) / max) * 100, 'an-m0', `${p.project}: ${usd(p.usd)}`), el('span', { class: 'an-q' }, usd(p.usd)))),
          )
        : el('p', { class: 'an-none' }, 'Nenhum projeto com custo no período.'),
    ),
  ];
}

// ---------- Exportar ----------

/** Baixa o JSON já lido (o que está na tela), sem ir ao núcleo de novo. */
export function fileName(tab, data, days) {
  const day = typeof data?.until === 'string' ? data.until : typeof data?.today === 'string' ? data.today : 'hoje';
  return tab === 'cost' ? `ahrena-analytics-cost-${days}d-${day}.json` : `ahrena-analytics-${day}.json`;
}

function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- A tela ----------

function loadStyle() {
  if (typeof document.querySelector === 'function' && document.querySelector(`link[href="${STYLE}"]`)) return;
  document.head?.append(el('link', { rel: 'stylesheet', href: STYLE }));
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function timeOf(iso, timeZone) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return null;
  try {
    return new Date(t).toLocaleTimeString('pt-BR', { timeZone: timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return null;
  }
}

/** O dia da semana como a tela escreve: a API manda `mon`…`sun`, a tela mostra `seg`…`dom`. */
const WEEKDAY_LABELS = { mon: 'seg', tue: 'ter', wed: 'qua', thu: 'qui', fri: 'sex', sat: 'sáb', sun: 'dom' };
export const dayLabel = (day) => WEEKDAY_LABELS[day] ?? day;

export async function mount(area, ctx, { releituraMs: rereadMs = REREAD_MS } = {}) {
  loadStyle();
  const requested = ctx.params?.tab;
  const tab = requested === undefined ? 'overview' : requested === 'cost' ? 'cost' : null;
  const sub = tab === 'cost' ? COST_SUB : OVERVIEW_SUB;
  const timeZone = browserTimeZone();
  let days = 30;
  let last = null; // a última resposta, para exportar e para manter a tela numa releitura que falha
  let nodes = null;
  let turn = 0;
  let wait = null;

  const head = (actions = []) => {
    const c = header({ icon: 'analytics', title: 'Analytics', sub, actions });
    c.setAttribute('class', 'cc-head an-head'); // an-cab: as ações descem numa janela estreita
    return c;
  };

  if (!tab) {
    ctx.title?.('Analytics');
    area.replaceChildren(head(), empty({ title: 'Aba não encontrada', text: `O Analytics não tem a aba "${requested}".`, action: { label: 'Ir para a Visão geral', onClick: () => ctx.navigate('/ui/analytics') } }));
    return () => {};
  }
  ctx.title?.(tab === 'cost' ? 'Analytics · Custo' : 'Analytics');

  const exportButton = () =>
    el('button', { type: 'button', class: 'btn', title: 'Baixar o JSON do que está na tela', onClick: () => last && download(fileName(tab, last, days), last) }, icon('an-download'), 'Exportar');

  function selector() {
    return el(
      'div',
      { class: 'an-seg', role: 'group', 'aria-label': 'Período' },
      ...PERIODS.map((p) =>
        el('button', { type: 'button', 'aria-pressed': p === days ? 'true' : 'false', 'data-days': p, onClick: () => p !== days && ((days = p), draw()) }, `${p} dias`),
      ),
    );
  }

  function actions(data) {
    if (tab === 'cost') return [selector(), exportButton()];
    const hour = timeOf(data?.generatedAt, timeZone);
    return [hour ? el('span', { class: 'an-chip', title: 'Hora em que o núcleo calculou estes números' }, icon('an-clock'), hour) : null, exportButton()].filter(Boolean);
  }

  function withNothing(data) {
    if (tab === 'overview') return (data?.numbers?.sessions?.total ?? 0) === 0;
    return (data?.byModel ?? []).length === 0 && (data?.byProject ?? []).length === 0;
  }

  async function draw({ silencioso: quiet = false } = {}) {
    const mine = ++turn;
    if (!quiet) area.replaceChildren(head(tab === 'cost' ? [selector()] : []), ...(tab === 'cost' ? [tabs('cost')] : []), loading());
    const z = encodeURIComponent(timeZone);
    const route = tab === 'cost' ? `${COST_ROUTE}?days=${days}&tz=${z}` : `${OVERVIEW_ROUTE}?tz=${z}`;
    try {
      const data = await ctx.read(route);
      if (mine !== turn) return;
      last = data;
      if (withNothing(data)) {
        nodes =
          tab === 'overview'
            ? [head(), empty({ title: 'Nenhuma sessão ainda', text: 'Os números aparecem quando o console registrar a primeira sessão do Claude Code.' })]
            : [head([selector()]), tabs('cost'), empty({ title: `Nenhum custo nos últimos ${days} dias`, text: 'Escolha um período maior ou volte depois de usar o Claude Code.' })];
      } else nodes = [head(actions(data)), ...(tab === 'cost' ? costScreen(data) : overviewScreen(data))];
      area.replaceChildren(...nodes);
    } catch (e) {
      if (e?.name === 'AbortError' || mine !== turn) return;
      if (quiet && nodes) {
        area.replaceChildren(nodes[0], errorBand({ title: 'Não deu para atualizar.', text: `${e?.message ?? e}. Os números abaixo são da última leitura.`, action: { label: 'Tentar de novo', onClick: () => draw({ silencioso: true }) } }), ...nodes.slice(1));
        return;
      }
      nodes = null;
      area.replaceChildren(head(tab === 'cost' ? [selector()] : []), error({ text: e?.message ?? String(e), retry: () => draw() }));
    }
  }

  ctx.onChange(() => {
    if (wait) return;
    wait = setTimeout(() => {
      wait = null;
      draw({ silencioso: true });
    }, rereadMs);
  });
  ctx.onRestart(() => draw({ silencioso: true }));
  await draw();
  return () => {
    clearTimeout(wait);
    wait = null;
    turn++;
  };
}
