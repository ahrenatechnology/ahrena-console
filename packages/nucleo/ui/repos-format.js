// Formatos, filtros e escalas das telas Repositórios (C22) e Repositório (C23). Sem DOM: o teste
// importa direto no node. Número nenhum é inventado: o que não veio sai como "—".

export const DASH = '—';
/** O sinal de menos tipográfico, como no wireframe ("−21,5 k"). */
export const MINUS = '−';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const nf = (digits) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const NF0 = nf(0);
const NF1 = nf(1);

const empty = (n) => n === null || n === undefined || !Number.isFinite(n);

/** "1.204". */
export function integer(n) {
  return empty(n) ? DASH : NF0.format(Math.round(n));
}

/** "1,6": uma casa decimal. */
export function decimal(n) {
  return empty(n) ? DASH : NF1.format(n);
}

/** "48,3 mil", "1,2 mi"; abaixo de mil, o número inteiro. Sem sinal. Arredonda antes de escolher a
 * escala: 999,6 é "1,0 mil", não "1.000"; e só vira "mi" quando "mil" daria "1.000,0 mil". */
export function thousand(n) {
  if (empty(n)) return DASH;
  const a = Math.abs(n);
  if (Math.round(a / 100) >= 1e4) return `${NF1.format(a / 1e6)} mi`;
  if (Math.round(a) >= 1e3) return `${NF1.format(a / 1e3)} mil`;
  return NF0.format(Math.round(a));
}

/** "61,4 k" a partir de mil (arredondado: 999,6 é "1,0 k"); abaixo, o inteiro ("212"). Sem sinal. */
export function kilo(n) {
  if (empty(n)) return DASH;
  const a = Math.abs(n);
  return Math.round(a) >= 1e3 ? `${NF1.format(a / 1e3)} k` : NF0.format(Math.round(a));
}

/** O número com "+" ou "−" na frente (zero fica sem sinal), no formato dado. */
export function signed(n, fmt = integer) {
  if (empty(n)) return DASH;
  const text = fmt(Math.abs(n));
  return n > 0 ? `+${text}` : n < 0 ? `${MINUS}${text}` : text;
}

/** De 0 a 1 em "94%". */
export function percentage(slice) {
  return empty(slice) ? DASH : `${Math.round(slice * 100)}%`;
}

/** Duração em ms: "1 d 4 h", "3 h 12", "6 min", "< 1 min". */
export function duration(ms) {
  if (empty(ms) || ms < 0) return DASH;
  if (ms >= DAY) {
    const d = Math.floor(ms / DAY);
    const h = Math.floor((ms % DAY) / HOUR);
    return h ? `${d} d ${h} h` : `${d} d`;
  }
  if (ms >= HOUR) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MIN);
    return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
  }
  if (ms >= MIN) return `${Math.floor(ms / MIN)} min`;
  return '< 1 min';
}

/** Há quanto tempo, curto: "agora", "2 min", "1 h", "ontem", "2 dias", "3 meses", "1 ano". */
export function relative(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return DASH;
  const d = now - t;
  if (d < MIN) return 'agora';
  if (d < HOUR) return `${Math.floor(d / MIN)} min`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h`;
  const days = Math.floor(d / DAY);
  if (days === 1) return 'ontem';
  if (days < 60) return `${days} dias`;
  if (days < 365) return `${Math.floor(days / 30)} meses`;
  const years = Math.floor(days / 365);
  return years === 1 ? '1 ano' : `${years} anos`;
}

/** "há 6 dias" (release); "agora" e "ontem" ficam como estão. */
export function ago(iso, now = Date.now()) {
  const r = relative(iso, now);
  return r === DASH || r === 'agora' || r === 'ontem' ? r : `há ${r}`;
}

export const PERIODS = [
  ['30d', '30 dias'],
  ['90d', '90 dias'],
  ['1a', '1 ano'],
];
export const DEFAULT_PERIOD = '90d';

/** The period of `?period=` (`1y` in the URL is `1a`, the API value), or the default when it is missing or odd. */
export function periodFrom(search) {
  const q = new URLSearchParams(search ?? '').get('period');
  const p = q === '1y' ? '1a' : q;
  return PERIODS.some(([v]) => v === p) ? p : DEFAULT_PERIOD;
}

/** The period as the URL writes it: `1y` for the year, the others as they are. */
export const periodInUrl = (p) => (p === '1a' ? '1y' : p);

export const periodLabel = (p) => (PERIODS.find(([v]) => v === p) ?? PERIODS[1])[1];

// ---------- a lista (C22) ----------

export const SORTS = [
  ['recente', 'Atividade: recente'],
  ['nome', 'Nome'],
  ['issues', 'Issues abertas'],
  ['prs', 'PRs abertos'],
  ['sessoes', 'Sessões'],
];

/**
 * "Com sessões" é o repositório com sessão viva ou com sessão no mês (`ativas > 0 || noMes > 0`):
 * o card do resumo conta "com sessões este mês", e uma sessão viva sempre conta.
 */
export const VISIBILITIES = [
  ['todos', 'Todos'],
  ['com-sessoes', 'Com sessões'],
  ['publicos', 'Públicos'],
  ['privados', 'Privados'],
];

/** Sem acento e sem caixa, para a busca. */
export const withoutAccent = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

const hasSession = (r) => r.sessoes.ativas > 0 || r.sessoes.noMes > 0;
const VIS = {
  todos: () => true,
  'com-sessoes': hasSession,
  publicos: (r) => r.visibilidade === 'publico',
  privados: (r) => r.visibilidade === 'privado',
};

const byName = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR');
const pushOf = (r) => (r.ultimoPush ? Date.parse(r.ultimoPush) || 0 : -Infinity);
const ORDER = {
  recente: (a, b) => pushOf(b) - pushOf(a) || byName(a, b),
  nome: byName,
  issues: (a, b) => b.issuesAbertas - a.issuesAbertas || byName(a, b),
  prs: (a, b) => b.prsAbertos - a.prsAbertos || byName(a, b),
  sessoes: (a, b) => b.sessoes.ativas - a.sessoes.ativas || b.sessoes.noMes - a.sessoes.noMes || byName(a, b),
};

/**
 * Os grupos depois da busca (nome ou `dono/nome`, sem acento nem caixa), da organização (`dono`,
 * vazio = todas), da visibilidade e da ordenação. Grupo que ficou sem repositório some; a ordem dos
 * grupos é a que veio do núcleo.
 */
export function filterRepos(groups, { busca: search = '', dono: owner = '', vis = 'todos', ordem: order = 'recente' } = {}) {
  const term = withoutAccent(search).trim();
  const passes = VIS[vis] ?? VIS.todos;
  const compare = ORDER[order] ?? ORDER.recente;
  const output = [];
  for (const g of groups ?? []) {
    if (owner && g.dono !== owner) continue;
    const repos = g.repos.filter((r) => passes(r) && (!term || withoutAccent(r.nome).includes(term) || withoutAccent(r.completo).includes(term))).sort(compare);
    if (repos.length) output.push({ ...g, repos });
  }
  return output;
}

// ---------- escalas dos gráficos ----------

const one = (n) => Math.round(n * 10) / 10;

/** Os pontos da sparkline (`x,y x,y …`), ou `null` sem semanas: nada de linha inventada. */
export function sparkline(values, width = 90, height = 22) {
  if (!values?.length) return null;
  const max = Math.max(...values) || 1;
  const step = values.length > 1 ? (width - 2) / (values.length - 1) : 0;
  return values.map((n, i) => `${one(i * step + 1)},${one(height - 2 - (n / max) * (height - 4))}`).join(' ');
}

/** Barras verticais de baixo para cima até `base`: `{ x, y, largura, altura }` por valor. */
export function bars(values, width = 520, base = 90) {
  if (!values?.length) return [];
  const max = Math.max(...values) || 1;
  const slot = width / values.length;
  return values.map((n, i) => {
    const h = (n / max) * (base - 6);
    return { x: one(i * slot + 1), y: one(base - h), largura: one(Math.max(1, slot - 3)), altura: one(h) };
  });
}

/**
 * Frequência de código: adicionadas para cima e removidas para baixo de `meio`, na mesma escala.
 * `{ x, largura, cima: { y, altura }, baixo: { y, altura } }` por semana.
 */
export function frequency(weeks, width = 520, middle = 64, topHeight = 58, bottomHeight = 52) {
  if (!weeks?.length) return [];
  const max = Math.max(...weeks.map((s) => Math.max(s.adicionadas, s.removidas))) || 1;
  const slot = width / weeks.length;
  return weeks.map((s, i) => {
    const top = (s.adicionadas / max) * topHeight;
    const bottom = (s.removidas / max) * bottomHeight;
    return { x: one(i * slot + 1), largura: one(Math.max(1, slot - 4)), cima: { y: one(middle - top), altura: one(top) }, baixo: { y: middle, altura: one(bottom) } };
  });
}

/** Porcentagens (0 a 100) de partes de um total; total zero dá zeros. */
export function slices(parts) {
  const total = parts.reduce((s, n) => s + (n || 0), 0);
  return parts.map((n) => (total ? one(((n || 0) / total) * 100) : 0));
}

/** As linguagens com as `max` maiores e o resto somado em "Outras". */
export function languages(list, max = 4) {
  if (!list?.length) return [];
  const sorted = [...list].sort((a, b) => b.bytes - a.bytes);
  const total = sorted.reduce((s, l) => s + l.bytes, 0) || 1;
  const topLanguages = sorted.slice(0, max).map((l) => ({ nome: l.nome, pct: (l.bytes / total) * 100 }));
  const rest = sorted.slice(max).reduce((s, l) => s + l.bytes, 0);
  if (rest > 0) topLanguages.push({ nome: 'Outras', pct: (rest / total) * 100 });
  return topLanguages;
}

// ---------- o que a tela mostra ----------

/** O texto do estado `sem-github`, igual nas duas telas. */
export const NO_GITHUB = {
  titulo: 'O núcleo está sem o GitHub',
  texto: 'Rode gh auth login no terminal (instale o gh se faltar) e reinicie o núcleo sem --sem-github.',
};

export const COMPUTING = 'calculando…';

/** A lista tem dado: já veio do GitHub alguma vez ou tem grupos. */
export const hasList = (data) => Boolean(data && (data.atualizadoEm !== null || data.grupos?.length));
/** As métricas têm dado: o cabeçalho do repositório já veio. */
export const hasRepo = (data) => Boolean(data?.repo);

/**
 * O que a tela desenha a partir da última resposta (`dados`), da última falha de leitura (`falha`)
 * e de se há dado para mostrar (`temDado`, de `temLista` ou `temRepo`):
 *
 * - `tela`: `carregando` (a primeira leitura não voltou), `lendo` (o núcleo ainda lê o GitHub),
 *   `sem-github`, `nao-encontrado`, `erro`, `vazio` (pronto e sem nada) ou `dados`.
 * - `faixa`: com dado na tela, `conexao` (a leitura falhou) ou `github` (o núcleo mandou `erro`).
 * - `reler`: o núcleo ainda monta ou o GitHub ainda calcula; a tela relê em 5 s.
 */
export function screenState({ dados: data = null, falha: failure = null, temDado: hasData = false }) {
  if (!hasData) {
    if (failure) return { tela: 'erro', faixa: null, reler: false };
    if (!data) return { tela: 'carregando', faixa: null, reler: false };
    if (data.estado === 'sem-github' || data.estado === 'nao-encontrado' || data.estado === 'erro') return { tela: data.estado, faixa: null, reler: false };
    if (data.estado === 'carregando') return { tela: 'lendo', faixa: null, reler: true };
    return { tela: 'vazio', faixa: null, reler: false };
  }
  return {
    tela: 'dados',
    faixa: failure ? 'conexao' : data.erro ? 'github' : null,
    reler: data.estado === 'carregando' || Boolean(data.calculando?.length),
  };
}

/** O campo ainda vai chegar: o núcleo monta (`carregando`) ou o GitHub calcula (`calculando`). */
export const pending = (data, field) => data?.estado === 'carregando' || Boolean(data?.calculando?.includes(field));

/** O valor formatado, ou "calculando…" se pendente, ou "—". Número nenhum é inventado. */
export function valueOrPending(value, data, field, format = (v) => String(v)) {
  if (value !== null && value !== undefined) return { texto: format(value), pendente: false };
  const p = pending(data, field);
  return { texto: p ? COMPUTING : DASH, pendente: p };
}

/**
 * A mudança do Ao vivo que pede releitura: `repos`/`lista` sempre; nas métricas, também a chave do
 * repositório (`dono/repo`), comparada sem caixa.
 */
export function changeMatters(changes, key = null) {
  const mine = key ? key.toLowerCase() : null;
  return (changes ?? []).some((m) => m.tipo === 'repos' && (m.chave === 'lista' || (mine !== null && String(m.chave).toLowerCase() === mine)));
}

/** O card do fim das métricas: com escrita, `trafego` ("Tráfego e segurança"); sem, `comunidade`. */
export const trafficCardKind = (data) => (data?.escrita ? 'trafego' : 'comunidade');

/** Endereço do GitHub vindo do dado, só se for https em github.com; fora disso, `null` (sem link). */
export function githubUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com' ? url : null;
  } catch {
    return null;
  }
}

/** A resposta ainda vale: é do último pedido e do período que está na tela. */
export const currentResponse = ({ pedido: request, ultimo: last, periodo: period = null, periodoAtual: currentPeriod = null }) => request === last && period === currentPeriod;
