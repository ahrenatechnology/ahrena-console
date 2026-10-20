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
  /** Tokens que o principal mandou na última mensagem (input mais cache). */
  usados: number;
  /** Janela do modelo, em tokens (200k, ou 1M no modo longo). */
  limite: number;
  /** 0 a 100. */
  pct: number;
  /** Estouros da sessão: cada compactação automática (a janela encheu). */
  estouros: number;
  /** A partir de 2 estouros (como no Podium). */
  alerta: boolean;
  /** Compactações manuais (`/compact`, o botão Compactar): à parte, não são estouro. */
  compactacoesManuais: number;
  /** "62.6k / 200k (31%)". */
  rotulo: string;
  /** O medidor de cada subagente que já mandou mensagem; `agenteId` é o `SubagenteDoPainel.id`. */
  agentes: ContextoDoAgente[];
}

export interface ContextoDoAgente {
  agenteId: string;
  usados: number;
  limite: number;
  pct: number;
  estouros: number;
  alerta: boolean;
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
  /** #146: o subagente que disparou este; `null` quando foi a própria sessão. */
  pai: string | null;
  /**
   * #146: a onda, o turno da sessão (1, 2, …) em que o subagente foi disparado; o aninhado herda a
   * do subagente de cima. `null` sem os prompts da sessão: o painel agrupa pela sobreposição no tempo.
   */
  onda: number | null;
}

export interface FilhaDoPainel {
  id: string;
  /** `local_…` do índice do Claude Desktop, para abrir a conversa; `null` na sessão só de terminal. */
  local: string | null;
  titulo: string;
  estado: EstadoDoInbox | 'desconhecido';
  motivo: AwaitingReason | null;
  /** Desde quando está no que faz: a atividade atual, se trabalhando; a espera, se parada. */
  desde: string | null;
  /** #131: o que a filha trabalhando está fazendo ("pensando", "rodando Bash"); `null` parada. */
  fazendo?: string | null;
  /** #145: arquivada no Claude Desktop. O painel a conta e lista por último, e oferece desarquivar. */
  arquivada?: boolean;
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
    /** As checagens do último commit, contadas ("CI ✓ 6/6"); `null` sem a contagem. */
    checks?: { total: number; ok: number; falhas: number; rodando: number } | null;
    review: 'aprovado' | 'ajustes' | 'pendente' | null;
  } | null;
  /** O branch não tem upstream: nada foi enviado ainda. */
  semPush: boolean;
  /** O GitHub não respondeu; o resto é o último dado bom, ou nada. */
  erro: string | null;
}

export interface PrecisaDeVoce {
  id: string;
  /**
   * #140: `precisa`, bloqueada até você agir (permissão, pergunta com opções, plano para aprovar,
   * decisão pedida, erro), com destaque e na contagem; `sua-vez`, o bate-bola comum, sem destaque.
   */
  nivel: 'precisa' | 'sua-vez';
  porque: 'permissao' | 'pergunta' | 'plano' | 'decisao' | 'erro' | 'sua-vez' | 'interrompida' | 'no-prompt';
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
  /** Só as que precisam de você (nível `precisa`). */
  total: number;
  /** As que só estão na sua vez: fora da contagem, sem destaque. */
  suaVez: number;
  /** A divisão por conta; "Sem conta" quando não se sabe. Limites nunca entram aqui. */
  porConta: { conta: ContaDoPainel | null; n: number }[];
  /** Só a família desta sessão (quem a abriu e quem ela abriu), urgentes primeiro. */
  familia: PrecisaDeVoce[];
  /** A máquina inteira, urgentes primeiro, até 12. */
  maquina: PrecisaDeVoce[];
}

/** Um PR aberto por uma sessão que aguarda a sua aprovação (review pendente no GitHub). */
export interface PrAguardando {
  numero: number;
  url: string;
  repo: string | null;
  /** A issue do branch, ou o branch. */
  titulo: string;
  sessao: { id: string; titulo: string; local: string | null };
}

export interface PrsDoPainel {
  total: number;
  /** Mais novos primeiro. */
  itens: PrAguardando[];
}

export interface Painel {
  versao: 1;
  /**
   * A versão da API e, para o rodapé: o commit do código que ela carregou ao subir e o da pasta
   * agora (diferentes, a API precisa reiniciar); `null` fora de um git. `abreSessao`: a API abre
   * a conversa no Claude Desktop (`POST /abrir/<local_…>`).
   */
  api: { versao: string; commit: string | null; pasta: string | null; abreSessao: boolean };
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
  /** #140: os PRs aguardando a sua aprovação, em toda a máquina. */
  prs: PrsDoPainel;
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
  /**
   * Quantas vigentes e a confirmar cada escopo tem: o seletor mostra as três contagens, e a pessoa
   * vê quando a troca não muda nada (todas da própria sessão).
   */
  porEscopo?: Record<EscopoDasDecisoes, number>;
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

/**
 * O contrato de `GET /api/mural` (#34, wireframe C2 "Mural ao vivo"): um card por sessão aberta nesta
 * máquina. "Aberta" e a ordem estão em api/mural.ts. Datas em ISO 8601 (UTC).
 */
export interface Mural {
  versao: 1;
  geradoEm: string;
  /**
   * Para o seletor Todas / Esperando / Ativas. `esperando`: estado `waiting` ou `error` (precisa de
   * você); `ativas`: estado `active`, `delegating` ou `background`. As concluídas só contam em `todas`.
   */
  contagem: { todas: number; esperando: number; ativas: number };
  /** Primeiro as que precisam de você (as urgentes antes), depois a atividade mais recente. */
  cards: CardDoMural[];
}

export interface CardDoMural {
  /** Id da sessão: o card leva a `/ui/sessoes/<id>`. */
  id: string;
  /** Como `SessaoDoPainel.titulo`. */
  titulo: string;
  /** O nome da pasta da sessão (basename do cwd); `null` sem pasta. */
  projeto: string | null;
  branch: string | null;
  /** O badge. */
  status: DisplayStatus;
  estado: EstadoDoInbox;
  motivo: AwaitingReason | null;
  /** Espera `notification` ou `interrupted`, e o erro (como `PrecisaDeVoce.urgente`). */
  urgente: boolean;
  /** Desde quando está no estado atual (a espera, o erro, ou a última atividade). */
  desde: string;
  /** A linha do meio: o que pede (waiting), o erro, "terminou sem erro", ou o que está fazendo. */
  atividade: AtividadeDaSessao;
  modelo: string | null;
  /** O esforço (`effort`) da sessão, do índice do Claude Desktop; `null` quando o núcleo não sabe. */
  esforco: string | null;
  /** Agentes: o principal mais os subagentes; os trabalhando agora e todos os que a sessão já teve. */
  agentes: { ativos: number; total: number };
  /** `usd: null`: há uso, mas sem preço ("sem preço", nunca zero). */
  custo: { usd: number | null; estimativa: true };
  plano: { feitos: number; total: number; atual: string | null } | null;
  contexto: { pct: number; usados: number; limite: number; rotulo: string } | null;
}
