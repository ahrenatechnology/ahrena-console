// Histórico (C15, #33): as sessões encerradas, agrupadas por dia, do mais recente ao mais antigo.
// Busca no cabeçalho, mais dias ao rolar (sem botão) e a ligação depois do `/clear` (3.8).
//
// As funções puras exportadas (rota, datas, valores) não tocam o DOM: os testes as importam no node.

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../estados.js';

/** Quantos dias cada página traz. */
export const DIAS_POR_PAGINA = 7;

const ESPERA_DA_BUSCA_MS = 300;
const ESPERA_DO_AO_VIVO_MS = 500;
const ESPERA_MAXIMA_DO_AO_VIVO_MS = 2000;
/** O tamanho máximo da busca: o núcleo recusa mais que isso (BUSCA_MAXIMA em src/historico/modelo.ts). */
export const BUSCA_MAXIMA = 100;

// ---------- Funções puras ----------

/** A rota da API do histórico, só com os parâmetros presentes. */
export function rotaDoHistorico({ antes = null, busca = '', dias = DIAS_POR_PAGINA } = {}) {
  const partes = [];
  if (antes) partes.push(`antes=${encodeURIComponent(antes)}`);
  if (dias) partes.push(`dias=${encodeURIComponent(dias)}`);
  if (busca) partes.push(`busca=${encodeURIComponent(busca)}`);
  return partes.length ? `/api/historico?${partes.join('&')}` : '/api/historico';
}

const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const mesmoDia = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * O rótulo de um dia (`AAAA-MM-DD`, lido como data local): "Hoje · sábado, 18 out", "Ontem · sexta,
 * 17 out", "quinta, 16 out" e, se o ano não é o de `hoje`, "quinta, 16 out 2025".
 */
export function rotuloDoDia(dia, hoje = new Date()) {
  const [a, m, d] = String(dia).split('-').map(Number);
  const data = new Date(a, m - 1, d);
  // Data inexistente (30 de fevereiro) não volta igual: sai como veio.
  if (!a || !m || !d || data.getFullYear() !== a || data.getMonth() !== m - 1 || data.getDate() !== d) return String(dia);
  const base = `${SEMANA[data.getDay()]}, ${data.getDate()} ${MESES[data.getMonth()]}${data.getFullYear() !== hoje.getFullYear() ? ` ${data.getFullYear()}` : ''}`;
  if (mesmoDia(data, hoje)) return `Hoje · ${base}`;
  if (mesmoDia(data, new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 1))) return `Ontem · ${base}`;
  return base;
}

/** "~US$ 1,96"; abaixo de meio centavo, "<US$ 0,01"; sem valor, "—". */
export function formatarCusto(usd) {
  if (usd === null || usd === undefined || typeof usd !== 'number' || !Number.isFinite(usd)) return '—';
  if (usd > 0 && usd < 0.005) return '<US$ 0,01';
  const [inteiro, centavos] = Math.abs(usd).toFixed(2).split('.');
  const milhar = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `~US$ ${usd < 0 ? '-' : ''}${milhar},${centavos}`;
}

/** "<1 min", "52 min", "1 h 12 min", "2 h"; sem valor, "—". */
export function formatarDuracao(ms) {
  if (ms === null || ms === undefined || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return '<1 min';
  const total = Math.round(ms / 60_000);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const min = total % 60;
  return min ? `${h} h ${min} min` : `${h} h`;
}

/** Os 8 primeiros caracteres do id. */
export const idCurto = (id) => String(id ?? '').slice(0, 8);

/**
 * Ao vivo: a primeira página relida (`novos`) mais os dias já carregados que são mais antigos que o
 * dia mais antigo dela. Primeira página vazia: lista vazia.
 */
export function juntarDias(atuais, novos) {
  if (!novos?.length) return [];
  const maisAntigo = novos[novos.length - 1].dia;
  return [...novos, ...(atuais ?? []).filter((d) => d.dia < maisAntigo)];
}

/** Anexa uma página seguinte: se o primeiro dia novo é o último carregado, as sessões vão juntas. */
export function anexarDias(atuais, novos) {
  const lista = [...(atuais ?? [])];
  for (const dia of novos ?? []) {
    const ultimo = lista[lista.length - 1];
    if (ultimo && ultimo.dia === dia.dia) {
      const ids = new Set(ultimo.sessoes.map((s) => s.id));
      lista[lista.length - 1] = { ...ultimo, sessoes: [...ultimo.sessoes, ...dia.sessoes.filter((s) => !ids.has(s.id))] };
    } else lista.push(dia);
  }
  return lista;
}

// ---------- Peças ----------

const STATUS = {
  completed: 'Concluída',
  error: 'Com erro',
  abandoned: 'Abandonada',
  active: 'Ativa',
  waiting: 'Esperando você',
};

function badge(status) {
  const conhecido = Object.hasOwn(STATUS, status);
  return el('span', { class: `badge b-${conhecido ? status : 'abandoned'}` }, el('span', { class: 'p' }), conhecido ? STATUS[status] : String(status ?? '—'));
}

const rotaDaSessao = (id) => `/ui/sessoes/${encodeURIComponent(id)}`;

function linha(s) {
  const id = String(s.id);
  const anterior = s.anterior
    ? el(
        'div',
        { class: 'o trunc hist-continuou' },
        icone('continuou'),
        ' continuou depois do ',
        el('code', {}, '/clear'),
        ' em ',
        el('a', { class: 'c-accent hist-anterior', href: rotaDaSessao(String(s.anterior.id)) }, s.anterior.titulo || idCurto(s.anterior.id)),
      )
    : null;
  return el(
    'div',
    { class: 'linha hist-linha' },
    badge(s.status),
    el('div', { class: 'trunc hist-bloco' }, el('a', { class: 'hist-alvo', href: rotaDaSessao(id) }, el('b', { class: 'hist-titulo' }, s.titulo || 'Sem título')), ' ', el('span', { class: 'o mono' }, idCurto(id)), anterior),
    el('span', { class: 'o mono trunc hist-projeto' }, s.projeto || '—'),
    el('span', { class: 'o mono trunc hist-modelo' }, s.modelo || '—'),
    el('span', { class: 'o mono hist-duracao' }, formatarDuracao(s.duracaoMs)),
    el('span', { class: 'mono hist-custo' }, formatarCusto(s.custoUsd)),
    el('span', { class: 'c-muted hist-seta' }, icone('seta-direita')),
  );
}

function grupo(dia, hoje) {
  const rotulo = rotuloDoDia(dia.dia, hoje);
  const n = dia.sessoes.length;
  return el(
    'section',
    { class: 'hist-grupo', 'aria-label': rotulo },
    el('h2', { class: 'olhinho hist-dia' }, icone('calendario'), rotulo, el('span', { class: 'n' }, `${n} ${n === 1 ? 'sessão' : 'sessões'}`)),
    el('div', { class: 'cartao linhas' }, ...dia.sessoes.map(linha)),
  );
}

// ---------- Tela ----------

export function montar(area, ctx) {
  const entrada = el('input', { type: 'search', placeholder: 'Buscar…', 'aria-label': 'Buscar no histórico', maxlength: BUSCA_MAXIMA, autocomplete: 'off', spellcheck: 'false' });
  const campo = el('label', { class: 'campo hist-busca' }, icone('buscar'), entrada);
  const cab = cabecalho({ icone: 'historico', titulo: 'Histórico', sub: 'Sessões encerradas, por dia', acoes: [campo] });
  // Três regiões: a faixa do ao vivo, a lista e o rodapé (faixa da página seguinte ou sentinela).
  // As faixas são nós estáveis: um redesenho da lista não as recria nem as anuncia de novo.
  const topo = el('div', { class: 'hist-regiao', hidden: true });
  const lista = el('div', { class: 'hist-regiao' });
  const rodape = el('div', { class: 'hist-regiao', hidden: true });
  const sentinela = el('div', { class: 'hist-sentinela', 'aria-hidden': 'true' });
  const corpo = el('div', { class: 'hist-corpo' }, topo, lista, rodape);
  area.replaceChildren(cab, corpo);

  let busca = '';
  let dias = [];
  let proximo = null;
  let geracao = 0;
  let controle = null; // um por geração: mudar de geração cancela o que ela pediu
  let pronto = false; // a primeira leitura deu certo: o ao vivo pode reler
  let carregandoMais = false;
  let faixaAoVivo = null;
  let faixaMais = null;
  let vezDoAoVivo = 0;
  let esperaBusca = null;
  let esperaAoVivo = null;
  let primeiraPendente = null;
  let encerrada = false;

  const observador =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entradas) => entradas.some((e) => e.isIntersecting) && carregarMais(), { root: area, rootMargin: '0px 0px 300px 0px' })
      : null;

  const abortou = (e) => e?.name === 'AbortError' || encerrada;

  function novaGeracao() {
    controle?.abort();
    controle = new AbortController();
    return ++geracao;
  }

  // O `ctx.ler` põe o sinal da tela antes das opções: o nosso o substituiria, então vão os dois juntos.
  function ler(rota) {
    const sinal = ctx.sinal && typeof AbortSignal.any === 'function' ? AbortSignal.any([ctx.sinal, controle.signal]) : controle.signal;
    return ctx.ler(rota, { signal: sinal });
  }

  function porNa(regiao, no) {
    if (regiao.firstChild !== no || regiao.childNodes.length !== (no ? 1 : 0)) regiao.replaceChildren(...(no ? [no] : []));
    regiao.hidden = !no;
  }

  function focarDepoisDeTentar(link) {
    if (corpo.contains(document.activeElement)) return;
    (link ?? lista.querySelector('a.hist-alvo') ?? entrada).focus();
  }

  function desenharLista() {
    // Quem navega pelo teclado não perde o lugar quando a lista é redesenhada.
    const focado = lista.contains(document.activeElement) ? document.activeElement : null;
    const foco = focado?.matches('a[href]') ? { href: focado.getAttribute('href'), classe: focado.className } : null;

    const hoje = new Date();
    const filhos = [];
    if (!dias.length && (!proximo || !observador)) {
      filhos.push(
        busca
          ? vazio({ titulo: 'Nenhuma sessão encontrada', texto: `Nada com “${busca}” no histórico.` })
          : vazio({ titulo: 'Nenhuma sessão encerrada ainda', texto: 'As sessões aparecem aqui quando terminam.' }),
      );
    } else if (!dias.length) filhos.push(carregando()); // páginas vazias: o sentinela segue buscando
    for (const dia of dias) filhos.push(grupo(dia, hoje));
    lista.replaceChildren(...filhos);

    if (foco) {
      for (const a of lista.querySelectorAll('a[href]')) {
        if (a.getAttribute('href') === foco.href && a.className === foco.classe) {
          a.focus({ preventScroll: true });
          break;
        }
      }
    }
    porNa(topo, faixaAoVivo);
    const comSentinela = !faixaMais && proximo && observador;
    porNa(rodape, faixaMais ?? (comSentinela ? sentinela : null));
    // Observar de novo dispara a checagem: numa tela alta, o sentinela já visível pede a próxima página.
    observador?.disconnect();
    if (comSentinela) observador.observe(sentinela);
  }

  async function recomecar() {
    const g = novaGeracao();
    clearTimeout(esperaAoVivo);
    primeiraPendente = null;
    dias = [];
    proximo = null;
    pronto = false;
    carregandoMais = false;
    faixaAoVivo = null;
    faixaMais = null;
    observador?.disconnect();
    porNa(topo, null);
    porNa(rodape, null);
    lista.replaceChildren(carregando());
    try {
      const r = await ler(rotaDoHistorico({ busca }));
      if (g !== geracao || encerrada) return;
      dias = r?.dias ?? [];
      proximo = r?.proximo ?? null;
      pronto = true;
      desenharLista();
    } catch (e) {
      if (abortou(e) || g !== geracao) return;
      // Status 0: o núcleo não respondeu (o título padrão). Outro status: ele respondeu com erro.
      lista.replaceChildren(erro({ titulo: e?.status ? 'Não deu para ler o histórico' : undefined, texto: e?.message ?? String(e), tentar: recomecar }));
    }
  }

  async function carregarMais() {
    if (!pronto || !proximo || carregandoMais) return;
    const g = geracao;
    carregandoMais = true;
    try {
      const r = await ler(rotaDoHistorico({ antes: proximo, busca }));
      if (g !== geracao || encerrada) return;
      dias = anexarDias(dias, r?.dias ?? []);
      proximo = r?.proximo ?? null;
      faixaMais = null;
    } catch (e) {
      if (abortou(e) || g !== geracao) return;
      faixaMais ??= faixaDeErro({ titulo: 'Não deu para carregar mais dias', texto: e?.message ?? String(e), acao: { rotulo: 'Tentar de novo', aoClicar: tentarMais } });
    }
    carregandoMais = false;
    desenharLista();
  }

  async function tentarMais() {
    const antes = lista.querySelectorAll('a.hist-alvo').length;
    await carregarMais();
    // Deu certo: o foco vai para a primeira sessão que chegou.
    focarDepoisDeTentar(lista.querySelectorAll('a.hist-alvo')[antes]);
  }

  async function releer() {
    if (!pronto) return;
    const g = geracao;
    const vez = ++vezDoAoVivo;
    try {
      const r = await ler(rotaDoHistorico({ busca }));
      if (g !== geracao || vez !== vezDoAoVivo || encerrada) return;
      const novos = r?.dias ?? [];
      const maisAntigo = novos.length ? novos[novos.length - 1].dia : null;
      // Os dias já carregados além da primeira página ficam, e o cursor deles também.
      const guardaAntigos = maisAntigo !== null && dias.some((d) => d.dia < maisAntigo);
      dias = juntarDias(dias, novos);
      if (!guardaAntigos) proximo = r?.proximo ?? null;
      faixaAoVivo = null;
    } catch (e) {
      if (abortou(e) || g !== geracao || vez !== vezDoAoVivo) return;
      faixaAoVivo ??= faixaDeErro({ titulo: 'Não deu para atualizar o histórico', texto: e?.message ?? String(e), acao: { rotulo: 'Tentar de novo', aoClicar: tentarAoVivo } });
    }
    desenharLista();
  }

  async function tentarAoVivo() {
    await releer();
    focarDepoisDeTentar(null);
  }

  entrada.addEventListener('input', () => {
    clearTimeout(esperaBusca);
    esperaBusca = setTimeout(() => {
      const valor = entrada.value.trim();
      if (valor === busca) return;
      busca = valor;
      recomecar();
    }, ESPERA_DA_BUSCA_MS);
  });

  // Espera a rajada de mudanças assentar, mas relê no máximo ESPERA_MAXIMA_DO_AO_VIVO_MS depois da
  // primeira mudança pendente, mesmo que elas não parem.
  ctx.aoMudar((mudancas) => {
    if (!mudancas?.some((m) => m.tipo === 'sessao')) return;
    const agora = Date.now();
    primeiraPendente ??= agora;
    clearTimeout(esperaAoVivo);
    const atraso = Math.max(0, Math.min(ESPERA_DO_AO_VIVO_MS, primeiraPendente + ESPERA_MAXIMA_DO_AO_VIVO_MS - agora));
    esperaAoVivo = setTimeout(() => {
      primeiraPendente = null;
      releer();
    }, atraso);
  });
  // Núcleo reiniciado ou conexão de volta: com a lista no ar, relê sem perder páginas nem rolagem.
  ctx.aoReiniciar(() => (pronto ? releer() : recomecar()));

  recomecar();

  return () => {
    encerrada = true;
    geracao++;
    controle?.abort();
    observador?.disconnect();
    clearTimeout(esperaBusca);
    clearTimeout(esperaAoVivo);
  };
}
