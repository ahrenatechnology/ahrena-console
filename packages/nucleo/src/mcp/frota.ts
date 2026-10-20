// O que as ferramentas leem da máquina: as sessões vivas com estado, motivo e conta, as
// encerradas hoje e o custo de hoje. Tudo pela porta e por caches em memória, como o painel
// (decisão 0004): nenhuma chamada varre transcripts.
//
// - Vivas: as `active` e `error` da porta, com `readInbox` (1.5). Guardadas por `cacheMs`, e
//   chamadas ao mesmo tempo esperam a mesma leitura.
// - Encerradas hoje: `completed` e `abandoned` com a última atividade hoje, no fuso da máquina.
// - Today's cost: the day's `aggregateCost` (1.6), recomputed at most every `custoMs`.
// - Conta: `Contas.daSessao` (decisão 0006), a mesma instância do painel quando o núcleo a
//   passa, para o rótulo "conta 1" ser o mesmo nas duas superfícies.

import { basename } from 'node:path';
import { aggregateCost, dayOf, type CostReport } from '../cost/aggregation.ts';
import { readInbox, type InboxState, type InboxReading } from '../states/inbox.ts';
import type { Agent, Session, SessionStatus } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { Contas } from '../api/contas.ts';
import type { IndiceDoDesktop, SessaoDoDesktop } from '../api/indice-desktop.ts';
import { atencaoDe, type MotivoDaAtencao } from '../api/atencao.ts';
import { ResumosDeSessao, type ResumoDosEventos } from '../api/resumo.ts';
import type { ContaDoPainel } from '../api/tipos.ts';
import { ferramentaSegura, tituloSeguro } from './saida.ts';

/**
 * Por que a sessão precisa de você. A divisão é a do painel (`atencaoDe`, #140): as cinco
 * primeiras travam a sessão até você agir; as três últimas são "sua vez" no bate-bola (o turno
 * acabou, Esc, sessão nova no prompt).
 */
export type Motivo = 'permission' | 'question' | 'plan' | 'decision' | 'error' | 'turn_ended' | 'interrupted' | 'first_prompt';
export type Grupo = 'blocking' | 'your_turn';
export const MOTIVOS: readonly Motivo[] = ['permission', 'question', 'plan', 'decision', 'error', 'turn_ended', 'interrupted', 'first_prompt'];

const MOTIVO_DO_PAINEL: Record<MotivoDaAtencao, Motivo> = {
  permissao: 'permission',
  pergunta: 'question',
  plano: 'plan',
  decisao: 'decision',
  erro: 'error',
  'sua-vez': 'turn_ended',
  interrompida: 'interrupted',
  'no-prompt': 'first_prompt',
};

export interface SessaoDaFrota {
  session: Session;
  inbox: InboxReading;
  desktop: SessaoDoDesktop | null;
  conta: ContaDoPainel | null;
  /** Já limpo (saida.ts). */
  titulo: string;
}

export interface Atencao {
  motivo: Motivo;
  grupo: Grupo;
  /** A ferramenta que pede permissão, quando tem nome conhecido. */
  ferramenta: string | null;
  /** Quantas opções a pergunta tem (`AskUserQuestion`); nunca o texto. */
  opcoes: number | null;
  /** O código do erro da API ("529", "overloaded_error"); nunca a mensagem. */
  codigoDoErro: string | null;
}

export interface EncerradaHoje {
  id: string;
  status: SessionStatus;
  conta: ContaDoPainel | null;
}

export interface OpcoesDaFrota {
  storage: StoragePort;
  contas: Contas;
  desktop?: IndiceDoDesktop | null;
  agora?: () => number;
  /** Fuso IANA dos dias (custo de hoje, encerradas hoje). Padrão: o da máquina. */
  fusoHorario?: string;
  cacheMs?: number;
  custoMs?: number;
}

export class LeituraDaFrota {
  readonly storage: StoragePort;
  private readonly contas: Contas;
  private readonly desktop: IndiceDoDesktop | null;
  readonly agora: () => number;
  readonly fusoHorario: string;
  private readonly cacheMs: number;
  private readonly custoMs: number;
  private readonly resumos: ResumosDeSessao;
  private vivasCache: { em: number; itens: SessaoDaFrota[] } | null = null;
  private vivasRodando: Promise<SessaoDaFrota[]> | null = null;
  private custoCache: { em: number; dia: string; relatorio: CostReport } | null = null;

  constructor({ storage, contas, desktop = null, agora = Date.now, fusoHorario, cacheMs = 2_000, custoMs = 30_000 }: OpcoesDaFrota) {
    this.storage = storage;
    this.contas = contas;
    this.desktop = desktop;
    this.agora = agora;
    this.fusoHorario = fusoHorario ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
    this.cacheMs = cacheMs;
    this.custoMs = custoMs;
    this.resumos = new ResumosDeSessao(storage, { agora, maximo: 256 });
  }

  hoje(): string {
    return dayOf(new Date(this.agora()).toISOString(), this.fusoHorario);
  }

  /** As sessões `active` e `error`, com o estado do inbox e a conta. Mais recentes primeiro. */
  async vivas(): Promise<SessaoDaFrota[]> {
    if (this.vivasCache && this.agora() - this.vivasCache.em < this.cacheMs) return this.vivasCache.itens;
    this.vivasRodando ??= (async () => {
      await Promise.all([this.contas.atualizar(), this.desktop?.atualizar()]);
      const itens: SessaoDaFrota[] = [];
      for await (const session of this.todas({ status: ['active', 'error'] })) {
        const agentes: Agent[] = await this.storage.listAgents(session.id);
        const desktop = this.desktop?.sessaoPorCli(session.id) ?? null;
        itens.push({ session, inbox: readInbox(session, agentes), desktop, conta: this.contas.daSessao(session, desktop), titulo: tituloDe(session, desktop) });
      }
      this.vivasCache = { em: this.agora(), itens };
      return itens;
    })().finally(() => {
      this.vivasRodando = null;
    });
    return this.vivasRodando;
  }

  /** `completed` e `abandoned` com a última atividade hoje. */
  async encerradasHoje(): Promise<EncerradaHoje[]> {
    const hoje = this.hoje();
    const out: EncerradaHoje[] = [];
    for await (const s of this.todas({ status: ['completed', 'abandoned'] }, hoje)) {
      const desktop = this.desktop?.sessaoPorCli(s.id) ?? null;
      out.push({ id: s.id, status: s.status, conta: this.contas.daSessao(s, desktop) });
    }
    return out;
  }

  async custoDeHoje(): Promise<CostReport> {
    const dia = this.hoje();
    const c = this.custoCache;
    if (c && c.dia === dia && this.agora() - c.em < this.custoMs) return c.relatorio;
    const relatorio = await aggregateCost(this.storage, { since: dia, until: dia, timeZone: this.fusoHorario });
    this.custoCache = { em: this.agora(), dia, relatorio };
    return relatorio;
  }

  /** A conta de uma sessão qualquer (para o custo de uma que não está entre as vivas). */
  async contaDe(sessionId: string): Promise<ContaDoPainel | null> {
    const s = await this.storage.getSession(sessionId);
    if (!s) return null;
    return this.contas.daSessao(s, this.desktop?.sessaoPorCli(s.id) ?? null);
  }

  /** Por que uma sessão que precisa de você está esperando, sem texto da conversa. */
  async atencao(s: SessaoDaFrota): Promise<Atencao> {
    const r = await this.resumos.ler(s.session.id, s.session.updatedAt);
    return classificar(s.inbox, r);
  }

  private async *todas(query: { status: SessionStatus[] }, desdeODia?: string): AsyncGenerator<Session> {
    let cursor: string | null = null;
    do {
      const page = await this.storage.listSessions({ ...query, limit: 500, cursor });
      for (const s of page.items) {
        // Mais recentes primeiro: a primeira de antes do dia encerra a busca.
        if (desdeODia && dayOf(s.updatedAt, this.fusoHorario) < desdeODia) return;
        yield s;
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
}

/**
 * O motivo e o grupo vêm de `atencaoDe` (src/api/atencao.ts), a mesma regra do "precisam de você"
 * do painel; aqui só se acrescenta o que o MCP mostra além dela, sem texto da conversa.
 */
export function classificar(inbox: InboxReading, r: ResumoDosEventos): Atencao {
  const { nivel, porque } = atencaoDe(inbox, r);
  const motivo = MOTIVO_DO_PAINEL[porque];
  return {
    motivo,
    grupo: nivel === 'precisa' ? 'blocking' : 'your_turn',
    ferramenta: motivo === 'permission' ? ferramentaSegura(r.ultimaFerramenta?.nome) : null,
    opcoes: motivo === 'question' ? r.ultimaPergunta?.opcoes || null : null,
    codigoDoErro: motivo === 'error' ? codigoDoErro(r.ultimoErro?.texto ?? null) : null,
  };
}

/** Só o código: o status HTTP e o tipo do erro da API, nunca a mensagem. */
function codigoDoErro(texto: string | null): string | null {
  if (!texto) return null;
  const partes = [/\b([45]\d\d)\b/.exec(texto)?.[1], /\b([a-z]+(?:_[a-z]+)*_error)\b/.exec(texto)?.[1]].filter(Boolean);
  return partes.length > 0 ? partes.join(' ') : null;
}

function tituloDe(s: Session, d: SessaoDoDesktop | null): string {
  return tituloSeguro(d?.titulo) ?? tituloSeguro(s.name) ?? (s.cwd ? tituloSeguro(basename(s.cwd)) : null) ?? s.id.slice(0, 8);
}

export function projetoDe(s: Session): string | null {
  return s.cwd ? tituloSeguro(basename(s.cwd)) : null;
}

/** Estados vivos na ordem em que aparecem nos totais. */
export const ESTADOS_VIVOS: readonly InboxState[] = ['active', 'waiting', 'delegating', 'background', 'error'];

/**
 * Casa a conta da sessão com o filtro `account`: rótulo (sem diferença de caixa), id, ou "none"
 * para "Sem conta". Sem filtro, tudo passa.
 */
export function casaConta(conta: ContaDoPainel | null, filtro: readonly string[] | null): boolean {
  if (!filtro) return true;
  return filtro.some((f) => (f.toLowerCase() === 'none' ? conta === null : conta !== null && (conta.id === f || conta.label.toLowerCase() === f.toLowerCase())));
}

export function minutosDesde(iso: string, agora: number): number {
  return Math.max(0, Math.floor((agora - Date.parse(iso)) / 60_000));
}
