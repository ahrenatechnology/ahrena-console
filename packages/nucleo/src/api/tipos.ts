// O contrato de `GET /api/painel/<sessão>`: tudo o que o painel lateral desenha, num pedido só.
// O plugin (plugins/ahrena-console/types) repete estes tipos; mudar um é mudar os dois.
// Datas em ISO 8601 (UTC); o painel calcula "há quanto tempo" com o próprio relógio.

import type { AccountSource, AwaitingReason, DisplayStatus } from '../model.ts';
import type { EstadoDoInbox } from '../estados/leitura.ts';

export interface ContaDoPainel {
  /** `<accountUuid>/<organizationUuid>`; só para agrupar, nunca para mostrar. */
  id: string;
  rotulo: string;
  /** Hex: a cor da `ClaudeAccount`, a do arquivo de rótulos ou uma da paleta da marca. */
  cor: string;
  /** De onde veio, pela ordem da decisão 0006. */
  fonte: AccountSource;
}

/** Linha de baixo do card "Esta sessão": o que ela está fazendo agora. */
export interface AtividadeDaSessao {
  tipo: 'ferramenta' | 'delegando' | 'pergunta' | 'permissao' | 'erro' | 'prompt' | 'sua-vez' | 'interrompida' | 'concluida' | 'abandonada' | 'ociosa';
  texto: string;
}

/** A faixa de cima, quando a sessão espera por algo que precisa ser lido inteiro (P2, P3, P5). */
export interface FaixaDaSessao {
  tipo: 'pergunta' | 'permissao' | 'erro';
  /** O texto inteiro: a pergunta, o pedido de permissão ou o erro. */
  texto: string;
  /** "3 opções · responda na conversa ao lado". */
  rodape: string;
  desde: string;
}

export interface SessaoDoPainel {
  id: string;
  titulo: string;
  modelo: string | null;
  iniciadaEm: string;
  status: DisplayStatus;
  estado: EstadoDoInbox;
  motivo: AwaitingReason | null;
  urgente: boolean;
  /** Desde quando está no estado atual (a espera, ou a última atividade). */
  desde: string;
  turno: number;
  atividade: AtividadeDaSessao;
  faixa: FaixaDaSessao | null;
  conta: ContaDoPainel | null;
  branch: string | null;
  cwd: string | null;
}

export interface ContextoDoPainel {
  usados: number;
  limite: number;
  /** 0 a 100. */
  pct: number;
}

export interface CustoDoPainel {
  /** `null`: há uso, mas nenhum modelo dele tem preço ("sem preço", nunca zero). */
  usd: number | null;
  /** Custo acumulado ao longo da sessão, de 2 a 16 pontos, para a linha do card. */
  serie: number[];
  estimativa: true;
}

export interface PlanoDoPainel {
  feitos: number;
  total: number;
  /** O item em andamento. */
  atual: string | null;
  /** O próximo a fazer. */
  proximo: string | null;
  /** Quantos ainda faltam além do próximo. */
  restantes: number;
  /** Quem faz o item em andamento. */
  atualDono: DonoDoPasso | null;
  /** Hora da última mudança do plano; `null` no plano lido só do TodoWrite (sem plano gravado). */
  mudouEm: string | null;
  /** Os passos na ordem do plano (item 1.9). */
  passos: PassoDoPainel[];
}

/** O principal, um subagente ou uma sessão filha, quando o passo foi delegado. */
export interface DonoDoPasso {
  tipo: 'principal' | 'subagente' | 'sessao';
  /** Nome do subagente (tipo ou `owner`) ou da sessão filha; `null` no principal. */
  nome: string | null;
  /** Id do agente no núcleo, quando se sabe. */
  agenteId: string | null;
}

export interface PassoDoPainel {
  id: string;
  texto: string;
  /** O texto no gerúndio, para o passo em andamento. */
  textoAtivo: string | null;
  estado: 'pending' | 'in_progress' | 'completed';
  dono: DonoDoPasso;
}

export interface SubagenteDoPainel {
  id: string;
  nome: string;
  tarefa: string | null;
  status: 'working' | 'waiting' | 'completed' | 'error';
  desde: string;
  ate: string | null;
}

export interface FilhaDoPainel {
  id: string;
  titulo: string;
  estado: EstadoDoInbox | 'desconhecido';
  motivo: AwaitingReason | null;
  desde: string | null;
}

export interface TrabalhoDoPainel {
  branch: string;
  /** `dono/repo`, do remote do git. */
  repo: string | null;
  issue: { numero: number; titulo: string; url: string; subIssues: { feitas: number; total: number } | null } | null;
  pr: {
    numero: number;
    url: string;
    estado: 'rascunho' | 'aberto' | 'mergeado' | 'fechado';
    ci: 'ok' | 'falhou' | 'rodando' | null;
    review: 'aprovado' | 'ajustes' | 'pendente' | null;
  } | null;
  /** O branch não tem upstream: nada foi enviado ainda. */
  semPush: boolean;
  /** O GitHub não respondeu; o resto é o último dado bom, ou nada. */
  erro: string | null;
}

export interface PrecisaDeVoce {
  id: string;
  titulo: string;
  estado: 'waiting' | 'error';
  motivo: AwaitingReason | null;
  urgente: boolean;
  desde: string;
  /** O que ela espera: o comando, a pergunta, o erro. */
  texto: string;
  modelo: string | null;
  /** Em relação a esta sessão. */
  relacao: 'mae' | 'filha' | 'irma' | null;
  /** Mesmo projeto (cwd) desta sessão. */
  mesmoProjeto: boolean;
  conta: ContaDoPainel | null;
}

export interface PrecisamDoPainel {
  total: number;
  /** A divisão por conta; "Sem conta" quando não se sabe. Limites nunca entram aqui. */
  porConta: { conta: ContaDoPainel | null; n: number }[];
  /** Só a família desta sessão (quem a abriu e quem ela abriu), urgentes primeiro. */
  familia: PrecisaDeVoce[];
  /** A máquina inteira, urgentes primeiro, até 12. */
  maquina: PrecisaDeVoce[];
}

export interface Painel {
  versao: 1;
  geradoEm: string;
  /** `null`: o núcleo ainda não viu esta sessão (nem hook, nem transcript). */
  sessao: SessaoDoPainel | null;
  contexto: ContextoDoPainel | null;
  custo: CustoDoPainel | null;
  tokens: { entrada: number; saida: number } | null;
  background: { total: number; primeiro: string | null };
  plano: PlanoDoPainel | null;
  subagentes: { ativos: number; itens: SubagenteDoPainel[] };
  filhas: FilhaDoPainel[];
  trabalho: TrabalhoDoPainel | null;
  precisam: PrecisamDoPainel;
}
