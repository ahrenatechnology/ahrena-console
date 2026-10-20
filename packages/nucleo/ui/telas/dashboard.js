// Dashboard (C1, #27): os seis números, "precisam de você" em destaque, os agentes ativos com os
// subagentes e a atividade recente. Lê `GET /api/dashboard` e `GET /api/attention` (#87).
// O título da inbox conta o `total` da atenção (trava + sua vez), como o C1 e a barra de menus.
//
// As funções sem DOM (formatação e o que cada parte mostra) saem exportadas para o teste.

import { cabecalho, el, icone } from '../dom.js';
import { carregando, erro, faixaDeErro, vazio } from '../estados.js';

const ESTILO = '/ui/dashboard.css';
// As rotas do núcleo, num lugar só. A da atenção é a `ROTA_DA_ATENCAO` de src/api/rota-atencao.ts (#87):
// se o nome mudar lá, muda aqui.
export const ROTA_DO_DASHBOARD = '/api/dashboard';
export const ROTA_DA_ATENCAO = '/api/attention';
/** Releitura depois de uma rajada de mudanças, e a releitura de fundo das idades ("2 min"). */
const ESPERA_MS = 400;
const FUNDO_MS = 30_000;
const NA_INBOX = 4;

export const ROTULO_DO_STATUS = { active: 'Ativa', waiting: 'Esperando você', completed: 'Concluída', error: 'Com erro', abandoned: 'Abandonada' };
const STATUS_DO_SUBAGENTE = { working: 'active', waiting: 'waiting', completed: 'completed', error: 'error' };
const ICONE_DO_MOTIVO = {
  permissao: 'permissao',
  pergunta: 'pergunta',
  plano: 'plano',
  decisao: 'decisao',
  erro: 'erro',
  'sua-vez': 'sua-vez',
  interrompida: 'interrompida',
  'no-prompt': 'no-prompt',
};

// ---------- Formatação ----------

const decimal1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const inteiro = new Intl.NumberFormat('pt-BR');
const dolar = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 412 → "412"; 3200 → "3,2 mil"; 48100 → "48,1 mil"; 2,1 milhões → "2,1 mi". */
export function quantidade(n) {
  if (n < 1000) return inteiro.format(n);
  if (n < 1_000_000) return `${decimal1.format(n / 1000)} mil`;
  return `${decimal1.format(n / 1_000_000)} mi`;
}

/** Sempre com "~": é estimativa. `null` é "sem preço". */
export const custo = (usd) => (usd === null || usd === undefined ? '~US$ —' : `~US$ ${dolar.format(usd)}`);

/** Há quanto tempo, curto: "agora", "12 s", "2 min", "1 h", "3 d". */
export function idade(iso, agora = Date.now()) {
  const s = Math.max(0, Math.floor((agora - Date.parse(iso)) / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

/** "claude-opus-5-5" → "Opus 5.5"; o que não reconhece sai como veio. */
export function nomeDoModelo(id) {
  if (!id) return null;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`;
}

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const emSessoes = (n) => `em ${plural(n, 'sessão', 'sessões')}`;

/** Os seis cards, na ordem do C1. */
export function cards(numeros) {
  const { sessoes, agentes, subagentes, eventos, custo: c } = numeros;
  const detalhe = [sessoes.esperando ? `${sessoes.esperando} esperando` : null, sessoes.comErro ? `${sessoes.comErro} com erro` : null].filter(Boolean);
  return [
    { id: 'sessoes', rotulo: 'Sessões', icone: 'sessoes', cor: 'acento', valor: inteiro.format(sessoes.total), extra: `${sessoes.ativas} ${sessoes.ativas === 1 ? 'ativa' : 'ativas'}`, sub: detalhe.length ? detalhe.join(' · ') : 'nenhuma esperando' },
    { id: 'agentes', rotulo: 'Agentes ativos', icone: 'bot', cor: 'ativa', valor: inteiro.format(agentes.ativos), sub: emSessoes(agentes.sessoes) },
    { id: 'subagentes', rotulo: 'Subagentes ativos', icone: 'subagente', cor: 'acento', valor: inteiro.format(subagentes.ativos), sub: emSessoes(subagentes.sessoes) },
    { id: 'eventos-hoje', rotulo: 'Eventos hoje', icone: 'eventos', cor: 'esperando', valor: quantidade(eventos.hoje), sub: `+${quantidade(eventos.ultimaHora)} na última hora` },
    { id: 'eventos-total', rotulo: 'Eventos no total', icone: 'atividade', cor: 'apagada', valor: quantidade(eventos.total), sub: 'desde a importação' },
    {
      id: 'custo',
      rotulo: 'Custo',
      icone: 'custo',
      cor: 'concluida',
      valor: custo(c.usd),
      sub: c.usd === null ? `sem preço para ${c.semPreco.join(', ')}` : `estimativa · ${c.dias} dias`,
    },
  ];
}

/**
 * Os cartões do "precisam de você": a ordem e o texto da `/api/attention`; o pedido ("Bash: npm run
 * migrate") e o modelo vêm do card do agente, quando a sessão está entre os ativos.
 */
export function cartoesDaInbox(atencao, agentes) {
  const porSessao = new Map((agentes ?? []).map((a) => [a.sessao, a]));
  return atencao.itens.slice(0, NA_INBOX).map((i) => {
    const a = porSessao.get(i.sessao);
    return {
      sessao: i.sessao,
      motivo: i.motivo,
      motivoCurto: i.motivoCurto,
      urgente: i.nivel === 'precisa',
      idade: i.minutos < 1 ? 'agora' : `${i.minutos} min`,
      nome: i.projeto ?? i.titulo,
      texto: (i.motivo === 'permissao' && a?.tarefa) || i.motivoLongo,
      pe: nomeDoModelo(a?.modelo) ?? i.conta?.rotulo ?? '',
      href: `/ui/sessoes/${encodeURIComponent(i.sessao)}`,
    };
  });
}

export const tituloDaInbox = (total) => (total === 0 ? 'Ninguém precisa de você agora' : `${total} ${total === 1 ? 'precisa' : 'precisam'} de você`);

// ---------- Peças ----------

const badge = (status) => el('span', { class: `badge b-${status}` }, el('span', { class: 'p' }), ROTULO_DO_STATUS[status] ?? status);

function chipDoMotivo(c) {
  if (c.motivo === 'erro') return badge('error');
  return el('span', { class: `mot${c.urgente ? '' : ' leve'}` }, icone(ICONE_DO_MOTIVO[c.motivo] ?? 'sua-vez'), c.motivoCurto);
}

function cardDeNumero(c) {
  return el(
    'div',
    { class: 'cartao stat', 'data-card': c.id },
    el('span', { class: 'rot' }, c.rotulo),
    el('span', { class: `ic cor-${c.cor}` }, icone(c.icone)),
    el('span', { class: 'v' }, c.valor, c.extra ? el('small', {}, c.extra) : null),
    el('span', { class: 's' }, c.sub),
  );
}

function inbox(atencao, agentes) {
  const total = atencao.total;
  const titulo = el(
    'div',
    { class: 'ttl' },
    icone('sino'),
    el('span', { class: total ? 'c-esperando' : 'c-apagada' }, tituloDaInbox(total)),
    el('a', { class: 'r', href: '/ui/sessoes' }, 'esperando e com erro · urgentes primeiro', icone('chevron-direita')),
  );
  if (!total) return el('section', { class: 'cartao inbox calma', 'aria-label': 'Precisam de você' }, titulo);
  const mini = cartoesDaInbox(atencao, agentes).map((c) =>
    el(
      'a',
      { class: 'cartao mini', href: c.href, 'data-sessao': c.sessao },
      el('div', { class: 'l1' }, chipDoMotivo(c), el('span', { class: 'idade' }, c.idade)),
      el('div', { class: 'n trunc' }, c.nome),
      el('div', { class: 'x trunc' }, c.texto),
      el('div', { class: 'pe' }, el('span', {}, c.pe), el('b', {}, 'Abrir ›')),
    ),
  );
  return el('section', { class: 'cartao inbox', 'aria-label': 'Precisam de você' }, titulo, el('div', { class: 'grade4' }, ...mini));
}

function arvore(a) {
  return el(
    'ul',
    { class: 'arvore', id: `subs-${a.sessao}` },
    ...a.subagentes.map((s) =>
      el(
        'li',
        { class: 'cartao filho', 'data-subagente': s.id },
        el('span', { class: 'av' }, icone('subagente')),
        el('div', { class: 'trunc' }, el('b', {}, s.tipo ?? 'Subagente'), s.tarefa ? el('span', { class: 'meta' }, ` · ${s.tarefa}`) : null),
        el('span', { class: 'idade' }, idade(s.ate ?? s.desde)),
        badge(STATUS_DO_SUBAGENTE[s.status] ?? 'active'),
      ),
    ),
  );
}

function cardDoAgente(a, abertos, alternar) {
  const n = a.subagentes.length;
  const aberto = n > 0 && abertos.has(a.sessao);
  const ativos = a.subagentes.filter((s) => s.status === 'working').length;
  const exp = n
    ? el('button', { type: 'button', class: `exp${aberto ? ' aberto' : ''}`, 'aria-expanded': String(aberto), 'aria-controls': `subs-${a.sessao}`, 'aria-label': aberto ? 'Esconder os subagentes' : 'Mostrar os subagentes', aoClicar: () => alternar(a.sessao) }, icone('chevron-direita'))
    : el('span', { class: 'exp' }, icone('ponto'));
  const mensagens = a.mensagens.length ? a.mensagens : ['(sem mensagens)'];
  const card = el(
    'a',
    { class: `cartao ac st-${a.status}`, href: `/ui/sessoes/${encodeURIComponent(a.sessao)}`, 'data-sessao': a.sessao },
    el(
      'div',
      { class: 'l1' },
      el('span', { class: 'av' }, icone('bot')),
      el('div', { class: 'trunc' }, el('div', { class: 'tt trunc' }, `Agente principal · ${a.titulo}`), el('div', { class: 'meta trunc' }, [a.projeto, plural(n, 'subagente', 'subagentes'), plural(a.turnos, 'turno', 'turnos')].filter(Boolean).join(' · '))),
      badge(a.status),
    ),
    el('blockquote', {}, ...mensagens.map((m) => el('span', { class: 'trunc' }, m))),
    el(
      'div',
      { class: 'rodape' },
      a.modelo ? el('span', {}, icone('modelo'), nomeDoModelo(a.modelo)) : null,
      el('span', {}, icone('moedas'), custo(a.custoUsd)),
      el('span', {}, icone('relogio'), idade(a.ultimaAtividade)),
      a.tarefa ? el('span', { class: 'trunc tarefa' }, a.tarefa) : null,
      el('span', { class: 'id' }, a.sessao.slice(0, 8)),
    ),
  );
  const subs = n
    ? el('button', { type: 'button', class: 'subs', 'aria-expanded': String(aberto), 'aria-controls': `subs-${a.sessao}`, aoClicar: () => alternar(a.sessao) }, icone('subagente'), plural(n, 'subagente', 'subagentes'), ativos && ativos < n ? ` · ${ativos} ${ativos === 1 ? 'ativo' : 'ativos'}` : null)
    : null;
  return el('div', { class: 'agente' }, exp, el('div', { class: 'coluna' }, card, subs, aberto ? arvore(a) : null));
}

function agentesAtivos(agentes, abertos, alternar) {
  const titulo = el('div', { class: 'ttl' }, 'Agentes ativos');
  if (!agentes.length) return el('div', { class: 'coluna' }, titulo, vazio({ icone: 'bot', titulo: 'Nenhum agente ativo', texto: 'Quando uma sessão estiver aberta, o agente dela aparece aqui.' }));
  return el('div', { class: 'coluna' }, titulo, ...agentes.map((a) => cardDoAgente(a, abertos, alternar)));
}

function atividadeRecente(atividade) {
  const titulo = el('div', { class: 'ttl' }, 'Atividade recente', el('a', { class: 'r', href: '/ui/sessoes' }, 'Ver tudo', icone('seta-direita')));
  if (!atividade.length) return el('div', { class: 'coluna' }, titulo, vazio({ icone: 'atividade', titulo: 'Nada ainda', texto: 'Os eventos das sessões aparecem aqui assim que chegam.' }));
  return el(
    'div',
    { class: 'coluna' },
    titulo,
    el(
      'div',
      { class: 'cartao linhas' },
      ...atividade.map((l) =>
        el(
          'a',
          { class: 'linha', href: `/ui/sessoes/${encodeURIComponent(l.sessao)}`, 'data-sessao': l.sessao },
          badge(l.status),
          el('span', { class: 'trunc' }, l.texto),
          l.projeto ? el('span', { class: 'o mono trunc' }, l.projeto) : null,
          el('span', { class: 't' }, idade(l.em)),
        ),
      ),
    ),
  );
}

function usarEstilo() {
  if (document.querySelector(`link[href="${ESTILO}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href: ESTILO }));
}

// ---------- A tela ----------

export async function montar(area, ctx) {
  usarEstilo();
  const atualizar = el('button', { type: 'button', class: 'btn', aoClicar: () => desenhar() }, icone('atualizar'), 'Atualizar');
  const cab = cabecalho({ icone: 'dashboard', titulo: 'Dashboard', sub: 'O agora das suas sessões', acoes: [atualizar] });
  area.replaceChildren(cab, carregando({ rotulo: 'Lendo as sessões' }));

  const abertos = new Set();
  let ultimo = null;
  let pedido = 0;

  function alternar(sessao) {
    if (abertos.has(sessao)) abertos.delete(sessao);
    else abertos.add(sessao);
    if (ultimo) pintar(ultimo);
  }

  function pintar({ dashboard, atencao }) {
    const partes = [cab, el('div', { class: 'stats' }, ...cards(dashboard.numeros).map(cardDeNumero))];
    if (atencao.ok) partes.push(inbox(atencao.valor, dashboard.agentes));
    else partes.push(faixaDeErro({ titulo: 'Não deu para ler quem precisa de você.', texto: atencao.erro.message, acao: { rotulo: 'Tentar de novo', aoClicar: () => desenhar() } }));
    partes.push(el('div', { class: 'duas' }, agentesAtivos(dashboard.agentes, abertos, alternar), atividadeRecente(dashboard.atividade)));
    area.replaceChildren(...partes);
  }

  async function desenhar() {
    const meu = ++pedido;
    const [d, a] = await Promise.allSettled([ctx.ler(ROTA_DO_DASHBOARD), ctx.ler(ROTA_DA_ATENCAO)]);
    if (meu !== pedido || ctx.sinal.aborted) return;
    if (d.status === 'rejected') {
      if (d.reason?.name === 'AbortError') return;
      ultimo = null;
      area.replaceChildren(cab, erro({ texto: d.reason?.message, tentar: () => desenhar() }));
      return;
    }
    if (a.status === 'rejected' && a.reason?.name === 'AbortError') return;
    const atencao = a.status === 'fulfilled' ? { ok: true, valor: a.value } : { ok: false, erro: a.reason };
    ctx.contador('dashboard', atencao.ok ? atencao.valor.total : 0);
    ultimo = { dashboard: d.value, atencao };
    pintar(ultimo);
  }

  // Uma rajada de mudanças vira uma releitura só.
  let espera = null;
  const relerLogo = () => {
    clearTimeout(espera);
    espera = setTimeout(() => desenhar(), ESPERA_MS);
  };
  ctx.aoMudar(relerLogo);
  ctx.aoReiniciar(() => desenhar());
  const fundo = setInterval(() => desenhar(), FUNDO_MS);

  await desenhar();
  return () => {
    clearTimeout(espera);
    clearInterval(fundo);
  };
}
