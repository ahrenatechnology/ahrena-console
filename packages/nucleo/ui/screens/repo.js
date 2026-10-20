// Repositório (C23, issue 105): as métricas que a API do GitHub dá, num período (30 dias, 90 dias, 1
// ano) que vale para a tela inteira. Lê `GET /api/repos/<dono>/<repo>?period=` (src/api/repos-tipos.ts).
//
// - The period lives in `?period=` (default 90d; `1y` is the year): switching rewrites the URL without a new history entry and re-reads.
// - Campo `null` vira "—"; se o GitHub ainda calcula (`calculando`) ou o núcleo ainda monta
//   (`carregando`), "calculando…" (`valorOuPendente`). Número nenhum é inventado.
// - Com escrita no repositório, o último card é "Tráfego e segurança"; sem, "Comunidade".
// - `carregando` ou `calculando`: relê a cada 5 s, além da mudança `repos` do Ao vivo.

import { el, icon } from '../dom.js';
import { loading, error, errorBand, empty } from '../states.js';
import {
  barras,
  cardDeTrafego,
  comSinal,
  decimal,
  duracao,
  estadoDaTela,
  fatias,
  frequencia,
  ha,
  inteiro,
  kilo,
  linguagens,
  mil,
  mudancaInteressa,
  periodInUrl,
  periodoDe,
  PERIODOS,
  porcentagem,
  respostaAtual,
  rotuloDoPeriodo,
  SEM_GITHUB,
  temRepo,
  TRACO,
  urlDoGithub,
  valorOuPendente,
} from '../repos-format.js';
import { carregarEstilo, pilulaDeCi } from './repos.js';

const SVG = 'http://www.w3.org/2000/svg';
const RELER_MS = 5000;
const CONTRIBUIDORES = 10;

const COR_DO_TIPO = { História: 'repo-k-accent', 'Tarefa técnica': 'repo-k-orange-light', Bug: 'repo-k-error', Spike: 'repo-k-wait', Épico: 'repo-k-pink' };
const CORES_DAS_LINGUAGENS = ['repo-k-accent', 'repo-k-orange-light', 'repo-k-orange-dark', 'repo-k-muted'];

function svg(tag, atributos = {}, ...filhos) {
  const no = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(atributos)) no.setAttribute(k, String(v));
  for (const f of filhos) no.append(f);
  return no;
}

const barraH = (pct, cor) => {
  const i = el('i', { class: cor });
  i.style.setProperty('--w', `${Math.max(0, Math.min(100, pct))}%`);
  return i;
};

const soLeitor = (texto) => el('span', { class: 'repo-sr-only' }, texto);

function card(titulo, direita, ...filhos) {
  return el('section', { class: 'card repo-card' }, el('h2', { class: 'repo-ttl' }, titulo, direita ? el('span', { class: 'repo-ttl-r' }, direita) : null), ...filhos);
}

const nota = (texto) => el('p', { class: 'repo-empty' }, texto);
/** A nota da amostra paginada que não cobre o total: `Por tipo sobre 100 de 240 issues lidas.` */
const amostraParcial = (a, inicio, nome) => (a?.truncado ? el('span', { class: 'repo-note' }, `${inicio} sobre ${inteiro(a.lidos)} de ${inteiro(a.total)} ${nome}.`) : null);

function graficoCommits(semanas) {
  const W = 520;
  const H = 90;
  const n = semanas.length;
  const total = semanas.reduce((s, x) => s + x, 0);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H + 16}`, class: 'repo-chart', role: 'img', 'aria-label': `Commits por semana, ${n} semanas: ${inteiro(total)} no total, ${inteiro(semanas[n - 1])} nesta semana` });
  barras(semanas, W, H).forEach((b, i) => g.append(svg('rect', { x: b.x, y: b.y, width: b.largura, height: b.altura, rx: 1.5, class: i === n - 1 ? 'repo-chart-bar repo-chart-current' : 'repo-chart-bar' })));
  g.append(
    svg('line', { x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, class: 'repo-chart-base' }),
    svg('text', { x: 0, y: H + 13 }, `${n} ${n === 1 ? 'semana' : 'semanas'} atrás`),
    svg('text', { x: W, y: H + 13, 'text-anchor': 'end' }, 'esta semana'),
  );
  return g;
}

function graficoFrequencia(f) {
  const W = 520;
  const H = 120;
  const MEIO = 64;
  const n = f.semanas.length;
  const g = svg('svg', { viewBox: `0 0 ${W} ${H + 14}`, class: 'repo-chart', role: 'img', 'aria-label': `Frequência de código, ${n} semanas: ${comSinal(f.adicionadas, kilo)} linhas adicionadas e ${comSinal(-f.removidas, kilo)} removidas` });
  for (const s of frequencia(f.semanas, W, MEIO, 58, 52)) {
    g.append(svg('rect', { x: s.x, y: s.cima.y, width: s.largura, height: s.cima.altura, rx: 1.5, class: 'repo-chart-add' }), svg('rect', { x: s.x, y: s.baixo.y, width: s.largura, height: s.baixo.altura, rx: 1.5, class: 'repo-chart-rem' }));
  }
  g.append(
    svg('line', { x1: 0, x2: W, y1: MEIO, y2: MEIO, class: 'repo-chart-base' }),
    svg('text', { x: 0, y: H + 12 }, `${n} ${n === 1 ? 'semana' : 'semanas'} atrás`),
    svg('text', { x: W, y: H + 12, 'text-anchor': 'end' }, 'esta semana'),
  );
  return g;
}

export async function mount(area, ctx) {
  carregarEstilo();
  const { owner: dono, repo: nome } = ctx.params;
  let periodo = periodoDe(location.search);
  let dados = null;
  let falha = null;
  let timer = null;
  let pedido = 0;

  // ---------- o cabeçalho: montado uma vez, o segmentado não perde o foco ----------
  const titulo = el('h1', {}, `${dono}/${nome}`);
  const ciLugar = el('span', {});
  const visLugar = el('span', {});
  const botoesPeriodo = PERIODOS.map(([v, rotulo]) => {
    const b = el('button', { type: 'button', 'aria-pressed': String(v === periodo) }, rotulo);
    b.addEventListener('click', () => trocarPeriodo(v));
    return b;
  });
  const abrirNoGithub = el('a', { class: 'btn outline', target: '_blank', rel: 'noopener noreferrer', hidden: true }, icon('external'), 'Abrir no GitHub');
  const chips = el('div', { class: 'repo-chips' });
  const cab = el(
    'header',
    { class: 'repo-head' },
    el(
      'div',
      { class: 'repo-head-l1' },
      el('a', { class: 'repo-back', href: '/ui/repos', 'aria-label': 'Voltar para Repositórios' }, icon('back')),
      titulo,
      ciLugar,
      visLugar,
      el('div', { class: 'repo-head-dir' }, el('div', { class: 'repo-seg', role: 'group', 'aria-label': 'Período' }, ...botoesPeriodo), abrirNoGithub),
    ),
    chips,
  );
  const faixa = el('div', { hidden: true });
  const conteudo = el('div', { class: 'repo-groups' });
  area.replaceChildren(cab, faixa, conteudo);

  function trocarPeriodo(v) {
    if (v === periodo) return;
    periodo = v;
    for (const [i, b] of botoesPeriodo.entries()) b.setAttribute('aria-pressed', String(PERIODOS[i][0] === v));
    history.replaceState(history.state, '', `${location.pathname}?period=${periodInUrl(v)}`);
    dados = null;
    falha = null;
    conteudo.replaceChildren(loading({ label: `Lendo ${rotuloDoPeriodo(v)}…` }));
    read();
  }

  // ---------- os valores ----------
  const valor = (v, campo, formatar) => valorOuPendente(v, dados, campo, formatar).texto;

  function stat(rotulo, campo, v, formatar, sub, nomeIcone, cor) {
    const r = valorOuPendente(v, dados, campo, formatar);
    const tem = v !== null && v !== undefined;
    return el(
      'section',
      { class: 'card repo-stat' },
      el('span', { class: 'repo-stat-label' }, rotulo),
      el('span', { class: `repo-stat-ic ${cor}` }, icon(nomeIcone)),
      el('span', { class: tem ? 'repo-stat-v' : 'repo-stat-v repo-pending' }, r.texto),
      el('span', { class: 'repo-stat-s' }, tem ? sub : ''),
    );
  }

  function chip(nomeIcone, titulo, visivel, leitor = null) {
    return el('span', { class: 'repo-chip', title: titulo }, icon(nomeIcone), visivel, leitor ? soLeitor(leitor) : null);
  }

  function desenharCabecalho() {
    const r = dados?.repo;
    titulo.textContent = r?.completo ?? `${dono}/${nome}`;
    ctx.title(titulo.textContent);
    ciLugar.replaceChildren(...(r?.ci ? [pilulaDeCi(r.ci)] : []));
    visLugar.replaceChildren(...(r ? [el('span', { class: 'repo-chip repo-chip-sans' }, r.visibilidade === 'publico' ? 'público' : 'privado')] : []));
    const url = r ? urlDoGithub(r.url) : null;
    abrirNoGithub.hidden = !url;
    if (url) abrirNoGithub.setAttribute('href', url);
    else abrirNoGithub.removeAttribute('href');
    if (!r) return chips.replaceChildren();
    const agora = Date.now();
    const lista = [
      r.branchPadrao ? chip('branch', 'Branch padrão', r.branchPadrao, ' (branch padrão)') : null,
      chip('star', 'Estrelas', inteiro(r.estrelas), r.estrelas === 1 ? ' estrela' : ' estrelas'),
      chip('subagent', 'Forks', inteiro(r.forks), r.forks === 1 ? ' fork' : ' forks'),
      chip('eye', 'Observadores', inteiro(r.observadores), r.observadores === 1 ? ' observador' : ' observadores'),
      r.release ? chip('tag', 'Última release', `${r.release.tag} · ${ha(r.release.em, agora)}`, ' (última release)') : null,
      r.licenca ? chip('license', 'Licença', r.licenca, ' (licença)') : null,
    ];
    // `replaceChildren` escreveria "null": só os chips que existem.
    chips.replaceChildren(...lista.filter(Boolean));
  }

  function abas(url) {
    const fora = (caminho, nomeIcone, rotulo) =>
      url ? el('a', { href: `${url}/${caminho}`, target: '_blank', rel: 'noopener noreferrer' }, icon(nomeIcone), rotulo) : el('span', {}, icon(nomeIcone), rotulo);
    return el(
      'nav',
      { class: 'repo-tabs', 'aria-label': 'Seções do repositório' },
      el('span', { 'aria-current': 'page' }, icon('analytics'), 'Métricas'),
      fora('issues', 'dot', `Issues (${inteiro(dados.abas.issues)})`),
      fora('pulls', 'git-pull-request', `PRs (${inteiro(dados.abas.prs)})`),
      fora('actions', 'ci', 'CI'),
      // A tela Sessões não filtra por repositório: a busca casa com o diretório, e o clone tem o nome do repo.
      el('a', { href: `/ui/sessions?search=${encodeURIComponent(nome)}`, title: `Sessões cujo diretório tem "${nome}"` }, icon('sessions'), `Sessões (${inteiro(dados.abas.sessoes)})`),
      el('span', { 'aria-disabled': 'true', title: 'As decisões ainda não têm contagem por repositório' }, icon('decision'), 'Decisões'),
    );
  }

  function kpis() {
    const { linhas, commits, prs, issues, ci } = dados;
    const rot = rotuloDoPeriodo(dados.periodo ?? periodo);
    const mediana = (ms, texto) => (ms === null ? 'sem mediana no período' : texto(duracao(ms)));
    const ciSub = ci ? `${inteiro(ci.execucoes)} execuções${ci.duracaoMediaMs === null ? '' : ` · ${duracao(ci.duracaoMediaMs)} médio`}` : '';
    return el(
      'div',
      { class: 'repo-stats repo-stats-6' },
      stat('Linhas', 'linhas', linhas?.total ?? null, mil, linhas ? `${comSinal(linhas.noPeriodo, mil)} em ${rot}` : '', 'lines', 'repo-c-accent'),
      stat('Commits', 'commits', commits?.total ?? null, inteiro, commits ? `~${inteiro(commits.porSemana)} por semana` : '', 'decision', 'repo-c-accent'),
      stat('PRs mergeados', 'prs', prs?.mergeados ?? null, inteiro, prs ? mediana(prs.medianaAteMergeMs, (d) => `merge em ${d} (mediana)`) : '', 'merge', 'repo-c-ok'),
      stat('Issues fechadas', 'issues', issues?.fechadas ?? null, inteiro, issues ? mediana(issues.medianaAteFecharMs, (d) => `fecha em ${d} (mediana)`) : '', 'ok', 'repo-c-ok'),
      stat('Review', 'prs', prs?.medianaAtePrimeiroReviewMs ?? null, duracao, 'até o 1º review (mediana)', 'conversation', 'repo-c-wait'),
      stat('CI verde', 'ci', ci?.taxaVerde ?? null, porcentagem, ciSub, 'ci', 'repo-c-ok'),
    );
  }

  function cardCommits() {
    const c = dados.commits;
    if (!c) return card('Commits por semana', null, nota(valor(null, 'commits')));
    if (!c.semanas.length) return card('Commits por semana', null, nota('Nenhuma semana no período'));
    return card('Commits por semana', `${c.semanas.length} ${c.semanas.length === 1 ? 'semana' : 'semanas'}`, graficoCommits(c.semanas));
  }

  function cardFrequencia() {
    const f = dados.frequencia;
    const t = 'Frequência de código';
    const r = 'linhas adicionadas e removidas por semana';
    if (!f) return card(t, r, nota(valor(null, 'frequencia')));
    if (!f.semanas.length) return card(t, r, nota('Nenhuma semana no período'));
    return card(
      t,
      r,
      graficoFrequencia(f),
      el(
        'div',
        { class: 'repo-leg' },
        el('span', {}, el('span', { class: 'repo-dot repo-k-ok' }), 'Adicionadas ', el('b', {}, comSinal(f.adicionadas, kilo))),
        el('span', {}, el('span', { class: 'repo-dot repo-k-error' }), 'Removidas ', el('b', {}, comSinal(-f.removidas, kilo))),
      ),
    );
  }

  function cardIssues() {
    const i = dados.issues;
    const t = 'Issues fechadas por tipo';
    if (!i) return card(t, 'fechadas · abertas', nota(valor(null, 'issues')));
    if (!i.porTipo.length) return card(t, 'fechadas · abertas', nota('Nenhuma issue no período'));
    const max = Math.max(1, ...i.porTipo.map((x) => x.fechadas));
    return card(
      t,
      'fechadas · abertas',
      el(
        'div',
        {},
        ...i.porTipo.map((x) =>
          el(
            'div',
            { class: 'repo-type' },
            el('span', { class: 'repo-trunc', title: x.tipo }, x.tipo),
            el('div', { class: 'repo-bar', 'aria-hidden': 'true' }, barraH((x.fechadas / max) * 100, COR_DO_TIPO[x.tipo] ?? 'repo-k-muted')),
            el(
              'span',
              { class: 'repo-type-q' },
              el('span', { 'aria-hidden': 'true' }, `${inteiro(x.fechadas)} · ${inteiro(x.abertas)}`),
              soLeitor(`${inteiro(x.fechadas)} ${x.fechadas === 1 ? 'fechada' : 'fechadas'}, ${inteiro(x.abertas)} ${x.abertas === 1 ? 'aberta' : 'abertas'}`),
            ),
          ),
        ),
      ),
      amostraParcial(i.amostra, 'Por tipo', 'issues lidas'),
    );
  }

  function cardPrs() {
    const p = dados.prs;
    const rot = rotuloDoPeriodo(dados.periodo ?? periodo);
    if (!p) return card('Pull requests', rot, nota(valor(null, 'prs')));
    const [m, f, a] = fatias([p.mergeados, p.fechadosSemMerge, p.abertos]);
    const tam = p.tamanhoMediano ? `${comSinal(p.tamanhoMediano.adicionadas)} ${comSinal(-p.tamanhoMediano.removidas)}` : TRACO;
    return card(
      'Pull requests',
      rot,
      el('div', { class: 'repo-bar repo-bar-thick', 'aria-hidden': 'true' }, barraH(m, 'repo-k-ok'), barraH(f, 'repo-k-muted'), barraH(a, 'repo-k-wait')),
      el(
        'div',
        { class: 'repo-leg' },
        el('span', {}, el('span', { class: 'repo-dot repo-k-ok' }), 'Mergeados ', el('b', {}, inteiro(p.mergeados))),
        el('span', {}, el('span', { class: 'repo-dot repo-k-muted' }), 'Fechados sem merge ', el('b', {}, inteiro(p.fechadosSemMerge))),
        el('span', {}, el('span', { class: 'repo-dot repo-k-wait' }), 'Abertos ', el('b', {}, inteiro(p.abertos))),
      ),
      el(
        'div',
        { class: 'repo-leg' },
        el('span', {}, 'Tamanho mediano ', el('b', {}, tam)),
        el('span', {}, 'Rodadas de review ', el('b', {}, decimal(p.rodadasDeReview))),
        el('span', {}, 'Abertos por agentes ', el('b', {}, porcentagem(p.fatiaPorAgentes))),
      ),
      amostraParcial(p.amostra, 'Medianas', 'PRs lidos'),
    );
  }

  function cardLinguagens() {
    const l = dados.linguagens;
    if (!l) return card('Linguagens', 'bytes', nota(valor(null, 'linguagens')));
    const partes = linguagens(l);
    if (!partes.length) return card('Linguagens', 'bytes', nota('Nenhuma linguagem detectada'));
    const cor = (p, i) => (p.nome === 'Outras' ? 'repo-k-border' : CORES_DAS_LINGUAGENS[i]);
    return card(
      'Linguagens',
      'bytes',
      el('div', { class: 'repo-bar repo-bar-thick', 'aria-hidden': 'true' }, ...partes.map((p, i) => barraH(p.pct, cor(p, i)))),
      el('div', { class: 'repo-lang' }, ...partes.map((p, i) => el('span', {}, el('span', { class: `repo-dot ${cor(p, i)}` }), el('span', { class: 'repo-trunc' }, p.nome), el('span', { class: 'repo-lang-pct' }, `${Math.round(p.pct)}%`)))),
    );
  }

  function cardContribuidores() {
    const c = dados.contribuidores;
    if (!c) return card('Quem contribuiu', null, nota(valor(null, 'contribuidores')));
    if (!c.length) return card('Quem contribuiu', null, nota('Ninguém contribuiu no período'));
    return el(
      'div',
      { class: 'card' },
      el(
        'table',
        { class: 'repo-table' },
        el('colgroup', {}, el('col', { class: 'repo-contrib-who' }), el('col', { class: 'repo-contrib-n' }), el('col', { class: 'repo-contrib-n' }), el('col', { class: 'repo-contrib-n' })),
        el(
          'thead',
          {},
          el('tr', {}, el('th', { scope: 'col' }, 'Quem contribuiu'), el('th', { scope: 'col', class: 'repo-dir' }, 'Commits'), el('th', { scope: 'col', class: 'repo-dir' }, 'Adicionadas'), el('th', { scope: 'col', class: 'repo-dir' }, 'Removidas')),
        ),
        el(
          'tbody',
          {},
          ...c.slice(0, CONTRIBUIDORES).map((p) =>
            el(
              'tr',
              {},
              el('td', { title: p.login }, p.login),
              el('td', { class: 'repo-num repo-dir' }, inteiro(p.commits)),
              el('td', { class: 'repo-num repo-dir repo-c-ok' }, comSinal(p.adicionadas, kilo)),
              el('td', { class: 'repo-num repo-dir repo-c-error' }, comSinal(-p.removidas, kilo)),
            ),
          ),
        ),
      ),
    );
  }

  function cardTrafego() {
    const rot = rotuloDoPeriodo(dados.periodo ?? periodo);
    const releases = el(
      'span',
      {},
      'Releases ',
      el('b', {}, valor(dados.releases, 'releases', inteiro)),
      dados.releases !== null && dados.releases !== undefined ? ` em ${rot}` : null,
      dados.releasesNoTotal !== null && dados.releasesNoTotal !== undefined ? ` · ${inteiro(dados.releasesNoTotal)} no total` : null,
    );
    const comunidade = el('span', {}, 'Saúde da comunidade ', el('b', {}, valor(dados.comunidade, 'comunidade', (n) => `${inteiro(n)}%`)));
    // Sem escrita (critério 5 da issue 105), tráfego e alertas somem: só a comunidade.
    if (cardDeTrafego(dados) === 'comunidade') return card('Comunidade', null, el('div', { class: 'repo-leg' }, comunidade, releases));

    const t = dados.trafego ?? null;
    const s = dados.seguranca ?? null;
    const alerta = (rotulo, n) => {
      const cor = !s || n === null ? 'repo-k-muted' : n > 0 ? 'repo-k-wait' : 'repo-k-ok';
      return el('span', {}, el('span', { class: `repo-dot ${cor}` }), `${rotulo} `, el('b', {}, s ? (n === null ? 'desligado' : inteiro(n)) : valor(null, 'seguranca')));
    };
    const origens = !t ? [el('b', {}, valor(null, 'trafego'))] : t.origens.length ? t.origens.flatMap((o, i) => (i ? [', ', el('b', {}, o)] : [el('b', {}, o)])) : [el('b', {}, TRACO)];
    return card(
      'Tráfego e segurança',
      `${t?.dias ?? 14} dias`,
      el(
        'div',
        { class: 'repo-leg' },
        el('span', {}, 'Visitas ', el('b', {}, valor(t?.visitas ?? null, 'trafego', inteiro)), t ? ` (${inteiro(t.unicas)} únicas)` : null),
        el('span', {}, 'Clones ', el('b', {}, valor(t?.clones ?? null, 'trafego', inteiro))),
      ),
      el('div', { class: 'repo-leg' }, el('span', {}, 'Origem: ', ...origens)),
      el('div', { class: 'repo-leg' }, alerta('Alertas do Dependabot', s?.dependabot ?? null), alerta('Code scanning', s?.codeScanning ?? null)),
      el('div', { class: 'repo-leg' }, comunidade, releases),
      el('span', { class: 'repo-note' }, 'Tráfego e alertas só aparecem para quem tem acesso de escrita no repositório.'),
    );
  }

  function metricas() {
    return [
      abas(urlDoGithub(dados.repo.url)),
      kpis(),
      el('div', { class: 'repo-two' }, cardCommits(), cardFrequencia()),
      el('div', { class: 'repo-three' }, cardIssues(), cardPrs(), cardLinguagens()),
      el('div', { class: 'repo-end' }, cardContribuidores(), cardTrafego()),
    ];
  }

  // ---------- os estados ----------
  const tentar = () => (conteudo.replaceChildren(loading()), read());
  const naoEncontrado = () =>
    empty({ icon: 'repos', title: 'Repositório não encontrado', text: `${dono}/${nome} não existe ou a conta do GitHub não tem acesso a ele.`, action: { label: 'Voltar para Repositórios', icon: 'back', onClick: () => ctx.navigate('/ui/repos') } });

  function desenhar() {
    clearTimeout(timer);
    timer = null;
    desenharCabecalho();
    const e = estadoDaTela({ dados, falha, temDado: temRepo(dados) });
    if (e.reler) timer = setTimeout(read, RELER_MS);

    const quando = dados?.atualizadoEm ? new Date(dados.atualizadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
    if (e.faixa === 'conexao') faixa.replaceChildren(errorBand({ title: 'Sem conexão com o núcleo.', text: `${falha.message}. Mostrando a última leitura${quando ? `, de ${quando}` : ''}.`, action: { label: 'Tentar de novo', onClick: () => read() } }));
    else if (e.faixa === 'github') faixa.replaceChildren(errorBand({ title: 'GitHub com problema.', text: `${dados.erro}. Mostrando as métricas${quando ? ` de ${quando}` : ' da última leitura'}.` }));
    else faixa.replaceChildren();
    faixa.hidden = !faixa.firstChild;

    if (e.tela === 'erro') return conteudo.replaceChildren(falha ? error({ text: falha.message, retry: tentar }) : error({ title: 'O GitHub não respondeu', text: dados.erro ?? 'A leitura do repositório falhou.', retry: tentar }));
    if (e.tela === 'carregando') return conteudo.replaceChildren(loading());
    if (e.tela === 'lendo') return conteudo.replaceChildren(loading({ label: 'Lendo o GitHub…' }));
    if (e.tela === 'sem-github') return conteudo.replaceChildren(empty({ icon: 'github', ...SEM_GITHUB }));
    if (e.tela !== 'dados') return conteudo.replaceChildren(naoEncontrado());
    conteudo.replaceChildren(...metricas());
  }

  async function read() {
    clearTimeout(timer);
    timer = null;
    const n = ++pedido;
    const p = periodo;
    // Resposta de um pedido velho ou de um período que a pessoa já trocou: descartada.
    const vale = () => respostaAtual({ pedido: n, ultimo: pedido, periodo: p, periodoAtual: periodo });
    try {
      const d = await ctx.read(`/api/repos/${encodeURIComponent(dono)}/${encodeURIComponent(nome)}?period=${p === '1a' ? '1y' : p}`);
      if (!vale()) return;
      dados = d;
      falha = null;
    } catch (e) {
      if (e?.name === 'AbortError' || !vale()) return;
      falha = e instanceof Error ? e : new Error(String(e));
    }
    desenhar();
  }

  ctx.onChange((mudancas) => {
    if (mudancaInteressa(mudancas, `${dono}/${nome}`)) read();
  });
  ctx.onRestart(() => read());

  conteudo.replaceChildren(loading());
  await read();
  return () => {
    clearTimeout(timer);
    timer = null;
    pedido++;
  };
}
