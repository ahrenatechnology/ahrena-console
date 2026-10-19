// Executor: aplica o roteiro pela porta de armazenamento, de uma vez (lote) ou no ritmo
// do relógio (tempo real). Relógio e espera são injetáveis para os testes.

import type { ModelPricing } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { gerarCenario, type Operacao, type Roteiro } from './cenario.ts';

export type Modo = 'lote' | 'tempo-real';

export interface OpcoesDaSimulacao {
  semente: string | number;
  sessoes?: number;
  duracaoMin?: number;
  caos?: boolean;
  intensidadeDoCaos?: number;
  /**
   * `lote`: grava tudo de uma vez, com a janela terminando agora (as sessões já aconteceram).
   * `tempo-real`: começa agora e grava cada operação na hora dela. Padrão `lote`.
   */
  modo?: Modo;
  /** Só em tempo real: quantos minutos simulados passam por minuto de relógio. Padrão 30. */
  velocidade?: number;
  /** Grava preços ilustrativos para os modelos simulados que ainda não têm preço. */
  precos?: boolean;
  /** Relógio em ms. Padrão `Date.now`. */
  agora?: () => number;
  /** Espera em ms. Padrão `setTimeout`, cancelável pelo `signal`. */
  esperar?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Interrompe a simulação em tempo real; o que já foi gravado fica. */
  signal?: AbortSignal;
  /** Chamado depois de cada gravação. */
  aoGravar?: (op: Operacao) => void;
}

export interface Resumo {
  semente: string;
  prefixo: string;
  modo: Modo;
  inicio: string;
  roteiros: Record<Roteiro, number>;
  gravados: { sessoes: number; agentes: number; eventos: number; usos: number; precos: number };
  /** `true` quando o `signal` parou a simulação antes do fim. */
  interrompido: boolean;
}

/**
 * Preços ilustrativos, em US$ por milhão de tokens, só para o custo aparecer na demonstração.
 * Não são a tabela oficial: quem usa o console de verdade edita a própria tabela (item 1.6).
 */
export const PRECOS_ILUSTRATIVOS: readonly Omit<ModelPricing, 'updatedAt'>[] = [
  { pattern: 'claude-opus-5%', inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: null, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null },
  { pattern: 'claude-sonnet-5%', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: null, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null },
  { pattern: 'claude-haiku-5%', inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: null, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null },
];

function esperarPadrao(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', parar);
      resolve();
    }, ms);
    const parar = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', parar, { once: true });
  });
}

export async function simular(porta: StoragePort, opcoes: OpcoesDaSimulacao): Promise<Resumo> {
  const modo = opcoes.modo ?? 'lote';
  const velocidade = opcoes.velocidade ?? 30;
  if (!(velocidade > 0)) throw new RangeError(`velocidade inválida: ${velocidade}`);
  const duracaoMin = opcoes.duracaoMin ?? 360;
  const agora = opcoes.agora ?? Date.now;
  const esperar = opcoes.esperar ?? esperarPadrao;

  // Em lote a janela termina agora; em tempo real ela começa agora e corre `velocidade` vezes mais rápido.
  const escala = modo === 'lote' ? 1 : 1 / velocidade;
  const inicio = modo === 'lote' ? agora() - duracaoMin * 60_000 : agora();
  const instante = (deslocamentoMs: number) => inicio + Math.round(deslocamentoMs * escala);

  const cenario = gerarCenario({
    semente: opcoes.semente,
    sessoes: opcoes.sessoes,
    duracaoMin,
    caos: opcoes.caos,
    intensidadeDoCaos: opcoes.intensidadeDoCaos,
    relogio: (ms) => new Date(instante(ms)).toISOString(),
  });

  const resumo: Resumo = {
    semente: String(opcoes.semente),
    prefixo: cenario.prefixo,
    modo,
    inicio: new Date(inicio).toISOString(),
    roteiros: { normal: 0, travada: 0, erro: 0, abandono: 0, estouro: 0, enxame: 0 },
    gravados: { sessoes: 0, agentes: 0, eventos: 0, usos: 0, precos: 0 },
    interrompido: false,
  };
  for (const r of cenario.roteiros) resumo.roteiros[r]++;

  if (opcoes.precos) {
    const existentes = new Set((await porta.listModelPricing()).map((p) => p.pattern));
    for (const p of PRECOS_ILUSTRATIVOS) {
      if (existentes.has(p.pattern)) continue;
      await porta.putModelPricing({ ...p, updatedAt: new Date(inicio).toISOString() });
      resumo.gravados.precos++;
    }
  }

  const sessoes = new Set<string>();
  const agentes = new Set<string>();
  for (const op of cenario.operacoes) {
    if (modo === 'tempo-real') {
      const falta = instante(op.deslocamentoMs) - agora();
      if (falta > 0) await esperar(falta, opcoes.signal);
    }
    if (opcoes.signal?.aborted) {
      resumo.interrompido = true;
      break;
    }
    switch (op.tipo) {
      case 'sessao':
        await porta.putSession(op.registro);
        sessoes.add(op.registro.id);
        break;
      case 'agente':
        await porta.putAgent(op.registro);
        agentes.add(op.registro.id);
        break;
      case 'evento':
        if (await porta.appendEvent(op.registro)) resumo.gravados.eventos++;
        break;
      case 'uso':
        await porta.putTokenUsage(op.registro);
        resumo.gravados.usos++;
        break;
    }
    opcoes.aoGravar?.(op);
  }
  resumo.gravados.sessoes = sessoes.size;
  resumo.gravados.agentes = agentes.size;
  return resumo;
}
