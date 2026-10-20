// Mural ao vivo (C2, #34): um card por sessão aberta nesta máquina, do mesmo tamanho, três por linha.
// Lê `GET /api/mural`, que já vem ordenado pelo núcleo; o seletor Todas/Esperando/Ativas filtra no
// cliente, sem novo pedido. Ao vivo: qualquer mudança relê o mural (com uma pequena espera, para
// juntar a rajada); `aoReiniciar` relê na hora.
//
// As barras são `<progress>`: a largura sai do `value`, sem estilo inline (a CSP bloqueia).
// As funções sem DOM (formatação e o que cada card mostra) saem exportadas para o teste.

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../estados.js';

const ESTILO = '/ui/mural.css';
export const ROTA_DO_MURAL = '/api/mural';
/** Releitura depois de uma rajada de mudanças. */
export const ESPERA_MS = 400;
/** Contexto a partir daqui pinta a barra com a cor de erro. */
export const CONTEXTO_ALTO = 80;

export const ROTULO_DO_STATUS = { active: 'Ativa', waiting: 'Esperando você', completed: 'Concluída', error: 'Com erro', abandoned: 'Abandonada' };
// Os motivos do "esperando", como no wireframe: urgente em negrito, o resto leve.
const MOTIVOS = {
  notification: { rotulo: 'Pede permissão', icone: 'mural-permissao', urgente: true },
  interrupted: { rotulo: 'Interrompida', icone: 'mural-interrompida', urgente: true },
  stop: { rotulo: 'Sua vez', icone: 'mural-sua-vez', urgente: false },
  session_start: { rotulo: 'No prompt', icone: 'mural-prompt', urgente: false },
};
const ESFORCOS = { low: 'baixo', medium: 'médio', high: 'alto', xhigh: 'muito alto', max: 'máximo' };

export const FILTROS = [
  { id: 'todas', rotulo: 'Todas', passa: () => true, vazio: 'Nenhuma sessão aberta' },
  // Os mesmos grupos da `contagem` do núcleo: o erro também precisa de você.
  { id: 'esperando', rotulo: 'Esperando', passa: (c) => c.estado === 'waiting' || c.estado === 'error', vazio: 'Nenhuma sessão esperando você' },
  { id: 'ativas', rotulo: 'Ativas', passa: (c) => ['active', 'delegating', 'background'].includes(c.estado), vazio: 'Nenhuma sessão ativa' },
];

// ---------- Formatação ----------

const dolar = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Em dólar, como no wireframe ("~1,84"), sempre com "~": é estimativa. `null` (uso sem preço) é traço. */
export const custo = (usd) => (usd === null || usd === undefined ? '—' : `~${dolar.format(usd)}`);

/** Só a família: "claude-opus-5-5" → "Opus"; "Sonnet 5.5" → "Sonnet"; sem modelo, traço. */
export function nomeDoModelo(id) {
  const texto = String(id ?? '').trim();
  if (!texto) return '—';
  const familia = /(opus|sonnet|haiku|fable)/i.exec(texto);
  const palavra = familia ? familia[1].toLowerCase() : texto.split(/\s+/)[0];
  return `${palavra[0].toUpperCase()}${palavra.slice(1)}`;
}

/** "high" → "alto"; o que não reconhece sai como veio; sem esforço, traço. */
export const esforco = (e) => (e ? (ESFORCOS[e] ?? e) : '—');

const limitar = (n) => Math.min(100, Math.max(0, Math.round(n)));

/**
 * O que o card mostra, sem DOM. Plano `null` é "Plano 0/0" com a barra vazia (o wireframe desenha
 * assim a sessão sem plano); contexto `null` é "contexto —" com a barra vazia.
 */
export function oQueOCardMostra(c) {
  const plano = c.plano ?? { feitos: 0, total: 0 };
  const pct = c.contexto ? limitar(c.contexto.pct) : null;
  let linha;
  if (c.status === 'waiting') linha = { tipo: 'pede', motivo: MOTIVOS[c.motivo] ?? null, texto: c.atividade?.texto ?? '' };
  else if (c.status === 'error') linha = { tipo: 'erro', texto: c.atividade?.texto ?? '' };
  else if (c.status === 'completed') linha = { tipo: 'concluida', texto: 'Terminou sem erro' };
  else if (c.status === 'abandoned') linha = { tipo: 'parada', texto: c.atividade?.texto ?? '' };
  else linha = { tipo: 'fazendo', texto: c.atividade?.texto ?? '' };
  return {
    id: c.id,
    href: `/ui/sessoes/${encodeURIComponent(c.id)}`,
    status: c.status,
    titulo: c.titulo,
    origem: [c.projeto, c.branch].filter(Boolean).join(' · ') || '—',
    linha,
    grade: [
      ['Modelo', nomeDoModelo(c.modelo)],
      ['Esforço', esforco(c.esforco)],
      ['Agentes', String(c.agentes?.total ?? 0)],
      ['Custo', custo(c.custo?.usd)],
    ],
    agentes: c.agentes ?? { ativos: 0, total: 0 },
    plano: { feitos: plano.feitos, total: plano.total, rotulo: `Plano ${plano.feitos}/${plano.total}`, atual: c.plano?.atual ?? null },
    contexto: { pct, rotulo: pct === null ? 'contexto —' : `contexto ${pct}%`, alto: pct !== null && pct >= CONTEXTO_ALTO },
  };
}

// ---------- Peças ----------

function usarEstilo() {
  if (document.querySelector(`link[href="${ESTILO}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href: ESTILO }));
}

const badge = (status) => el('span', { class: `mu-badge mu-b-${status}` }, el('span', { class: 'p' }), ROTULO_DO_STATUS[status] ?? status);

function linhaDoCard(l) {
  if (l.tipo === 'pede') {
    const chip = l.motivo ? el('span', { class: `mu-mot${l.motivo.urgente ? '' : ' leve'}` }, icone(l.motivo.icone), l.motivo.rotulo) : null;
    return el('div', { class: 'mu-linha' }, chip, el('span', { class: 'mu-trunc mu-apagada' }, l.texto));
  }
  if (l.tipo === 'erro') return el('div', { class: 'mu-linha mu-erro' }, icone('erro'), el('span', { class: 'mu-trunc' }, l.texto));
  if (l.tipo === 'concluida') return el('div', { class: 'mu-linha mu-concluida' }, icone('mural-check'), el('span', { class: 'mu-trunc' }, l.texto));
  if (l.tipo === 'parada') return el('div', { class: 'mu-linha mu-apagada' }, el('span', { class: 'mu-trunc' }, l.texto));
  return el('div', { class: 'mu-linha mu-apagada' }, icone('mural-loader'), el('span', { class: 'mu-trunc' }, l.texto));
}

/** A barra: `<progress>` estilizado, a largura vem do `value`. */
function barra({ valor, max, rotulo, alto = false, tipo }) {
  return el('progress', { class: `mu-barra${alto ? ' alto' : ''}`, 'data-barra': tipo, max: max > 0 ? max : 1, value: max > 0 ? Math.min(valor, max) : 0, 'aria-label': rotulo });
}

function card(c) {
  const v = oQueOCardMostra(c);
  return el(
    'a',
    { class: `cartao mu-card st-${v.status}`, href: v.href, 'data-sessao': v.id },
    el('div', { class: 'mu-l1' }, el('span', { class: 'mu-tt mu-trunc', title: v.titulo }, v.titulo), badge(v.status)),
    el('div', { class: 'mu-pj mu-trunc' }, v.origem),
    linhaDoCard(v.linha),
    el(
      'div',
      { class: 'mu-gr' },
      ...v.grade.map(([rotulo, valor]) =>
        el('div', rotulo === 'Agentes' ? { title: `${v.agentes.ativos} ativos de ${v.agentes.total}` } : rotulo === 'Custo' ? { title: valor === '—' ? 'Sem preço para o modelo' : `US$ ${valor.slice(1)}, estimado` } : {}, rotulo, el('b', { class: 'mu-trunc' }, valor)),
      ),
    ),
    el('div', { class: 'mu-linhaplano' }, el('span', { title: v.plano.atual ?? null }, v.plano.rotulo), el('span', {}, v.contexto.rotulo)),
    el(
      'div',
      { class: 'mu-barras' },
      barra({ tipo: 'plano', valor: v.plano.feitos, max: v.plano.total, rotulo: `Plano: ${v.plano.feitos} de ${v.plano.total}` }),
      barra({ tipo: 'contexto', valor: v.contexto.pct ?? 0, max: 100, alto: v.contexto.alto, rotulo: v.contexto.pct === null ? 'Contexto: sem leitura' : `Contexto: ${v.contexto.pct}%` }),
    ),
  );
}

// ---------- A tela ----------

export async function montar(area, ctx) {
  usarEstilo();
  let filtro = 'todas';
  let mural = null;
  let falha = null;
  let pedido = 0;
  let espera = null;

  // O seletor só com os rótulos, como no wireframe: a `contagem` do núcleo não aparece.
  const botoes = new Map();
  const seletor = el(
    'div',
    { class: 'mu-seg', role: 'group', 'aria-label': 'Filtrar sessões' },
    ...FILTROS.map((f) => {
      const b = el('button', { type: 'button', 'data-filtro': f.id, 'aria-pressed': f.id === filtro ? 'true' : 'false', aoClicar: () => escolher(f.id) }, f.rotulo);
      botoes.set(f.id, b);
      return b;
    }),
  );
  const atualizar = el('button', { type: 'button', class: 'btn', 'data-acao': 'atualizar', aoClicar: () => ler() }, icone('atualizar'), 'Atualizar');
  const cab = cabecalho({ icone: 'mural', titulo: 'Mural ao vivo', sub: 'Um card por sessão aberta nesta máquina', acoes: [seletor, atualizar] });

  function escolher(id) {
    filtro = id;
    for (const [k, b] of botoes) b.setAttribute('aria-pressed', k === id ? 'true' : 'false');
    desenhar();
  }

  function desenhar() {
    if (!mural) {
      area.replaceChildren(cab, falha ? erro({ texto: falha.message, tentar: () => ler() }) : carregando({ rotulo: 'Lendo o mural' }));
      return;
    }
    const f = FILTROS.find((x) => x.id === filtro);
    const cards = (mural.cards ?? []).filter(f.passa);
    const faixa = falha ? faixaDeErro({ titulo: 'O mural não atualizou.', texto: falha.message, acao: { rotulo: 'Tentar de novo', aoClicar: () => ler() } }) : null;
    const nos = cards.map(card);
    const corpo = cards.length
      ? el('div', { class: 'mu-grade' }, ...nos)
      : vazio({ icone: 'mural', titulo: f.vazio, texto: filtro === 'todas' ? 'Abra uma sessão do Claude Code nesta máquina e ela aparece aqui.' : 'Troque o filtro para ver as outras.' });
    // Redesenhar troca os cards: o foco do teclado volta ao card da mesma sessão.
    const focado = globalThis.document?.activeElement?.closest?.('[data-sessao]')?.getAttribute('data-sessao') ?? null;
    area.replaceChildren(...[cab, faixa, corpo].filter(Boolean));
    if (focado) nos.find((n) => n.getAttribute('data-sessao') === focado)?.focus();
  }

  async function ler() {
    const meu = ++pedido;
    try {
      const novo = await ctx.ler(ROTA_DO_MURAL);
      if (meu !== pedido) return;
      mural = novo;
      falha = null;
    } catch (e) {
      if (e?.name === 'AbortError' || meu !== pedido) return;
      falha = e instanceof Error ? e : new Error(String(e));
    }
    desenhar();
  }

  ctx.aoReiniciar(() => ler());
  // Junta a rajada, mas com teto: com atividade contínua, relê no máximo a cada ESPERA_MS.
  ctx.aoMudar(() => {
    espera ??= setTimeout(() => {
      espera = null;
      ler();
    }, ESPERA_MS);
  });

  desenhar();
  await ler();
  return () => clearTimeout(espera);
}
