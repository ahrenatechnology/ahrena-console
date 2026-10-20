// Repositórios (C22, issue 104): as organizações e os repositórios da conta do GitHub, com atividade,
// issues, PRs, CI e as sessões que mexem em cada um. Lê `GET /api/repos` (src/api/repos-tipos.ts).
//
// - Os filtros ficam montados entre as releituras: só a lista e os cards são redesenhados, e a busca
//   não perde o foco enquanto a pessoa digita.
// - `carregando` do núcleo (o GitHub ainda não respondeu): relê a cada 5 s, além da mudança
//   `repos`/`lista` do Ao vivo. O que a tela desenha sai de `estadoDaTela` (repos-format.js).

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../states.js';
import { estadoDaTela, filtrarRepos, inteiro, mudancaInteressa, ORDENACOES, porcentagem, relativo, SEM_GITHUB, sparkline, temLista, TRACO, VISIBILIDADES } from '../repos-format.js';

const SVG = 'http://www.w3.org/2000/svg';
const RELER_MS = 5000;

/** O estilo das duas telas de repositórios, uma vez por página. */
export function carregarEstilo() {
  if (!document.querySelector('link[data-screen="repos"]')) document.head.append(el('link', { rel: 'stylesheet', href: '/ui/repos.css', 'data-screen': 'repos' }));
}

const CI = {
  ok: ['b-completed', 'CI ✓', 'CI passou'],
  rodando: ['b-waiting', 'CI …', 'CI rodando'],
  falhou: ['b-error', 'CI ✕', 'CI falhou'],
};

/** A pílula do CI do branch padrão, ou o traço sem CI. O leitor de tela ouve "CI passou". */
export function pilulaDeCi(ci) {
  const c = CI[ci];
  if (!c) return el('span', { class: 'repo-muted' }, TRACO);
  return el('span', { class: `repo-pill ${c[0]}` }, el('span', { 'aria-hidden': 'true' }, c[1]), el('span', { class: 'repo-sr-only' }, c[2]));
}

/** `/ui/repos/<dono>/<repo>`, com os segmentos escapados. */
export const rotaDoRepo = (dono, nome) => `/ui/repos/${encodeURIComponent(dono)}/${encodeURIComponent(nome)}`;

function svg(tag, atributos) {
  const no = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(atributos)) no.setAttribute(k, String(v));
  return no;
}

function spark(valores) {
  const pontos = sparkline(valores, 90, 22);
  if (!pontos) return el('span', { class: 'repo-muted', title: 'O GitHub ainda não mandou as semanas' }, TRACO);
  const s = svg('svg', { viewBox: '0 0 90 22', preserveAspectRatio: 'none', class: 'repo-spark', role: 'img', 'aria-label': `Commits por semana nas últimas 12 semanas: ${valores.join(', ')}` });
  s.append(svg('polyline', { points: pontos }));
  return s;
}

function stat(rotulo, valor, sub, nomeIcone, cor) {
  return el(
    'section',
    { class: 'card repo-stat' },
    el('span', { class: 'repo-stat-label' }, rotulo),
    el('span', { class: `repo-stat-ic ${cor}` }, icone(nomeIcone)),
    el('span', { class: 'repo-stat-v' }, valor),
    el('span', { class: 'repo-stat-s' }, sub),
  );
}

function sessoes({ ativas, precisam }) {
  if (!ativas) return el('span', { class: 'repo-muted' }, TRACO);
  return el(
    'span',
    { class: 'repo-sessions-inner' },
    el('span', { class: 'badge b-active', title: `${ativas} ${ativas === 1 ? 'sessão viva' : 'sessões vivas'}` }, el('span', { class: 'p' }), String(ativas), el('span', { class: 'repo-sr-only' }, ativas === 1 ? ' sessão viva' : ' sessões vivas')),
    precisam ? el('span', { class: 'reason' }, `${precisam} ${precisam === 1 ? 'precisa' : 'precisam'} de você`) : null,
  );
}

const COLUNAS = [
  ['repo-col-name', 'Repositório'],
  ['repo-col-lang', 'Linguagem'],
  ['repo-col-commits', 'Commits · 12 sem.'],
  ['repo-col-issues', 'Issues'],
  ['repo-col-prs', 'PRs'],
  ['repo-col-ci', 'CI'],
  ['repo-col-sessions', 'Sessões'],
  ['repo-col-push', 'Último push'],
];

export async function montar(area, ctx) {
  carregarEstilo();
  const filtro = { busca: '', dono: '', vis: 'todos', ordem: 'recente' };
  let dados = null;
  let falha = null;
  let timer = null;
  let pedido = 0;

  // ---------- cabeçalho ----------
  const chipConta = el('span', { class: 'repo-chip', hidden: true });
  const atualizar = el('button', { type: 'button', class: 'btn' }, icone('refresh'), 'Atualizar');
  atualizar.addEventListener('click', async () => {
    atualizar.disabled = true;
    atualizar.setAttribute('aria-busy', 'true');
    try {
      await ler({ forcar: true });
    } finally {
      atualizar.disabled = false;
      atualizar.removeAttribute('aria-busy');
    }
  });
  const cab = cabecalho({ icone: 'repos', titulo: 'Repositórios', sub: 'Organizações e repositórios da sua conta do GitHub', acoes: [chipConta, atualizar] });

  // ---------- filtros: montados uma vez ----------
  const busca = el('input', { type: 'search', placeholder: 'Buscar repositórios…', 'aria-label': 'Buscar repositórios', autocomplete: 'off', spellcheck: 'false' });
  busca.addEventListener('input', () => ((filtro.busca = busca.value), desenharLista()));

  const orgs = el('select', { 'aria-label': 'Organização' });
  orgs.addEventListener('change', () => ((filtro.dono = orgs.value), desenharLista()));
  let donosDoSelect = null;

  const ordem = el('select', { 'aria-label': 'Ordenar por' }, ...ORDENACOES.map(([v, rotulo]) => el('option', { value: v }, rotulo)));
  ordem.addEventListener('change', () => ((filtro.ordem = ordem.value), desenharLista()));

  const botoesVis = VISIBILIDADES.map(([v, rotulo]) => {
    const b = el('button', { type: 'button', 'aria-pressed': String(v === filtro.vis) }, rotulo);
    b.addEventListener('click', () => {
      filtro.vis = v;
      for (const x of botoesVis) x.setAttribute('aria-pressed', String(x === b));
      desenharLista();
    });
    return b;
  });

  const filtros = el(
    'div',
    { class: 'card repo-filters', role: 'search' },
    el('label', { class: 'repo-field repo-field-search' }, icone('search'), busca),
    el('label', { class: 'repo-field repo-field-list' }, orgs, icone('chevron-down')),
    el('label', { class: 'repo-field repo-field-list' }, ordem, icone('chevron-down')),
    el('div', { class: 'repo-seg', role: 'group', 'aria-label': 'Visibilidade' }, ...botoesVis),
  );

  const faixa = el('div', { hidden: true });
  const stats = el('div', { class: 'repo-stats' });
  const lista = el('div', { class: 'repo-groups' });

  function preencherOrgs() {
    const donos = dados.grupos.map((g) => g.dono);
    if (donosDoSelect && donosDoSelect.join('\n') === donos.join('\n')) return;
    donosDoSelect = donos;
    if (filtro.dono && !donos.includes(filtro.dono)) filtro.dono = '';
    orgs.replaceChildren(
      el('option', { value: '' }, 'Todas as organizações'),
      ...dados.grupos.map((g) => el('option', { value: g.dono }, g.tipo === 'pessoal' ? 'você (pessoal)' : g.dono)),
    );
    orgs.value = filtro.dono;
  }

  function desenharStats() {
    const r = dados.resumo;
    stats.replaceChildren(
      stat('Organizações', inteiro(r.organizacoes), '+ a conta pessoal', 'organization', 'repo-c-accent'),
      stat('Repositórios', inteiro(r.repositorios), `${inteiro(r.comSessoesNoMes)} com sessões este mês`, 'repos', 'repo-c-accent'),
      stat('PRs abertos', inteiro(r.prsAbertos), `${inteiro(r.prsEsperandoReview)} esperando review`, 'git-pull-request', 'repo-c-wait'),
      stat('Issues abertas', inteiro(r.issuesAbertas), `${inteiro(r.issuesFechadasNaSemana)} fechadas na semana`, 'dot', 'repo-c-accent'),
      stat('CI', porcentagem(r.ci.taxaVerde), r.ci.taxaVerde === null ? `sem execuções · ${r.ci.dias} dias` : `de execuções verdes · ${r.ci.dias} dias`, 'ok', 'repo-c-ok'),
    );
  }

  function linha(r, agora) {
    const href = rotaDoRepo(r.dono, r.nome);
    const completo = `${r.completo} · ${r.visibilidade === 'publico' ? 'público' : 'privado'}`;
    const tr = el(
      'tr',
      { class: 'repo-row' },
      el('td', { class: 'repo-name' }, el('a', { href, title: r.nome }, r.nome), el('small', { title: completo }, completo)),
      el('td', { title: r.linguagem }, r.linguagem ?? el('span', { class: 'repo-muted' }, TRACO)),
      el('td', {}, spark(r.commits12)),
      el('td', { class: 'repo-num' }, inteiro(r.issuesAbertas)),
      el('td', { class: 'repo-num' }, inteiro(r.prsAbertos)),
      el('td', {}, pilulaDeCi(r.ci)),
      el('td', { class: 'repo-sessions' }, sessoes(r.sessoes)),
      el('td', { class: 'repo-muted', title: r.ultimoPush ? new Date(r.ultimoPush).toLocaleString('pt-BR') : null }, relativo(r.ultimoPush, agora)),
      el('td', { class: 'repo-arrow' }, icone('chevron-right')),
    );
    // A linha inteira leva ao repositório; o link do nome é o caminho pelo teclado.
    tr.addEventListener('click', (ev) => {
      if (ev.defaultPrevented || (ev.target instanceof Element && ev.target.closest('a'))) return;
      if (getSelection()?.toString()) return;
      ctx.navegar(href);
    });
    return tr;
  }

  function grupo(g, agora) {
    const n = g.repos.length;
    return el(
      'section',
      { class: 'repo-group' },
      el('div', { class: 'repo-group-head' }, icone(g.tipo === 'pessoal' ? 'person' : 'organization'), el('h2', {}, g.tipo === 'pessoal' ? 'você (pessoal)' : g.dono), el('span', {}, `${n} ${n === 1 ? 'repositório' : 'repositórios'}`)),
      el(
        'div',
        { class: 'card' },
        el(
          'table',
          { class: 'repo-table' },
          el('colgroup', {}, ...COLUNAS.map(([c]) => el('col', { class: c })), el('col', { class: 'repo-col-arrow' })),
          el('thead', {}, el('tr', {}, ...COLUNAS.map(([, t]) => el('th', { scope: 'col' }, t)), el('th', { scope: 'col', 'aria-label': 'Abrir' }))),
          el('tbody', {}, ...g.repos.map((r) => linha(r, agora))),
        ),
      ),
    );
  }

  function desenharLista() {
    if (!dados) return;
    // Quem estava com o foco num link da lista continua nele depois do redesenho.
    const focado = lista.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
    const grupos = filtrarRepos(dados.grupos, filtro);
    const agora = Date.now();
    lista.replaceChildren(...(grupos.length ? grupos.map((g) => grupo(g, agora)) : [vazio({ icone: 'search', titulo: 'Nenhum repositório com esse filtro', texto: 'Mude a busca, a organização ou a visibilidade.' })]));
    if (focado) [...lista.querySelectorAll('a[href]')].find((a) => a.getAttribute('href') === focado)?.focus();
  }

  const nenhum = () => vazio({ icone: 'repos', titulo: 'Nenhum repositório', texto: 'A conta do GitHub não tem repositórios, fora os arquivados.' });
  const tentar = () => (area.replaceChildren(cab, carregando()), ler());

  function desenhar() {
    clearTimeout(timer);
    timer = null;
    chipConta.hidden = !dados?.conta;
    chipConta.replaceChildren(icone('github'), `conta: ${dados?.conta ?? ''}`);

    const e = estadoDaTela({ dados, falha, temDado: temLista(dados) });
    if (e.reler) timer = setTimeout(ler, RELER_MS);
    if (e.tela === 'erro') return area.replaceChildren(cab, falha ? erro({ texto: falha.message, tentar }) : erro({ titulo: 'O GitHub não respondeu', texto: dados.erro ?? 'A leitura dos repositórios falhou.', tentar: () => (area.replaceChildren(cab, carregando()), ler({ forcar: true })) }));
    if (e.tela === 'carregando') return area.replaceChildren(cab, carregando());
    if (e.tela === 'lendo') return area.replaceChildren(cab, carregando({ rotulo: 'Lendo o GitHub…' }));
    if (e.tela === 'sem-github') return area.replaceChildren(cab, vazio({ icone: 'github', ...SEM_GITHUB }));
    if (e.tela !== 'dados') return area.replaceChildren(cab, nenhum());

    if (!area.contains(filtros)) area.replaceChildren(cab, faixa, stats, filtros, lista);
    const quando = dados.atualizadoEm ? new Date(dados.atualizadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
    if (e.faixa === 'conexao') faixa.replaceChildren(faixaDeErro({ titulo: 'Sem conexão com o núcleo.', texto: `${falha.message}. Mostrando a última leitura${quando ? `, de ${quando}` : ''}.`, acao: { rotulo: 'Tentar de novo', aoClicar: () => ler() } }));
    else if (e.faixa === 'github') faixa.replaceChildren(faixaDeErro({ titulo: 'GitHub com problema.', texto: `${dados.erro}. Mostrando os repositórios${quando ? ` de ${quando}` : ' da última leitura'}.` }));
    else faixa.replaceChildren();
    faixa.hidden = !faixa.firstChild;

    if (dados.grupos.length === 0) {
      stats.replaceChildren();
      lista.replaceChildren(nenhum());
      return;
    }
    preencherOrgs();
    desenharStats();
    desenharLista();
  }

  async function ler({ forcar = false } = {}) {
    clearTimeout(timer);
    timer = null;
    const n = ++pedido;
    try {
      const d = await ctx.ler(forcar ? '/api/repos?refresh=1' : '/api/repos');
      if (n !== pedido) return;
      dados = d;
      falha = null;
    } catch (e) {
      if (e?.name === 'AbortError' || n !== pedido) return;
      falha = e instanceof Error ? e : new Error(String(e));
    }
    desenhar();
  }

  ctx.aoMudar((mudancas) => {
    if (mudancaInteressa(mudancas)) ler();
  });
  ctx.aoReiniciar(() => ler());

  area.replaceChildren(cab, carregando());
  await ler();
  return () => {
    clearTimeout(timer);
    timer = null;
    pedido++;
  };
}
