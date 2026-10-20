// Workflows (#96, C14): as KPIs de orquestração, os runs do Workflow tool (fases e agentes) e o grafo
// de orquestração, sobre `GET /api/workflows?filtro=&no=` (src/api/workflows.ts). O filtro do topo e o
// clique num nó do grafo valem para a tela inteira: os dois vão para a API, que devolve tudo filtrado.
//
// Ao vivo: relê a cada mudança `sessao` ou `estado` (de qualquer sessão) e quando a moldura manda
// reler. Subagente que começa ou termina não gera mudança, então, enquanto houver run ativo ou sessão
// em andamento, relê a cada 10 s.
//
// Tudo o que vem do núcleo entra por `textContent` (`el()` e `svg()`), nunca como HTML.

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../states.js';
import { decimal, duracao, nomeDoModelo, num, porcento, quando, tokens } from './workflow-format.js';

const SVG = 'http://www.w3.org/2000/svg';
const RELER_ATIVO_MS = 10_000;

export const FILTROS = [
  { id: 'todas', rotulo: 'Todas as sessões', resumo: 'todas as sessões' },
  { id: 'ativas', rotulo: 'Só ativas', resumo: 'só as ativas' },
  { id: 'concluidas', rotulo: 'Concluídas', resumo: 'só as concluídas' },
];

// ---------- Partes puras (testadas no node) ----------

/** A rota da API para o filtro e o nó escolhidos. */
export function rotaDosWorkflows(filtro, no) {
  const q = new URLSearchParams({ filter: filtro });
  if (no) q.set('node', no);
  return `/api/workflows?${q}`;
}

/** As seis KPIs do C14, já escritas: `{ id, rotulo, valor, sub, icone, cor }`. `null` vira "—". */
export function kpisEscritas(k) {
  return [
    { id: 'profundidade', rotulo: 'Profundidade', valor: decimal(k.profundidadeMedia), sub: 'níveis de agente', icone: 'subagente', cor: 'acento' },
    { id: 'subagentes', rotulo: 'Subagentes', valor: decimal(k.subagentesPorSessao), sub: 'por sessão', icone: 'usuarios', cor: 'acento' },
    { id: 'sucesso', rotulo: 'Sucesso', valor: porcento(k.sucessoSubagentes), sub: 'dos subagentes', icone: 'ok', cor: 'ok' },
    { id: 'fluxo', rotulo: 'Fluxo comum', valor: k.fluxoComum?.rotulo ?? '—', sub: k.fluxoComum ? `${porcento(k.fluxoComum.fracao)} das sessões` : null, icone: 'repetir', cor: 'acento' },
    { id: 'rodadas', rotulo: 'Rodadas', valor: decimal(k.rodadasPorPr), sub: 'de review por PR', icone: 'atualizar', cor: 'acento' },
    { id: 'duracao', rotulo: 'Duração', valor: duracao(k.duracaoMediaMs), sub: 'média', icone: 'cronometro', cor: 'espera' },
  ];
}

/** "motor-de-regras · 5 agentes · 36 ferramentas · 223 k tokens · 28 min" e, se acabou, "· ontem". */
export function metaDoRun(run, agora = new Date()) {
  const n = run.agentes.length;
  const partes = [
    run.projeto,
    `${num(n)} ${n === 1 ? 'agente' : 'agentes'}`,
    `${num(run.ferramentas)} ${run.ferramentas === 1 ? 'ferramenta' : 'ferramentas'}`,
    `${tokens(run.tokens)} tokens`,
    duracao(run.duracaoMs),
    run.estado === 'ativa' ? null : quando(run.fim ?? run.inicio, agora),
  ];
  return partes.filter(Boolean).join(' · ');
}

const ESTADO_DO_RUN = { ativa: ['Ativa', 'active'], concluida: ['Concluída', 'completed'], erro: ['Erro', 'error'] };

/** O estado de um agente do run: `[texto, cor]`. */
export function estadoDoAgente(a) {
  if (a.estado === 'concluido') return ['Concluído', 'completed'];
  if (a.estado === 'rodando') return ['Rodando', 'active'];
  if (a.estado === 'erro') return ['Erro', 'error'];
  if (a.ajustes === null || a.ajustes === undefined) return ['Ajustes', 'error'];
  return [`${num(a.ajustes)} ${a.ajustes === 1 ? 'ajuste' : 'ajustes'}`, 'error'];
}

/** Espessura de uma aresta pelo volume, entre 1,2 e 22 (a mais grossa é a de maior volume). */
export function espessura(volume, maior) {
  if (!(maior > 0)) return 1.2;
  return Math.max(1.2, Math.round((volume / maior) * 220) / 10);
}

const LARGURA = 960;
const NO_A = 30;
const PASSO = 42;
const LETRA = 5.8; // largura de um caractere do rótulo (mono, 9,5 px)

/**
 * O desenho do grafo de orquestração na `largura` do painel, em px, sem escala: as colunas, na ordem da
 * API, dividem a largura; os nós ficam empilhados no meio de cada coluna; as arestas vão em curva da
 * direita de um nó à esquerda do outro, com espessura pelo volume. O rótulo que não cabe no nó encolhe
 * com reticências (`texto`); o inteiro fica em `rotulo`.
 */
export function layoutDaOrquestracao(grafo, largura = LARGURA) {
  const colunas = grafo.colunas;
  const n = Math.max(1, colunas.length);
  const NO_L = Math.round(Math.min(152, Math.max(104, (largura - 20) / n - 18)));
  const passoX = colunas.length > 1 ? (largura - 20 - NO_L) / (colunas.length - 1) : 0;
  const porColuna = colunas.map((c) => grafo.nos.filter((no) => no.coluna === c.id));
  const altura = Math.max(1, ...porColuna.map((l) => l.length)) * PASSO;
  const pos = new Map();
  const nos = [];
  porColuna.forEach((lista, i) => {
    const x = Math.round(10 + i * passoX);
    const k = lista.length;
    const s = k > 1 ? Math.min(70, (altura - NO_A) / (k - 1)) : 0;
    const topo = (altura - (NO_A + s * (k - 1))) / 2;
    lista.forEach((no, j) => {
      const y = Math.round(topo + j * s);
      const volume = num(no.volume);
      const cabe = Math.max(4, Math.floor((NO_L - 22 - volume.length * LETRA) / LETRA));
      pos.set(no.id, { x, y });
      nos.push({ ...no, x, y, texto: no.rotulo.length > cabe ? `${no.rotulo.slice(0, cabe - 1)}…` : no.rotulo, volumeEscrito: volume });
    });
  });
  const maior = Math.max(0, ...grafo.arestas.map((a) => a.volume));
  const arestas = grafo.arestas
    .filter((a) => pos.has(a.de) && pos.has(a.para))
    .map((a) => {
      const A = pos.get(a.de);
      const B = pos.get(a.para);
      const x1 = A.x + NO_L;
      const y1 = A.y + NO_A / 2;
      const x2 = B.x;
      const y2 = B.y + NO_A / 2;
      const m = (x1 + x2) / 2;
      return { ...a, d: `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`, espessura: espessura(a.volume, maior), erro: a.para === 'resultado:erro' };
    });
  return {
    largura,
    altura,
    colunas: colunas.map((c, i) => ({ ...c, x: Math.round(10 + i * passoX + NO_L / 2) })),
    nos,
    arestas,
    no: { largura: NO_L, altura: NO_A },
  };
}

/** Há o que mudar sem aviso? Run ativo ou sessão em andamento: a tela relê de tempos em tempos. */
export function temAtivo(dados) {
  return dados.runs.some((r) => r.estado === 'ativa') || dados.grafo.nos.some((n) => n.id === 'resultado:andamento' && n.volume > 0);
}

// ---------- DOM ----------

function svg(tag, atributos = {}, ...filhos) {
  const no = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(atributos)) if (v !== null && v !== undefined && v !== false) no.setAttribute(k, String(v));
  for (const f of filhos.flat()) if (f !== null && f !== undefined && f !== false) no.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return no;
}

function carregarCss() {
  if (document.querySelector('link[data-tela="workflows"]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: '/ui/screens/workflows.css', 'data-tela': 'workflows' }));
}

function selo(texto, cor) {
  return el('span', { class: `badge b-${cor}` }, el('span', { class: 'p' }), texto);
}

function kpis(k) {
  return el(
    'div',
    { class: 'wf-kpis' },
    ...kpisEscritas(k).map((c) =>
      el(
        'div',
        { class: `cartao wf-kpi wf-kpi-${c.id}` },
        el('span', { class: 'wf-kpi-rot' }, c.rotulo),
        el('span', { class: `wf-kpi-ic wf-cor-${c.cor}` }, icone(c.icone)),
        el('span', { class: 'wf-kpi-v mono' }, c.valor),
        el('span', { class: 'wf-kpi-s' }, c.sub ?? ''),
      ),
    ),
  );
}

function painel(titulo, direita, ...corpo) {
  return el('section', { class: 'cartao wf-painel' }, el('div', { class: 'wf-ttl' }, ...titulo, el('span', { class: 'wf-ttl-r' }, direita)), ...corpo);
}

function chip(texto, extra = '') {
  return el('span', { class: `wf-chip${extra}` }, texto);
}

function linhaDoRun(run, aberto, alternar, ctx) {
  const [rotulo, cor] = ESTADO_DO_RUN[run.estado] ?? ESTADO_DO_RUN.concluida;
  const destino = `/ui/sessions/${encodeURIComponent(run.sessaoId)}`;
  const link = el('a', { class: 'wf-run-link', href: `${destino}#workflow`, title: 'Abrir a sessão', 'aria-label': `Abrir a sessão de ${run.nome}` }, icone('externo'));
  // A moldura troca de tela pelo caminho e deixaria o `#workflow` para trás: o hash vai antes.
  link.addEventListener('click', (ev) => {
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    ev.preventDefault();
    history.pushState(null, '', `${destino}#workflow`);
    ctx.navegar(destino);
  });
  const cab = el(
    'div',
    { class: 'wf-run-cab' },
    el(
      'button',
      { type: 'button', class: 'wf-run-abrir', 'data-run': run.id, 'aria-expanded': aberto ? 'true' : 'false', aoClicar: alternar },
      el('span', { class: 'wf-mudo' }, icone(aberto ? 'chevron-baixo' : 'chevron-direita')),
      el('b', {}, run.nome),
      selo(rotulo, cor),
      aberto && run.modelo ? chip(nomeDoModelo(run.modelo), ' wf-chip-modelo mono') : null,
      el('span', { class: 'wf-meta' }, metaDoRun(run)),
    ),
    link,
  );
  if (!aberto) return el('div', { class: 'wf-run' }, cab);

  const fases = run.fases.length
    ? el(
        'div',
        { class: 'wf-fases' },
        el('span', { class: 'wf-mudo' }, icone('camadas')),
        ...run.fases.flatMap((f, i) => [i ? el('span', { class: 'wf-mudo' }, icone('seta-direita')) : null, chip(f.nome)]),
        run.volta ? el('span', { class: 'wf-volta' }, run.volta) : null,
      )
    : null;

  const tabela = el(
    'table',
    { class: 'wf-tabela' },
    el('colgroup', {}, ...['agente', 'fase', 'estado', 'tokens', 'ferramentas', 'duracao'].map((c) => el('col', { class: `wf-col-${c}` }))),
    el('thead', {}, el('tr', {}, el('th', {}, 'Agente'), el('th', {}, 'Fase'), el('th', {}, 'Estado'), el('th', { class: 'wf-num' }, 'Tokens'), el('th', { class: 'wf-num' }, 'Ferramentas'), el('th', { class: 'wf-num' }, 'Duração'))),
    el(
      'tbody',
      {},
      ...run.agentes.map((a) => {
        const [texto, c] = estadoDoAgente(a);
        return el(
          'tr',
          {},
          el('td', { title: a.tipo ? `${a.rotulo} · ${a.tipo}` : a.rotulo }, el('span', { class: 'mono' }, a.rotulo), a.tipo ? el('span', { class: 'wf-tipo' }, `· ${a.tipo}`) : null),
          el('td', {}, a.fase ? chip(a.fase) : el('span', { class: 'wf-mudo' }, '—')),
          el('td', {}, el('span', { class: `wf-pilula b-${c}` }, texto)),
          el('td', { class: 'wf-num mono' }, tokens(a.tokens)),
          el('td', { class: 'wf-num mono' }, num(a.ferramentas)),
          el('td', { class: 'wf-num mono' }, duracao(a.duracaoMs)),
        );
      }),
    ),
  );
  return el('div', { class: 'wf-run wf-run-aberto' }, cab, fases, el('div', { class: 'wf-tabela-caixa' }, tabela));
}

function grafoSvg(grafo, largura, selecionado, escolher) {
  const g = layoutDaOrquestracao(grafo, largura);
  const { largura: W, altura: H } = g.no;
  const raiz = svg('svg', { class: 'wf-orq', viewBox: `0 -26 ${g.largura} ${g.altura + 30}`, width: g.largura, height: g.altura + 30, role: 'group', 'aria-label': 'Grafo de orquestração' });
  for (const c of g.colunas) raiz.append(svg('text', { class: 'wf-orq-col', x: c.x, y: -10, 'text-anchor': 'middle' }, c.rotulo.toUpperCase()));
  for (const a of g.arestas) raiz.append(svg('path', { class: `wf-aresta${a.erro ? ' wf-aresta-erro' : ''}`, d: a.d, 'stroke-width': a.espessura }, svg('title', {}, `${a.volume}`)));
  for (const n of g.nos) {
    const cls = ['wf-no', n.id === 'resultado:concluida' ? 'wf-no-ok' : '', n.id === 'resultado:erro' ? 'wf-no-erro' : '', n.id === selecionado ? 'wf-no-sel' : ''].filter(Boolean).join(' ');
    const grupo = svg(
      'g',
      { class: cls, 'data-no': n.id, tabindex: 0, role: 'button', 'aria-pressed': n.id === selecionado ? 'true' : 'false', 'aria-label': `${n.rotulo}: ${n.volume}. ${n.id === selecionado ? 'Limpar o filtro' : 'Filtrar a tela por este nó'}` },
      svg('title', {}, `${n.rotulo} · ${n.id === selecionado ? 'clique para limpar o filtro' : 'clique para filtrar a tela'}`),
      svg('rect', { x: n.x, y: n.y, width: W, height: H, rx: 7 }),
      svg('text', { class: 'wf-no-rot', x: n.x + 8, y: n.y + 19 }, n.texto),
      svg('text', { class: 'wf-no-vol', x: n.x + W - 8, y: n.y + 19, 'text-anchor': 'end' }, n.volumeEscrito),
    );
    grupo.addEventListener('click', () => escolher(n.id));
    grupo.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      escolher(n.id);
    });
    raiz.append(grupo);
  }
  return raiz;
}

// ---------- A tela ----------

export async function montar(area, ctx) {
  carregarCss();
  let filtro = 'todas';
  let no = null;
  let dados = null;
  let falha = null;
  let seq = 0;
  let timer = null;
  let espera = null;
  let abertos = null; // os runs abertos; `null` até a primeira leitura abrir o primeiro
  let foco = null; // o nó que tinha o foco, para devolvê-lo depois de redesenhar

  const botoes = FILTROS.map((f) => {
    const b = el('button', { type: 'button', 'aria-pressed': f.id === filtro ? 'true' : 'false' }, f.rotulo);
    b.addEventListener('click', () => {
      if (filtro === f.id) return;
      filtro = f.id;
      marcarFiltro();
      ler();
    });
    return b;
  });
  const marcarFiltro = () => FILTROS.forEach((f, i) => botoes[i].setAttribute('aria-pressed', f.id === filtro ? 'true' : 'false'));
  const seg = el('div', { class: 'wf-seg', role: 'group', 'aria-label': 'Quais sessões' }, ...botoes);
  const cab = cabecalho({ icone: 'workflows', titulo: 'Workflows', sub: 'Como os agentes se orquestram: delegação, rodadas de review e resultado', acoes: [seg] });

  area.replaceChildren(cab, carregando({ rotulo: 'Carregando os workflows' }));

  function escolherNo(id) {
    no = no === id ? null : id;
    foco = id;
    ler();
  }

  const caixaDoGrafo = el('div', { class: 'wf-orq-caixa' });
  let larguraDoGrafo = 0;
  function desenharGrafo() {
    const largura = Math.floor(caixaDoGrafo.clientWidth);
    if (!dados || !caixaDoGrafo.isConnected || largura <= 0) return;
    larguraDoGrafo = largura;
    caixaDoGrafo.replaceChildren(grafoSvg(dados.grafo, largura, dados.no, escolherNo));
  }
  const observador = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (Math.floor(caixaDoGrafo.clientWidth) !== larguraDoGrafo) desenharGrafo();
  }) : null;
  observador?.observe(caixaDoGrafo);

  function desenhar() {
    const d = dados;
    // Nenhuma sessão, sem filtro nenhum: a tela inteira diz isso.
    if (!d.sessoes && d.filtro === 'todas' && !d.no) {
      area.replaceChildren(
        ...[cab, falha ? faixaDeErro({ titulo: 'Não deu para atualizar.', texto: falha, acao: { rotulo: 'Tentar de novo', aoClicar: () => ler() } }) : null].filter(Boolean),
        vazio({ icone: 'workflows', titulo: 'Nenhuma sessão ainda', texto: 'Quando houver sessões do Claude Code nesta máquina, a orquestração dos agentes aparece aqui.' }),
      );
      return;
    }
    if (abertos === null) abertos = new Set(d.runs.length ? [d.runs[0].id] : []);
    const rotuloDoNo = no ? (d.grafo.nos.find((n) => n.id === no)?.rotulo ?? no) : null;
    // Com o teto de sessões lidas cortando, o subtítulo diz que são só as mais recentes.
    const resumo = `${FILTROS.find((f) => f.id === d.filtro)?.resumo ?? 'todas as sessões'}${d.truncado ? `, das ${d.maximo ?? 500} mais recentes` : ''}`;

    const runs = d.runs.length
      ? d.runs.map((r) =>
          linhaDoRun(r, abertos.has(r.id), () => {
            abertos.has(r.id) ? abertos.delete(r.id) : abertos.add(r.id);
            desenhar();
            [...area.querySelectorAll('.wf-run-abrir')].find((b) => b.getAttribute('data-run') === r.id)?.focus();
          }, ctx),
        )
      : [el('p', { class: 'wf-nada' }, d.sessoes ? 'Nenhum run do Workflow tool nestas sessões.' : 'Nenhuma sessão neste filtro.')];

    // O grafo é desenhado depois, na largura que o painel tem na tela (e de novo quando ela muda).
    const grafo = d.grafo.nos.length
      ? caixaDoGrafo
      : el(
          'div',
          { class: 'wf-nada' },
          el('p', {}, 'Nenhuma sessão para desenhar.'),
          no ? el('button', { type: 'button', class: 'btn contorno', aoClicar: () => escolherNo(no) }, 'Limpar o filtro do nó') : null,
        );

    const partes = [
      cab,
      falha ? faixaDeErro({ titulo: 'Não deu para atualizar.', texto: falha, acao: { rotulo: 'Tentar de novo', aoClicar: () => ler() } }) : null,
      kpis(d.kpis),
      painel([icone('workflows'), 'Workflows dinâmicos'], 'frotas do Workflow tool, lidas dos journals', el('div', { class: 'wf-runs' }, ...runs)),
      painel(
        ['Grafo de orquestração'],
        no ? `${resumo} · passando por ${rotuloDoNo} · clique de novo para limpar` : `${resumo} · clique num nó para filtrar`,
        grafo,
      ),
    ];
    area.replaceChildren(...partes.filter(Boolean));
    if (d.grafo.nos.length) desenharGrafo();
    if (foco) {
      [...area.querySelectorAll('.wf-no')].find((g) => g.getAttribute('data-no') === foco)?.focus();
      foco = null;
    }
  }

  async function ler() {
    const meu = ++seq;
    clearTimeout(timer);
    try {
      const d = await ctx.ler(rotaDosWorkflows(filtro, no));
      if (meu !== seq) return;
      dados = d;
      falha = null;
      desenhar();
    } catch (e) {
      if (e?.name === 'AbortError' || meu !== seq) return;
      if (!dados) area.replaceChildren(cab, erro({ texto: e.message, tentar: () => (area.replaceChildren(cab, carregando({ rotulo: 'Carregando os workflows' })), ler()) }));
      else {
        falha = e.message;
        desenhar();
      }
    }
    if (meu === seq && !ctx.sinal.aborted && dados && temAtivo(dados)) timer = setTimeout(ler, RELER_ATIVO_MS);
  }

  ctx.aoMudar((mudancas) => {
    if (!mudancas.some((m) => m.tipo === 'sessao' || m.tipo === 'estado')) return;
    clearTimeout(espera);
    espera = setTimeout(ler, 400);
  });
  ctx.aoReiniciar(() => ler());

  await ler();
  return () => {
    clearTimeout(timer);
    clearTimeout(espera);
    observador?.disconnect();
  };
}
