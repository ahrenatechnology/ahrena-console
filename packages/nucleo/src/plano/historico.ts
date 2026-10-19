// Histórico dos planos da sessão (issue #131): onde um plano acaba e o próximo começa.
//
// A extração (extracao.ts) mantém uma lista só, a do momento. Aqui cada mudança da lista é
// lida como ajuste do plano atual ou como plano novo:
// - plano novo: a lista foi trocada por outra substancialmente diferente, ou o plano anterior
//   terminou (todos os passos feitos) e vieram passos novos;
// - ajuste: marcar, desmarcar, reordenar, acrescentar ou renomear passos continua no mesmo plano;
// - fim sem plano novo: a lista ficou vazia (`/clear`, TodoWrite vazio, passos apagados).
//
// O estado (número do plano aberto, início e os passos herdados do anterior) fica em
// `metadata.historico` do plano gravado; cada plano do histórico é um `PlanRecord` na porta.

import type { SessionEvent } from '../model.ts';
import type { PlanRecord, PlanStep, SessionPlan } from './modelo.ts';

export type Separacao = 'continua' | 'novo' | 'fim';

/** Abaixo disso, a lista nova é outra: menos da metade dos passos em comum. */
export const SEMELHANCA_MINIMA = 0.5;

const normal = (texto: string) => texto.toLowerCase().replace(/\s+/g, ' ').trim();

/** Passos em comum (pelo texto) sobre o tamanho da maior lista: 1 é a mesma lista, 0 nenhum em comum. */
export function semelhanca(a: readonly Pick<PlanStep, 'text'>[], b: readonly Pick<PlanStep, 'text'>[]): number {
  const ta = new Set(a.map((s) => normal(s.text)));
  const tb = new Set(b.map((s) => normal(s.text)));
  const maior = Math.max(ta.size, tb.size);
  if (maior === 0) return 1;
  let comum = 0;
  for (const t of ta) if (tb.has(t)) comum++;
  return comum / maior;
}

/**
 * A regra da separação, função pura. `anterior` são os passos do plano aberto (vazio se não há
 * plano aberto), `novo` a lista depois da mudança. `incremental` é a mudança de um passo só
 * (TaskCreate, TaskUpdate, `update_plan` sem lista): ela nunca troca a lista inteira, então só
 * começa plano novo quando o anterior já tinha terminado.
 */
export function separarPlano(anterior: readonly PlanStep[], novo: readonly PlanStep[], incremental = false): Separacao {
  if (novo.length === 0) return anterior.length ? 'fim' : 'continua';
  if (anterior.length === 0) return 'novo';
  if (anterior.every((s) => s.status === 'completed')) {
    const antes = new Set(anterior.map((s) => normal(s.text)));
    // Veio passo por fazer que o plano terminado não tinha: é outro plano.
    if (novo.some((s) => s.status !== 'completed' && !antes.has(normal(s.text)))) return 'novo';
    // A mesma lista inteira de volta a pendente: o mesmo roteiro, de novo.
    const emComum = novo.filter((s) => antes.has(normal(s.text)));
    if (emComum.length === anterior.length && emComum.every((s) => s.status !== 'completed')) return 'novo';
    return 'continua';
  }
  if (incremental) return 'continua';
  return semelhanca(anterior, novo) < SEMELHANCA_MINIMA ? 'novo' : 'continua';
}

/** Estado do histórico, guardado em `metadata.historico` do plano gravado. */
export interface EstadoDoHistorico {
  /** Número do último plano aberto na sessão (0: nenhum ainda). */
  seq: number;
  aberto: boolean;
  /** Início do plano aberto. */
  inicio: string | null;
  /** Passos que o plano aberto herdou feitos do anterior (`<id>\0<texto>`): não são dele. */
  herdados: string[];
}

const chave = (s: PlanStep) => `${s.id}\u0000${s.text}`;

export function historicoDe(plano: SessionPlan | null): EstadoDoHistorico {
  const h = plano?.metadata?.historico as Partial<EstadoDoHistorico> | undefined;
  if (h && typeof h.seq === 'number') {
    return { seq: h.seq, aberto: h.aberto === true, inicio: h.inicio ?? null, herdados: Array.isArray(h.herdados) ? h.herdados : [] };
  }
  // Plano gravado antes do histórico: ele é o primeiro, aberto desde a última mudança.
  if (plano && plano.steps.length > 0) return { seq: 1, aberto: true, inicio: plano.changedAt, herdados: [] };
  return { seq: 0, aberto: false, inicio: null, herdados: [] };
}

const passosDo = (steps: readonly PlanStep[], herdados: readonly string[]) => {
  const fora = new Set(herdados);
  return steps.filter((s) => !fora.has(chave(s)));
};

/** A mudança é de um passo só? (TaskCreate, TaskUpdate, `update_plan` sem `items`.) */
export function mudancaIncremental(e: SessionEvent): boolean {
  if (e.toolName === 'TaskCreate' || e.toolName === 'TaskUpdate') return true;
  if (!e.toolName || !/(^|__)update_plan$/.test(e.toolName)) return false;
  const entrada = (e.data as { tool_input?: { items?: unknown } } | null)?.tool_input;
  return !Array.isArray(entrada?.items);
}

function registro(plano: SessionPlan, h: EstadoDoHistorico, steps: PlanStep[], fim: string | null): PlanRecord {
  const done = steps.filter((s) => s.status === 'completed').length;
  return {
    sessionId: plano.sessionId,
    seq: h.seq,
    source: plano.source,
    startedAt: h.inicio!,
    endedAt: fim,
    result: fim === null ? 'current' : done === steps.length ? 'completed' : 'abandoned',
    steps,
    done,
    total: steps.length,
    currentStepId: steps.find((s) => s.status === 'in_progress')?.id ?? null,
    changedAt: fim ?? plano.changedAt,
    metadata: {},
  };
}

/**
 * Segue o histórico numa mudança do plano: `antes` é o plano gravado, `depois` o que a extração
 * devolveu para o evento `e`. Devolve o plano a gravar (com `metadata.historico` atualizado) e os
 * planos do histórico que mudaram: o que fechou e o aberto.
 */
export function seguirHistorico(
  antes: SessionPlan | null,
  depois: SessionPlan,
  e: SessionEvent,
): { plano: SessionPlan; registros: PlanRecord[] } {
  let h = historicoDe(antes);
  const anterior = h.aberto && antes ? passosDo(antes.steps, h.herdados) : [];
  const decisao = separarPlano(anterior, passosDo(depois.steps, h.herdados), mudancaIncremental(e));
  const registros: PlanRecord[] = [];
  const em = e.createdAt < (h.inicio ?? '') ? h.inicio! : e.createdAt;

  if (decisao !== 'continua' && h.aberto && antes) {
    registros.push(registro(antes, h, anterior, em));
    h = { ...h, aberto: false, inicio: null, herdados: [] };
  }
  if (decisao === 'novo') {
    // Plano novo depois de um terminado: os passos feitos que vieram dele continuam na lista
    // (TaskCreate acrescenta às tarefas que já existem), mas são do plano anterior.
    const terminado = anterior.length > 0 && anterior.every((s) => s.status === 'completed');
    const deAntes = new Set((antes?.steps ?? []).map(chave));
    const herdados = terminado ? depois.steps.filter((s) => s.status === 'completed' && deAntes.has(chave(s))).map(chave) : [];
    h = { seq: h.seq + 1, aberto: true, inicio: em, herdados };
  }
  if (h.aberto) {
    const steps = passosDo(depois.steps, h.herdados);
    if (steps.length > 0) registros.push(registro(depois, h, steps, null));
  }
  return { plano: { ...depois, metadata: { ...depois.metadata, historico: h } }, registros };
}
