// O histórico das sessões encerradas (#33, C15): regras puras, sem porta nem relógio.
//
// - Entra a sessão com `endedAt`; o dia dela é o do fim, no fuso pedido (o da máquina do núcleo,
//   injetável para teste).
// - A página conta dias com sessão (dias vazios não aparecem), do mais recente ao mais antigo; no
//   dia, as sessões do fim mais recente ao mais antigo.
// - O cursor é um dia: `antes` devolve os dias estritamente anteriores a ele, e `proximo` é o último
//   dia da página enquanto houver mais.
// - A busca é substring sem diferenciar maiúsculas no título, no id e no projeto, antes de paginar.

import { basename } from 'node:path';
import { diaDe } from '../custo/agregacao.ts';
import type { Session, SessionStatus } from '../model.ts';

export const DIAS_PADRAO = 7;
export const DIAS_MAXIMO = 31;
export const BUSCA_MAXIMA = 100;

/** O que o histórico precisa de uma sessão encerrada, antes do custo e das ligações. */
export interface SessaoEncerrada {
  id: string;
  titulo: string | null;
  /** A pasta da sessão (`basename` do `cwd`). */
  projeto: string | null;
  /** O id do modelo: o núcleo não tem nome legível para ele. */
  modelo: string | null;
  status: SessionStatus;
  inicio: string;
  fim: string;
}

export interface PedidoDoHistorico {
  /** `AAAA-MM-DD`: só dias estritamente anteriores. `null` começa pelo mais recente. */
  antes: string | null;
  /** Quantos dias com sessão por página. */
  dias: number;
  /** Já sem espaços nas pontas; `null` sem filtro. */
  busca: string | null;
}

export interface DiaDoHistorico<T> {
  dia: string;
  sessoes: T[];
}

export interface PaginaDoHistorico<T> {
  dias: DiaDoHistorico<T>[];
  /** Passe como `antes` para a próxima página; `null` quando acabou. */
  proximo: string | null;
}

/** A sessão do histórico, ou `null` se ela não terminou. `titulo` troca o nome da sessão (ex.: o do Desktop). */
export function encerradaDe(s: Session, titulo?: string | null): SessaoEncerrada | null {
  if (!s.endedAt) return null;
  return {
    id: s.id,
    titulo: titulo ?? s.name ?? null,
    projeto: s.cwd ? basename(s.cwd) || null : null,
    modelo: s.model,
    status: s.status,
    inicio: s.startedAt,
    fim: s.endedAt,
  };
}

function casa(s: SessaoEncerrada, busca: string): boolean {
  const alvo = busca.toLowerCase();
  return [s.titulo, s.id, s.projeto].some((v) => v !== null && v.toLowerCase().includes(alvo));
}

// Fim mais recente primeiro; no empate, o id maior, para a ordem não depender da leitura.
const doMaisRecente = (a: SessaoEncerrada, b: SessaoEncerrada) => (a.fim === b.fim ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.fim < b.fim ? 1 : -1);

export function paginaDoHistorico<T extends SessaoEncerrada>(sessoes: readonly T[], pedido: PedidoDoHistorico, fusoHorario: string): PaginaDoHistorico<T> {
  const porDia = new Map<string, T[]>();
  for (const s of sessoes) {
    if (pedido.busca && !casa(s, pedido.busca)) continue;
    const dia = diaDe(s.fim, fusoHorario);
    if (pedido.antes && dia >= pedido.antes) continue;
    const lista = porDia.get(dia);
    if (lista) lista.push(s);
    else porDia.set(dia, [s]);
  }
  const todos = [...porDia.keys()].sort().reverse();
  const pagina = todos.slice(0, pedido.dias);
  return {
    dias: pagina.map((dia) => ({ dia, sessoes: porDia.get(dia)!.sort(doMaisRecente) })),
    proximo: todos.length > pagina.length ? pagina.at(-1)! : null,
  };
}

function diaValido(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export type LeituraDoPedido = { ok: true; pedido: PedidoDoHistorico } | { ok: false; erro: string };

/** Lê `antes`, `dias` e `busca` da query; o erro diz qual parâmetro e por quê. */
export function lerPedidoDoHistorico(q: URLSearchParams): LeituraDoPedido {
  const antes = q.get('antes');
  if (antes !== null && !diaValido(antes)) return { ok: false, erro: 'antes: um dia AAAA-MM-DD' };
  const dias = q.get('dias');
  let n = DIAS_PADRAO;
  if (dias !== null) {
    n = /^\d{1,2}$/.test(dias) ? Number(dias) : NaN;
    if (!(n >= 1 && n <= DIAS_MAXIMO)) return { ok: false, erro: `dias: um inteiro de 1 a ${DIAS_MAXIMO}` };
  }
  const busca = q.get('busca');
  if (busca !== null && busca.length > BUSCA_MAXIMA) return { ok: false, erro: `busca: até ${BUSCA_MAXIMA} caracteres` };
  return { ok: true, pedido: { antes, dias: n, busca: busca?.trim() || null } };
}
