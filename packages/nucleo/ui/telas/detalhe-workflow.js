// A aba Workflow do detalhe da sessão (#97, C7): o grafo dos agentes, com o laço dev → review →
// ajustes, e a linha do tempo dos agentes, sobre `GET /api/sessoes/<id>/workflow`
// (src/api/workflows.ts).
//
// O contrato das abas do detalhe: `criar(ctx, base, { cabeca, rotular })` devolve
// `{ mostrar(corpo), esconder(), atualizar() }`. `base` é `/api/sessoes/<id>`. A mudança da sessão
// chega pelo `atualizar()` do detalhe; como subagente que começa ou termina não gera mudança, enquanto
// houver agente ativo a aba relê a cada 10 s, e para quando sai de cena (`esconder()`).
//
// Tudo o que vem do núcleo entra por `textContent` (`el()` e `svg()`), nunca como HTML.

import { el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro } from '../estados.js';
import { duracao, nomeDoModelo, num } from './workflow-formato.js';

const SVG = 'http://www.w3.org/2000/svg';
const RELER_ATIVO_MS = 10_000;
const DEC = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

// ---------- Partes puras (testadas no node) ----------

/**
 * Colunas pelas dependências e linhas para os ramos. A coluna de um nó é o maior caminho até ele
 * pelas arestas (quem abriu ou entregou vem antes). O ramo mais longo segue na linha do pai; os
 * outros filhos ocupam a linha livre mais perto, primeiro abaixo, depois acima.
 * Devolve `{ colunas, linhas, pos: { [id]: { coluna, linha } } }`.
 */
export function layoutDoGrafo(nos, arestas) {
  const ids = nos.map((n) => n.id);
  const existe = new Set(ids);
  const validas = arestas.filter((a) => existe.has(a.de) && existe.has(a.para) && a.de !== a.para);
  const filhos = new Map(ids.map((i) => [i, []]));
  const pais = new Map(ids.map((i) => [i, []]));
  for (const a of validas) {
    if (!filhos.get(a.de).includes(a.para)) filhos.get(a.de).push(a.para);
    if (!pais.get(a.para).includes(a.de)) pais.get(a.para).push(a.de);
  }

  // Profundidade: o maior caminho desde uma raiz (Kahn). Num ciclo, o nó fica depois dos pais já vistos.
  const prof = new Map();
  const grau = new Map(ids.map((i) => [i, pais.get(i).length]));
  const fila = ids.filter((i) => grau.get(i) === 0);
  for (const i of fila) prof.set(i, 0);
  while (fila.length) {
    const i = fila.shift();
    for (const f of filhos.get(i)) {
      prof.set(f, Math.max(prof.get(f) ?? 0, prof.get(i) + 1));
      grau.set(f, grau.get(f) - 1);
      if (grau.get(f) === 0) fila.push(f);
    }
  }
  for (const i of ids) {
    if (prof.has(i)) continue;
    const vistos = pais.get(i).filter((p) => prof.has(p));
    prof.set(i, vistos.length ? Math.max(...vistos.map((p) => prof.get(p))) + 1 : 0);
  }

  // Quem põe cada nó na tela: o primeiro pai da coluna anterior (ou o primeiro pai).
  const dono = new Map();
  for (const i of ids) {
    const ps = pais.get(i);
    const p = ps.find((x) => prof.get(x) === prof.get(i) - 1) ?? ps.find((x) => prof.get(x) < prof.get(i));
    if (p !== undefined) dono.set(i, p);
  }
  const debaixo = new Map(ids.map((i) => [i, []]));
  for (const i of ids) if (dono.has(i)) debaixo.get(dono.get(i)).push(i);

  // Altura do ramo: quantas colunas ele ainda anda.
  const alt = new Map();
  const altura = (i, pilha = new Set()) => {
    if (alt.has(i)) return alt.get(i);
    if (pilha.has(i)) return 0;
    pilha.add(i);
    const h = 1 + Math.max(0, ...debaixo.get(i).map((f) => altura(f, pilha)));
    pilha.delete(i);
    alt.set(i, h);
    return h;
  };

  const ocupado = new Map();
  const livre = (coluna, desejada) => {
    const usadas = ocupado.get(coluna) ?? new Set();
    for (let d = 0; ; d++) {
      for (const l of d === 0 ? [desejada] : [desejada + d, desejada - d]) if (!usadas.has(l)) return l;
    }
  };
  const pos = {};
  const por = (i, desejada) => {
    if (pos[i]) return;
    const coluna = prof.get(i);
    const linha = livre(coluna, desejada);
    if (!ocupado.has(coluna)) ocupado.set(coluna, new Set());
    ocupado.get(coluna).add(linha);
    pos[i] = { coluna, linha };
    const ordem = [...debaixo.get(i)].sort((a, b) => altura(b) - altura(a));
    for (const f of ordem) por(f, linha);
  };
  for (const i of ids) if (!dono.has(i)) por(i, 0);
  for (const i of ids) por(i, 0);

  const linhas = Object.values(pos).map((p) => p.linha);
  const menor = linhas.length ? Math.min(...linhas) : 0;
  for (const p of Object.values(pos)) p.linha -= menor;
  return {
    colunas: ids.length ? Math.max(...Object.values(pos).map((p) => p.coluna)) + 1 : 0,
    linhas: linhas.length ? Math.max(...linhas) - menor + 1 : 0,
    pos,
  };
}

/** Minutos para o eixo: inteiros a partir de 4 min, uma casa abaixo disso. */
function minutos(ms, total) {
  const m = ms / 60_000;
  return total >= 4 * 60_000 ? String(Math.round(m)) : DEC.format(m);
}

/**
 * A escala da linha do tempo, de `inicio` a `fim` da sessão: `fracao(iso)` de 0 a 1, as marcas do
 * eixo (0, ¼, ½, ¾ e o fim, em min) e o resumo "0 a 28 min".
 */
export function escalaDaLinha({ inicio, fim }) {
  const a = Date.parse(inicio);
  const total = Math.max(1, Date.parse(fim) - a);
  const fracao = (iso) => (iso === null || iso === undefined ? 1 : Math.min(1, Math.max(0, (Date.parse(iso) - a) / total)));
  const marcas = [0, 0.25, 0.5, 0.75, 1].map((k) => (k === 0 ? '0' : `${minutos(k * total, total)} min`));
  return { total, fracao, marcas, resumo: `0 a ${minutos(total, total)} min` };
}

/** Os trechos de uma faixa em porcentagem da sessão: `{ x, largura, estado }`. Trecho aberto vai até o fim. */
export function trechosDaFaixa(faixa, escala) {
  return faixa.trechos.map((t) => {
    const x = escala.fracao(t.inicio);
    const f = escala.fracao(t.fim);
    return { x: Math.round(x * 10000) / 100, largura: Math.max(0.4, Math.round((f - x) * 10000) / 100), estado: t.estado };
  });
}

/** O nome do nó com a rodada: "dev · r1". */
export const nomeDoNo = (n) => (n.rodada ? `${n.nome} · r${n.rodada}` : n.nome);

/** A segunda linha do nó: "3 ajustes pedidos" no review que pediu; senão a tarefa (ou o modelo) e o tempo. */
export function detalheDoNo(n) {
  if (n.ajustes > 0) return { texto: `${num(n.ajustes)} ${n.ajustes === 1 ? 'ajuste pedido' : 'ajustes pedidos'}`, ajustes: true };
  const quem = n.tarefa ?? (n.modelo ? nomeDoModelo(n.modelo) : null);
  return { texto: [quem, duracao(n.duracaoMs)].filter(Boolean).join(' · '), ajustes: false };
}

const ESTADO = { ativo: 'Ativa', concluido: 'Concluída', erro: 'Erro' };

// ---------- DOM ----------

function svg(tag, atributos = {}, ...filhos) {
  const no = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(atributos)) if (v !== null && v !== undefined && v !== false) no.setAttribute(k, String(v));
  for (const f of filhos.flat()) if (f !== null && f !== undefined && f !== false) no.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return no;
}

const curto = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function carregarCss() {
  if (document.querySelector('link[data-tela="detalhe-workflow"]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: '/ui/telas/detalhe-workflow.css', 'data-tela': 'detalhe-workflow' }));
}

// As medidas do C7 (6 colunas em ~980 px): o SVG encolhe para caber no painel, o texto junto.
const NO_L = 128;
const NO_A = 64;
const PASSO_X = 168;
const PASSO_Y = 96;
const MARGEM = 4;

function grafo(w) {
  const lay = layoutDoGrafo(w.nos, w.arestas);
  const largura = MARGEM * 2 + (lay.colunas - 1) * PASSO_X + NO_L;
  const altura = MARGEM * 2 + (lay.linhas - 1) * PASSO_Y + NO_A;
  const xy = (id) => ({ x: MARGEM + lay.pos[id].coluna * PASSO_X, y: MARGEM + lay.pos[id].linha * PASSO_Y });
  const raiz = svg('svg', { class: largura > 720 ? 'wfd-grafo wfd-largo' : 'wfd-grafo', viewBox: `0 0 ${largura} ${altura}`, width: largura, height: altura, role: 'img', 'aria-label': 'Grafo dos agentes da sessão' });
  const seta = (id, cls) => svg('marker', { id, viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' }, svg('path', { d: 'M0,0 L8,4 L0,8 Z', class: cls }));
  raiz.append(svg('defs', {}, seta('wfd-seta', 'wfd-ponta'), seta('wfd-seta-aj', 'wfd-ponta wfd-aj')));

  for (const a of w.arestas) {
    if (!lay.pos[a.de] || !lay.pos[a.para]) continue;
    const A = xy(a.de);
    const B = xy(a.para);
    const x1 = A.x + NO_L;
    const y1 = A.y + NO_A / 2;
    const x2 = B.x - 3;
    const y2 = B.y + NO_A / 2;
    const m = (x1 + x2) / 2;
    const aj = a.tipo === 'ajustes';
    raiz.append(svg('path', { class: `wfd-aresta${aj ? ' wfd-aj' : ''}`, d: `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`, 'marker-end': `url(#${aj ? 'wfd-seta-aj' : 'wfd-seta'})` }));
    if (a.rotulo) raiz.append(svg('text', { class: `wfd-rotulo${aj ? ' wfd-aj' : ''}`, x: m, y: (y1 + y2) / 2 - 6, 'text-anchor': 'middle' }, a.rotulo));
  }

  for (const n of w.nos) {
    if (!lay.pos[n.id]) continue;
    const { x, y } = xy(n.id);
    const det = detalheDoNo(n);
    const estado = ESTADO[n.estado] ?? n.estado;
    raiz.append(
      svg(
        'g',
        { class: `wfd-no wfd-e-${n.estado}` },
        svg('title', {}, [nomeDoNo(n), n.tarefa, duracao(n.duracaoMs), estado].filter(Boolean).join(' · ')),
        svg('rect', { class: 'wfd-caixa', x, y, width: NO_L, height: NO_A, rx: 8 }),
        svg('rect', { class: 'wfd-borda', x, y: y + 1, width: 3, height: NO_A - 2, rx: 1.5 }),
        svg('text', { class: 'wfd-no-nome', x: x + 11, y: y + 19 }, curto(nomeDoNo(n), 18)),
        svg('text', { class: `wfd-no-det${det.ajustes ? ' wfd-aj' : ''}`, x: x + 11, y: y + 36 }, curto(det.texto, 20)),
        n.estado === 'ativo' ? svg('circle', { class: 'wfd-no-ponto', cx: x + 15, cy: y + 49, r: 3.5 }) : null,
        svg('text', { class: 'wfd-no-estado', x: x + (n.estado === 'ativo' ? 22 : 11), y: y + 53 }, n.estado === 'concluido' ? `✓ ${estado}` : n.estado === 'erro' ? `✕ ${estado}` : estado),
      ),
    );
  }
  return el('div', { class: 'wfd-rolar' }, raiz);
}

function legenda(w) {
  const tracejado = svg('svg', { class: 'wfd-tracejado', viewBox: '0 0 18 4', width: 18, height: 4, 'aria-hidden': 'true' }, svg('line', { x1: 0, y1: 2, x2: 18, y2: 2 }));
  return el(
    'div',
    { class: 'wfd-legenda' },
    el('span', {}, el('i', { class: 'wfd-bola wfd-e-ativo' }), 'Ativo'),
    el('span', {}, el('i', { class: 'wfd-bola wfd-e-concluido' }), 'Concluído'),
    el('span', {}, tracejado, 'review pediu ajustes: volta para o dev'),
    el('span', {}, 'Rodadas de review ', el('b', { class: 'mono' }, num(w.rodadasDeReview))),
    el('span', {}, 'Ajustes ', el('b', { class: 'mono' }, num(w.ajustes))),
  );
}

function linhaDoTempo(w) {
  const escala = escalaDaLinha(w.linhaDoTempo);
  const faixas = w.linhaDoTempo.faixas.map((f) =>
    el(
      'div',
      { class: 'wfd-faixa' },
      el('span', { class: 'mono wfd-nome', title: f.rotulo }, f.rotulo),
      svg(
        'svg',
        { class: 'wfd-pista', width: '100%', height: 16, 'aria-hidden': 'true' },
        svg('rect', { class: 'wfd-fundo', x: 0, y: 0, width: '100%', height: 16, rx: 4 }),
        ...trechosDaFaixa(f, escala).map((t) => svg('rect', { class: `wfd-trecho wfd-e-${t.estado}`, x: `${t.x}%`, y: 2, width: `${t.largura}%`, height: 12, rx: 3 })),
      ),
    ),
  );
  const eixo = el('div', { class: 'wfd-faixa wfd-eixo mono' }, el('span', {}), el('div', {}, ...escala.marcas.map((m) => el('span', {}, m))));
  return el(
    'section',
    { class: 'cartao wfd-painel' },
    el('div', { class: 'wfd-ttl' }, icone('gantt'), 'Linha do tempo dos agentes', el('span', { class: 'wfd-ttl-r' }, `${escala.resumo} · concorrência`)),
    ...faixas,
    eixo,
  );
}

function desenho(w) {
  return [
    el(
      'section',
      { class: 'cartao wfd-painel' },
      el('div', { class: 'wfd-ttl' }, icone('subagente'), 'Grafo de agentes', el('span', { class: 'wfd-ttl-r' }, w.resumo ?? '')),
      grafo(w),
      legenda(w),
    ),
    linhaDoTempo(w),
  ];
}

// ---------- A aba ----------

export function criar(ctx, base) {
  let alvo = null;
  let dados = null;
  let seq = 0;
  let timer = null;
  ctx.sinal?.addEventListener('abort', () => clearTimeout(timer));

  async function desenhar() {
    const meu = ++seq;
    clearTimeout(timer);
    if (!alvo) return;
    carregarCss();
    try {
      const w = await ctx.ler(`${base}/workflow`);
      if (meu !== seq || !alvo) return;
      dados = w;
      alvo.replaceChildren(...desenho(w));
    } catch (e) {
      if (e?.name === 'AbortError' || meu !== seq || !alvo) return;
      if (dados) alvo.replaceChildren(faixaDeErro({ titulo: 'Não deu para atualizar.', texto: e.message, acao: { rotulo: 'Tentar de novo', aoClicar: () => desenhar() } }), ...desenho(dados));
      else alvo.replaceChildren(erro({ titulo: e.status === 404 ? 'Sessão não encontrada' : 'Não deu para ler o workflow', texto: e.message, tentar: () => (alvo?.replaceChildren(carregando({ rotulo: 'Carregando', blocos: 2 })), desenhar()) }));
    }
    if (meu === seq && alvo && !ctx.sinal?.aborted && dados?.nos.some((n) => n.estado === 'ativo')) timer = setTimeout(desenhar, RELER_ATIVO_MS);
  }

  return {
    mostrar(corpo) {
      alvo = corpo;
      return desenhar();
    },
    esconder() {
      alvo = null;
      seq++;
      clearTimeout(timer);
    },
    atualizar: () => desenhar(),
  };
}
