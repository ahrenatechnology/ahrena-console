// O histórico das sessões encerradas (#33, C15): regras puras, sem porta nem relógio.
//
// - Entra a sessão com `endedAt`; o dia dela é o do fim, no fuso pedido (o da máquina do núcleo,
//   injetável para teste).
// - A página conta dias com sessão (dias vazios não aparecem), do mais recente ao mais antigo; no
//   dia, as sessões do fim mais recente ao mais antigo.
// - O cursor é um dia: `before` devolve os dias estritamente anteriores a ele, e `next` é o último
//   dia da página enquanto houver mais.
// - The shapes that reach the API (`SessaoEncerrada`, `DiaDoHistorico`, `PaginaDoHistorico`) have
//   English keys since phase 2b of #173; the old route answers in the old ones (src/api/legacy-routes.ts).
// - A busca é substring sem diferenciar maiúsculas no título, no id e no projeto, antes de paginar.

import { basename } from 'node:path';
import { diaDe } from '../custo/agregacao.ts';
import { PRECOS_PADRAO, type PrecoPadrao } from '../custo/precos-padrao.ts';
import type { Session, SessionStatus } from '../model.ts';
import { resolvePricing } from '../pricing.ts';

export const DIAS_PADRAO = 7;
export const DIAS_MAXIMO = 31;
export const BUSCA_MAXIMA = 100;

/** O que o histórico precisa de uma sessão encerrada, antes do custo e das ligações. */
export interface SessaoEncerrada {
  id: string;
  title: string | null;
  /** A pasta da sessão (`basename` do `cwd`). */
  project: string | null;
  /** O nome legível do modelo (`nomeDoModelo`). */
  model: string | null;
  status: SessionStatus;
  start: string;
  end: string;
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
  day: string;
  sessions: T[];
}

export interface PaginaDoHistorico<T> {
  days: DiaDoHistorico<T>[];
  /** Passe como `before` para a próxima página; `null` quando acabou. */
  next: string | null;
}

/**
 * `claude-opus-5-5` → "Opus 5.5", pelo nome da tabela de preços padrão; `[1m]` vira " 1M". Modelo
 * que não está na tabela fica com o id.
 */
export function nomeDoModelo(model: string | null): string | null {
  if (!model) return null;
  const longo = /\[1m\]$/i.test(model);
  const id = model.replace(/\[1m\]$/i, '');
  const nome = (resolvePricing(id, PRECOS_PADRAO) as PrecoPadrao | null)?.nome.replace(/^Claude /, '');
  return nome ? `${nome}${longo ? ' 1M' : ''}` : model;
}

/** A sessão do histórico, ou `null` se ela não terminou. `titulo` troca o nome da sessão (ex.: o do Desktop). */
export function encerradaDe(s: Session, titulo?: string | null): SessaoEncerrada | null {
  if (!s.endedAt) return null;
  return {
    id: s.id,
    title: titulo ?? s.name ?? null,
    project: s.cwd ? basename(s.cwd) || null : null,
    model: nomeDoModelo(s.model),
    status: s.status,
    start: s.startedAt,
    end: s.endedAt,
  };
}

function casa(s: SessaoEncerrada, busca: string): boolean {
  const alvo = busca.toLowerCase();
  return [s.title, s.id, s.project].some((v) => v !== null && v.toLowerCase().includes(alvo));
}

// Fim mais recente primeiro; no empate, o id maior, para a ordem não depender da leitura.
const doMaisRecente = (a: SessaoEncerrada, b: SessaoEncerrada) => (a.end === b.end ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.end < b.end ? 1 : -1);

export function paginaDoHistorico<T extends SessaoEncerrada>(sessoes: readonly T[], pedido: PedidoDoHistorico, fusoHorario: string): PaginaDoHistorico<T> {
  const porDia = new Map<string, T[]>();
  for (const s of sessoes) {
    if (pedido.busca && !casa(s, pedido.busca)) continue;
    const dia = diaDe(s.end, fusoHorario);
    if (pedido.antes && dia >= pedido.antes) continue;
    const lista = porDia.get(dia);
    if (lista) lista.push(s);
    else porDia.set(dia, [s]);
  }
  const todos = [...porDia.keys()].sort().reverse();
  const pagina = todos.slice(0, pedido.dias);
  return {
    days: pagina.map((dia) => ({ day: dia, sessions: porDia.get(dia)!.sort(doMaisRecente) })),
    next: todos.length > pagina.length ? pagina.at(-1)! : null,
  };
}

function diaValido(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export type LeituraDoPedido = { ok: true; pedido: PedidoDoHistorico } | { ok: false; erro: string };

/** Lê `before`, `days` e `search` da query; o erro diz qual parâmetro (pelo nome novo) e por quê. */
export function lerPedidoDoHistorico(q: URLSearchParams): LeituraDoPedido {
  const antes = q.get('before');
  if (antes !== null && !diaValido(antes)) return { ok: false, erro: 'before: um dia AAAA-MM-DD' };
  const dias = q.get('days');
  let n = DIAS_PADRAO;
  if (dias !== null) {
    n = /^\d{1,2}$/.test(dias) ? Number(dias) : NaN;
    if (!(n >= 1 && n <= DIAS_MAXIMO)) return { ok: false, erro: `days: um inteiro de 1 a ${DIAS_MAXIMO}` };
  }
  const busca = q.get('search');
  if (busca !== null && busca.length > BUSCA_MAXIMA) return { ok: false, erro: `search: até ${BUSCA_MAXIMA} caracteres` };
  return { ok: true, pedido: { antes, dias: n, busca: busca?.trim() || null } };
}
