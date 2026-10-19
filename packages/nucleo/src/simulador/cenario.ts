// Gera o roteiro da simulação: a lista ordenada de gravações (sessão, agente, evento, uso)
// que o executor aplica pela porta. Função pura da semente e das opções: nada de relógio
// nem de Math.random aqui dentro.
//
// Os estados são gravados como dados, do jeito que a máquina de estados (item 1.5) gravaria;
// o simulador não decide transições, só encena roteiros plausíveis.

import {
  emptyTokenCounts,
  type Agent,
  type AwaitingReason,
  type Session,
  type SessionEvent,
  type TokenCounts,
  type TokenUsage,
} from '../model.ts';
import { Aleatorio, hash32 } from './aleatorio.ts';
import * as V from './vocabulario.ts';

export const TIPOS_DE_CAOS = ['travada', 'erro', 'abandono', 'estouro', 'enxame'] as const;
/**
 * Falhas que o modo caos injeta:
 * - `travada`: para esperando input (permissão ou turno interrompido) e não sai mais disso;
 * - `erro`: uma ferramenta falha e a sessão termina em `error`;
 * - `abandono`: para de responder e, 180 min depois, vira `abandoned`;
 * - `estouro`: picos de tokens que estouram o contexto mais de uma vez;
 * - `enxame`: muitos subagentes em paralelo no mesmo turno.
 */
export type TipoDeCaos = (typeof TIPOS_DE_CAOS)[number];
export type Roteiro = 'normal' | TipoDeCaos;

export const LIMITE_DE_CONTEXTO = 200_000;
export const MINUTOS_ATE_ABANDONO = 180;

export interface OpcoesDoCenario {
  /** Semente: a mesma semente com as mesmas opções gera exatamente o mesmo roteiro. */
  semente: string | number;
  /** Número de sessões. Padrão 12. */
  sessoes?: number;
  /** Janela simulada, em minutos. Padrão 360 (o abandono precisa de pelo menos ~240). */
  duracaoMin?: number;
  /** Liga o modo caos. */
  caos?: boolean;
  /** Fração das sessões que recebe uma falha no modo caos, além da garantia de uma de cada. Padrão 0.4. */
  intensidadeDoCaos?: number;
  /** Converte o deslocamento simulado (ms desde o início) em data ISO. */
  relogio: (deslocamentoMs: number) => string;
}

export type Gravacao =
  | { tipo: 'sessao'; registro: Session }
  | { tipo: 'agente'; registro: Agent }
  | { tipo: 'evento'; registro: SessionEvent }
  | { tipo: 'uso'; registro: TokenUsage };

export type Operacao = Gravacao & {
  /** Deslocamento simulado em ms desde o início; o executor usa para o ritmo. */
  deslocamentoMs: number;
  /** Índice da sessão no cenário. */
  sessao: number;
  /** Ordem dentro da sessão; desempata operações no mesmo instante. */
  seq: number;
};

export interface Cenario {
  /** Prefixo dos ids desta semente (`sim-<hash>`); reaplicar a mesma semente sobrescreve, não duplica. */
  prefixo: string;
  roteiros: Roteiro[];
  operacoes: Operacao[];
}

const SEGUNDO = 1000;
const MINUTO = 60 * SEGUNDO;

export function gerarCenario(opcoes: OpcoesDoCenario): Cenario {
  const total = opcoes.sessoes ?? 12;
  const duracaoMs = (opcoes.duracaoMin ?? 360) * MINUTO;
  if (!Number.isInteger(total) || total < 1) throw new RangeError(`sessoes inválido: ${total}`);
  if (!(duracaoMs > 0)) throw new RangeError(`duracaoMin inválido: ${opcoes.duracaoMin}`);

  const prefixo = `sim-${hash32(String(opcoes.semente)).toString(36)}`;
  const mestre = new Aleatorio(`${opcoes.semente}:mestre`);
  const roteiros = distribuirRoteiros(mestre, total, opcoes.caos ?? false, opcoes.intensidadeDoCaos ?? 0.4);

  const operacoes: Operacao[] = [];
  roteiros.forEach((roteiro, i) => {
    const rng = new Aleatorio(`${opcoes.semente}:sessao:${i}`);
    // Abandono começa cedo para que os 180 min caibam na janela; as outras falhas, antes do
    // último terço, para chegarem ao ponto da falha; as normais, a qualquer hora (as tardias ficam em andamento).
    const fracao = roteiro === 'abandono' ? 0.15 : roteiro === 'normal' ? 0.85 : 0.6;
    const inicio = rng.inteiro(0, Math.floor(duracaoMs * fracao));
    const sessao = new SessaoSimulada(rng, opcoes.relogio, `${prefixo}-s${String(i + 1).padStart(3, '0')}`, i, roteiro);
    sessao.encenar(inicio);
    for (const op of sessao.operacoes) if (op.deslocamentoMs <= duracaoMs) operacoes.push(op);
  });

  operacoes.sort((a, b) => a.deslocamentoMs - b.deslocamentoMs || a.sessao - b.sessao || a.seq - b.seq);
  return { prefixo, roteiros, operacoes };
}

/** Sem caos, tudo normal. Com caos, garante uma sessão de cada falha e sorteia mais pela intensidade. */
function distribuirRoteiros(rng: Aleatorio, total: number, caos: boolean, intensidade: number): Roteiro[] {
  const roteiros: Roteiro[] = Array.from({ length: total }, () => 'normal');
  if (!caos) return roteiros;
  const ordem = rng.embaralhar(roteiros.map((_, i) => i));
  ordem.forEach((indice, k) => {
    if (k < TIPOS_DE_CAOS.length) roteiros[indice] = TIPOS_DE_CAOS[k];
    else if (rng.chance(intensidade)) roteiros[indice] = rng.escolher(TIPOS_DE_CAOS);
  });
  return roteiros;
}

function somar(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  };
}

function escolherPonderado(rng: Aleatorio, itens: readonly (readonly [string, number])[]): string {
  const soma = itens.reduce((s, [, p]) => s + p, 0);
  let alvo = rng.proximo() * soma;
  for (const [item, peso] of itens) {
    alvo -= peso;
    if (alvo < 0) return item;
  }
  return itens[itens.length - 1][0];
}

/** Uma sessão encenada do começo ao fim, acumulando as operações com o próprio cursor de tempo. */
class SessaoSimulada {
  readonly operacoes: Operacao[] = [];
  private seq = 0;
  private eventos = 0;
  private readonly sessao: Session;
  private readonly principal: Agent;
  private readonly usos = new Map<string, TokenUsage>();
  private contexto = 0;
  private estouros = 0;
  private subagentes = 0;
  private readonly projeto: string;
  private readonly rng: Aleatorio;
  private readonly relogio: (ms: number) => string;
  private readonly id: string;
  private readonly indice: number;
  private readonly roteiro: Roteiro;

  constructor(rng: Aleatorio, relogio: (ms: number) => string, id: string, indice: number, roteiro: Roteiro) {
    this.rng = rng;
    this.relogio = relogio;
    this.id = id;
    this.indice = indice;
    this.roteiro = roteiro;
    this.projeto = rng.escolher(V.PROJETOS);
    const modelo = rng.escolher(V.MODELOS.principal);
    const t = relogio(0);
    this.sessao = {
      id,
      name: rng.escolher(V.TAREFAS),
      status: 'active',
      cwd: `${V.RAIZ}/${this.projeto}`,
      model: modelo,
      source: 'startup',
      startedAt: t,
      endedAt: null,
      awaitingInputSince: null,
      awaitingReason: null,
      updatedAt: t,
      metadata: {},
    };
    this.principal = {
      id: `${id}-a0`,
      sessionId: id,
      name: 'principal',
      type: 'main',
      subagentType: null,
      status: 'waiting',
      task: this.sessao.name,
      currentTool: null,
      parentAgentId: null,
      startedAt: t,
      endedAt: null,
      updatedAt: t,
      metadata: { simulado: true },
    };
  }

  encenar(inicio: number): void {
    let t = inicio;
    this.sessao.startedAt = this.principal.startedAt = this.relogio(t);
    this.esperar(t, 'session_start');
    this.evento(t, null, 'SessionStart', null, 'sessão iniciada', { source: 'startup' });
    this.gravarAgente(t, this.principal);

    const turnos = this.rng.inteiro(3, 8);
    // Ponto do roteiro em que a falha acontece (turno, passo).
    const turnoDaFalha = this.rng.inteiro(1, Math.max(1, turnos - 2));
    const passoDaFalha = this.rng.inteiro(1, 3);
    t += this.rng.inteiro(5, 60) * SEGUNDO;

    for (let turno = 0; turno < turnos; turno++) {
      if (this.roteiro === 'abandono' && turno === turnoDaFalha) {
        this.abandonar(t);
        return;
      }
      const prompt = turno === 0 ? this.sessao.name! : this.rng.escolher(V.PEDIDOS_DE_SEGUIMENTO);
      this.limparEspera();
      this.principal.status = 'working';
      this.evento(t, this.principal.id, 'UserPromptSubmit', null, prompt, { prompt });
      this.gravarAgente(t, this.principal);

      const passos = this.rng.inteiro(2, 7);
      for (let passo = 0; passo < passos; passo++) {
        t += this.rng.inteiro(2, 25) * SEGUNDO;
        const naFalha = turno === turnoDaFalha && passo === Math.min(passoDaFalha, passos - 1);

        if (naFalha && this.roteiro === 'enxame') t = this.delegar(t, this.rng.inteiro(8, 14));
        else if (passo === 1 && this.rng.chance(0.2)) t = this.delegar(t, this.rng.inteiro(1, 3));

        if (naFalha && this.roteiro === 'travada') {
          this.travar(t);
          return;
        }
        if (naFalha && this.roteiro === 'erro') {
          this.falhar(t);
          return;
        }
        if (naFalha && this.roteiro === 'estouro') t = this.estourar(t);

        t = this.ferramenta(t, this.principal);
        this.consumir(t, this.sessao.model!, this.rng.inteiro(1500, 9000), true);
      }

      t += this.rng.inteiro(3, 20) * SEGUNDO;
      this.principal.status = 'waiting';
      this.principal.currentTool = null;
      this.esperar(t, 'stop');
      this.evento(t, this.principal.id, 'Stop', null, 'turno concluído', null);
      this.gravarAgente(t, this.principal);
      // A vez é do usuário: alguns segundos ou alguns minutos até o próximo pedido.
      t += this.rng.inteiro(20, 6 * 60) * SEGUNDO;
    }

    // Parte das sessões normais fica aberta, esperando o usuário; o resto termina.
    if (this.roteiro !== 'normal' || this.rng.chance(0.7)) this.encerrar(t);
  }

  // --- trechos do roteiro -------------------------------------------------------------

  private ferramenta(t: number, agente: Agent): number {
    const nome = escolherPonderado(this.rng, V.FERRAMENTAS);
    const { resumo, dados } = this.argumentos(nome);
    agente.currentTool = nome;
    this.evento(t, agente.id, 'PreToolUse', nome, resumo, dados);
    this.gravarAgente(t, agente);
    t += this.rng.inteiro(1, nome === 'Bash' ? 45 : 8) * SEGUNDO;
    agente.currentTool = null;
    this.evento(t, agente.id, 'PostToolUse', nome, resumo, { ok: true });
    this.gravarAgente(t, agente);
    return t;
  }

  private argumentos(nome: string): { resumo: string; dados: unknown } {
    switch (nome) {
      case 'Bash': {
        const command = this.rng.escolher(V.COMANDOS);
        return { resumo: command, dados: { command } };
      }
      case 'Grep': {
        const pattern = this.rng.escolher(V.BUSCAS);
        return { resumo: pattern, dados: { pattern } };
      }
      case 'Glob':
        return { resumo: 'src/**/*.ts', dados: { pattern: 'src/**/*.ts' } };
      case 'WebFetch':
        return { resumo: 'https://example.com/docs', dados: { url: 'https://example.com/docs' } };
      case 'TodoWrite':
        return { resumo: 'plano atualizado', dados: { todos: this.rng.inteiro(2, 6) } };
      default: {
        const file_path = `${this.sessao.cwd}/${this.rng.escolher(V.ARQUIVOS)}`;
        return { resumo: file_path, dados: { file_path } };
      }
    }
  }

  /** O principal chama a ferramenta Agent e `n` subagentes trabalham em paralelo. Devolve quando o último termina. */
  private delegar(t: number, n: number): number {
    this.principal.currentTool = 'Agent';
    this.evento(t, this.principal.id, 'PreToolUse', 'Agent', `${n} subagente(s) em paralelo`, { subagentes: n });
    this.gravarAgente(t, this.principal);

    let fim = t;
    for (let k = 0; k < n; k++) {
      const inicio = t + this.rng.inteiro(0, 4) * SEGUNDO;
      const sub: Agent = {
        id: `${this.id}-a${++this.subagentes}`,
        sessionId: this.id,
        name: `subagente ${this.subagentes}`,
        type: 'subagent',
        subagentType: this.rng.escolher(V.TIPOS_DE_SUBAGENTE),
        status: 'working',
        task: this.rng.escolher(V.TAREFAS_DE_SUBAGENTE),
        currentTool: null,
        parentAgentId: this.principal.id,
        startedAt: this.relogio(inicio),
        endedAt: null,
        updatedAt: this.relogio(inicio),
        metadata: { simulado: true },
      };
      this.gravarAgente(inicio, sub);
      const modelo = this.rng.escolher(V.MODELOS.subagente);
      let ts = inicio;
      for (let p = this.rng.inteiro(2, 6); p > 0; p--) {
        ts = this.ferramenta(ts + this.rng.inteiro(2, 15) * SEGUNDO, sub);
        this.consumir(ts, modelo, this.rng.inteiro(1000, 6000), false);
      }
      ts += this.rng.inteiro(2, 10) * SEGUNDO;
      sub.status = 'completed';
      sub.endedAt = this.relogio(ts);
      this.evento(ts, sub.id, 'SubagentStop', null, `${sub.subagentType}: ${sub.task}`, null);
      this.gravarAgente(ts, sub);
      fim = Math.max(fim, ts);
    }

    fim += SEGUNDO;
    // O uso dos subagentes é gravado uma vez, no fim: gravar no meio daria fotos fora de ordem
    // quando dois subagentes paralelos somam no mesmo bucket.
    for (const uso of this.usos.values()) {
      uso.updatedAt = this.relogio(fim);
      this.emitir(fim, { tipo: 'uso', registro: structuredClone(uso) });
    }
    this.principal.currentTool = null;
    this.evento(fim, this.principal.id, 'PostToolUse', 'Agent', `${n} subagente(s) concluídos`, { ok: true });
    this.gravarAgente(fim, this.principal);
    return fim;
  }

  /** Para esperando alguém e não sai mais: pedido de permissão (o mais comum) ou turno interrompido. */
  private travar(t: number): void {
    const motivo: AwaitingReason = this.rng.chance(0.75) ? 'notification' : 'interrupted';
    const ferramenta = this.rng.escolher(['Bash', 'Edit', 'Write'] as const);
    this.principal.status = 'waiting';
    this.principal.currentTool = motivo === 'notification' ? ferramenta : null;
    this.esperar(t, motivo);
    if (motivo === 'notification') {
      this.evento(t, this.principal.id, 'Notification', ferramenta, `Claude precisa da sua permissão para usar ${ferramenta}`, {
        notification_type: 'permission_prompt',
      });
    } else {
      this.evento(t, this.principal.id, 'Interrupted', null, 'turno interrompido sem resposta', null);
    }
    this.gravarAgente(t, this.principal);
  }

  private falhar(t: number): void {
    const ferramenta = this.rng.escolher(['Bash', 'WebFetch', 'Edit'] as const);
    const erro = this.rng.escolher(V.ERROS);
    this.principal.currentTool = ferramenta;
    this.evento(t, this.principal.id, 'PreToolUse', ferramenta, ferramenta, null);
    t += this.rng.inteiro(2, 30) * SEGUNDO;
    this.evento(t, this.principal.id, 'PostToolUseFailure', ferramenta, erro, { error: erro });
    this.principal.status = 'error';
    this.principal.currentTool = null;
    this.gravarAgente(t, this.principal);
    this.limparEspera();
    this.sessao.status = 'error';
    this.gravarSessao(t);
  }

  /** Para de responder no meio do turno; 180 min depois a sessão é gravada como `abandoned`. */
  private abandonar(t: number): void {
    this.limparEspera();
    this.principal.status = 'working';
    this.evento(t, this.principal.id, 'UserPromptSubmit', null, this.rng.escolher(V.PEDIDOS_DE_SEGUIMENTO), null);
    t = this.ferramenta(t + 5 * SEGUNDO, this.principal);
    this.principal.currentTool = 'Bash';
    this.evento(t, this.principal.id, 'PreToolUse', 'Bash', 'npm run dev', { command: 'npm run dev' });
    this.gravarAgente(t, this.principal);

    const fim = t + MINUTOS_ATE_ABANDONO * MINUTO + this.rng.inteiro(1, 15) * MINUTO;
    this.sessao.status = 'abandoned';
    this.sessao.endedAt = this.relogio(fim);
    this.gravarSessao(fim);
  }

  /** Dois picos de tokens seguidos, cada um estourando o contexto e forçando uma compactação. */
  private estourar(t: number): number {
    for (let i = 0; i < 2; i++) {
      t += this.rng.inteiro(5, 30) * SEGUNDO;
      const file_path = `${this.sessao.cwd}/logs/saida-completa.log`;
      this.evento(t, this.principal.id, 'PreToolUse', 'Read', file_path, { file_path });
      t += this.rng.inteiro(1, 5) * SEGUNDO;
      this.evento(t, this.principal.id, 'PostToolUse', 'Read', file_path, { ok: true });
      this.consumir(t, this.sessao.model!, LIMITE_DE_CONTEXTO - this.contexto + this.rng.inteiro(5_000, 40_000), true);
    }
    return t;
  }

  private encerrar(t: number): void {
    t += this.rng.inteiro(5, 60) * SEGUNDO;
    this.limparEspera();
    this.sessao.status = 'completed';
    this.sessao.endedAt = this.relogio(t);
    this.principal.status = 'completed';
    this.principal.endedAt = this.relogio(t);
    this.principal.currentTool = null;
    this.evento(t, null, 'SessionEnd', null, 'sessão encerrada', { reason: 'other' });
    this.gravarAgente(t, this.principal);
  }

  // --- tokens -------------------------------------------------------------------------

  /**
   * Uma resposta do modelo: lê o contexto do cache, escreve o que cresceu. Estoura e compacta quando passa do limite.
   * Só o principal conta contexto e grava na hora; o uso dos subagentes sai no fim da delegação.
   */
  private consumir(t: number, modelo: string, crescimento: number, contaContexto: boolean): void {
    const uso = this.usos.get(modelo) ?? {
      sessionId: this.id,
      model: modelo,
      speed: 'standard',
      inferenceGeo: '',
      serviceTier: 'standard',
      contextSize: '',
      tokens: emptyTokenCounts(),
      webSearchRequests: 0,
      webFetchRequests: 0,
      codeExecutionRequests: 0,
      baseline: emptyTokenCounts(),
      updatedAt: this.relogio(t),
    };
    this.usos.set(modelo, uso);

    const output = this.rng.inteiro(80, 1800);
    const lido = contaContexto ? this.contexto : this.rng.inteiro(8_000, 30_000);
    uso.tokens = somar(uso.tokens, {
      input: this.rng.inteiro(20, 2500),
      output,
      cacheRead: lido,
      cacheWrite5m: Math.round(crescimento * 0.8),
      cacheWrite1h: Math.round(crescimento * 0.2),
    });
    uso.updatedAt = this.relogio(t);

    if (contaContexto) {
      this.contexto += crescimento + output;
      if (this.contexto > LIMITE_DE_CONTEXTO) {
        // Compactação: o que o transcript contava vira piso, e o contexto recomeça resumido.
        this.estouros++;
        uso.baseline = somar(uso.baseline, uso.tokens);
        uso.tokens = emptyTokenCounts();
        this.evento(t, this.principal.id, 'PreCompact', null, `contexto estourou (${this.estouros}x): compactação automática`, {
          trigger: 'auto',
          contexto: this.contexto,
          limite: LIMITE_DE_CONTEXTO,
        });
        this.contexto = this.rng.inteiro(18_000, 40_000);
      }
    }
    if (!contaContexto) return;
    this.emitir(t, { tipo: 'uso', registro: structuredClone(uso) });
    this.gravarSessao(t);
  }

  // --- gravação -----------------------------------------------------------------------

  private esperar(t: number, motivo: AwaitingReason): void {
    this.sessao.awaitingInputSince = this.relogio(t);
    this.sessao.awaitingReason = motivo;
  }

  private limparEspera(): void {
    this.sessao.awaitingInputSince = null;
    this.sessao.awaitingReason = null;
  }

  private evento(t: number, agentId: string | null, type: string, toolName: string | null, summary: string | null, data: unknown): void {
    this.emitir(t, {
      tipo: 'evento',
      registro: {
        id: `${this.id}-e${String(++this.eventos).padStart(4, '0')}`,
        sessionId: this.id,
        agentId,
        type,
        toolName,
        summary,
        data: data ?? null,
        createdAt: this.relogio(t),
      },
    });
    this.gravarSessao(t);
  }

  private gravarSessao(t: number): void {
    this.sessao.updatedAt = this.relogio(t);
    this.sessao.metadata = {
      simulado: true,
      roteiro: this.roteiro,
      projeto: this.projeto,
      contexto: { usados: this.contexto, limite: LIMITE_DE_CONTEXTO, estouros: this.estouros },
    };
    this.emitir(t, { tipo: 'sessao', registro: structuredClone(this.sessao) });
  }

  private gravarAgente(t: number, agente: Agent): void {
    agente.updatedAt = this.relogio(t);
    this.emitir(t, { tipo: 'agente', registro: structuredClone(agente) });
  }

  private emitir(t: number, gravacao: Gravacao): void {
    this.operacoes.push({ ...gravacao, deslocamentoMs: t, sessao: this.indice, seq: this.seq++ });
  }
}
