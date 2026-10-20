// O Feed de atividade (C8, #94): todos os eventos das sessões, ao vivo, com filtros, pausa e uma
// linha aberta com o detalhe. Lê `GET /api/eventos`; o estado (lista, cursor, pausa) está em
// `feed-estado.js`, e esta tela só desenha.
//
// - Primeira leitura (ou filtro novo, ou "Atualizar", ou o núcleo reiniciado): a página do topo.
// - Ao vivo: a cada mudança do long polling, pede `depois=<cursor>` e põe os novos no topo. Um pedido
//   em voo por vez; mudança que chega no meio pede um único pedido a mais no fim.
// - Pausa: a lista congela; o que chega espera e aparece como "N novos", que solta tudo ao retomar.
// - "Mostrar mais": pede `antes=<anteriores>` e põe os mais velhos no fim.

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../estados.js';
import {
  alternar,
  carregar,
  consulta,
  dataHora,
  diaParaIso,
  horaCurta,
  idCurto,
  novoEstado,
  pausar,
  receberAnteriores,
  receberNovos,
  retomar,
  rotaDaSessao,
  STATUS,
  tempoRelativo,
  temFiltro,
  trilha,
} from './feed-estado.js';

const CSS = '/ui/feed.css';
const RELOGIO_MS = 5000;
/** O `limite` padrão de `/api/eventos`: um lote do ao vivo com esse tamanho diz que há mais. */
const LOTE_DO_AO_VIVO = 50;
const DIGITANDO_MS = 300;

function ligarCss() {
  if (document.head.querySelector('link[data-tela="feed"]')) return null;
  const link = el('link', { rel: 'stylesheet', href: CSS, 'data-tela': 'feed' });
  document.head.append(link);
  return link;
}

const ehAbort = (e) => e?.name === 'AbortError';

export async function montar(area, ctx) {
  const css = ligarCss();
  const estado = novoEstado();
  const filtros = {};
  const itens = new Map(); // id → nó da linha (com o detalhe, quando aberta)
  let geracao = 0;
  let pronto = false;
  let emVoo = false;
  let deNovo = false;
  let digitando = null;

  // ---------- cabeçalho ----------

  const botaoPausa = el('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', aoClicar: () => (estado.pausado ? soltar() : congelar()) });
  const botaoAtualizar = el('button', { type: 'button', class: 'btn', aoClicar: () => recarregar() }, icone('atualizar'), 'Atualizar');
  const cab = cabecalho({ icone: 'atividade', titulo: 'Feed de atividade', sub: 'Todos os eventos das sessões, ao vivo', acoes: [botaoPausa, botaoAtualizar] });

  // ---------- sobre ----------

  const sobre = el(
    'details',
    { class: 'cartao feed-sobre' },
    el('summary', {}, icone('info'), el('b', {}, 'Sobre eventos, filtros e agrupamento'), el('span', {}, ' · como ler as pílulas, o ciclo de vida e os filtros')),
    el(
      'div',
      { class: 'feed-sobre-corpo' },
      el('p', {}, 'Cada linha é um evento gravado pelo núcleo, do mais novo para o mais velho. A pílula diz em que estado a sessão ficou depois dele: Ativa, Esperando você, Concluída ou Com erro.'),
      el('p', {}, 'Uma sessão nasce, roda turnos, chama ferramentas e subagentes, e termina. O caminho projeto › sessão › agente diz de onde o evento veio; "Sessão" abre o detalhe dela.'),
      el('p', {}, 'Os filtros se somam. A busca olha o resumo e a ferramenta. Com a pausa, a lista para de mexer e os eventos novos esperam no aviso "novos".'),
    ),
  );

  // ---------- filtros ----------

  const busca = el('input', { type: 'search', class: 'feed-entrada', maxlength: '100', placeholder: 'Buscar no resumo ou na ferramenta…', 'aria-label': 'Buscar no resumo ou na ferramenta' });
  const de = el('input', { type: 'date', class: 'feed-entrada', 'aria-label': 'De' });
  const ate = el('input', { type: 'date', class: 'feed-entrada', 'aria-label': 'Até' });
  const seletor = (rotulo) => el('select', { class: 'feed-chip feed-seletor', 'aria-label': rotulo }, el('option', { value: '' }, rotulo));
  const sStatus = seletor('Status');
  const sTipo = seletor('Tipo de evento');
  const sFerramenta = seletor('Ferramenta');
  const sSessao = seletor('Sessão');
  opcoesDo(sStatus, 'Status', Object.entries(STATUS));

  const cartaoFiltros = el(
    'div',
    { class: 'cartao feed-filtros' },
    el(
      'div',
      { class: 'feed-filtros-linha' },
      el('label', { class: 'feed-campo feed-busca' }, icone('filtro'), busca),
      el('label', { class: 'feed-campo feed-dia' }, icone('calendario'), el('span', {}, 'De'), de),
      el('label', { class: 'feed-campo feed-dia' }, icone('calendario'), el('span', {}, 'Até'), ate),
    ),
    el('div', { class: 'feed-filtros-linha' }, sStatus, sTipo, sFerramenta, sSessao),
  );

  function lerFiltros() {
    filtros.busca = busca.value;
    filtros.de = diaParaIso(de.value);
    filtros.ate = diaParaIso(ate.value, true);
    filtros.status = sStatus.value;
    filtros.tipo = sTipo.value;
    filtros.ferramenta = sFerramenta.value;
    filtros.sessao = sSessao.value;
  }
  const mudouFiltro = () => (lerFiltros(), recarregar());
  busca.addEventListener('input', () => {
    clearTimeout(digitando);
    digitando = setTimeout(mudouFiltro, DIGITANDO_MS);
  });
  for (const c of [de, ate, sStatus, sTipo, sFerramenta, sSessao]) c.addEventListener('change', mudouFiltro);

  /** Troca as opções de um seletor, sem perder a escolhida. */
  function opcoesDo(select, rotulo, pares) {
    const atual = select.value;
    const lista = [...pares];
    if (atual && !lista.some(([v]) => v === atual)) lista.unshift([atual, atual]);
    select.replaceChildren(el('option', { value: '' }, rotulo), ...lista.map(([v, t]) => el('option', { value: v }, t)));
    select.value = atual;
  }

  function atualizarOpcoes(opcoes) {
    if (!opcoes) return;
    opcoesDo(sTipo, 'Tipo de evento', (opcoes.tipos ?? []).map((t) => [t, t]));
    opcoesDo(sFerramenta, 'Ferramenta', (opcoes.ferramentas ?? []).map((t) => [t, t]));
    opcoesDo(sSessao, 'Sessão', (opcoes.sessoes ?? []).map((s) => [s.id, [s.projeto, s.titulo ?? s.id].filter(Boolean).join(' › ')]));
  }

  // ---------- aviso de novos, faixa e corpo ----------

  const aviso = el('button', { type: 'button', class: 'btn contorno feed-novos', hidden: true, aoClicar: () => soltar() });
  const faixa = el('div', { class: 'feed-faixa' });
  const corpo = el('div', { class: 'feed-corpo' });
  const listaEl = el('div', { class: 'feed-lista' });
  const botaoMais = el('button', { type: 'button', class: 'btn contorno feed-mais', aoClicar: () => mostrarMais() }, 'Mostrar mais');
  const cartaoLista = el('div', { class: 'cartao feed-linhas' }, listaEl, el('div', { class: 'feed-pe' }, botaoMais));

  area.replaceChildren(cab, sobre, cartaoFiltros, aviso, faixa, corpo);
  desenharPausa();

  const mostrarCorpo = (no) => corpo.replaceChildren(no);
  const limparFaixa = () => faixa.replaceChildren();
  const mostrarFaixa = (titulo, texto) => faixa.replaceChildren(faixaDeErro({ titulo, texto, acao: { rotulo: 'Atualizar', aoClicar: () => recarregar() } }));

  // ---------- linhas ----------

  function linha(ev) {
    const aberta = estado.aberto === ev.id;
    const rota = rotaDaSessao(ev.sessao?.id);
    const status = STATUS[ev.status] ? ev.status : 'completed';
    const seta = el(
      'button',
      { type: 'button', class: 'feed-seta', 'aria-expanded': aberta ? 'true' : 'false', 'aria-label': aberta ? 'Fechar o detalhe' : 'Abrir o detalhe' },
      icone(aberta ? 'chevron-baixo' : 'chevron-direita'),
    );
    seta.addEventListener('click', (e) => {
      e.stopPropagation();
      abrirFechar(ev.id);
    });
    const caminho = trilha(ev);
    const cabeca = el(
      'div',
      { class: `feed-linha${aberta ? ' feed-aberta' : ''}` },
      seta,
      el('span', { class: 'feed-o mono feed-hora' }, horaCurta(ev.criadoEm)),
      el('span', { class: `badge b-${status}` }, el('span', { class: 'p' }), STATUS[status]),
      el('span', { class: 'feed-o feed-trunc feed-trilha', title: caminho }, caminho),
      el('span', { class: 'feed-trunc feed-resumo', title: ev.resumo ?? ev.tipo ?? '' }, ev.resumo ?? ev.tipo ?? ''),
      ev.ferramenta ? el('span', { class: 'feed-chip' }, ev.ferramenta) : null,
      el('span', { class: 'feed-o feed-rel', title: dataHora(ev.criadoEm) }, tempoRelativo(ev.criadoEm)),
      rota ? el('a', { class: 'btn contorno feed-sessao', href: rota }, 'Sessão', icone('externo')) : null,
    );
    cabeca.addEventListener('click', (e) => {
      if (e.target?.closest?.('a, button')) return;
      abrirFechar(ev.id);
    });
    return cabeca;
  }

  function detalhe(ev) {
    const d = ev.detalhe ?? {};
    const agente = ev.agente ?? {};
    const pares = [
      ['Evento', ev.tipo],
      ['Registrado', dataHora(ev.criadoEm)],
      ['Sessão', ev.sessao?.id],
      ['Agente', [agente.nome, idCurto(agente.id)].filter(Boolean).join(' · ')],
      ['Ferramenta', ev.ferramenta],
      ['Call id', d.callId],
    ];
    const bloco = ev.ferramenta
      ? el('div', { class: 'feed-ferrbloco' }, icone('terminal'), el('span', { class: 'feed-n' }, ev.ferramenta), el('span', { class: 'feed-cmd feed-trunc', title: d.entrada ?? '' }, d.entrada ?? ''))
      : el('p', { class: 'feed-texto' }, ev.resumo ?? d.entrada ?? '—');
    return el(
      'div',
      { class: 'feed-detalhe' },
      el('div', { class: 'cartao feed-bloco' }, el('div', { class: 'olhinho' }, 'Resumo'), bloco, ev.ferramenta && ev.resumo ? el('p', { class: 'feed-texto' }, ev.resumo) : null),
      el('dl', { class: 'feed-kv mono' }, ...pares.flatMap(([k, v]) => [el('dt', {}, k), el('dd', { class: 'feed-trunc', title: v ?? '' }, v || '—')])),
    );
  }

  function item(ev) {
    const no = el('div', { class: 'feed-item', 'data-id': ev.id });
    preencher(no, ev);
    itens.set(ev.id, { no, ev });
    return no;
  }

  function preencher(no, ev) {
    no.replaceChildren(...[linha(ev), estado.aberto === ev.id ? detalhe(ev) : null].filter(Boolean));
  }

  function abrirFechar(id) {
    const antes = estado.aberto;
    alternar(estado, id);
    for (const k of new Set([antes, estado.aberto])) {
      const it = k && itens.get(k);
      if (it) preencher(it.no, it.ev);
    }
  }

  function desenharTudo() {
    itens.clear();
    if (!estado.eventos.length) {
      mostrarCorpo(
        temFiltro(filtros)
          ? vazio({ titulo: 'Nenhum evento com esses filtros', texto: 'Mude ou limpe os filtros para ver mais.' })
          : vazio({ titulo: 'Nenhum evento ainda', texto: 'Os eventos aparecem aqui assim que uma sessão do Claude Code registrar algo.' }),
      );
      return;
    }
    listaEl.replaceChildren(...estado.eventos.map(item));
    botaoMais.hidden = !estado.anteriores;
    mostrarCorpo(cartaoLista);
  }

  function desenharNovos({ entraram, cortados, noTopo }) {
    if (!entraram.length) return;
    if (corpo.firstChild !== cartaoLista || !noTopo) return desenharTudo();
    for (const ev of cortados) {
      itens.get(ev.id)?.no.remove();
      itens.delete(ev.id);
    }
    listaEl.prepend(...entraram.map(item));
    botaoMais.hidden = !estado.anteriores;
  }

  function desenharPausa() {
    botaoPausa.replaceChildren(icone(estado.pausado ? 'retomar' : 'pausar'), estado.pausado ? 'Retomar' : 'Pausar');
    botaoPausa.setAttribute('aria-pressed', estado.pausado ? 'true' : 'false');
    const n = estado.chegados;
    aviso.hidden = !n;
    aviso.textContent = n ? `${n} ${n === 1 ? 'novo' : 'novos'}` : '';
  }

  function congelar() {
    pausar(estado);
    desenharPausa();
  }

  function soltar() {
    desenharNovos(retomar(estado));
    desenharPausa();
  }

  // ---------- leitura ----------

  async function recarregar({ manterLista = false } = {}) {
    const g = ++geracao;
    pronto = false;
    deNovo = false;
    if (!manterLista) mostrarCorpo(carregando({ rotulo: 'Carregando eventos' }));
    try {
      const r = await ctx.ler(consulta(filtros));
      if (g !== geracao) return;
      carregar(estado, r);
      atualizarOpcoes(r.opcoes);
      pronto = true;
      limparFaixa();
      desenharTudo();
      desenharPausa();
    } catch (e) {
      if (ehAbort(e) || g !== geracao) return;
      if (manterLista && corpo.firstChild === cartaoLista) mostrarFaixa('Não deu para reler o feed.', e?.message);
      else mostrarCorpo(erro({ texto: e?.message ?? String(e), tentar: () => recarregar() }));
    }
  }

  async function buscarNovos() {
    if (!pronto) return;
    if (emVoo) return void (deNovo = true);
    emVoo = true;
    const g = geracao;
    try {
      const r = await ctx.ler(consulta(filtros, { depois: estado.cursor }));
      if (g !== geracao) return;
      limparFaixa();
      atualizarOpcoes(r.opcoes);
      desenharNovos(receberNovos(estado, r));
      desenharPausa();
      // Lote cheio: há mais gravado depois deste cursor; pede de novo na hora.
      if ((r.eventos?.length ?? 0) >= LOTE_DO_AO_VIVO) deNovo = true;
    } catch (e) {
      if (ehAbort(e) || g !== geracao) return;
      mostrarFaixa('O ao vivo do feed falhou.', e?.message);
    } finally {
      emVoo = false;
      if (deNovo && !ctx.sinal?.aborted) {
        deNovo = false;
        buscarNovos();
      }
    }
  }

  async function mostrarMais() {
    if (!estado.anteriores) return;
    const g = geracao;
    botaoMais.disabled = true;
    try {
      const r = await ctx.ler(consulta(filtros, { antes: estado.anteriores }));
      if (g !== geracao) return;
      const velhos = receberAnteriores(estado, r);
      listaEl.append(...velhos.map(item));
      botaoMais.hidden = !estado.anteriores;
    } catch (e) {
      if (ehAbort(e) || g !== geracao) return;
      mostrarFaixa('Não deu para ler os eventos mais velhos.', e?.message);
    } finally {
      botaoMais.disabled = false;
    }
  }

  ctx.aoMudar(() => buscarNovos());
  ctx.aoReiniciar(() => recarregar({ manterLista: true }));

  // Evento novo sozinho não é mudança no long polling (só estado, plano, decisão...): o relógio também
  // pergunta pelos novos, para o feed não esperar a próxima mudança de estado.
  const relogio = setInterval(() => {
    if (ctx.aoVivo?.() !== 'sem-conexao') buscarNovos();
    const agora = Date.now();
    for (const { no, ev } of itens.values()) {
      const rel = no.querySelector('.feed-rel');
      if (rel) rel.textContent = tempoRelativo(ev.criadoEm, agora);
    }
  }, RELOGIO_MS);

  function limpar() {
    clearInterval(relogio);
    clearTimeout(digitando);
    css?.remove();
  }
  // Sair durante a primeira carga aborta o sinal antes de a moldura receber a limpeza: liga aqui.
  ctx.sinal?.addEventListener('abort', limpar, { once: true });

  await recarregar();
  if (ctx.sinal?.aborted) limpar();

  return limpar;
}
