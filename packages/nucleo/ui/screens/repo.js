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
  bars,
  trafficCardKind,
  signed,
  decimal,
  duration,
  screenState,
  slices,
  frequency,
  ago,
  integer,
  kilo,
  languages,
  thousand,
  changeMatters,
  periodInUrl,
  periodFrom,
  PERIODS,
  percentage,
  currentResponse,
  periodLabel,
  NO_GITHUB,
  hasRepo,
  DASH,
  githubUrl,
  valueOrPending,
} from '../repos-format.js';
import { loadStyle, ciPill } from './repos.js';

const SVG = 'http://www.w3.org/2000/svg';
const REREAD_MS = 5000;
const CONTRIBUTORS = 10;

const TYPE_COLOR = { História: 'repo-k-accent', 'Tarefa técnica': 'repo-k-orange-light', Bug: 'repo-k-error', Spike: 'repo-k-wait', Épico: 'repo-k-pink' };
const LANGUAGE_COLORS = ['repo-k-accent', 'repo-k-orange-light', 'repo-k-orange-dark', 'repo-k-muted'];

function svg(tag, attributes = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attributes)) node.setAttribute(k, String(v));
  for (const f of children) node.append(f);
  return node;
}

const barH = (pct, color) => {
  const i = el('i', { class: color });
  i.style.setProperty('--w', `${Math.max(0, Math.min(100, pct))}%`);
  return i;
};

const srOnly = (text) => el('span', { class: 'repo-sr-only' }, text);

function card(title, right, ...children) {
  return el('section', { class: 'card repo-card' }, el('h2', { class: 'repo-ttl' }, title, right ? el('span', { class: 'repo-ttl-r' }, right) : null), ...children);
}

const note = (text) => el('p', { class: 'repo-empty' }, text);
/** A nota da amostra paginada que não cobre o total: `Por tipo sobre 100 de 240 issues lidas.` */
const partialSample = (a, start, name) => (a?.truncado ? el('span', { class: 'repo-note' }, `${start} sobre ${integer(a.lidos)} de ${integer(a.total)} ${name}.`) : null);

function commitsChart(weeks) {
  const W = 520;
  const H = 90;
  const n = weeks.length;
  const total = weeks.reduce((s, x) => s + x, 0);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H + 16}`, class: 'repo-chart', role: 'img', 'aria-label': `Commits por semana, ${n} semanas: ${integer(total)} no total, ${integer(weeks[n - 1])} nesta semana` });
  bars(weeks, W, H).forEach((b, i) => g.append(svg('rect', { x: b.x, y: b.y, width: b.largura, height: b.altura, rx: 1.5, class: i === n - 1 ? 'repo-chart-bar repo-chart-current' : 'repo-chart-bar' })));
  g.append(
    svg('line', { x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, class: 'repo-chart-base' }),
    svg('text', { x: 0, y: H + 13 }, `${n} ${n === 1 ? 'semana' : 'semanas'} atrás`),
    svg('text', { x: W, y: H + 13, 'text-anchor': 'end' }, 'esta semana'),
  );
  return g;
}

function frequencyChart(f) {
  const W = 520;
  const H = 120;
  const MIDDLE = 64;
  const n = f.semanas.length;
  const g = svg('svg', { viewBox: `0 0 ${W} ${H + 14}`, class: 'repo-chart', role: 'img', 'aria-label': `Frequência de código, ${n} semanas: ${signed(f.adicionadas, kilo)} linhas adicionadas e ${signed(-f.removidas, kilo)} removidas` });
  for (const s of frequency(f.semanas, W, MIDDLE, 58, 52)) {
    g.append(svg('rect', { x: s.x, y: s.cima.y, width: s.largura, height: s.cima.altura, rx: 1.5, class: 'repo-chart-add' }), svg('rect', { x: s.x, y: s.baixo.y, width: s.largura, height: s.baixo.altura, rx: 1.5, class: 'repo-chart-rem' }));
  }
  g.append(
    svg('line', { x1: 0, x2: W, y1: MIDDLE, y2: MIDDLE, class: 'repo-chart-base' }),
    svg('text', { x: 0, y: H + 12 }, `${n} ${n === 1 ? 'semana' : 'semanas'} atrás`),
    svg('text', { x: W, y: H + 12, 'text-anchor': 'end' }, 'esta semana'),
  );
  return g;
}

export async function mount(area, ctx) {
  loadStyle();
  const { owner: owner, repo: name } = ctx.params;
  let period = periodFrom(location.search);
  let data = null;
  let failure = null;
  let timer = null;
  let request = 0;

  // ---------- o cabeçalho: montado uma vez, o segmentado não perde o foco ----------
  const title = el('h1', {}, `${owner}/${name}`);
  const ciSlot = el('span', {});
  const visSlot = el('span', {});
  const periodButtons = PERIODS.map(([v, label]) => {
    const b = el('button', { type: 'button', 'aria-pressed': String(v === period) }, label);
    b.addEventListener('click', () => switchPeriod(v));
    return b;
  });
  const openOnGithub = el('a', { class: 'btn outline', target: '_blank', rel: 'noopener noreferrer', hidden: true }, icon('external'), 'Abrir no GitHub');
  const chips = el('div', { class: 'repo-chips' });
  const head = el(
    'header',
    { class: 'repo-head' },
    el(
      'div',
      { class: 'repo-head-l1' },
      el('a', { class: 'repo-back', href: '/ui/repos', 'aria-label': 'Voltar para Repositórios' }, icon('back')),
      title,
      ciSlot,
      visSlot,
      el('div', { class: 'repo-head-dir' }, el('div', { class: 'repo-seg', role: 'group', 'aria-label': 'Período' }, ...periodButtons), openOnGithub),
    ),
    chips,
  );
  const band = el('div', { hidden: true });
  const content = el('div', { class: 'repo-groups' });
  area.replaceChildren(head, band, content);

  function switchPeriod(v) {
    if (v === period) return;
    period = v;
    for (const [i, b] of periodButtons.entries()) b.setAttribute('aria-pressed', String(PERIODS[i][0] === v));
    history.replaceState(history.state, '', `${location.pathname}?period=${periodInUrl(v)}`);
    data = null;
    failure = null;
    content.replaceChildren(loading({ label: `Lendo ${periodLabel(v)}…` }));
    read();
  }

  // ---------- os valores ----------
  const value = (v, field, format) => valueOrPending(v, data, field, format).texto;

  function stat(label, field, v, format, sub, iconName, color) {
    const r = valueOrPending(v, data, field, format);
    const has = v !== null && v !== undefined;
    return el(
      'section',
      { class: 'card repo-stat' },
      el('span', { class: 'repo-stat-label' }, label),
      el('span', { class: `repo-stat-ic ${color}` }, icon(iconName)),
      el('span', { class: has ? 'repo-stat-v' : 'repo-stat-v repo-pending' }, r.texto),
      el('span', { class: 'repo-stat-s' }, has ? sub : ''),
    );
  }

  function chip(iconName, title, visible, reader = null) {
    return el('span', { class: 'repo-chip', title: title }, icon(iconName), visible, reader ? srOnly(reader) : null);
  }

  function drawHeader() {
    const r = data?.repo;
    title.textContent = r?.completo ?? `${owner}/${name}`;
    ctx.title(title.textContent);
    ciSlot.replaceChildren(...(r?.ci ? [ciPill(r.ci)] : []));
    visSlot.replaceChildren(...(r ? [el('span', { class: 'repo-chip repo-chip-sans' }, r.visibilidade === 'publico' ? 'público' : 'privado')] : []));
    const url = r ? githubUrl(r.url) : null;
    openOnGithub.hidden = !url;
    if (url) openOnGithub.setAttribute('href', url);
    else openOnGithub.removeAttribute('href');
    if (!r) return chips.replaceChildren();
    const now = Date.now();
    const list = [
      r.branchPadrao ? chip('branch', 'Branch padrão', r.branchPadrao, ' (branch padrão)') : null,
      chip('star', 'Estrelas', integer(r.estrelas), r.estrelas === 1 ? ' estrela' : ' estrelas'),
      chip('subagent', 'Forks', integer(r.forks), r.forks === 1 ? ' fork' : ' forks'),
      chip('eye', 'Observadores', integer(r.observadores), r.observadores === 1 ? ' observador' : ' observadores'),
      r.release ? chip('tag', 'Última release', `${r.release.tag} · ${ago(r.release.em, now)}`, ' (última release)') : null,
      r.licenca ? chip('license', 'Licença', r.licenca, ' (licença)') : null,
    ];
    // `replaceChildren` escreveria "null": só os chips que existem.
    chips.replaceChildren(...list.filter(Boolean));
  }

  function tabs(url) {
    const outside = (path, iconName, label) =>
      url ? el('a', { href: `${url}/${path}`, target: '_blank', rel: 'noopener noreferrer' }, icon(iconName), label) : el('span', {}, icon(iconName), label);
    return el(
      'nav',
      { class: 'repo-tabs', 'aria-label': 'Seções do repositório' },
      el('span', { 'aria-current': 'page' }, icon('analytics'), 'Métricas'),
      outside('issues', 'dot', `Issues (${integer(data.abas.issues)})`),
      outside('pulls', 'git-pull-request', `PRs (${integer(data.abas.prs)})`),
      outside('actions', 'ci', 'CI'),
      // A tela Sessões não filtra por repositório: a busca casa com o diretório, e o clone tem o nome do repo.
      el('a', { href: `/ui/sessions?search=${encodeURIComponent(name)}`, title: `Sessões cujo diretório tem "${name}"` }, icon('sessions'), `Sessões (${integer(data.abas.sessoes)})`),
      el('span', { 'aria-disabled': 'true', title: 'As decisões ainda não têm contagem por repositório' }, icon('decision'), 'Decisões'),
    );
  }

  function kpis() {
    const { linhas: rows, commits, prs, issues, ci } = data;
    const periodText = periodLabel(data.periodo ?? period);
    const median = (ms, text) => (ms === null ? 'sem mediana no período' : text(duration(ms)));
    const ciSub = ci ? `${integer(ci.execucoes)} execuções${ci.duracaoMediaMs === null ? '' : ` · ${duration(ci.duracaoMediaMs)} médio`}` : '';
    return el(
      'div',
      { class: 'repo-stats repo-stats-6' },
      stat('Linhas', 'linhas', rows?.total ?? null, thousand, rows ? `${signed(rows.noPeriodo, thousand)} em ${periodText}` : '', 'lines', 'repo-c-accent'),
      stat('Commits', 'commits', commits?.total ?? null, integer, commits ? `~${integer(commits.porSemana)} por semana` : '', 'decision', 'repo-c-accent'),
      stat('PRs mergeados', 'prs', prs?.mergeados ?? null, integer, prs ? median(prs.medianaAteMergeMs, (d) => `merge em ${d} (mediana)`) : '', 'merge', 'repo-c-ok'),
      stat('Issues fechadas', 'issues', issues?.fechadas ?? null, integer, issues ? median(issues.medianaAteFecharMs, (d) => `fecha em ${d} (mediana)`) : '', 'ok', 'repo-c-ok'),
      stat('Review', 'prs', prs?.medianaAtePrimeiroReviewMs ?? null, duration, 'até o 1º review (mediana)', 'conversation', 'repo-c-wait'),
      stat('CI verde', 'ci', ci?.taxaVerde ?? null, percentage, ciSub, 'ci', 'repo-c-ok'),
    );
  }

  function commitsCard() {
    const c = data.commits;
    if (!c) return card('Commits por semana', null, note(value(null, 'commits')));
    if (!c.semanas.length) return card('Commits por semana', null, note('Nenhuma semana no período'));
    return card('Commits por semana', `${c.semanas.length} ${c.semanas.length === 1 ? 'semana' : 'semanas'}`, commitsChart(c.semanas));
  }

  function frequencyCard() {
    const f = data.frequencia;
    const t = 'Frequência de código';
    const r = 'linhas adicionadas e removidas por semana';
    if (!f) return card(t, r, note(value(null, 'frequencia')));
    if (!f.semanas.length) return card(t, r, note('Nenhuma semana no período'));
    return card(
      t,
      r,
      frequencyChart(f),
      el(
        'div',
        { class: 'repo-leg' },
        el('span', {}, el('span', { class: 'repo-dot repo-k-ok' }), 'Adicionadas ', el('b', {}, signed(f.adicionadas, kilo))),
        el('span', {}, el('span', { class: 'repo-dot repo-k-error' }), 'Removidas ', el('b', {}, signed(-f.removidas, kilo))),
      ),
    );
  }

  function issuesCard() {
    const i = data.issues;
    const t = 'Issues fechadas por tipo';
    if (!i) return card(t, 'fechadas · abertas', note(value(null, 'issues')));
    if (!i.porTipo.length) return card(t, 'fechadas · abertas', note('Nenhuma issue no período'));
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
            el('div', { class: 'repo-bar', 'aria-hidden': 'true' }, barH((x.fechadas / max) * 100, TYPE_COLOR[x.tipo] ?? 'repo-k-muted')),
            el(
              'span',
              { class: 'repo-type-q' },
              el('span', { 'aria-hidden': 'true' }, `${integer(x.fechadas)} · ${integer(x.abertas)}`),
              srOnly(`${integer(x.fechadas)} ${x.fechadas === 1 ? 'fechada' : 'fechadas'}, ${integer(x.abertas)} ${x.abertas === 1 ? 'aberta' : 'abertas'}`),
            ),
          ),
        ),
      ),
      partialSample(i.amostra, 'Por tipo', 'issues lidas'),
    );
  }

  function prsCard() {
    const p = data.prs;
    const periodText = periodLabel(data.periodo ?? period);
    if (!p) return card('Pull requests', periodText, note(value(null, 'prs')));
    const [m, f, a] = slices([p.mergeados, p.fechadosSemMerge, p.abertos]);
    const size = p.tamanhoMediano ? `${signed(p.tamanhoMediano.adicionadas)} ${signed(-p.tamanhoMediano.removidas)}` : DASH;
    return card(
      'Pull requests',
      periodText,
      el('div', { class: 'repo-bar repo-bar-thick', 'aria-hidden': 'true' }, barH(m, 'repo-k-ok'), barH(f, 'repo-k-muted'), barH(a, 'repo-k-wait')),
      el(
        'div',
        { class: 'repo-leg' },
        el('span', {}, el('span', { class: 'repo-dot repo-k-ok' }), 'Mergeados ', el('b', {}, integer(p.mergeados))),
        el('span', {}, el('span', { class: 'repo-dot repo-k-muted' }), 'Fechados sem merge ', el('b', {}, integer(p.fechadosSemMerge))),
        el('span', {}, el('span', { class: 'repo-dot repo-k-wait' }), 'Abertos ', el('b', {}, integer(p.abertos))),
      ),
      el(
        'div',
        { class: 'repo-leg' },
        el('span', {}, 'Tamanho mediano ', el('b', {}, size)),
        el('span', {}, 'Rodadas de review ', el('b', {}, decimal(p.rodadasDeReview))),
        el('span', {}, 'Abertos por agentes ', el('b', {}, percentage(p.fatiaPorAgentes))),
      ),
      partialSample(p.amostra, 'Medianas', 'PRs lidos'),
    );
  }

  function languagesCard() {
    const l = data.linguagens;
    if (!l) return card('Linguagens', 'bytes', note(value(null, 'linguagens')));
    const parts = languages(l);
    if (!parts.length) return card('Linguagens', 'bytes', note('Nenhuma linguagem detectada'));
    const color = (p, i) => (p.nome === 'Outras' ? 'repo-k-border' : LANGUAGE_COLORS[i]);
    return card(
      'Linguagens',
      'bytes',
      el('div', { class: 'repo-bar repo-bar-thick', 'aria-hidden': 'true' }, ...parts.map((p, i) => barH(p.pct, color(p, i)))),
      el('div', { class: 'repo-lang' }, ...parts.map((p, i) => el('span', {}, el('span', { class: `repo-dot ${color(p, i)}` }), el('span', { class: 'repo-trunc' }, p.nome), el('span', { class: 'repo-lang-pct' }, `${Math.round(p.pct)}%`)))),
    );
  }

  function contributorsCard() {
    const c = data.contribuidores;
    if (!c) return card('Quem contribuiu', null, note(value(null, 'contribuidores')));
    if (!c.length) return card('Quem contribuiu', null, note('Ninguém contribuiu no período'));
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
          ...c.slice(0, CONTRIBUTORS).map((p) =>
            el(
              'tr',
              {},
              el('td', { title: p.login }, p.login),
              el('td', { class: 'repo-num repo-dir' }, integer(p.commits)),
              el('td', { class: 'repo-num repo-dir repo-c-ok' }, signed(p.adicionadas, kilo)),
              el('td', { class: 'repo-num repo-dir repo-c-error' }, signed(-p.removidas, kilo)),
            ),
          ),
        ),
      ),
    );
  }

  function trafficCard() {
    const periodText = periodLabel(data.periodo ?? period);
    const releases = el(
      'span',
      {},
      'Releases ',
      el('b', {}, value(data.releases, 'releases', integer)),
      data.releases !== null && data.releases !== undefined ? ` em ${periodText}` : null,
      data.releasesNoTotal !== null && data.releasesNoTotal !== undefined ? ` · ${integer(data.releasesNoTotal)} no total` : null,
    );
    const community = el('span', {}, 'Saúde da comunidade ', el('b', {}, value(data.comunidade, 'comunidade', (n) => `${integer(n)}%`)));
    // Sem escrita (critério 5 da issue 105), tráfego e alertas somem: só a comunidade.
    if (trafficCardKind(data) === 'comunidade') return card('Comunidade', null, el('div', { class: 'repo-leg' }, community, releases));

    const t = data.trafego ?? null;
    const s = data.seguranca ?? null;
    const alert = (label, n) => {
      const color = !s || n === null ? 'repo-k-muted' : n > 0 ? 'repo-k-wait' : 'repo-k-ok';
      return el('span', {}, el('span', { class: `repo-dot ${color}` }), `${label} `, el('b', {}, s ? (n === null ? 'desligado' : integer(n)) : value(null, 'seguranca')));
    };
    const origins = !t ? [el('b', {}, value(null, 'trafego'))] : t.origens.length ? t.origens.flatMap((o, i) => (i ? [', ', el('b', {}, o)] : [el('b', {}, o)])) : [el('b', {}, DASH)];
    return card(
      'Tráfego e segurança',
      `${t?.dias ?? 14} dias`,
      el(
        'div',
        { class: 'repo-leg' },
        el('span', {}, 'Visitas ', el('b', {}, value(t?.visitas ?? null, 'trafego', integer)), t ? ` (${integer(t.unicas)} únicas)` : null),
        el('span', {}, 'Clones ', el('b', {}, value(t?.clones ?? null, 'trafego', integer))),
      ),
      el('div', { class: 'repo-leg' }, el('span', {}, 'Origem: ', ...origins)),
      el('div', { class: 'repo-leg' }, alert('Alertas do Dependabot', s?.dependabot ?? null), alert('Code scanning', s?.codeScanning ?? null)),
      el('div', { class: 'repo-leg' }, community, releases),
      el('span', { class: 'repo-note' }, 'Tráfego e alertas só aparecem para quem tem acesso de escrita no repositório.'),
    );
  }

  function metrics() {
    return [
      tabs(githubUrl(data.repo.url)),
      kpis(),
      el('div', { class: 'repo-two' }, commitsCard(), frequencyCard()),
      el('div', { class: 'repo-three' }, issuesCard(), prsCard(), languagesCard()),
      el('div', { class: 'repo-end' }, contributorsCard(), trafficCard()),
    ];
  }

  // ---------- os estados ----------
  const retry = () => (content.replaceChildren(loading()), read());
  const notFound = () =>
    empty({ icon: 'repos', title: 'Repositório não encontrado', text: `${owner}/${name} não existe ou a conta do GitHub não tem acesso a ele.`, action: { label: 'Voltar para Repositórios', icon: 'back', onClick: () => ctx.navigate('/ui/repos') } });

  function draw() {
    clearTimeout(timer);
    timer = null;
    drawHeader();
    const e = screenState({ dados: data, falha: failure, temDado: hasRepo(data) });
    if (e.reler) timer = setTimeout(read, REREAD_MS);

    const when = data?.atualizadoEm ? new Date(data.atualizadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
    if (e.faixa === 'conexao') band.replaceChildren(errorBand({ title: 'Sem conexão com o núcleo.', text: `${failure.message}. Mostrando a última leitura${when ? `, de ${when}` : ''}.`, action: { label: 'Tentar de novo', onClick: () => read() } }));
    else if (e.faixa === 'github') band.replaceChildren(errorBand({ title: 'GitHub com problema.', text: `${data.erro}. Mostrando as métricas${when ? ` de ${when}` : ' da última leitura'}.` }));
    else band.replaceChildren();
    band.hidden = !band.firstChild;

    if (e.tela === 'erro') return content.replaceChildren(failure ? error({ text: failure.message, retry }) : error({ title: 'O GitHub não respondeu', text: data.erro ?? 'A leitura do repositório falhou.', retry }));
    if (e.tela === 'carregando') return content.replaceChildren(loading());
    if (e.tela === 'lendo') return content.replaceChildren(loading({ label: 'Lendo o GitHub…' }));
    if (e.tela === 'sem-github') return content.replaceChildren(empty({ icon: 'github', ...NO_GITHUB }));
    if (e.tela !== 'dados') return content.replaceChildren(notFound());
    content.replaceChildren(...metrics());
  }

  async function read() {
    clearTimeout(timer);
    timer = null;
    const n = ++request;
    const p = period;
    // Resposta de um pedido velho ou de um período que a pessoa já trocou: descartada.
    const stillValid = () => currentResponse({ pedido: n, ultimo: request, periodo: p, periodoAtual: period });
    try {
      const d = await ctx.read(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}?period=${p === '1a' ? '1y' : p}`);
      if (!stillValid()) return;
      data = d;
      failure = null;
    } catch (e) {
      if (e?.name === 'AbortError' || !stillValid()) return;
      failure = e instanceof Error ? e : new Error(String(e));
    }
    draw();
  }

  ctx.onChange((changes) => {
    if (changeMatters(changes, `${owner}/${name}`)) read();
  });
  ctx.onRestart(() => read());

  content.replaceChildren(loading());
  await read();
  return () => {
    clearTimeout(timer);
    timer = null;
    request++;
  };
}
