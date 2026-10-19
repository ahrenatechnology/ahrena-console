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

/** Um plano do histórico da sessão (issue #131). */
export interface PlanoDaSessao {
  /** 1, 2, 3… na ordem em que os planos começaram. */
  numero: number;
  resultado: 'atual' | 'concluido' | 'abandonado';
  /** O primeiro passo do plano. */
  resumo: string;
  feitos: number;
  total: number;
  /** O passo em andamento (só no atual). */
  atual: string | null;
  inicio: string;
  /** `null` no atual. */
  fim: string | null;
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
  /** `local_…` do índice do Claude Desktop, para abrir a conversa; `null` na sessão só de terminal. */
  local: string | null;
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
  /** `local_…` do índice do Claude Desktop, para abrir a conversa; `null` na sessão só de terminal. */
  local: string | null;
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
  /** A versão da API e o commit do checkout em que ela roda (`null` fora de um git), para o rodapé. */
  api: { versao: string; commit: string | null };
  geradoEm: string;
  /** `null`: o núcleo ainda não viu esta sessão (nem hook, nem transcript). */
  sessao: SessaoDoPainel | null;
  contexto: ContextoDoPainel | null;
  custo: CustoDoPainel | null;
  tokens: { entrada: number; saida: number } | null;
  background: { total: number; primeiro: string | null };
  plano: PlanoDoPainel | null;
  /** Os planos da sessão, do mais recente para o mais antigo; o atual, se houver, primeiro. */
  planos: PlanoDaSessao[];
  subagentes: { ativos: number; itens: SubagenteDoPainel[] };
  filhas: FilhaDoPainel[];
  trabalho: TrabalhoDoPainel | null;
  precisam: PrecisamDoPainel;
  /** `null`: o núcleo subiu sem a porta das decisões. */
  decisoes: DecisoesDoPainel | null;
}

/** O escopo da lista de decisões (o Select do P9). */
export type EscopoDasDecisoes = 'sessao' | 'familia' | 'branch';

/** Uma decisão no card 34 × 6 (P9). */
export interface DecisaoDoPainel {
  id: string;
  /** "D4": o número na família. */
  rotulo: string;
  origem: 'pergunta' | 'plano' | 'permissao' | 'correcao' | 'sugerida';
  /** Só os três primeiros entram na lista; a descartada só volta como resposta do Descartar. */
  estado: 'vigente' | 'substituida' | 'a_confirmar' | 'descartada';
  /** O que foi decidido, numa frase. */
  titulo: string;
  /** O texto inteiro, para o detalhe (na correção, o que a pessoa escreveu). */
  texto: string;
  /** A pergunta, o pedido ou a proposta que levou à decisão. */
  contexto: string | null;
  /** A última ação feita pelo painel, que o Desfazer volta; `null` quando não há. */
  desfazer: 'confirmar' | 'descartar' | 'ajustar' | null;
  /** O que foi descartado ("não: …"). */
  nao: string[];
  decididaPor: 'usuario' | 'agente';
  decididaEm: string;
  /** A sugerida que a pessoa confirmou pelo painel: quando. */
  confirmadaEm: string | null;
  /** O "D4" da decisão que substituiu esta. */
  substituidaPor: string | null;
  /** De que sessão veio, em relação a esta. */
  sessao: 'esta' | 'mae' | 'familia' | 'branch';
  /** O `tool_use_id` da mensagem, para o "ver na conversa" quando ela é desta sessão. */
  toolUseId: string | null;
}

export interface ListaDeDecisoes {
  escopo: EscopoDasDecisoes;
  /** Vigentes e a confirmar neste escopo. */
  vigentes: number;
  aConfirmar: number;
  /** Mais recentes primeiro: vigentes, a confirmar e substituídas. */
  itens: DecisaoDoPainel[];
}

/**
 * A faixa do P10: as decisões da sessão anterior que valem nesta depois de um /clear. Só vem
 * quando a reinjeição (#100) gravou o que injetou; até lá, sempre `null`.
 */
export interface RetomadaDoPainel {
  /** Quantas decisões foram injetadas. */
  n: number;
  /** Tokens que a injeção custou (estimativa). */
  tokens: number | null;
  /** O título da sessão anterior. */
  de: string | null;
}

export interface DecisoesDoPainel {
  /** Vigentes no escopo família: a linha "N decisões vigentes". */
  vigentes: number;
  aConfirmar: number;
  retomada: RetomadaDoPainel | null;
  /** A lista aberta, só quando o painel pede (`?decisoes=<escopo>`). */
  lista: ListaDeDecisoes | null;
}
