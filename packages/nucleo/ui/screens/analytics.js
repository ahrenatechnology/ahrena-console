// A tela Analytics (#95 e #32, C12 e C13): a Visão geral em /ui/analytics e o Custo em
// /ui/analytics/cost. The two tabs are the same screen; the tab comes from `ctx.params.tab`.
//
// - Lê `GET /api/analytics?tz=` (Visão geral) e `GET /api/analytics/cost?days=&tz=` (Custo),
//   sempre por `ctx.ler`, com o fuso do navegador.
// - Ao vivo: uma mudança relê depois de alguns segundos (uma releitura por rajada); reiniciar relê já.
// - Os gráficos são SVG desenhado aqui, sem biblioteca. Tamanho e posição são atributos SVG; cor só
//   por classe (analytics.css), com as variáveis de marca.css.
// - Custo é estimativa: `usd: null` quer dizer "sem preço" (modelo fora da tabela), nunca US$ 0.
// - Com mais de uma conta, o custo leva a divisão por conta ao lado (decisão 0006).

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../states.js';

export const ROTA_DA_VISAO = '/api/analytics';
export const ROTA_DO_CUSTO = '/api/analytics/cost';
export const PERIODOS = [7, 30, 90];
const ESTILO = '/ui/analytics.css';
const RELER_MS = 4000;

const SUB_VISAO = 'Uso, custo e produtividade das sessões';
const SUB_CUSTO = 'Custo estimado pelo transcript, com o preço de cada modelo';

// ---------- Formatação (pt-BR) ----------

const inteiro = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const umaCasa = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const duasCasas = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** 412, 1.086, 48,1 mil, 2,1 mi, 1,9 B. */
export function quantidade(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a < 10_000) return inteiro.format(n);
  if (a < 1e6) return `${umaCasa.format(n / 1e3)} mil`;
  if (a < 1e9) return `${umaCasa.format(n / 1e6)} mi`;
  return `${umaCasa.format(n / 1e9)} B`;
}

/** Custo estimado: "~US$ 12,40"; `curto` arredonda de 100 para cima ("~US$ 341"); `null` é "sem preço". */
export function usd(v, { curto = false } = {}) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'sem preço';
  if (curto && Math.abs(v) >= 100) return `~US$ ${inteiro.format(v)}`;
  return `~US$ ${duasCasas.format(v)}`;
}

/** "71%"; sem dado, traço. */
export function porcento(p) {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  return p > 0 && p < 1 ? '<1%' : `${inteiro.format(p)}%`;
}

/** "2026-10-13" vira "13 out". */
export function dataCurta(dia) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia ?? '');
  return m ? `${Number(m[3])} ${MESES[Number(m[2]) - 1]}` : String(dia ?? '');
}

/** Tokens em milhões, como no C12: 1180, 4,2, 0,3. */
export function milhoes(tokens) {
  const m = tokens / 1e6;
  return m >= 10 ? inteiro.format(m) : umaCasa.format(m);
}

const FAMILIAS = ['opus', 'sonnet', 'haiku', 'fable'];
const nomeDaFamilia = (f) => f[0].toUpperCase() + f.slice(1);

/** O nome amigável do modelo: claude-opus-5-5 vira "Opus 5.5". Se não reconhecer, o id como veio. */
export function nomeDoModelo(id) {
  if (id === null || id === undefined) return null;
  const limpo = String(id).replace(/\[1m\]$/, '');
  let m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(limpo);
  if (m && FAMILIAS.includes(m[1])) return `${nomeDaFamilia(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  m = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(limpo);
  if (m && FAMILIAS.includes(m[3])) return `${nomeDaFamilia(m[3])} ${m[1]}${m[2] ? `.${m[2]}` : ''}`;
  return String(id);
}

/** A cor de um modelo segue a família, não a posição: a mesma nas duas abas. */
export function classeDoModelo(id) {
  const s = String(id ?? '');
  if (/opus/.test(s)) return 'an-m0';
  if (/sonnet/.test(s)) return 'an-m1';
  if (/haiku/.test(s)) return 'an-m2';
  return 'an-m3';
}

const plural = (n, um, varios) => `${inteiro.format(n)} ${n === 1 ? um : varios}`;

// ---------- Cor da conta ----------

// A cor da conta chega como valor; aqui ela só vira classe quando é uma das cores da marca que o
// núcleo dá às contas (perfis/cores.ts). Uma cor própria fora da paleta fica só com o rótulo.
const CORES_DAS_CONTAS = { 'an-conta-rosa': '--rose-500', 'an-conta-verde': '--green-500', 'an-conta-amarela': '--yellow-500', 'an-conta-cinza': '--gray-200' };

export function classeDaConta(cor) {
  if (typeof cor !== 'string' || typeof getComputedStyle !== 'function') return null;
  let estilo;
  try {
    estilo = getComputedStyle(document.documentElement);
  } catch {
    return null;
  }
  const alvo = cor.trim().toLowerCase();
  for (const [classe, variavel] of Object.entries(CORES_DAS_CONTAS)) if (estilo.getPropertyValue(variavel).trim().toLowerCase() === alvo) return classe;
  return null;
}

function divisaoPorConta(linhas) {
  return el(
    'ul',
    { class: 'an-contas', 'aria-label': 'Divisão por conta' },
    ...linhas.map((l) => {
      const classe = classeDaConta(l.cor);
      // Com preço só para parte dos modelos, o valor é parcial: a dica diz quais ficaram de fora.
      const parcial = l.usd !== null && l.usd !== undefined && (l.semPreco ?? []).length > 0;
      return el(
        'li',
        { 'data-conta': l.conta ?? 'sem-conta', title: parcial ? `Parcial: sem preço para ${l.semPreco.map(nomeDoModelo).join(', ')}` : null },
        el('span', { class: classe ? `an-ponto ${classe}` : 'an-ponto', 'aria-hidden': 'true' }),
        el('span', { class: 'an-trunc' }, l.rotulo),
        el('b', {}, usd(l.usd), parcial ? el('span', { class: 'an-parcial' }, ' · parcial') : null),
      );
    }),
  );
}

/** As linhas da divisão por conta do C12, ou `null` com uma conta só. */
export function contasDaVisao(dados) {
  const contas = dados?.contas ?? [];
  const por = dados?.numeros?.custo?.porConta ?? [];
  if (contas.length < 2 || por.length < 2) return null;
  return por.map((p) => {
    const c = contas.find((x) => x.id === p.conta);
    return { conta: p.conta, rotulo: c?.rotulo ?? 'Sem conta', cor: c?.cor ?? null, usd: p.usd, semPreco: p.semPreco ?? [] };
  });
}

/** As linhas da divisão por conta do C13 (do período, ou de hoje com `por`), ou `null` com uma conta só. */
export function contasDoCusto(dados, por = dados?.porConta ?? []) {
  if ((dados?.contas ?? []).length < 2 || (por ?? []).length < 2) return null;
  return por.map((p) => ({ conta: p.conta, rotulo: p.rotulo ?? 'Sem conta', cor: p.cor ?? null, usd: p.usd, semPreco: p.semPreco ?? [] }));
}

// ---------- SVG ----------

const NS = 'http://www.w3.org/2000/svg';

function svg(tag, atributos = {}, ...filhos) {
  const no = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(atributos)) if (v !== null && v !== undefined && v !== false) no.setAttribute(k, String(v));
  for (const f of filhos.flat()) {
    if (f === null || f === undefined || f === false) continue;
    no.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return no;
}
const dica = (texto) => svg('title', {}, texto);
const r1 = (n) => Math.round(n * 10) / 10;

/** Uma barra horizontal: o trilho (CSS) e a parte cheia, um SVG com a largura em % por atributo
 *  (sem estilo inline) e as pontas redondas em px. */
function barra(pct, classe = 'an-m0', texto = null) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return el(
    'div',
    { class: 'an-barra' },
    p > 0 ? svg('svg', { width: `${r1(Math.max(p, 1.5))}%`, height: 6, 'aria-hidden': 'true' }, svg('rect', { class: `an-cheia ${classe}`, width: '100%', height: '100%', rx: 3 }, texto ? dica(texto) : null)) : null,
  );
}

/** Heatmap de atividade: uma célula por dia, colunas por semana, linhas de seg a dom. */
export function heatmap(dias) {
  const PASSO = 13;
  const CEL = 10;
  const ESQ = 30;
  const TOPO = 14;
  const dow = (dia) => (new Date(`${dia}T00:00:00Z`).getUTCDay() + 6) % 7;
  const desloc = dias.length ? dow(dias[0].dia) : 0;
  const colunas = Math.max(1, Math.ceil((dias.length + desloc) / 7));
  const max = Math.max(0, ...dias.map((d) => d.eventos ?? 0));
  const nivel = (v) => (v > 0 && max > 0 ? Math.min(4, Math.max(1, Math.ceil((v / max) * 4))) : 0);
  const filhos = [];
  let ultimaColunaComMes = -10;
  dias.forEach((d, i) => {
    const p = i + desloc;
    const col = Math.floor(p / 7);
    if (d.dia.slice(8) === '01' && col - ultimaColunaComMes >= 3) {
      filhos.push(svg('text', { x: ESQ + col * PASSO, y: 9 }, MESES[Number(d.dia.slice(5, 7)) - 1]));
      ultimaColunaComMes = col;
    }
  });
  ['seg', 'qua', 'sex'].forEach((n, i) => filhos.push(svg('text', { x: 0, y: TOPO + i * 2 * PASSO + 8 }, n)));
  dias.forEach((d, i) => {
    const p = i + desloc;
    filhos.push(
      svg('rect', { class: `an-cel an-n${nivel(d.eventos)}`, x: ESQ + Math.floor(p / 7) * PASSO, y: TOPO + (p % 7) * PASSO, width: CEL, height: CEL, rx: 2 }, dica(`${dataCurta(d.dia)}: ${plural(d.eventos ?? 0, 'evento', 'eventos')}`)),
    );
  });
  return [
    svg('svg', { class: 'an-graf', viewBox: `0 0 ${ESQ + colunas * PASSO} ${TOPO + 7 * PASSO}`, role: 'img', 'aria-label': `Eventos por dia nas últimas ${Math.round(dias.length / 7)} semanas` }, filhos),
    el('div', { class: 'an-leg' }, el('span', {}, 'menos'), ...[0, 1, 2, 3, 4].map((n) => el('span', { class: `an-amostra an-n${n}`, 'aria-hidden': 'true' })), el('span', {}, 'mais')),
  ];
}

/** Colunas dos últimos 30 dias, sessões por dia; o dia de hoje em destaque. A altura vem do CSS
 *  (o SVG estica sem manter a proporção), por isso as datas das pontas ficam fora dele, em HTML. */
export function barras30(dias) {
  const W = 300;
  const H = 100;
  const passo = W / Math.max(1, dias.length);
  const largura = r1(passo * 0.7);
  const max = Math.max(1, ...dias.map((d) => d.sessoes ?? 0));
  const filhos = dias.map((d, i) => {
    const h = r1(((d.sessoes ?? 0) / max) * (H - 4));
    return svg('rect', { class: `an-col${i === dias.length - 1 ? ' an-atual' : ''}`, x: r1(i * passo), y: r1(H - h), width: largura, height: h }, dica(`${dataCurta(d.dia)}: ${plural(d.sessoes ?? 0, 'sessão', 'sessões')}`));
  });
  filhos.push(svg('line', { class: 'an-eixo', x1: 0, x2: W, y1: H, y2: H, 'vector-effect': 'non-scaling-stroke' }));
  return [
    svg('svg', { class: 'an-graf an-colunas', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Sessões por dia nos últimos 30 dias' }, filhos),
    dias.length ? el('div', { class: 'an-leg an-pontas an-datas' }, el('span', {}, dataCurta(dias[0].dia)), el('span', {}, dataCurta(dias.at(-1).dia))) : null,
  ];
}

/** O topo "redondo" do eixo: 20 para um pico de 18,40. */
export function topoDoEixo(v) {
  if (!(v > 0)) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 4, 5, 10]) if (m * e >= v) return m * e;
  return 10 * e;
}

/** Custo por dia: linha com área, eixo em US$; um dia sem preço interrompe a linha. */
export function linhaDoCusto(porDia) {
  const W = 600;
  const H = 170;
  const P = 30;
  const n = porDia.length;
  const max = topoDoEixo(Math.max(0, ...porDia.map((d) => d.usd ?? 0)));
  const x = (i) => r1(n > 1 ? P + (i * (W - P - 10)) / (n - 1) : (P + W - 10) / 2);
  const y = (v) => r1(H - 20 - (v / max) * (H - 36));
  const filhos = [];
  for (let t = 0; t <= 4; t++) {
    const v = (max / 4) * t;
    filhos.push(svg('line', { class: 'an-grade', x1: P, x2: W - 10, y1: y(v), y2: y(v) }), svg('text', { x: P - 6, y: y(v) + 3, 'text-anchor': 'end' }, umaCasa.format(v)));
  }
  // Trechos contínuos com preço.
  let trecho = [];
  const trechos = [];
  porDia.forEach((d, i) => {
    if (d.usd === null || d.usd === undefined) {
      if (trecho.length) trechos.push(trecho);
      trecho = [];
    } else trecho.push([x(i), y(d.usd)]);
  });
  if (trecho.length) trechos.push(trecho);
  for (const t of trechos) {
    const pts = t.map(([a, b]) => `${a},${b}`).join(' ');
    filhos.push(svg('polygon', { class: 'an-area', points: `${t[0][0]},${y(0)} ${pts} ${t.at(-1)[0]},${y(0)}` }), svg('polyline', { class: 'an-linha', points: pts }));
  }
  const fim = trechos.at(-1)?.at(-1);
  if (fim) filhos.push(svg('circle', { class: 'an-ponta', cx: fim[0], cy: fim[1], r: 4 }));
  // Alvos de passar o mouse, um por dia, maiores que a linha.
  const meio = n > 1 ? (W - P - 10) / (n - 1) / 2 : 10;
  porDia.forEach((d, i) => filhos.push(svg('rect', { class: 'an-alvo', x: r1(x(i) - meio), y: 8, width: r1(meio * 2), height: H - 28 }, dica(`${dataCurta(d.dia)}: ${usd(d.usd)}`))));
  if (n) filhos.push(svg('text', { x: P, y: H - 4 }, dataCurta(porDia[0].dia)), svg('text', { x: W - 10, y: H - 4, 'text-anchor': 'end' }, dataCurta(porDia.at(-1).dia)));
  return svg('svg', { class: 'an-graf', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Custo estimado por dia, em dólares' }, filhos);
}

/** As fatias da rosca: até quatro modelos com preço; o resto vira "Outros". */
export function fatiasPorModelo(porModelo) {
  const com = porModelo.filter((m) => m.usd !== null && m.usd !== undefined);
  const sem = porModelo.filter((m) => m.usd === null || m.usd === undefined);
  const fatias = com.slice(0, com.length > 4 ? 3 : 4).map((m) => ({ nome: nomeDoModelo(m.modelo), classe: classeDoModelo(m.modelo), usd: m.usd, pct: m.pct }));
  if (com.length > 4) {
    const resto = com.slice(3);
    fatias.push({ nome: `Outros (${resto.length})`, classe: 'an-outros', usd: resto.reduce((s, m) => s + m.usd, 0), pct: resto.reduce((s, m) => s + (m.pct ?? 0), 0) });
  }
  return [...fatias, ...sem.map((m) => ({ nome: nomeDoModelo(m.modelo), classe: null, usd: null, pct: null }))];
}

function rosca(porModelo, total, dias) {
  const R = 52;
  const C = 2 * Math.PI * R;
  const fatias = fatiasPorModelo(porModelo);
  let a = 0;
  const arcos = fatias
    .filter((f) => f.pct > 0)
    .map((f) => {
      const comprimento = (C * f.pct) / 100;
      const arco = svg('circle', { class: `an-fatia ${f.classe}`, cx: 70, cy: 70, r: R, 'stroke-dasharray': `${r1(Math.max(0, comprimento - 2))} ${r1(C)}`, 'stroke-dashoffset': r1((-C * a) / 100), transform: 'rotate(-90 70 70)' }, dica(`${f.nome}: ${usd(f.usd)} (${porcento(f.pct)})`));
      a += f.pct;
      return arco;
    });
  return el(
    'div',
    { class: 'an-rosca' },
    svg(
      'svg',
      { class: 'an-graf', width: 140, height: 140, viewBox: '0 0 140 140', role: 'img', 'aria-label': `Custo por modelo nos últimos ${dias} dias` },
      svg('circle', { class: 'an-fundo', cx: 70, cy: 70, r: R }),
      arcos,
      svg('text', { class: 'an-centro', x: 70, y: 68, 'text-anchor': 'middle' }, usd(total, { curto: true })),
      svg('text', { x: 70, y: 84, 'text-anchor': 'middle' }, `${dias} dias`),
    ),
    el(
      'ul',
      { class: 'an-legenda' },
      ...fatias.map((f) => el('li', {}, f.classe ? el('span', { class: `an-ponto ${f.classe}`, 'aria-hidden': 'true' }) : el('span', { class: 'an-ponto an-vazio', 'aria-hidden': 'true' }), el('span', { class: 'an-trunc' }, f.nome), el('span', { class: 'an-q' }, f.pct === null ? 'sem preço' : porcento(f.pct)))),
    ),
  );
}

// ---------- Peças ----------

function stat({ id, rotulo, valor, sub, icone: nome, cor, contas = null, dica: titulo = null }) {
  return el(
    'div',
    { class: 'cartao an-stat', 'data-card': id, title: titulo },
    el('span', { class: 'an-rot' }, rotulo),
    el('span', { class: `an-ic an-cor-${cor}` }, icone(nome)),
    el('span', { class: 'an-v' }, valor),
    el('span', { class: 'an-s' }, sub),
    contas ? divisaoPorConta(contas) : null,
  );
}

function cartao(titulo, direita, ...corpo) {
  return el('section', { class: 'cartao an-cartao' }, el('div', { class: 'an-ttl' }, el('h2', {}, titulo), direita ? el('span', { class: 'an-r' }, direita) : null), ...corpo);
}

function lista(linhas, vazioTexto) {
  if (!linhas.length) return el('p', { class: 'an-nada' }, vazioTexto);
  const max = Math.max(...linhas.map((l) => l.valor ?? 0), 0) || 1;
  return el(
    'ul',
    { class: 'an-lista' },
    ...linhas.map((l) => el('li', { class: 'an-linha-lista' }, el('span', { class: 'an-n an-trunc', title: l.nomeLongo ?? l.nome }, l.nome), barra(((l.valor ?? 0) / max) * 100, l.classe, l.dica), el('span', { class: 'an-q' }, l.texto))),
  );
}

function abas(atual) {
  const aba = (id, rotulo, href) => el('a', { href, class: atual === id ? 'an-on' : null, 'aria-current': atual === id ? 'page' : null }, rotulo);
  return el('nav', { class: 'an-seg an-abas', 'aria-label': 'Abas do Analytics' }, aba('visao', 'Visão geral', '/ui/analytics'), aba('custo', 'Custo', '/ui/analytics/cost'));
}

function rodape(esquerda, direita) {
  return el('div', { class: 'an-leg an-pontas' }, el('span', {}, ...esquerda), el('span', {}, ...direita));
}

// ---------- Visão geral (C12) ----------

export function telaDaVisao(d) {
  const n = d.numeros;
  const semPreco = n.custo.semPreco ?? [];
  const u30 = d.ultimos30 ?? { dias: [], pico: null, total: 0 };
  return [
    el(
      'div',
      { class: 'an-stats an-cinco' },
      stat({ id: 'sessoes', rotulo: 'Sessões', valor: quantidade(n.sessoes.total), sub: plural(n.sessoes.ativas, 'ativa', 'ativas'), icone: 'sessoes', cor: 'acento' }),
      stat({ id: 'agentes', rotulo: 'Agentes', valor: quantidade(n.agentes.total), sub: plural(n.agentes.ativos, 'ativo', 'ativos'), icone: 'an-bot', cor: 'ativa' }),
      stat({ id: 'tokens', rotulo: 'Tokens', valor: quantidade(n.tokens.total), sub: n.tokens.cachePct === null ? 'cache sem dado' : `${porcento(n.tokens.cachePct)} de cache`, icone: 'porta', cor: 'acento' }),
      stat({
        id: 'custo',
        rotulo: 'Custo',
        valor: usd(n.custo.usd, { curto: true }),
        sub: `estimativa · ${n.custo.dias ?? 30} dias${semPreco.length ? ` · ${plural(semPreco.length, 'modelo', 'modelos')} sem preço` : ''}`,
        icone: 'an-dolar',
        cor: 'concluida',
        contas: contasDaVisao(d),
      }),
      stat({ id: 'eventos', rotulo: 'Eventos', valor: quantidade(n.eventos.total), sub: n.eventos.porSessao === null ? 'por sessão: —' : `~${quantidade(Math.round(n.eventos.porSessao))} por sessão`, icone: 'an-raio', cor: 'esperando' }),
    ),
    abas('visao'),
    el(
      'div',
      { class: 'an-grade-2 an-larga' },
      cartao(`Atividade · últimas ${d.atividade?.semanas ?? 52} semanas`, 'eventos por dia', ...heatmap(d.atividade?.dias ?? [])),
      cartao(
        'Últimos 30 dias',
        'sessões por dia',
        ...barras30(u30.dias),
        rodape(u30.pico ? ['Pico ', el('b', {}, inteiro.format(u30.pico.sessoes)), ` em ${dataCurta(u30.pico.dia)}`] : ['Sem sessões no período'], ['Total ', el('b', {}, inteiro.format(u30.total ?? 0))]),
      ),
    ),
    el(
      'div',
      { class: 'an-grade-3' },
      cartao(
        'Tokens por modelo',
        'milhões',
        lista(
          (d.tokensPorModelo ?? []).map((m) => ({ nome: nomeDoModelo(m.modelo), nomeLongo: m.modelo, valor: m.tokens, texto: milhoes(m.tokens), classe: classeDoModelo(m.modelo), dica: `${nomeDoModelo(m.modelo)}: ${quantidade(m.tokens)} tokens` })),
          'Nenhum token no período.',
        ),
      ),
      cartao(
        'Ferramentas',
        '30 dias',
        lista(
          (d.ferramentas ?? []).slice(0, 5).map((f) => ({ nome: f.nome, valor: f.usos, texto: inteiro.format(f.usos), dica: `${f.nome}: ${plural(f.usos, 'uso', 'usos')}` })),
          'Nenhuma ferramenta usada no período.',
        ),
      ),
      cartao(
        'Por dia da semana',
        'sessões',
        lista(
          (d.diaDaSemana ?? []).map((s) => ({ nome: rotuloDoDia(s.dia), valor: s.sessoes, texto: inteiro.format(s.sessoes), dica: `${rotuloDoDia(s.dia)}: ${plural(s.sessoes, 'sessão', 'sessões')}` })),
          'Nenhuma sessão ainda.',
        ),
      ),
    ),
  ];
}

// ---------- Custo (C13) ----------

/** O custo de hoje: `resumoDeHoje` (`hoje` é o dia, "AAAA-MM-DD"). */
const custoDeHoje = (d) => d.resumoDeHoje ?? { usd: null, sessoes: 0 };

export function telaDoCusto(d) {
  const hoje = custoDeHoje(d);
  const semPreco = d.semPreco?.modelos ?? [];
  const max = Math.max(0, ...(d.porProjeto ?? []).map((p) => p.usd ?? 0)) || 1;
  return [
    abas('custo'),
    el(
      'div',
      { class: 'an-stats an-quatro' },
      stat({ id: 'hoje', rotulo: 'Hoje', valor: usd(hoje.usd), sub: plural(hoje.sessoes ?? 0, 'sessão', 'sessões'), icone: 'an-dolar', cor: 'concluida', contas: contasDoCusto(d, hoje.porConta) }),
      stat({
        id: 'periodo',
        rotulo: `${d.dias} dias`,
        valor: usd(d.periodo?.usd, { curto: true }),
        sub: d.periodo?.mediaPorDia === null || d.periodo?.mediaPorDia === undefined ? 'média: sem preço' : `média ${usd(d.periodo.mediaPorDia)} por dia`,
        icone: 'an-calendario',
        cor: 'acento',
        contas: contasDoCusto(d),
      }),
      stat({ id: 'cache', rotulo: 'Cache', valor: porcento(d.cache?.pct), sub: 'dos tokens de entrada', icone: 'an-camadas', cor: 'acento' }),
      stat({
        id: 'sem-preco',
        rotulo: 'Sem preço',
        valor: inteiro.format(semPreco.length),
        sub: semPreco.length === 1 ? 'modelo sem tabela' : 'modelos sem tabela',
        icone: 'an-alerta',
        cor: semPreco.length ? 'esperando' : 'apagada',
        dica: semPreco.length ? `Sem tabela de preço: ${semPreco.map(nomeDoModelo).join(', ')}` : 'Todos os modelos têm preço',
      }),
    ),
    el(
      'div',
      { class: 'an-grade-2 an-media' },
      cartao(
        'Custo por dia',
        'US$',
        linhaDoCusto(d.porDia ?? []),
        rodape(d.pico ? ['Pico ', el('b', {}, usd(d.pico.usd)), ` em ${dataCurta(d.pico.dia)}`] : ['Sem custo no período'], ['Total ', el('b', {}, usd(d.periodo?.usd, { curto: true }))]),
      ),
      cartao('Por modelo', null, rosca(d.porModelo ?? [], d.periodo?.usd, d.dias)),
    ),
    cartao(
      'Por projeto',
      `${d.dias} dias`,
      (d.porProjeto ?? []).length
        ? el(
            'ul',
            { class: 'an-lista an-projetos' },
            ...d.porProjeto.map((p) => el('li', { class: 'an-linha-lista' }, el('span', { class: 'an-n an-trunc', title: p.projeto }, p.projeto), barra(((p.usd ?? 0) / max) * 100, 'an-m0', `${p.projeto}: ${usd(p.usd)}`), el('span', { class: 'an-q' }, usd(p.usd)))),
          )
        : el('p', { class: 'an-nada' }, 'Nenhum projeto com custo no período.'),
    ),
  ];
}

// ---------- Exportar ----------

/** Baixa o JSON já lido (o que está na tela), sem ir ao núcleo de novo. */
export function nomeDoArquivo(aba, dados, dias) {
  const dia = typeof dados?.ate === 'string' ? dados.ate : typeof dados?.hoje === 'string' ? dados.hoje : 'hoje';
  return aba === 'custo' ? `ahrena-analytics-custo-${dias}d-${dia}.json` : `ahrena-analytics-${dia}.json`;
}

function baixar(nome, dados) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' }));
  el('a', { href: url, download: nome }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- A tela ----------

function carregarEstilo() {
  if (typeof document.querySelector === 'function' && document.querySelector(`link[href="${ESTILO}"]`)) return;
  document.head?.append(el('link', { rel: 'stylesheet', href: ESTILO }));
}

function fusoDoNavegador() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function horaDe(iso, fuso) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return null;
  try {
    return new Date(t).toLocaleTimeString('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return null;
  }
}

/** O dia da semana como a tela escreve: a API manda `sab`, a tela mostra `sáb`. */
const rotuloDoDia = (dia) => (dia === 'sab' ? 'sáb' : dia);

export async function montar(area, ctx, { releituraMs = RELER_MS } = {}) {
  carregarEstilo();
  const pedida = ctx.params?.tab;
  const aba = pedida === undefined ? 'visao' : pedida === 'cost' ? 'custo' : null;
  const sub = aba === 'custo' ? SUB_CUSTO : SUB_VISAO;
  const fuso = fusoDoNavegador();
  let dias = 30;
  let ultimo = null; // a última resposta, para exportar e para manter a tela numa releitura que falha
  let nos = null;
  let vez = 0;
  let espera = null;

  const cab = (acoes = []) => {
    const c = cabecalho({ icone: 'analytics', titulo: 'Analytics', sub, acoes });
    c.setAttribute('class', 'cc-cab an-cab'); // an-cab: as ações descem numa janela estreita
    return c;
  };

  if (!aba) {
    ctx.titulo?.('Analytics');
    area.replaceChildren(cab(), vazio({ titulo: 'Aba não encontrada', texto: `O Analytics não tem a aba "${pedida}".`, acao: { rotulo: 'Ir para a Visão geral', aoClicar: () => ctx.navegar('/ui/analytics') } }));
    return () => {};
  }
  ctx.titulo?.(aba === 'custo' ? 'Analytics · Custo' : 'Analytics');

  const botaoExportar = () =>
    el('button', { type: 'button', class: 'btn', title: 'Baixar o JSON do que está na tela', aoClicar: () => ultimo && baixar(nomeDoArquivo(aba, ultimo, dias), ultimo) }, icone('an-baixar'), 'Exportar');

  function seletor() {
    return el(
      'div',
      { class: 'an-seg', role: 'group', 'aria-label': 'Período' },
      ...PERIODOS.map((p) =>
        el('button', { type: 'button', 'aria-pressed': p === dias ? 'true' : 'false', 'data-dias': p, aoClicar: () => p !== dias && ((dias = p), desenhar()) }, `${p} dias`),
      ),
    );
  }

  function acoes(dados) {
    if (aba === 'custo') return [seletor(), botaoExportar()];
    const hora = horaDe(dados?.geradoEm, fuso);
    return [hora ? el('span', { class: 'an-chip', title: 'Hora em que o núcleo calculou estes números' }, icone('an-relogio'), hora) : null, botaoExportar()].filter(Boolean);
  }

  function semNada(dados) {
    if (aba === 'visao') return (dados?.numeros?.sessoes?.total ?? 0) === 0;
    return (dados?.porModelo ?? []).length === 0 && (dados?.porProjeto ?? []).length === 0;
  }

  async function desenhar({ silencioso = false } = {}) {
    const minha = ++vez;
    if (!silencioso) area.replaceChildren(cab(aba === 'custo' ? [seletor()] : []), ...(aba === 'custo' ? [abas('custo')] : []), carregando());
    const z = encodeURIComponent(fuso);
    const rota = aba === 'custo' ? `${ROTA_DO_CUSTO}?days=${dias}&tz=${z}` : `${ROTA_DA_VISAO}?tz=${z}`;
    try {
      const dados = await ctx.ler(rota);
      if (minha !== vez) return;
      ultimo = dados;
      if (semNada(dados)) {
        nos =
          aba === 'visao'
            ? [cab(), vazio({ titulo: 'Nenhuma sessão ainda', texto: 'Os números aparecem quando o console registrar a primeira sessão do Claude Code.' })]
            : [cab([seletor()]), abas('custo'), vazio({ titulo: `Nenhum custo nos últimos ${dias} dias`, texto: 'Escolha um período maior ou volte depois de usar o Claude Code.' })];
      } else nos = [cab(acoes(dados)), ...(aba === 'custo' ? telaDoCusto(dados) : telaDaVisao(dados))];
      area.replaceChildren(...nos);
    } catch (e) {
      if (e?.name === 'AbortError' || minha !== vez) return;
      if (silencioso && nos) {
        area.replaceChildren(nos[0], faixaDeErro({ titulo: 'Não deu para atualizar.', texto: `${e?.message ?? e}. Os números abaixo são da última leitura.`, acao: { rotulo: 'Tentar de novo', aoClicar: () => desenhar({ silencioso: true }) } }), ...nos.slice(1));
        return;
      }
      nos = null;
      area.replaceChildren(cab(aba === 'custo' ? [seletor()] : []), erro({ texto: e?.message ?? String(e), tentar: () => desenhar() }));
    }
  }

  ctx.aoMudar(() => {
    if (espera) return;
    espera = setTimeout(() => {
      espera = null;
      desenhar({ silencioso: true });
    }, releituraMs);
  });
  ctx.aoReiniciar(() => desenhar({ silencioso: true }));
  await desenhar();
  return () => {
    clearTimeout(espera);
    espera = null;
    vez++;
  };
}
