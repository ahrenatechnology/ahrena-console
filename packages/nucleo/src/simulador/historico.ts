// Histórico simulado para a demonstração da tela Analytics (#95, #32): sessões encerradas espalhadas
// pelos últimos ~90 dias, mais ralas até 52 semanas, nas duas contas do simulador. Determinístico pela
// semente e pelo `agora`. Só para a --demo: nada aqui é dado real.
//
// Cada dia sorteado vira um cenário do simulador (gerarCenario) de poucas sessões, num horário do dia.
// Sem o modo caos, e o que o cenário deixa em andamento é encerrado no último instante gravado: as
// sessões semeadas ficam todas concluídas e no passado (de ontem para trás), sem espera nem erro,
// para não aparecerem no painel como "precisa de você" nem disputarem com as do cenário do painel.

import type { Agent, ClaudeAccount, Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { Aleatorio } from './aleatorio.ts';
import { gerarCenario } from './cenario.ts';

export interface OpcoesDoHistorico {
  semente?: string | number;
  /** Relógio em ms. O histórico termina ontem. */
  agora?: number;
  /** Até quantos dias atrás. Padrão 364. */
  dias?: number;
}

export interface ResumoDoHistorico {
  dias: number;
  sessoes: number;
  eventos: number;
}

const MIN = 60_000;
const DIA = 1440 * MIN;

/** Chance de um dia ter sessões: alta nos últimos 90 dias, rala antes; fim de semana mais calmo. */
function chanceDoDia(diasAtras: number, fimDeSemana: boolean): number {
  const base = diasAtras <= 90 ? 0.85 - (diasAtras / 90) * 0.25 : 0.18;
  return fimDeSemana ? base * 0.35 : base;
}

/** Sessão com erro também conta como "precisa de você" no painel: no histórico, tudo termina concluído. */
function encerrarSessao(s: Session): Session {
  return { ...s, status: 'completed', endedAt: s.endedAt ?? s.updatedAt, awaitingInputSince: null, awaitingReason: null };
}

function encerrarAgente(a: Agent): Agent {
  if (a.status === 'completed' || a.status === 'error') return a;
  return { ...a, status: 'completed', endedAt: a.endedAt ?? a.updatedAt, currentTool: null };
}

export async function semearHistorico(porta: StoragePort, opcoes: OpcoesDoHistorico = {}): Promise<ResumoDoHistorico> {
  const semente = opcoes.semente ?? 'analytics';
  const agora = opcoes.agora ?? Date.now();
  const total = opcoes.dias ?? 364;
  const rng = new Aleatorio(`${semente}:historico`);
  const hojeUtc = Math.floor(agora / DIA) * DIA;
  const resumo: ResumoDoHistorico = { dias: 0, sessoes: 0, eventos: 0 };
  const contas = new Map<string, ClaudeAccount>();

  for (let atras = total; atras >= 1; atras--) {
    const inicioDoDia = hojeUtc - atras * DIA;
    const fimDeSemana = [0, 6].includes(new Date(inicioDoDia).getUTCDay());
    if (!rng.chance(chanceDoDia(atras, fimDeSemana))) continue;
    const sessoes = atras <= 90 ? rng.inteiro(1, 4) : 1;
    // Começa entre 11h e 15h UTC (manhã no Brasil) e dura até 6 h: fica no mesmo dia.
    const inicio = inicioDoDia + rng.inteiro(11 * 60, 15 * 60) * MIN;
    const cenario = gerarCenario({
      semente: `${semente}:dia:${atras}`,
      sessoes,
      duracaoMin: 300,
      relogio: (ms) => new Date(inicio + ms).toISOString(),
    });
    resumo.dias++;
    for (const c of cenario.contas) {
      const vista = contas.get(c.id);
      contas.set(c.id, vista ? { ...vista, lastSeenAt: c.lastSeenAt } : c);
    }
    // O último registro de cada sessão e de cada agente, já encerrado; eventos e usos como vieram.
    const ultimaSessao = new Map<string, Session>();
    const ultimoAgente = new Map<string, Agent>();
    for (const op of cenario.operacoes) {
      if (op.tipo === 'sessao') ultimaSessao.set(op.registro.id, op.registro);
      else if (op.tipo === 'agente') ultimoAgente.set(op.registro.id, op.registro);
      else if (op.tipo === 'evento') {
        if (await porta.appendEvent(op.registro)) resumo.eventos++;
      } else await porta.putTokenUsage(op.registro);
    }
    for (const s of ultimaSessao.values()) await porta.putSession(encerrarSessao(s));
    for (const a of ultimoAgente.values()) await porta.putAgent(encerrarAgente(a));
    resumo.sessoes += ultimaSessao.size;
  }
  for (const c of contas.values()) await porta.putAccount(c);
  return resumo;
}
