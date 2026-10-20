// Formatos, filtros e escalas das telas Repositórios (C22) e Repositório (C23). Sem DOM: o teste
// importa direto no node. Número nenhum é inventado: o que não veio sai como "—".

export const TRACO = '—';
/** O sinal de menos tipográfico, como no wireframe ("−21,5 k"). */
export const MENOS = '−';

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

const nf = (casas) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const NF0 = nf(0);
const NF1 = nf(1);

const vazio = (n) => n === null || n === undefined || !Number.isFinite(n);

/** "1.204". */
export function inteiro(n) {
  return vazio(n) ? TRACO : NF0.format(Math.round(n));
}

/** "1,6": uma casa decimal. */
export function decimal(n) {
  return vazio(n) ? TRACO : NF1.format(n);
}

/** "48,3 mil", "1,2 mi"; abaixo de mil, o número inteiro. Sem sinal. */
export function mil(n) {
  if (vazio(n)) return TRACO;
  const a = Math.abs(n);
  if (a >= 1e6) return `${NF1.format(a / 1e6)} mi`;
  if (a >= 1e3) return `${NF1.format(a / 1e3)} mil`;
  return NF0.format(Math.round(a));
}

/** "61,4 k" a partir de mil; abaixo, o inteiro ("212"). Sem sinal. */
export function kilo(n) {
  if (vazio(n)) return TRACO;
  const a = Math.abs(n);
  return a >= 1e3 ? `${NF1.format(a / 1e3)} k` : NF0.format(Math.round(a));
}

/** O número com "+" ou "−" na frente (zero fica sem sinal), no formato dado. */
export function comSinal(n, formato = inteiro) {
  if (vazio(n)) return TRACO;
  const texto = formato(Math.abs(n));
  return n > 0 ? `+${texto}` : n < 0 ? `${MENOS}${texto}` : texto;
}

/** De 0 a 1 em "94%". */
export function porcentagem(fatia) {
  return vazio(fatia) ? TRACO : `${Math.round(fatia * 100)}%`;
}

/** Duração em ms: "1 d 4 h", "3 h 12", "6 min", "< 1 min". */
export function duracao(ms) {
  if (vazio(ms) || ms < 0) return TRACO;
  if (ms >= DIA) {
    const d = Math.floor(ms / DIA);
    const h = Math.floor((ms % DIA) / HORA);
    return h ? `${d} d ${h} h` : `${d} d`;
  }
  if (ms >= HORA) {
    const h = Math.floor(ms / HORA);
    const m = Math.floor((ms % HORA) / MIN);
    return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
  }
  if (ms >= MIN) return `${Math.floor(ms / MIN)} min`;
  return '< 1 min';
}

/** Há quanto tempo, curto: "agora", "2 min", "1 h", "ontem", "2 dias", "3 meses", "1 ano". */
export function relativo(iso, agora = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return TRACO;
  const d = agora - t;
  if (d < MIN) return 'agora';
  if (d < HORA) return `${Math.floor(d / MIN)} min`;
  if (d < DIA) return `${Math.floor(d / HORA)} h`;
  const dias = Math.floor(d / DIA);
  if (dias === 1) return 'ontem';
  if (dias < 60) return `${dias} dias`;
  if (dias < 365) return `${Math.floor(dias / 30)} meses`;
  const anos = Math.floor(dias / 365);
  return anos === 1 ? '1 ano' : `${anos} anos`;
}

/** "há 6 dias" (release); "agora" e "ontem" ficam como estão. */
export function ha(iso, agora = Date.now()) {
  const r = relativo(iso, agora);
  return r === TRACO || r === 'agora' || r === 'ontem' ? r : `há ${r}`;
}

export const PERIODOS = [
  ['30d', '30 dias'],
  ['90d', '90 dias'],
  ['1a', '1 ano'],
];
export const PERIODO_PADRAO = '90d';

/** O período de `?periodo=`, ou o padrão se não veio ou é estranho. */
export function periodoDe(busca) {
  const p = new URLSearchParams(busca ?? '').get('periodo');
  return PERIODOS.some(([v]) => v === p) ? p : PERIODO_PADRAO;
}

export const rotuloDoPeriodo = (p) => (PERIODOS.find(([v]) => v === p) ?? PERIODOS[1])[1];

// ---------- a lista (C22) ----------

export const ORDENACOES = [
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
export const VISIBILIDADES = [
  ['todos', 'Todos'],
  ['com-sessoes', 'Com sessões'],
  ['publicos', 'Públicos'],
  ['privados', 'Privados'],
];

/** Sem acento e sem caixa, para a busca. */
export const semAcento = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

const temSessao = (r) => r.sessoes.ativas > 0 || r.sessoes.noMes > 0;
const VIS = {
  todos: () => true,
  'com-sessoes': temSessao,
  publicos: (r) => r.visibilidade === 'publico',
  privados: (r) => r.visibilidade === 'privado',
};

const porNome = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR');
const pushDe = (r) => (r.ultimoPush ? Date.parse(r.ultimoPush) || 0 : -Infinity);
const ORDEM = {
  recente: (a, b) => pushDe(b) - pushDe(a) || porNome(a, b),
  nome: porNome,
  issues: (a, b) => b.issuesAbertas - a.issuesAbertas || porNome(a, b),
  prs: (a, b) => b.prsAbertos - a.prsAbertos || porNome(a, b),
  sessoes: (a, b) => b.sessoes.ativas - a.sessoes.ativas || b.sessoes.noMes - a.sessoes.noMes || porNome(a, b),
};

/**
 * Os grupos depois da busca (nome ou `dono/nome`, sem acento nem caixa), da organização (`dono`,
 * vazio = todas), da visibilidade e da ordenação. Grupo que ficou sem repositório some; a ordem dos
 * grupos é a que veio do núcleo.
 */
export function filtrarRepos(grupos, { busca = '', dono = '', vis = 'todos', ordem = 'recente' } = {}) {
  const termo = semAcento(busca).trim();
  const passa = VIS[vis] ?? VIS.todos;
  const comparar = ORDEM[ordem] ?? ORDEM.recente;
  const saida = [];
  for (const g of grupos ?? []) {
    if (dono && g.dono !== dono) continue;
    const repos = g.repos.filter((r) => passa(r) && (!termo || semAcento(r.nome).includes(termo) || semAcento(r.completo).includes(termo))).sort(comparar);
    if (repos.length) saida.push({ ...g, repos });
  }
  return saida;
}

// ---------- escalas dos gráficos ----------

const um = (n) => Math.round(n * 10) / 10;

/** Os pontos da sparkline (`x,y x,y …`), ou `null` sem semanas: nada de linha inventada. */
export function sparkline(valores, largura = 90, altura = 22) {
  if (!valores?.length) return null;
  const max = Math.max(...valores) || 1;
  const passo = valores.length > 1 ? (largura - 2) / (valores.length - 1) : 0;
  return valores.map((n, i) => `${um(i * passo + 1)},${um(altura - 2 - (n / max) * (altura - 4))}`).join(' ');
}

/** Barras verticais de baixo para cima até `base`: `{ x, y, largura, altura }` por valor. */
export function barras(valores, largura = 520, base = 90) {
  if (!valores?.length) return [];
  const max = Math.max(...valores) || 1;
  const slot = largura / valores.length;
  return valores.map((n, i) => {
    const h = (n / max) * (base - 6);
    return { x: um(i * slot + 1), y: um(base - h), largura: um(Math.max(1, slot - 3)), altura: um(h) };
  });
}

/**
 * Frequência de código: adicionadas para cima e removidas para baixo de `meio`, na mesma escala.
 * `{ x, largura, cima: { y, altura }, baixo: { y, altura } }` por semana.
 */
export function frequencia(semanas, largura = 520, meio = 64, alturaCima = 58, alturaBaixo = 52) {
  if (!semanas?.length) return [];
  const max = Math.max(...semanas.map((s) => Math.max(s.adicionadas, s.removidas))) || 1;
  const slot = largura / semanas.length;
  return semanas.map((s, i) => {
    const cima = (s.adicionadas / max) * alturaCima;
    const baixo = (s.removidas / max) * alturaBaixo;
    return { x: um(i * slot + 1), largura: um(Math.max(1, slot - 4)), cima: { y: um(meio - cima), altura: um(cima) }, baixo: { y: meio, altura: um(baixo) } };
  });
}

/** Porcentagens (0 a 100) de partes de um total; total zero dá zeros. */
export function fatias(partes) {
  const total = partes.reduce((s, n) => s + (n || 0), 0);
  return partes.map((n) => (total ? um(((n || 0) / total) * 100) : 0));
}

/** As linguagens com as `max` maiores e o resto somado em "Outras". */
export function linguagens(lista, max = 4) {
  if (!lista?.length) return [];
  const ordenadas = [...lista].sort((a, b) => b.bytes - a.bytes);
  const total = ordenadas.reduce((s, l) => s + l.bytes, 0) || 1;
  const topo = ordenadas.slice(0, max).map((l) => ({ nome: l.nome, pct: (l.bytes / total) * 100 }));
  const resto = ordenadas.slice(max).reduce((s, l) => s + l.bytes, 0);
  if (resto > 0) topo.push({ nome: 'Outras', pct: (resto / total) * 100 });
  return topo;
}
