// A máquina de estados: lê sessão e agentes pela porta, aplica as regras (regras.ts, vigia.ts) e grava.
// Entra por três lados:
// - `aoReceberHook`, pendurado no `onEvent` do receptor de hooks;
// - `sincronizar(id)`, para eventos que chegaram à porta por outro caminho (histórico, tempo real);
// - `varrer()`, o vigia, a cada 15 s com `iniciar()`.
// Relógio e sonda são injetáveis, para os testes serem determinísticos.

import type { IngestResult } from '../ingest/hooks/ingest.ts';
import type { Agent, Session, SessionEvent } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { lerInbox, type EstadoDoInbox } from './leitura.ts';
import { CHAVE_DA_MEMORIA, lerMemoria, transicionar, type EstadoDaSessao } from './regras.ts';
import { sondaDoSistema, type SondaDeProcesso } from './sonda.ts';
import { LIMITES_PADRAO, vigiar, type Limites, type RegraDoVigia } from './vigia.ts';

export const INTERVALO_DO_VIGIA_MS = 15_000;

export interface OpcoesDaMaquina {
  storage: StoragePort;
  /** Relógio. Padrão `new Date()`. */
  agora?: () => Date;
  /** Padrão `sondaDoSistema()`; `null` desliga (nuvem, fontes remotas). */
  sonda?: SondaDeProcesso | null;
  limites?: Partial<Limites>;
  /** Chamado a cada mudança gravada (para o tempo real avisar quem olha). */
  aoMudar?: (mudanca: Mudanca) => void;
  log?: (mensagem: string) => void;
}

export interface Mudanca {
  sessionId: string;
  antes: EstadoDoInbox;
  depois: EstadoDoInbox;
  /** Tipo do evento que causou, ou a regra do vigia. */
  causa: string;
  regra: RegraDoVigia | null;
}

export class MaquinaDeEstados {
  private readonly storage: StoragePort;
  private readonly agora: () => Date;
  private readonly sonda: SondaDeProcesso | null;
  private readonly limites: Limites;
  private readonly aoMudar?: (m: Mudanca) => void;
  private readonly log: (m: string) => void;
  private fila: Promise<unknown> = Promise.resolve();

  constructor(opcoes: OpcoesDaMaquina) {
    this.storage = opcoes.storage;
    this.agora = opcoes.agora ?? (() => new Date());
    this.sonda = opcoes.sonda === undefined ? sondaDoSistema() : opcoes.sonda;
    this.limites = { ...LIMITES_PADRAO, ...opcoes.limites };
    this.aoMudar = opcoes.aoMudar;
    this.log = opcoes.log ?? ((m) => console.error(`[ahrena-console estados] ${m}`));
  }

  /** Para o `onEvent` do receptor de hooks. */
  readonly aoReceberHook = async (resultado: IngestResult): Promise<void> => {
    await this.aplicar(resultado.event);
  };

  /** Aplica um evento já gravado na porta. */
  aplicar(evento: SessionEvent): Promise<Mudanca | null> {
    return this.emSerie(async () => {
      const estado = await this.carregar(evento.sessionId);
      if (!estado) return null;
      return this.gravar(estado, transicionar(estado, evento), evento.type, null);
    });
  }

  /** Aplica, em ordem, os eventos da sessão que a máquina ainda não viu (os do histórico, por exemplo). */
  sincronizar(sessionId: string): Promise<Mudanca | null> {
    return this.emSerie(() => this.sincronizarJa(sessionId));
  }

  /** Uma passada do vigia em todas as sessões ativas ou em erro. */
  varrer(): Promise<Mudanca[]> {
    return this.emSerie(async () => {
      const vivos = this.sonda ? await this.sonda.diretoriosVivos().catch(() => null) : null;
      const mudancas: Mudanca[] = [];
      let cursor: string | null = null;
      do {
        const pagina = await this.storage.listSessions({ status: ['active', 'error'], limit: 200, cursor });
        for (const s of pagina.items) {
          try {
            const m = await this.vigiarSessao(s, vivos);
            if (m) mudancas.push(m);
          } catch (err) {
            this.log(`vigia falhou na sessão ${s.id}: ${(err as Error).message}`);
          }
        }
        cursor = pagina.nextCursor;
      } while (cursor);
      return mudancas;
    });
  }

  /** Liga o vigia. Devolve a função que desliga. */
  iniciar(intervaloMs = INTERVALO_DO_VIGIA_MS): () => void {
    const timer = setInterval(() => {
      this.varrer().catch((err) => this.log(`vigia falhou: ${(err as Error).message}`));
    }, intervaloMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // --- interno ---

  private async vigiarSessao(s: Session, vivos: ReadonlySet<string> | null): Promise<Mudanca | null> {
    // Atividade que a máquina não viu (histórico importado, hook que falhou no onEvent): aplica antes de julgar.
    const memoria = lerMemoria(s);
    let sincronizada: Mudanca | null = null;
    if (!memoria.ultimoEvento || s.updatedAt > memoria.ultimoEvento) sincronizada = await this.sincronizarJa(s.id);

    const estado = await this.carregar(s.id);
    if (!estado) return sincronizada;
    const vigilia = vigiar(estado, this.agora(), vivos, this.limites);
    if (!vigilia) return sincronizada;
    await this.storage.appendEvent(vigilia.evento);
    return (await this.gravar(estado, transicionar(estado, vigilia.evento), vigilia.evento.type, vigilia.regra)) ?? sincronizada;
  }

  private async sincronizarJa(sessionId: string): Promise<Mudanca | null> {
    const inicial = await this.carregar(sessionId);
    if (!inicial) return null;
    let estado = inicial;
    let ultimo: string | null = null;
    let cursor: string | null = null;
    do {
      const pagina = await this.storage.listEvents(sessionId, { limit: 500, cursor });
      for (const e of pagina.items) {
        const proximo = transicionar(estado, e);
        if (proximo !== estado) ultimo = e.type;
        estado = proximo;
      }
      cursor = pagina.nextCursor;
    } while (cursor);
    if (!ultimo) return null;
    return this.gravar(inicial, estado, ultimo, null);
  }

  private async carregar(sessionId: string): Promise<EstadoDaSessao | null> {
    const session = await this.storage.getSession(sessionId);
    if (!session) return null;
    return { session, agentes: await this.storage.listAgents(sessionId) };
  }

  private async gravar(antes: EstadoDaSessao, depois: EstadoDaSessao, causa: string, regra: RegraDoVigia | null): Promise<Mudanca | null> {
    if (antes === depois) return null;
    const anteriores = new Map(antes.agentes.map((a) => [a.id, a]));
    for (const a of depois.agentes) {
      if (!igual(anteriores.get(a.id), a)) await this.storage.putAgent(a);
    }
    if (!igual(antes.session, depois.session)) {
      // Relê na hora de gravar: o receptor pode ter atualizado cwd, modelo ou metadata enquanto isso.
      const atual = (await this.storage.getSession(depois.session.id)) ?? antes.session;
      await this.storage.putSession(mesclar(atual, depois.session));
    }
    const de = lerInbox(antes.session, antes.agentes).estado;
    const para = lerInbox(depois.session, depois.agentes).estado;
    const mudanca: Mudanca = { sessionId: depois.session.id, antes: de, depois: para, causa, regra };
    if (de !== para) {
      try {
        this.aoMudar?.(mudanca);
      } catch (err) {
        this.log(`aoMudar falhou: ${(err as Error).message}`);
      }
    }
    return mudanca;
  }

  private emSerie<T>(tarefa: () => Promise<T>): Promise<T> {
    const rodada = this.fila.then(tarefa, tarefa);
    this.fila = rodada.catch(() => undefined);
    return rodada;
  }
}

/** Os campos de estado vêm da máquina; o resto, do registro atual (que outros também gravam). */
function mesclar(atual: Session, daMaquina: Session): Session {
  return {
    ...atual,
    status: daMaquina.status,
    endedAt: daMaquina.endedAt,
    awaitingInputSince: daMaquina.awaitingInputSince,
    awaitingReason: daMaquina.awaitingReason,
    updatedAt: atual.updatedAt > daMaquina.updatedAt ? atual.updatedAt : daMaquina.updatedAt,
    metadata: { ...atual.metadata, [CHAVE_DA_MEMORIA]: daMaquina.metadata[CHAVE_DA_MEMORIA] },
  };
}

function igual(a: Agent | Session | undefined, b: Agent | Session): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}
