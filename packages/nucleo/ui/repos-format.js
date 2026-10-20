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

const empty = (n) => n === null || n === undefined || !Number.isFinite(n);

/** "1.204". */
export function inteiro(n) {
  return empty(n) ? TRACO : NF0.format(Math.round(n));
}

/** "1,6": uma casa decimal. */
export function decimal(n) {
  return empty(n) ? TRACO : NF1.format(n);
}

/** "48,3 mil", "1,2 mi"; abaixo de mil, o número inteiro. Sem sinal. Arredonda antes de escolher a
 * escala: 999,6 é "1,0 mil", não "1.000"; e só vira "mi" quando "mil" daria "1.000,0 mil". */
export function mil(n) {
  if (empty(n)) return TRACO;
  const a = Math.abs(n);
  if (Math.round(a / 100) >= 1e4) return `${NF1.format(a / 1e6)} mi`;
  if (Math.round(a) >= 1e3) return `${NF1.format(a / 1e3)} mil`;
  return NF0.format(Math.round(a));
}

/** "61,4 k" a partir de mil (arredondado: 999,6 é "1,0 k"); abaixo, o inteiro ("212"). Sem sinal. */
export function kilo(n) {
  if (empty(n)) return TRACO;
  const a = Math.abs(n);
  return Math.round(a) >= 1e3 ? `${NF1.format(a / 1e3)} k` : NF0.format(Math.round(a));
}

/** O número com "+" ou "−" na frente (zero fica sem sinal), no formato dado. */
export function comSinal(n, formato = inteiro) {
  if (empty(n)) return TRACO;
  const texto = formato(Math.abs(n));
  return n > 0 ? `+${texto}` : n < 0 ? `${MENOS}${texto}` : texto;
}

/** De 0 a 1 em "94%". */
export function porcentagem(fatia) {
  return empty(fatia) ? TRACO : `${Math.round(fatia * 100)}%`;
}

/** Duração em ms: "1 d 4 h", "3 h 12", "6 min", "< 1 min". */
export function duracao(ms) {
  if (empty(ms) || ms < 0) return TRACO;
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

/** The period of `?period=` (`1y` in the URL is `1a`, the API value), or the default when it is missing or odd. */
export function periodoDe(busca) {
  const q = new URLSearchParams(busca ?? '').get('period');
  const p = q === '1y' ? '1a' : q;
  return PERIODOS.some(([v]) => v === p) ? p : PERIODO_PADRAO;
}

/** The period as the URL writes it: `1y` for the year, the others as they are. */
export const periodInUrl = (p) => (p === '1a' ? '1y' : p);

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

// ---------- o que a tela mostra ----------

/** O texto do estado `sem-github`, igual nas duas telas. */
export const SEM_GITHUB = {
  titulo: 'O núcleo está sem o GitHub',
  texto: 'Rode gh auth login no terminal (instale o gh se faltar) e reinicie o núcleo sem --sem-github.',
};

export const CALCULANDO = 'calculando…';

/** A lista tem dado: já veio do GitHub alguma vez ou tem grupos. */
export const temLista = (dados) => Boolean(dados && (dados.atualizadoEm !== null || dados.grupos?.length));
/** As métricas têm dado: o cabeçalho do repositório já veio. */
export const temRepo = (dados) => Boolean(dados?.repo);

/**
 * O que a tela desenha a partir da última resposta (`dados`), da última falha de leitura (`falha`)
 * e de se há dado para mostrar (`temDado`, de `temLista` ou `temRepo`):
 *
 * - `tela`: `carregando` (a primeira leitura não voltou), `lendo` (o núcleo ainda lê o GitHub),
 *   `sem-github`, `nao-encontrado`, `erro`, `vazio` (pronto e sem nada) ou `dados`.
 * - `faixa`: com dado na tela, `conexao` (a leitura falhou) ou `github` (o núcleo mandou `erro`).
 * - `reler`: o núcleo ainda monta ou o GitHub ainda calcula; a tela relê em 5 s.
 */
export function estadoDaTela({ dados = null, falha = null, temDado = false }) {
  if (!temDado) {
    if (falha) return { tela: 'erro', faixa: null, reler: false };
    if (!dados) return { tela: 'carregando', faixa: null, reler: false };
    if (dados.estado === 'sem-github' || dados.estado === 'nao-encontrado' || dados.estado === 'erro') return { tela: dados.estado, faixa: null, reler: false };
    if (dados.estado === 'carregando') return { tela: 'lendo', faixa: null, reler: true };
    return { tela: 'vazio', faixa: null, reler: false };
  }
  return {
    tela: 'dados',
    faixa: falha ? 'conexao' : dados.erro ? 'github' : null,
    reler: dados.estado === 'carregando' || Boolean(dados.calculando?.length),
  };
}

/** O campo ainda vai chegar: o núcleo monta (`carregando`) ou o GitHub calcula (`calculando`). */
export const pendente = (dados, campo) => dados?.estado === 'carregando' || Boolean(dados?.calculando?.includes(campo));

/** O valor formatado, ou "calculando…" se pendente, ou "—". Número nenhum é inventado. */
export function valorOuPendente(valor, dados, campo, formatar = (v) => String(v)) {
  if (valor !== null && valor !== undefined) return { texto: formatar(valor), pendente: false };
  const p = pendente(dados, campo);
  return { texto: p ? CALCULANDO : TRACO, pendente: p };
}

/**
 * A mudança do Ao vivo que pede releitura: `repos`/`lista` sempre; nas métricas, também a chave do
 * repositório (`dono/repo`), comparada sem caixa.
 */
export function mudancaInteressa(mudancas, chave = null) {
  const minha = chave ? chave.toLowerCase() : null;
  return (mudancas ?? []).some((m) => m.tipo === 'repos' && (m.chave === 'lista' || (minha !== null && String(m.chave).toLowerCase() === minha)));
}

/** O card do fim das métricas: com escrita, `trafego` ("Tráfego e segurança"); sem, `comunidade`. */
export const cardDeTrafego = (dados) => (dados?.escrita ? 'trafego' : 'comunidade');

/** Endereço do GitHub vindo do dado, só se for https em github.com; fora disso, `null` (sem link). */
export function urlDoGithub(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com' ? url : null;
  } catch {
    return null;
  }
}

/** A resposta ainda vale: é do último pedido e do período que está na tela. */
export const respostaAtual = ({ pedido, ultimo, periodo = null, periodoAtual = null }) => pedido === ultimo && periodo === periodoAtual;
