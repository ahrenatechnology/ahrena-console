// Repositórios (C22, issue 104): as organizações e os repositórios da conta do GitHub, com atividade,
// issues, PRs, CI e as sessões que mexem em cada um. Lê `GET /api/repos` (src/api/repos-tipos.ts).
//
// - Os filtros ficam montados entre as releituras: só a lista e os cards são redesenhados, e a busca
//   não perde o foco enquanto a pessoa digita.
// - `carregando` do núcleo (o GitHub ainda não respondeu): relê a cada 5 s, além da mudança
//   `repos`/`lista` do Ao vivo.

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../estados.js';
import { filtrarRepos, inteiro, ORDENACOES, porcentagem, relativo, sparkline, TRACO, VISIBILIDADES } from '../repos-formato.js';

const SVG = 'http://www.w3.org/2000/svg';
const RELER_MS = 5000;

const CI = {
  ok: ['ok', 'CI ✓', 'O CI do branch padrão passou'],
  rodando: ['rodando', 'CI …', 'O CI do branch padrão está rodando'],
  falhou: ['falhou', 'CI ✕', 'O CI do branch padrão falhou'],
};

/** A pílula do CI do branch padrão, ou o traço sem CI. */
export function pilulaDeCi(ci) {
  const c = CI[ci];
  return c ? el('span', { class: `rp-pill ${c[0]}`, title: c[2] }, c[1]) : el('span', { class: 'rp-muted' }, TRACO);
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
  if (!pontos) return el('span', { class: 'rp-muted', title: 'O GitHub ainda não mandou as semanas' }, TRACO);
  const s = svg('svg', { viewBox: '0 0 90 22', class: 'rp-spark', role: 'img', 'aria-label': `Commits por semana nas últimas 12 semanas: ${valores.join(', ')}` });
  s.append(svg('polyline', { points: pontos }));
  return s;
}

function stat(rotulo, valor, sub, nomeIcone, cor) {
  return el(
    'section',
    { class: 'cartao rp-stat' },
    el('span', { class: 'rot' }, rotulo),
    el('span', { class: `ic ${cor}` }, icone(nomeIcone)),
    el('span', { class: 'v' }, valor),
    el('span', { class: 's' }, sub),
  );
}

function sessoes({ ativas, precisam }) {
  if (!ativas) return el('span', { class: 'rp-muted' }, TRACO);
  return el(
    'span',
    { class: 'sessoes' },
    el('span', { class: 'rp-badge', title: `${ativas} ${ativas === 1 ? 'sessão viva' : 'sessões vivas'}` }, String(ativas)),
    precisam ? el('span', { class: 'rp-mot' }, `${precisam} ${precisam === 1 ? 'precisa' : 'precisam'} de você`) : null,
  );
}

export async function montar(area, ctx) {
  const filtro = { busca: '', dono: '', vis: 'todos', ordem: 'recente' };
  let dados = null;
  let falha = null;
  let timer = null;
  let pedido = 0;

  // ---------- cabeçalho ----------
  const chipConta = el('span', { class: 'rp-chip', hidden: true });
  const atualizar = el('button', { type: 'button', class: 'btn' }, icone('atualizar'), 'Atualizar');
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
    const b = el('button', { type: 'button', 'aria-pressed': String(v === filtro.vis), 'data-vis': v }, rotulo);
    b.addEventListener('click', () => {
      filtro.vis = v;
      for (const x of botoesVis) x.setAttribute('aria-pressed', String(x === b));
      desenharLista();
    });
    return b;
  });

  const filtros = el(
    'div',
    { class: 'cartao rp-filtros', role: 'search' },
    el('label', { class: 'rp-campo busca' }, icone('busca'), busca),
    el('label', { class: 'rp-campo lista' }, orgs, icone('chevron-baixo')),
    el('label', { class: 'rp-campo lista' }, ordem, icone('chevron-baixo')),
    el('div', { class: 'rp-seg', role: 'group', 'aria-label': 'Visibilidade' }, ...botoesVis),
  );

  const faixa = el('div', { hidden: true });
  const stats = el('div', { class: 'rp-stats' });
  const lista = el('div', { class: 'rp-grupos' });

  function preencherOrgs() {
    const donos = dados.grupos.map((g) => g.dono);
    if (donosDoSelect && donosDoSelect.join('\n') === donos.join('\n')) return;
    donosDoSelect = donos;
    if (filtro.dono && !donos.includes(filtro.dono)) filtro.dono = '';
    orgs.replaceChildren(
      el('option', { value: '' }, 'Todas as organizações'),
      ...dados.grupos.map((g) => el('option', { value: g.dono }, g.tipo === 'pessoal' ? `${g.dono} (pessoal)` : g.dono)),
    );
    orgs.value = filtro.dono;
  }

  function desenharStats() {
    const r = dados.resumo;
    stats.replaceChildren(
      stat('Organizações', inteiro(r.organizacoes), '+ a conta pessoal', 'organizacao', 'rp-c-accent'),
      stat('Repositórios', inteiro(r.repositorios), `${inteiro(r.comSessoesNoMes)} com sessões este mês`, 'repos', 'rp-c-accent'),
      stat('PRs abertos', inteiro(r.prsAbertos), `${inteiro(r.prsEsperandoReview)} esperando review`, 'pr', 'rp-c-espera'),
      stat('Issues abertas', inteiro(r.issuesAbertas), `${inteiro(r.issuesFechadasNaSemana)} fechadas na semana`, 'issue', 'rp-c-accent'),
      stat('CI', porcentagem(r.ci.taxaVerde), r.ci.taxaVerde === null ? `sem execuções · ${r.ci.dias} dias` : `de execuções verdes · ${r.ci.dias} dias`, 'ci-verde', 'rp-c-ok'),
    );
  }

  function linha(r, agora) {
    const href = rotaDoRepo(r.dono, r.nome);
    const tr = el(
      'tr',
      { class: 'clicavel' },
      el('td', { class: 'nm' }, el('a', { href }, r.nome), el('small', {}, `${r.completo} · ${r.visibilidade === 'publico' ? 'público' : 'privado'}`)),
      el('td', {}, r.linguagem ?? el('span', { class: 'rp-muted' }, TRACO)),
      el('td', {}, spark(r.commits12)),
      el('td', { class: 'num' }, inteiro(r.issuesAbertas)),
      el('td', { class: 'num' }, inteiro(r.prsAbertos)),
      el('td', {}, pilulaDeCi(r.ci)),
      el('td', {}, sessoes(r.sessoes)),
      el('td', { class: 'rp-muted', title: r.ultimoPush ? new Date(r.ultimoPush).toLocaleString('pt-BR') : null }, relativo(r.ultimoPush, agora)),
      el('td', { class: 'seta' }, icone('chevron-direita')),
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
      { class: 'rp-grupo' },
      el('div', { class: 'rp-grupo-cab' }, icone(g.tipo === 'pessoal' ? 'usuario' : 'organizacao'), el('h2', {}, g.tipo === 'pessoal' ? `${g.dono} (pessoal)` : g.dono), el('span', {}, `${n} ${n === 1 ? 'repositório' : 'repositórios'}`)),
      el(
        'div',
        { class: 'cartao rp-caixa' },
        el(
          'table',
          { class: 'rp-tabela' },
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              ...['Repositório', 'Linguagem', 'Commits · 12 sem.', 'Issues', 'PRs', 'CI', 'Sessões', 'Último push'].map((t) => el('th', { scope: 'col' }, t)),
              el('th', { scope: 'col', 'aria-label': 'Abrir' }),
            ),
          ),
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
    lista.replaceChildren(...(grupos.length ? grupos.map((g) => grupo(g, agora)) : [vazio({ icone: 'busca', titulo: 'Nenhum repositório com esse filtro', texto: 'Mude a busca, a organização ou a visibilidade.' })]));
    if (focado) [...lista.querySelectorAll('a[href]')].find((a) => a.getAttribute('href') === focado)?.focus();
  }

  const temDado = () => dados && (dados.atualizadoEm !== null || dados.grupos.length > 0);

  function desenhar() {
    clearTimeout(timer);
    timer = null;
    chipConta.hidden = !dados?.conta;
    chipConta.replaceChildren(icone('github'), `conta: ${dados?.conta ?? ''}`);

    if (!temDado()) {
      if (falha) return area.replaceChildren(cab, erro({ texto: falha.message, tentar: () => (area.replaceChildren(cab, carregando()), ler()) }));
      if (!dados) return area.replaceChildren(cab, carregando());
      if (dados.estado === 'sem-github')
        return area.replaceChildren(cab, vazio({ icone: 'github', titulo: 'O núcleo está sem o GitHub', texto: 'O gh não está instalado ou autenticado nesta máquina, ou o núcleo subiu com --sem-github. Autentique o gh e reinicie o núcleo para ver os repositórios.' }));
      if (dados.estado === 'erro') return area.replaceChildren(cab, erro({ titulo: 'O GitHub não respondeu', texto: dados.erro ?? 'A leitura dos repositórios falhou.', tentar: () => (area.replaceChildren(cab, carregando()), ler({ forcar: true })) }));
      if (dados.estado === 'carregando') {
        timer = setTimeout(ler, RELER_MS);
        return area.replaceChildren(cab, carregando({ rotulo: 'Lendo o GitHub…' }));
      }
      return area.replaceChildren(cab, vazio({ icone: 'repos', titulo: 'Nenhum repositório', texto: 'A conta do GitHub não tem repositórios, fora os arquivados.' }));
    }

    if (dados.estado === 'carregando') timer = setTimeout(ler, RELER_MS);
    if (!area.contains(filtros)) area.replaceChildren(cab, faixa, stats, filtros, lista);

    const quando = dados.atualizadoEm ? new Date(dados.atualizadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
    if (falha) faixa.replaceChildren(faixaDeErro({ titulo: 'Sem conexão com o núcleo.', texto: `${falha.message}. Mostrando a última leitura${quando ? `, de ${quando}` : ''}.`, acao: { rotulo: 'Tentar de novo', aoClicar: () => ler() } }));
    else if (dados.erro) faixa.replaceChildren(faixaDeErro({ titulo: 'GitHub com problema.', texto: `${dados.erro}. Mostrando os repositórios${quando ? ` de ${quando}` : ' da última leitura'}.` }));
    else faixa.replaceChildren();
    faixa.hidden = !faixa.firstChild;

    if (dados.grupos.length === 0) {
      stats.replaceChildren();
      lista.replaceChildren(vazio({ icone: 'repos', titulo: 'Nenhum repositório', texto: 'A conta do GitHub não tem repositórios, fora os arquivados.' }));
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
      const d = await ctx.ler(forcar ? '/api/repos?atualizar=1' : '/api/repos');
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
    if (mudancas.some((m) => m.tipo === 'repos' && m.chave === 'lista')) ler();
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
