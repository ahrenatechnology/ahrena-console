// Kanban do projeto (C11): o GitHub Project por Status, ao vivo; arrastar um card muda o Status no GitHub.
//
// - Lê `GET /api/projeto` (o botão Atualizar manda `?forcar=1`) e relê a cada novidade do "Ao vivo":
//   o núcleo guarda o quadro em cache, reler é barato.
// - Arrastar (ou Alt+← / Alt+→ no card focado) é otimista: o card muda de raia na hora e vai
//   `POST /api/projeto/mover`. Se o GitHub recusar, o card volta e a faixa diz por quê. Deu certo, o
//   toast oferece Desfazer, que é outro POST com a raia de antes.
// - A raia "Sem status" (id null) não recebe card: o GitHub não tem como voltar um item para lá.
// - Enquanto um movimento ou um arrasto está em curso, a releitura espera: um quadro lido antes do
//   movimento não pode desfazê-lo na tela.

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../estados.js';

const ROTA = '/api/projeto';
const ROTA_MOVER = '/api/projeto/mover';
const TEMPO_DO_TOAST = 8000;
const ESPERA_DO_AO_VIVO = 1000;
const COMANDO_DO_ESCOPO = 'gh auth refresh -s project';

// O tipo da issue no GitHub vira o rótulo do wireframe; a cor vem da classe.
const TIPOS = new Map([
  ['story', ['História', 'historia']],
  ['user story', ['História', 'historia']],
  ['tech task', ['Tarefa técnica', 'tarefa']],
  ['task', ['Tarefa técnica', 'tarefa']],
  ['spike', ['Spike', 'spike']],
  ['bug', ['Bug', 'bug']],
]);

/** `{ rotulo, classe }` do tipo de um card. Tipo desconhecido sai com o nome cru. */
export function tipoDoCard(card) {
  const cru = typeof card?.tipoDaIssue === 'string' ? card.tipoDaIssue.trim() : '';
  if (cru) {
    const [rotulo, classe] = TIPOS.get(cru.toLowerCase()) ?? [cru, 'outro'];
    return { rotulo, classe };
  }
  if (card?.tipo === 'PullRequest') return { rotulo: 'Pull request', classe: 'outro' };
  if (card?.tipo === 'DraftIssue') return { rotulo: 'Rascunho', classe: 'outro' };
  return { rotulo: 'Issue', classe: 'outro' };
}

const CI = new Map([
  ['ok', ['CI ✓', 'ok']],
  ['falhou', ['CI ✕', 'falhou']],
  ['rodando', ['CI …', 'rodando']],
]);
const REVIEW = new Map([
  ['aprovado', ['aprovado', 'ok']],
  ['ajustes', ['ajustes', 'falhou']],
  ['pendente', ['review', 'rodando']],
]);

/** Os cards de uma raia que passam no filtro de marco (`''` = todos). */
export function filtrar(cards, marco) {
  return marco ? cards.filter((c) => c.marco === marco) : cards;
}

const hora = (ms) => {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;
};

const codigoDe = (e) => e?.corpo?.codigo ?? null;
const comandoDe = (e) => e?.corpo?.comando ?? (codigoDe(e) === 'sem-escopo' ? COMANDO_DO_ESCOPO : null);
const nomeDoCard = (card) => (card.numero != null ? `#${card.numero}` : `“${card.titulo}”`);
const esperaDe = (e) => (e?.tentarEm ? ` Tente de novo em ${Math.ceil(e.tentarEm / 1000)} s.` : '');
const comComando = (no, comando) => (comando ? (no.querySelector('p')?.append(' ', el('code', { class: 'pj-comando mono' }, comando)), no) : no);

export async function montar(area, ctx) {
  let quadro = null; // o último quadro (do núcleo ou com o movimento otimista aplicado)
  let marco = '';
  let falhaDeLeitura = null; // leitura que falhou com um quadro já na tela
  let aviso = null; // movimento recusado: { titulo, texto, comando }
  let toast = null; // { card, nome, de }
  let arrastando = null; // { card, de }
  let emVoo = 0; // movimentos sem resposta
  let lendo = 0; // leituras sem resposta
  let leitura = 0; // a leitura mais nova; as outras são descartadas
  let adiada = null; // releitura que esperou um movimento ou arrasto: { forcar }
  let timerDoToast = null;
  let timerDoAoVivo = null;
  let focar = null; // itemId que recebe o foco no próximo desenho (movimento pelo teclado)
  let chaveDasFaixas = '';

  // ---------- a estrutura (fica de pé entre os redesenhos) ----------

  const seletor = el('select', { class: 'pj-sel', 'aria-label': 'Filtrar por marco' });
  seletor.addEventListener('change', () => {
    marco = seletor.value;
    desenharQuadro();
  });
  const botaoAtualizar = el('button', { type: 'button', class: 'btn', aoClicar: () => desenhar({ forcar: true }) }, icone('atualizar'), 'Atualizar');
  // O cabeçalho fica: a pílula "Ao vivo" é dele, e a moldura a mantém em dia.
  const cab = cabecalho({
    icone: 'github',
    titulo: 'Kanban do projeto',
    sub: 'GitHub Project · por Status · arraste para mudar',
    acoes: [el('label', { class: 'pj-marco' }, el('span', {}, 'Marco:'), seletor, icone('chevron-down')), botaoAtualizar],
  });
  const sub = cab.querySelector('.sub');
  // O toast mora numa região viva fixa, logo depois do cabeçalho: o leitor de tela anuncia o que entra
  // nela, e o Tab chega ao Desfazer sem atravessar o quadro. Foco ou mouse em cima seguram o tempo.
  const caixaDoToast = el('div', { class: 'pj-toast-caixa', role: 'status', 'aria-live': 'polite' });
  caixaDoToast.addEventListener('focusin', () => clearTimeout(timerDoToast));
  caixaDoToast.addEventListener('mouseenter', () => clearTimeout(timerDoToast));
  caixaDoToast.addEventListener('focusout', () => armarToast());
  caixaDoToast.addEventListener('mouseleave', () => armarToast());
  const caixaDasFaixas = el('div', { class: 'pj-faixas', hidden: true });
  const caixaDoQuadro = el('div', { class: 'pj-quadro' });
  let estruturaNaTela = false;

  function desenharCabecalho() {
    if (sub) sub.textContent = `GitHub Project “${quadro.projeto?.titulo ?? ''}” · por Status · arraste para mudar`;
    const marcos = Array.isArray(quadro.marcos) ? quadro.marcos : [];
    if (marco && !marcos.includes(marco)) marco = '';
    seletor.replaceChildren(el('option', { value: '' }, 'Todos os marcos'), ...marcos.map((m) => el('option', { value: m }, m)));
    seletor.value = marco;
  }

  function trocarArea(...nos) {
    estruturaNaTela = false;
    area.replaceChildren(cab, ...nos);
  }

  // ---------- leitura ----------

  async function desenhar({ forcar = false } = {}) {
    // Com um movimento sem resposta ou um card no ar, ler agora traria o quadro de antes: fica para depois.
    if (emVoo || arrastando) {
      adiada = { forcar: forcar || Boolean(adiada?.forcar) };
      return;
    }
    const minha = ++leitura;
    lendo++;
    if (!quadro) trocarArea(carregando({ rotulo: 'Lendo o GitHub Project' }));
    if (forcar) botaoAtualizar.setAttribute('aria-busy', 'true');
    try {
      const novo = await ctx.ler(forcar ? `${ROTA}?forcar=1` : ROTA);
      if (minha !== leitura) return;
      quadro = novo;
      falhaDeLeitura = null;
      desenharQuadro();
    } catch (e) {
      if (e?.name === 'AbortError' || minha !== leitura) return;
      if (quadro) {
        falhaDeLeitura = e;
        desenharQuadro();
      } else desenharFalha(e);
    } finally {
      if (--lendo === 0) botaoAtualizar.removeAttribute('aria-busy');
    }
  }

  /** Lê de novo o que ficou adiado, quando nada mais segura a leitura. */
  function lerAdiada() {
    if (!adiada || emVoo || arrastando) return;
    const { forcar } = adiada;
    adiada = null;
    desenhar({ forcar });
  }

  function desenharFalha(e) {
    const codigo = codigoDe(e);
    if (e?.status === 503 || codigo === 'desligado') {
      trocarArea(
        vazio({
          icone: 'github',
          titulo: 'O núcleo subiu sem GitHub',
          texto: 'Ele foi iniciado com --sem-github, então não há quadro para mostrar. Reinicie o núcleo sem essa opção para ver o Kanban do projeto.',
        }),
      );
      return;
    }
    if (e?.status === 401 || codigo === 'sem-escopo') {
      const caixa = erro({ titulo: 'Falta o escopo project no gh', texto: `${e.message} Rode o comando abaixo e tente de novo.`, tentar: () => desenhar({ forcar: true }) });
      caixa.insertBefore(el('code', { class: 'pj-comando mono' }, comandoDe(e)), caixa.lastChild);
      trocarArea(caixa);
      return;
    }
    const titulo = e?.status === 0 || e?.status === undefined ? undefined : 'GitHub indisponível';
    trocarArea(erro({ titulo, texto: `${e?.message ?? String(e)}${esperaDe(e)}`, tentar: () => desenhar({ forcar: true }) }));
  }

  // ---------- o quadro ----------

  /** As faixas de cima. Só são refeitas quando o que dizem muda: um alerta é anunciado uma vez. */
  function desenharFaixas() {
    const faixas = [];
    if (aviso) faixas.push({ titulo: aviso.titulo, texto: aviso.texto, comando: aviso.comando, acao: { rotulo: 'Fechar', aoClicar: () => ((aviso = null), desenharQuadro()) } });
    if (falhaDeLeitura) {
      faixas.push({
        titulo: 'Não deu para reler o quadro.',
        texto: `${falhaDeLeitura.message} Mostrando a última leitura.${esperaDe(falhaDeLeitura)}`,
        comando: codigoDe(falhaDeLeitura) === 'sem-escopo' ? comandoDe(falhaDeLeitura) : null,
        acao: { rotulo: 'Tentar agora', aoClicar: () => desenhar({ forcar: true }) },
      });
    } else if (quadro.desatualizado) {
      const quando = hora(quadro.lidoEm);
      faixas.push({
        titulo: 'GitHub indisponível.',
        texto: `Mostrando o quadro em cache${quando ? `, de ${quando}` : ''}.${quadro.motivo ? ` ${quadro.motivo}` : ''}`,
        acao: { rotulo: 'Tentar agora', aoClicar: () => desenhar({ forcar: true }) },
      });
    }
    const chave = JSON.stringify(faixas.map(({ titulo, texto, comando }) => [titulo, texto, comando]));
    if (chave === chaveDasFaixas) return;
    chaveDasFaixas = chave;
    if (faixas.length) caixaDasFaixas.removeAttribute('hidden');
    else caixaDasFaixas.setAttribute('hidden', '');
    caixaDasFaixas.replaceChildren(...faixas.map((f) => comComando(faixaDeErro(f), f.comando)));
  }

  function desenharQuadro() {
    if (!quadro) return;
    // Quem estava num card continua nele depois do redesenho (ou no card que acabou de mover).
    const ativo = globalThis.document?.activeElement;
    const itemAtivo = focar ?? ativo?.getAttribute?.('data-item') ?? null;
    desenharCabecalho();
    if (!estruturaNaTela) {
      chaveDasFaixas = null;
      area.replaceChildren(cab, caixaDoToast, caixaDasFaixas, caixaDoQuadro);
      estruturaNaTela = true;
    }
    desenharFaixas();

    const raias = Array.isArray(quadro.raias) ? quadro.raias : [];
    const nos = new Map();
    caixaDoQuadro.replaceChildren(
      raias.length
        ? el('div', { class: 'pj-colunas' }, ...raias.map((raia, i) => coluna(raia, i, raias, nos)))
        : vazio({ icone: 'github', titulo: 'O projeto não tem raias', texto: `O campo ${quadro.projeto?.campo ?? 'Status'} do GitHub Project não tem opções.` }),
    );
    if (itemAtivo && nos.has(itemAtivo)) nos.get(itemAtivo).focus();
  }

  function coluna(raia, indice, raias, nos) {
    const cards = filtrar(Array.isArray(raia.cards) ? raia.cards : [], marco);
    const aceita = raia.id !== null && raia.id !== undefined;
    const col = el(
      'section',
      { class: 'pj-col', 'data-raia': aceita ? raia.id : 'sem-status', 'aria-label': `${raia.nome}: ${cards.length} ${cards.length === 1 ? 'card' : 'cards'}` },
      el('div', { class: 'cab' }, el('span', { class: 'ponto' }), el('span', { class: 'nome' }, raia.nome), el('span', { class: 'n' }, String(cards.length))),
      ...cards.map((card) => {
        const no = cartao(card, raia, indice, raias);
        nos.set(card.itemId, no);
        return no;
      }),
    );
    if (aceita) {
      col.addEventListener('dragover', (ev) => {
        if (!arrastando || arrastando.de === raia.id) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        col.classList.add('alvo');
      });
      col.addEventListener('dragleave', (ev) => {
        // Passar de um card para outro dentro da raia não é sair dela.
        if (ev.relatedTarget && typeof col.contains === 'function' && col.contains(ev.relatedTarget)) return;
        col.classList.remove('alvo');
      });
      col.addEventListener('drop', (ev) => {
        ev.preventDefault();
        col.classList.remove('alvo');
        const indo = arrastando;
        arrastando = null;
        if (indo && indo.de !== raia.id) mover(indo.card.itemId, raia.id);
        else lerAdiada();
      });
    }
    return col;
  }

  function cartao(card, raia, indice, raias) {
    const { rotulo, classe } = tipoDoCard(card);
    const pe = [];
    if (card.subIssues && card.subIssues.total) pe.push(el('span', { title: 'Sub-issues feitas' }, icone('list-checks'), `${card.subIssues.feitas}/${card.subIssues.total}`));
    if (card.pr) {
      pe.push(el('span', { title: 'Pull request' }, icone('git-pull-request'), `#${card.pr.numero}`));
      const ci = CI.get(card.pr.ci);
      const review = REVIEW.get(card.pr.review);
      if (ci) pe.push(el('span', { class: `pj-pill ${ci[1]}` }, ci[0]));
      if (review) pe.push(el('span', { class: `pj-pill ${review[1]}` }, review[0]));
    }
    const no = el(
      'article',
      {
        class: 'cartao pj-card',
        draggable: 'true',
        tabindex: '0',
        'data-item': card.itemId,
        'aria-label': `${rotulo} ${card.numero != null ? `#${card.numero} ` : ''}${card.titulo}, em ${raia.nome}`,
        'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight',
      },
      el(
        'div',
        { class: 'tipo' },
        el('b', { class: `pj-tipo ${classe}` }, rotulo),
        card.numero != null ? el('span', { class: 'num mono' }, `#${card.numero}`) : null,
        el('span', { class: 'grip', title: 'Arraste para outra raia (ou Alt+← / Alt+→)' }, icone('grip-vertical')),
      ),
      el('div', { class: 'tt' }, card.titulo),
      pe.length ? el('div', { class: 'pe' }, ...pe) : null,
    );
    no.addEventListener('dragstart', (ev) => {
      arrastando = { card, de: raia.id ?? null };
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', card.itemId);
      }
      no.classList.add('arrastando');
    });
    no.addEventListener('dragend', () => {
      arrastando = null;
      no.classList.remove('arrastando');
      lerAdiada();
    });
    no.addEventListener('keydown', (ev) => {
      if (!ev.altKey || (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft')) return;
      const passo = ev.key === 'ArrowRight' ? 1 : -1;
      for (let i = indice + passo; i >= 0 && i < raias.length; i += passo) {
        if (raias[i].id === null || raias[i].id === undefined) continue;
        ev.preventDefault();
        mover(card.itemId, raias[i].id, { teclado: true });
        return;
      }
    });
    return no;
  }

  // ---------- mover ----------

  function acharCard(itemId) {
    for (const raia of quadro?.raias ?? []) {
      const i = (raia.cards ?? []).findIndex((c) => c.itemId === itemId);
      if (i >= 0) return { raia, i, card: raia.cards[i] };
    }
    return null;
  }

  /** Muda o card de raia aqui na tela: no fim da raia, ou na posição `onde` (a de antes, ao voltar). */
  function moverAqui(itemId, para, onde = null) {
    const achado = acharCard(itemId);
    const destino = quadro?.raias?.find((r) => r.id === para);
    if (!achado || !destino) return;
    achado.raia.cards.splice(achado.i, 1);
    achado.card.raiaId = para;
    const cards = (destino.cards ??= []);
    cards.splice(onde ?? cards.length, 0, achado.card);
  }

  const nomeDaRaia = (id) => quadro?.raias?.find((r) => r.id === id)?.nome ?? 'Sem status';

  async function mover(itemId, para, { teclado = false } = {}) {
    const antes = acharCard(itemId);
    if (para === null || para === undefined || !antes || antes.raia.id === para) return lerAdiada();
    // Uma leitura em voo saiu antes deste movimento: o que ela trouxer não vale, e relê-se depois.
    if (lendo) {
      leitura++;
      adiada = { forcar: Boolean(adiada?.forcar) };
    }
    // O movimento otimista mexe numa cópia: o quadro que veio da leitura fica como veio.
    quadro = structuredClone(quadro);
    const { card, i: ondeEstava, raia } = acharCard(itemId);
    const de = raia.id ?? null;
    moverAqui(itemId, para);
    aviso = null;
    mostrarToast(null);
    emVoo++;
    focar = teclado ? itemId : null;
    desenharQuadro();
    try {
      const r = await ctx.escrever(ROTA_MOVER, { itemId, optionId: para });
      // Só o último movimento em voo pode trocar o quadro inteiro; os de antes já estão na tela.
      if (r?.quadro && emVoo === 1) quadro = r.quadro;
      else if (emVoo > 1) adiada = { forcar: Boolean(adiada?.forcar) };
      mostrarToast({ card, nome: nomeDaRaia(para), de: r?.movido && r.movido.de !== undefined ? r.movido.de : de });
    } catch (e) {
      if (e?.name === 'AbortError') return;
      moverAqui(itemId, de, ondeEstava);
      const comando = codigoDe(e) === 'sem-escopo' ? comandoDe(e) : null;
      aviso = {
        titulo: `O GitHub não aceitou mover ${nomeDoCard(card)}.`,
        texto: `${e?.message ?? String(e)}${esperaDe(e)} O card voltou para ${nomeDaRaia(de)}.${comando ? ' Rode:' : ''}`,
        comando,
      };
      // O quadro mudou por fora (404, 422) ou outro movimento está em voo: só a releitura acerta a tela.
      if (e?.status === 404 || e?.status === 422 || emVoo > 1) adiada = { forcar: Boolean(adiada?.forcar) };
    } finally {
      emVoo--;
    }
    desenharQuadro();
    focar = null;
    lerAdiada();
  }

  // ---------- toast ----------

  function armarToast() {
    clearTimeout(timerDoToast);
    if (toast) timerDoToast = setTimeout(() => mostrarToast(null), TEMPO_DO_TOAST);
  }

  /** Troca o conteúdo da região viva do toast, sem redesenhar o quadro. */
  function mostrarToast(novo) {
    toast = novo;
    if (!toast) {
      clearTimeout(timerDoToast);
      caixaDoToast.replaceChildren();
      return;
    }
    const { card, de, nome } = toast;
    caixaDoToast.replaceChildren(
      el(
        'div',
        { class: 'pj-toast' },
        icone('check-circle-2'),
        el('span', {}, el('b', {}, nomeDoCard(card)), ' movido para ', el('b', {}, nome), ' no GitHub'),
        de !== null && de !== undefined ? el('button', { type: 'button', class: 'pj-desfazer', aoClicar: () => mover(card.itemId, de, { teclado: true }) }, 'Desfazer') : null,
      ),
    );
    armarToast();
  }

  // ---------- ao vivo ----------

  ctx.aoReiniciar(() => desenhar());
  ctx.aoMudar(() => {
    clearTimeout(timerDoAoVivo);
    timerDoAoVivo = setTimeout(() => desenhar(), ESPERA_DO_AO_VIVO);
  });

  await desenhar();

  return () => {
    clearTimeout(timerDoToast);
    clearTimeout(timerDoAoVivo);
    leitura++;
  };
}
