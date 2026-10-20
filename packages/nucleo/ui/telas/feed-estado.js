// O estado do Feed de atividade (C8, #94), sem DOM: a lista, o cursor do ao vivo, a pausa e as contas
// de tempo. A tela (`feed.js`) desenha o que este módulo decide; o teste exercita os dois.

/** Quantas linhas a lista guarda em memória; o ao vivo corta as mais velhas além disso. */
export const LIMITE = 500;

/** Os status de evento que o núcleo devolve e como a moldura os escreve. */
export const STATUS = {
  active: 'Ativa',
  waiting: 'Esperando você',
  completed: 'Concluída',
  error: 'Com erro',
};

/** O mesmo molde de id que a moldura aceita em `/ui/sessoes/:id`. */
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** O caminho do Detalhe de uma sessão, ou `null` se o id não serve como rota. */
export function rotaDaSessao(id) {
  return typeof id === 'string' && ID.test(id) ? `/ui/sessoes/${encodeURIComponent(id)}` : null;
}

export function novoEstado() {
  return { eventos: [], cursor: null, anteriores: null, pausado: false, pendentes: [], chegados: 0, aberto: null };
}

/** A primeira página (ou a releitura): troca a lista inteira e esvazia o que estava pendente. */
export function carregar(estado, resposta) {
  estado.eventos = [...(resposta.eventos ?? [])].slice(0, LIMITE);
  estado.cursor = resposta.cursor ?? null;
  estado.anteriores = resposta.anteriores ?? null;
  estado.pendentes = [];
  estado.chegados = 0;
  if (estado.aberto && !estado.eventos.some((e) => e.id === estado.aberto)) estado.aberto = null;
}

const ids = (estado) => new Set([...estado.eventos, ...estado.pendentes].map((e) => e.id));

/**
 * Eventos novos do ao vivo (mais novo primeiro). Pausado, eles esperam em `pendentes`; senão entram no
 * topo. Devolve `{ entraram, cortados }`: o que subiu para a lista e o que caiu do fim pelo limite.
 */
export function receberNovos(estado, resposta) {
  if (resposta.cursor) estado.cursor = resposta.cursor;
  const vistos = ids(estado);
  const novos = (resposta.eventos ?? []).filter((e) => !vistos.has(e.id));
  if (estado.pausado) {
    // Guarda só os `LIMITE` mais novos (mais que isso cairia da lista ao retomar), mas conta todos.
    estado.pendentes = [...novos, ...estado.pendentes].slice(0, LIMITE);
    estado.chegados += novos.length;
    return { entraram: [], cortados: [] };
  }
  return subir(estado, novos);
}

/** Mais novo primeiro: `criadoEm` decrescente e, no empate, `id` decrescente (a ordem do núcleo). */
export function maisNovoPrimeiro(a, b) {
  if (a.criadoEm !== b.criadoEm) return a.criadoEm < b.criadoEm ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Os novos entram na lista pela ordem: o evento gravado atrasado (com `criadoEm` mais velho) cai no
 * lugar dele, não no topo. `noTopo` diz se todos ficaram acima dos que já estavam (a tela só antepõe).
 */
function subir(estado, novos) {
  if (!novos.length) return { entraram: [], cortados: [], noTopo: true };
  const topo = estado.eventos[0];
  const ordenados = [...novos].sort(maisNovoPrimeiro);
  const noTopo = !topo || maisNovoPrimeiro(ordenados.at(-1), topo) < 0;
  estado.eventos = noTopo ? [...ordenados, ...estado.eventos] : [...ordenados, ...estado.eventos].sort(maisNovoPrimeiro);
  const cortados = estado.eventos.splice(LIMITE);
  // Cortar o fim deixa o cursor de "mostrar mais" apontando para depois do buraco: some o botão.
  if (cortados.length) estado.anteriores = null;
  if (cortados.some((e) => e.id === estado.aberto)) estado.aberto = null;
  const caiu = new Set(cortados.map((e) => e.id));
  return { entraram: ordenados.filter((e) => !caiu.has(e.id)), cortados, noTopo };
}

export function pausar(estado) {
  estado.pausado = true;
}

/** Retoma e solta no topo o que chegou durante a pausa. */
export function retomar(estado) {
  estado.pausado = false;
  const novos = estado.pendentes;
  estado.pendentes = [];
  estado.chegados = 0;
  return subir(estado, novos);
}

/** A página mais velha ("mostrar mais"): entra no fim, sem repetir. */
export function receberAnteriores(estado, resposta) {
  const vistos = ids(estado);
  const velhos = (resposta.eventos ?? []).filter((e) => !vistos.has(e.id));
  estado.eventos = [...estado.eventos, ...velhos];
  estado.anteriores = resposta.anteriores ?? null;
  return velhos;
}

/** Abre a linha, ou fecha se já estava aberta. Uma aberta por vez. */
export function alternar(estado, id) {
  estado.aberto = estado.aberto === id ? null : id;
  return estado.aberto;
}

// ---------- consulta ----------

const FILTROS = ['tipo', 'sessao', 'ferramenta', 'status', 'busca', 'de', 'ate'];

/** A rota de `/api/eventos` com os filtros preenchidos e os extras (`depois`, `antes`, `limite`). */
export function consulta(filtros = {}, extras = {}) {
  const partes = [];
  for (const [k, v] of Object.entries(extras)) if (v !== null && v !== undefined && v !== '') partes.push(`${k}=${encodeURIComponent(v)}`);
  for (const k of FILTROS) {
    const v = filtros[k];
    if (v !== null && v !== undefined && String(v).trim() !== '') partes.push(`${k}=${encodeURIComponent(String(v).trim())}`);
  }
  return partes.length ? `/api/eventos?${partes.join('&')}` : '/api/eventos';
}

export const temFiltro = (filtros = {}) => FILTROS.some((k) => filtros[k] !== null && filtros[k] !== undefined && String(filtros[k]).trim() !== '');

/** `aaaa-mm-dd` de um `<input type="date">` para ISO: o começo do dia local, ou o fim dele. */
export function diaParaIso(dia, fimDoDia = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia ?? '');
  if (!m) return null;
  const d = fimDoDia ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) : new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------- tempo ----------

const dois = (n) => String(n).padStart(2, '0');
const data = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** `23:12`, na hora local. */
export function horaCurta(iso) {
  const d = data(iso);
  return d ? `${dois(d.getHours())}:${dois(d.getMinutes())}` : '';
}

/** `18/10 23:12:04`, na hora local. */
export function dataHora(iso) {
  const d = data(iso);
  return d ? `${dois(d.getDate())}/${dois(d.getMonth() + 1)} ${dois(d.getHours())}:${dois(d.getMinutes())}:${dois(d.getSeconds())}` : '';
}

/** "agora", "12 s", "1 min", "2 h", "3 d". */
export function tempoRelativo(iso, agora = Date.now()) {
  const d = data(iso);
  if (!d) return '';
  const s = Math.max(0, Math.floor((agora - d.getTime()) / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

// ---------- texto ----------

/** O pedaço curto de um id, para o Agente ("test-runner · a7c2"). */
export const idCurto = (id) => (typeof id === 'string' && id ? id.slice(0, 4) : null);

/** `projeto › sessão › agente`, pulando o que falta. */
export function trilha(evento) {
  const sessao = evento.sessao ?? {};
  return [sessao.projeto, sessao.titulo ?? sessao.id, evento.agente?.nome].filter(Boolean).join(' › ');
}
