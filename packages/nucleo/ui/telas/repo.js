// Repositório (C23, issue 105): as métricas que a API do GitHub dá, num período (30 dias, 90 dias, 1
// ano) que vale para a tela inteira. Lê `GET /api/repos/<dono>/<repo>?periodo=` (src/api/repos-tipos.ts).
//
// - O período mora em `?periodo=` (padrão 90d): trocar reescreve a URL sem histórico novo e relê.
// - Campo `null` vira "—"; se o GitHub ainda calcula (`calculando`) ou o núcleo ainda monta
//   (`carregando`), "calculando…". Número nenhum é inventado.
// - Sem escrita no repositório, `trafego` e `seguranca` não vêm: o card vira "Comunidade".
// - `carregando` ou `calculando`: relê a cada 5 s, além da mudança `repos` do Ao vivo.

import { el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../estados.js';
import {
  barras,
  comSinal,
  decimal,
  duracao,
  fatias,
  frequencia,
  ha,
  inteiro,
  kilo,
  linguagens,
  mil,
  periodoDe,
  PERIODOS,
  porcentagem,
  rotuloDoPeriodo,
  TRACO,
} from '../repos-formato.js';
import { pilulaDeCi } from './repos.js';

const SVG = 'http://www.w3.org/2000/svg';
const RELER_MS = 5000;
const CONTRIBUIDORES = 10;

const COR_DO_TIPO = { História: 'rp-k-accent', 'Tarefa técnica': 'rp-k-laranja-claro', Bug: 'rp-k-erro', Spike: 'rp-k-espera', Épico: 'rp-k-rosa' };
const CORES_DAS_LINGUAGENS = ['rp-k-accent', 'rp-k-laranja-claro', 'rp-k-laranja-escuro', 'rp-k-muted'];

function svg(tag, atributos = {}, ...filhos) {
  const no = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(atributos)) no.setAttribute(k, String(v));
  for (const f of filhos) no.append(f);
  return no;
}

/** Endereço do GitHub vindo do dado: só https, nada de `javascript:`. */
function externo(url) {
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const barraH = (pct, cor) => {
  const i = el('i', { class: cor });
  i.style.setProperty('--w', `${Math.max(0, Math.min(100, pct))}%`);
  return i;
};

function card(titulo, direita, ...filhos) {
  return el('section', { class: 'cartao rp-card' }, el('h2', { class: 'rp-ttl' }, titulo, direita ? el('span', { class: 'r' }, direita) : null), ...filhos);
}

const nota = (texto) => el('p', { class: 'rp-vazio-card' }, texto);
const amostraParcial = (a, nome) => (a?.truncado ? el('span', { class: 'rp-nota' }, `Medianas sobre ${inteiro(a.lidos)} de ${inteiro(a.total)} ${nome} lidos.`) : null);

function graficoCommits(semanas) {
  const W = 520;
  const H = 90;
  const n = semanas.length;
  const total = semanas.reduce((s, x) => s + x, 0);
  const g = svg('svg', { viewBox: `0 0 ${W} ${H + 16}`, class: 'rp-graf', role: 'img', 'aria-label': `Commits por semana, ${n} semanas: ${inteiro(total)} no total, ${inteiro(semanas[n - 1])} nesta semana` });
  barras(semanas, W, H).forEach((b, i) => g.append(svg('rect', { x: b.x, y: b.y, width: b.largura, height: b.altura, rx: 1.5, class: i === n - 1 ? 'barra atual' : 'barra' })));
  g.append(
    svg('line', { x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, class: 'base' }),
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
  const g = svg('svg', { viewBox: `0 0 ${W} ${H + 14}`, class: 'rp-graf', role: 'img', 'aria-label': `Frequência de código, ${n} semanas: ${comSinal(f.adicionadas, kilo)} linhas adicionadas e ${comSinal(-f.removidas, kilo)} removidas` });
  for (const s of frequencia(f.semanas, W, MEIO, 58, 52)) {
    g.append(svg('rect', { x: s.x, y: s.cima.y, width: s.largura, height: s.cima.altura, rx: 1.5, class: 'add' }), svg('rect', { x: s.x, y: s.baixo.y, width: s.largura, height: s.baixo.altura, rx: 1.5, class: 'rem' }));
  }
  g.append(
    svg('line', { x1: 0, x2: W, y1: MEIO, y2: MEIO, class: 'base' }),
    svg('text', { x: 0, y: H + 12 }, `${n} ${n === 1 ? 'semana' : 'semanas'} atrás`),
    svg('text', { x: W, y: H + 12, 'text-anchor': 'end' }, 'esta semana'),
  );
  return g;
}

export async function montar(area, ctx) {
  const { dono, repo: nome } = ctx.params;
  const chave = `${dono}/${nome}`.toLowerCase();
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
  const abrirNoGithub = el('a', { class: 'btn contorno', target: '_blank', rel: 'noopener noreferrer', hidden: true }, icone('externo'), 'Abrir no GitHub');
  const chips = el('div', { class: 'chips' });
  const cab = el(
    'header',
    { class: 'rp-det-cab' },
    el(
      'div',
      { class: 'l1' },
      el('a', { class: 'voltar', href: '/ui/repos', 'aria-label': 'Voltar para Repositórios' }, icone('voltar')),
      titulo,
      ciLugar,
      visLugar,
      el('div', { class: 'dir' }, el('div', { class: 'rp-seg', role: 'group', 'aria-label': 'Período' }, ...botoesPeriodo), abrirNoGithub),
    ),
    chips,
  );
  const faixa = el('div', { hidden: true });
  const conteudo = el('div', { class: 'rp-grupos' });
  area.replaceChildren(cab, faixa, conteudo);

  function trocarPeriodo(v) {
    if (v === periodo) return;
    periodo = v;
    for (const [i, b] of botoesPeriodo.entries()) b.setAttribute('aria-pressed', String(PERIODOS[i][0] === v));
    history.replaceState(history.state, '', `${location.pathname}?periodo=${v}`);
    dados = null;
    falha = null;
    conteudo.replaceChildren(carregando({ rotulo: `Lendo ${rotuloDoPeriodo(v)}…` }));
    ler();
  }

  // ---------- os valores ----------
  const pendente = (campo) => dados.estado === 'carregando' || (dados.calculando ?? []).includes(campo);
  const semValor = (campo) => (pendente(campo) ? 'calculando…' : TRACO);

  function stat(rotulo, campo, valor, sub, nomeIcone, cor) {
    const tem = valor !== null;
    return el(
      'section',
      { class: 'cartao rp-stat' },
      el('span', { class: 'rot' }, rotulo),
      el('span', { class: `ic ${cor}` }, icone(nomeIcone)),
      el('span', { class: tem ? 'v' : 'v calc' }, tem ? valor : semValor(campo)),
      el('span', { class: 's' }, tem ? sub : ''),
    );
  }

  function desenharCabecalho() {
    const r = dados?.repo;
    titulo.textContent = r?.completo ?? `${dono}/${nome}`;
    ctx.titulo(titulo.textContent);
    ciLugar.replaceChildren(...(r?.ci ? [pilulaDeCi(r.ci)] : []));
    visLugar.replaceChildren(...(r ? [el('span', { class: 'rp-chip sans' }, r.visibilidade === 'publico' ? 'público' : 'privado')] : []));
    const url = r ? externo(r.url) : null;
    abrirNoGithub.hidden = !url;
    if (url) abrirNoGithub.setAttribute('href', url);
    if (!r) return chips.replaceChildren();
    const agora = Date.now();
    const lista = [
      r.branchPadrao ? el('span', { class: 'rp-chip', title: 'Branch padrão' }, icone('branch'), r.branchPadrao) : null,
      el('span', { class: 'rp-chip', title: 'Estrelas' }, icone('estrela'), inteiro(r.estrelas)),
      el('span', { class: 'rp-chip', title: 'Forks' }, icone('fork'), inteiro(r.forks)),
      el('span', { class: 'rp-chip', title: 'Observadores' }, icone('olho'), inteiro(r.observadores)),
      r.release ? el('span', { class: 'rp-chip', title: 'Última release' }, icone('tag'), `${r.release.tag} · ${ha(r.release.em, agora)}`) : null,
      r.licenca ? el('span', { class: 'rp-chip', title: 'Licença' }, icone('licenca'), r.licenca) : null,
    ];
    // `replaceChildren` escreveria "null": só os chips que existem.
    chips.replaceChildren(...lista.filter(Boolean));
  }

  function abas(url) {
    const fora = (caminho, nomeIcone, rotulo) =>
      url ? el('a', { href: `${url}/${caminho}`, target: '_blank', rel: 'noopener noreferrer' }, icone(nomeIcone), rotulo) : el('span', {}, icone(nomeIcone), rotulo);
    return el(
      'nav',
      { class: 'rp-abas', 'aria-label': 'Seções do repositório' },
      el('span', { 'aria-current': 'page' }, icone('metricas'), 'Métricas'),
      fora('issues', 'issue', `Issues (${inteiro(dados.abas.issues)})`),
      fora('pulls', 'pr', `PRs (${inteiro(dados.abas.prs)})`),
      fora('actions', 'ci', 'CI'),
      el('a', { href: '/ui/sessoes' }, icone('pasta'), `Sessões (${inteiro(dados.abas.sessoes)})`),
      el('span', { 'aria-disabled': 'true', title: 'As decisões ainda não têm contagem por repositório' }, icone('commit'), 'Decisões'),
    );
  }

  function kpis() {
    const { linhas, commits, prs, issues, ci } = dados;
    const rot = rotuloDoPeriodo(dados.periodo ?? periodo);
    const mediana = (ms, texto) => (ms === null ? 'sem mediana no período' : texto(duracao(ms)));
    return el(
      'div',
      { class: 'rp-stats seis' },
      stat('Linhas', 'linhas', linhas ? mil(linhas.total) : null, linhas ? `${comSinal(linhas.noPeriodo, mil)} em ${rot}` : '', 'linhas', 'rp-c-accent'),
      stat('Commits', 'commits', commits ? inteiro(commits.total) : null, commits ? `~${inteiro(commits.porSemana)} por semana` : '', 'commit', 'rp-c-accent'),
      stat('PRs mergeados', 'prs', prs ? inteiro(prs.mergeados) : null, prs ? mediana(prs.medianaAteMergeMs, (d) => `merge em ${d} (mediana)`) : '', 'merge', 'rp-c-ok'),
      stat('Issues fechadas', 'issues', issues ? inteiro(issues.fechadas) : null, issues ? mediana(issues.medianaAteFecharMs, (d) => `fecha em ${d} (mediana)`) : '', 'issue-fechada', 'rp-c-ok'),
      stat('Review', 'prs', prs && prs.medianaAtePrimeiroReviewMs !== null ? duracao(prs.medianaAtePrimeiroReviewMs) : null, 'até o 1º review (mediana)', 'review', 'rp-c-espera'),
      stat('CI verde', 'ci', ci && ci.taxaVerde !== null ? porcentagem(ci.taxaVerde) : null, ci ? `${inteiro(ci.execucoes)} execuções · ${duracao(ci.duracaoMediaMs)} médio` : '', 'ci', 'rp-c-ok'),
    );
  }

  function cardCommits() {
    const c = dados.commits;
    if (!c) return card('Commits por semana', null, nota(semValor('commits')));
    if (!c.semanas.length) return card('Commits por semana', null, nota('Nenhuma semana no período'));
    return card('Commits por semana', `${c.semanas.length} ${c.semanas.length === 1 ? 'semana' : 'semanas'}`, graficoCommits(c.semanas));
  }

  function cardFrequencia() {
    const f = dados.frequencia;
    const t = 'Frequência de código';
    const r = 'linhas adicionadas e removidas por semana';
    if (!f) return card(t, r, nota(semValor('frequencia')));
    if (!f.semanas.length) return card(t, r, nota('Nenhuma semana no período'));
    return card(
      t,
      r,
      graficoFrequencia(f),
      el(
        'div',
        { class: 'rp-leg' },
        el('span', {}, el('span', { class: 'rp-ponto rp-k-ok' }), 'Adicionadas ', el('b', {}, comSinal(f.adicionadas, kilo))),
        el('span', {}, el('span', { class: 'rp-ponto rp-k-erro' }), 'Removidas ', el('b', {}, comSinal(-f.removidas, kilo))),
      ),
    );
  }

  function cardIssues() {
    const i = dados.issues;
    const t = 'Issues fechadas por tipo';
    if (!i) return card(t, 'fechadas · abertas', nota(semValor('issues')));
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
            { class: 'rp-ferr' },
            el('span', { class: 'rp-trunc', title: x.tipo }, x.tipo),
            el('div', { class: 'rp-barra-h', 'aria-hidden': 'true' }, barraH((x.fechadas / max) * 100, COR_DO_TIPO[x.tipo] ?? 'rp-k-muted')),
            el('span', { class: 'q', 'aria-label': `${x.fechadas} fechadas, ${x.abertas} abertas` }, `${inteiro(x.fechadas)} · ${inteiro(x.abertas)}`),
          ),
        ),
      ),
      amostraParcial(i.amostra, 'issues'),
    );
  }

  function cardPrs() {
    const p = dados.prs;
    const rot = rotuloDoPeriodo(dados.periodo ?? periodo);
    if (!p) return card('Pull requests', rot, nota(semValor('prs')));
    const [m, f, a] = fatias([p.mergeados, p.fechadosSemMerge, p.abertos]);
    const tam = p.tamanhoMediano ? `${comSinal(p.tamanhoMediano.adicionadas)} ${comSinal(-p.tamanhoMediano.removidas)}` : TRACO;
    return card(
      'Pull requests',
      rot,
      el('div', { class: 'rp-barra-h grossa', 'aria-hidden': 'true' }, barraH(m, 'rp-k-ok'), barraH(f, 'rp-k-muted'), barraH(a, 'rp-k-espera')),
      el(
        'div',
        { class: 'rp-leg' },
        el('span', {}, el('span', { class: 'rp-ponto rp-k-ok' }), 'Mergeados ', el('b', {}, inteiro(p.mergeados))),
        el('span', {}, el('span', { class: 'rp-ponto rp-k-muted' }), 'Fechados sem merge ', el('b', {}, inteiro(p.fechadosSemMerge))),
        el('span', {}, el('span', { class: 'rp-ponto rp-k-espera' }), 'Abertos ', el('b', {}, inteiro(p.abertos))),
      ),
      el(
        'div',
        { class: 'rp-leg' },
        el('span', {}, 'Tamanho mediano ', el('b', {}, tam)),
        el('span', {}, 'Rodadas de review ', el('b', {}, decimal(p.rodadasDeReview))),
        el('span', {}, 'Abertos por agentes ', el('b', {}, porcentagem(p.fatiaPorAgentes))),
      ),
      amostraParcial(p.amostra, 'PRs'),
    );
  }

  function cardLinguagens() {
    const l = dados.linguagens;
    if (!l) return card('Linguagens', 'bytes', nota(semValor('linguagens')));
    const partes = linguagens(l);
    if (!partes.length) return card('Linguagens', 'bytes', nota('Nenhuma linguagem detectada'));
    const cor = (p, i) => (p.nome === 'Outras' ? 'rp-k-borda' : CORES_DAS_LINGUAGENS[i]);
    return card(
      'Linguagens',
      'bytes',
      el('div', { class: 'rp-barra-h grossa', 'aria-hidden': 'true' }, ...partes.map((p, i) => barraH(p.pct, cor(p, i)))),
      el('div', { class: 'rp-ling' }, ...partes.map((p, i) => el('span', {}, el('span', { class: `rp-ponto ${cor(p, i)}` }), el('span', { class: 'rp-trunc' }, p.nome), el('span', { class: 'pct' }, `${Math.round(p.pct)}%`)))),
    );
  }

  function cardContribuidores() {
    const c = dados.contribuidores;
    if (!c) return card('Quem contribuiu', null, nota(semValor('contribuidores')));
    if (!c.length) return card('Quem contribuiu', null, nota('Ninguém contribuiu no período'));
    return el(
      'div',
      { class: 'cartao rp-caixa' },
      el(
        'table',
        { class: 'rp-tabela' },
        el(
          'thead',
          {},
          el('tr', {}, el('th', { scope: 'col' }, 'Quem contribuiu'), el('th', { scope: 'col', class: 'dir' }, 'Commits'), el('th', { scope: 'col', class: 'dir' }, 'Adicionadas'), el('th', { scope: 'col', class: 'dir' }, 'Removidas')),
        ),
        el(
          'tbody',
          {},
          ...c.slice(0, CONTRIBUIDORES).map((p) =>
            el(
              'tr',
              {},
              el('td', {}, p.login),
              el('td', { class: 'num dir' }, inteiro(p.commits)),
              el('td', { class: 'num dir rp-c-ok' }, comSinal(p.adicionadas, kilo)),
              el('td', { class: 'num dir rp-c-erro' }, comSinal(-p.removidas, kilo)),
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
      el('b', {}, inteiro(dados.releases)),
      dados.releases !== null ? ` em ${rot}` : null,
      dados.releasesNoTotal !== null && dados.releasesNoTotal !== undefined ? ` · ${inteiro(dados.releasesNoTotal)} no total` : null,
    );
    const comunidade = el('span', {}, 'Saúde da comunidade ', el('b', {}, dados.comunidade === null ? TRACO : `${inteiro(dados.comunidade)}%`));
    const { trafego: t, seguranca: s } = dados;
    // Sem escrita as chaves não vêm (critério 5 da issue 105): a parte de tráfego e segurança some.
    if (!t && !s) return card('Comunidade', null, el('div', { class: 'rp-leg' }, comunidade, releases));
    const alerta = (rotulo, n) =>
      el('span', {}, el('span', { class: `rp-ponto ${n === null ? 'rp-k-muted' : n > 0 ? 'rp-k-espera' : 'rp-k-ok'}` }), `${rotulo} `, el('b', {}, n === null ? 'desligado' : inteiro(n)));
    const origens = t?.origens.length ? t.origens.flatMap((o, i) => (i ? [', ', el('b', {}, o)] : [el('b', {}, o)])) : [el('b', {}, TRACO)];
    return card(
      t ? 'Tráfego e segurança' : 'Segurança',
      t ? `${t.dias} dias` : null,
      t ? el('div', { class: 'rp-leg' }, el('span', {}, 'Visitas ', el('b', {}, inteiro(t.visitas)), ` (${inteiro(t.unicas)} únicas)`), el('span', {}, 'Clones ', el('b', {}, inteiro(t.clones)))) : null,
      t ? el('div', { class: 'rp-leg' }, el('span', {}, 'Origem: ', ...origens)) : null,
      s ? el('div', { class: 'rp-leg' }, alerta('Alertas do Dependabot', s.dependabot), alerta('Code scanning', s.codeScanning)) : null,
      el('div', { class: 'rp-leg' }, comunidade, releases),
      el('span', { class: 'rp-nota' }, 'Tráfego e alertas só aparecem para quem tem acesso de escrita no repositório.'),
    );
  }

  function metricas() {
    return [
      abas(externo(dados.repo.url)),
      kpis(),
      el('div', { class: 'rp-duas' }, cardCommits(), cardFrequencia()),
      el('div', { class: 'rp-tres' }, cardIssues(), cardPrs(), cardLinguagens()),
      el('div', { class: 'rp-fim' }, cardContribuidores(), cardTrafego()),
    ];
  }

  // ---------- os estados ----------
  const tentar = () => (conteudo.replaceChildren(carregando()), ler());

  function desenhar() {
    clearTimeout(timer);
    timer = null;
    desenharCabecalho();
    const r = dados?.repo;
    const quando = dados?.atualizadoEm ? new Date(dados.atualizadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
    if (r && falha) faixa.replaceChildren(faixaDeErro({ titulo: 'Sem conexão com o núcleo.', texto: `${falha.message}. Mostrando a última leitura${quando ? `, de ${quando}` : ''}.`, acao: { rotulo: 'Tentar de novo', aoClicar: () => ler() } }));
    else if (r && dados.erro) faixa.replaceChildren(faixaDeErro({ titulo: 'GitHub com problema.', texto: `${dados.erro}. Mostrando as métricas${quando ? ` de ${quando}` : ' da última leitura'}.` }));
    else faixa.replaceChildren();
    faixa.hidden = !faixa.firstChild;

    if (!r) {
      if (falha) return conteudo.replaceChildren(erro({ texto: falha.message, tentar }));
      if (!dados) return conteudo.replaceChildren(carregando());
      if (dados.estado === 'nao-encontrado')
        return conteudo.replaceChildren(
          vazio({ icone: 'repos', titulo: 'Repositório não encontrado', texto: `${dono}/${nome} não existe ou a conta do GitHub não tem acesso a ele.`, acao: { rotulo: 'Voltar para Repositórios', icone: 'voltar', aoClicar: () => ctx.navegar('/ui/repos') } }),
        );
      if (dados.estado === 'sem-github')
        return conteudo.replaceChildren(vazio({ icone: 'github', titulo: 'O núcleo está sem o GitHub', texto: 'O gh não está instalado ou autenticado nesta máquina, ou o núcleo subiu com --sem-github. Autentique o gh e reinicie o núcleo para ver as métricas.' }));
      if (dados.estado === 'erro') return conteudo.replaceChildren(erro({ titulo: 'O GitHub não respondeu', texto: dados.erro ?? 'A leitura do repositório falhou.', tentar }));
      timer = setTimeout(ler, RELER_MS);
      return conteudo.replaceChildren(carregando({ rotulo: 'Lendo o GitHub…' }));
    }

    if (dados.estado === 'carregando' || dados.calculando?.length) timer = setTimeout(ler, RELER_MS);
    conteudo.replaceChildren(...metricas());
  }

  async function ler() {
    clearTimeout(timer);
    timer = null;
    const n = ++pedido;
    const p = periodo;
    try {
      const d = await ctx.ler(`/api/repos/${encodeURIComponent(dono)}/${encodeURIComponent(nome)}?periodo=${p}`);
      // Resposta de um período que a pessoa já trocou: descartada.
      if (n !== pedido || p !== periodo) return;
      dados = d;
      falha = null;
    } catch (e) {
      if (e?.name === 'AbortError' || n !== pedido || p !== periodo) return;
      falha = e instanceof Error ? e : new Error(String(e));
    }
    desenhar();
  }

  ctx.aoMudar((mudancas) => {
    if (mudancas.some((m) => m.tipo === 'repos' && (m.chave === 'lista' || String(m.chave).toLowerCase() === chave))) ler();
  });
  ctx.aoReiniciar(() => ler());

  conteudo.replaceChildren(carregando());
  await ler();
  return () => {
    clearTimeout(timer);
    timer = null;
    pedido++;
  };
}
