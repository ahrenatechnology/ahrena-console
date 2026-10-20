// O contrato de `GET /api/panel/<session>`: tudo o que o painel lateral desenha, num pedido só.
// The plugin's types (plugins/ahrena-console/types) are the old Portuguese shape, served by the old
// route `/api/painel/<id>` and kept by the back-translator of src/api/legacy-routes.ts; changing these
// types does not change the plugin's.
// Since #173 phase 2b the keys and fixed values are English. The mod migrates on its own: until it
// does, it reads the old route (`/api/painel/<id>`), which answers the old Portuguese body through the
// back-translator of src/api/legacy-routes.ts (the `panel` spec, with the key table at its top).
// Datas em ISO 8601 (UTC); o painel calcula "há quanto tempo" com o próprio relógio.

import type { AccountSource, AwaitingReason, DisplayStatus } from '../model.ts';
import type { EstadoDoInbox } from '../estados/leitura.ts';

export interface ContaDoPainel {
  /** `<accountUuid>/<organizationUuid>`; só para agrupar, nunca para mostrar. */
  id: string;
  label: string;
  /** Hex: a cor da `ClaudeAccount`, a do arquivo de rótulos ou uma da paleta da marca. */
  color: string;
  /** De onde veio, pela ordem da decisão 0006. */
  source: AccountSource;
}

/** Linha de baixo do card "Esta sessão": o que ela está fazendo agora. */
export interface AtividadeDaSessao {
  type: 'tool' | 'delegating' | 'question' | 'permission' | 'error' | 'prompt' | 'your-turn' | 'interrupted' | 'completed' | 'abandoned' | 'idle';
  text: string;
}

/** A faixa de cima, quando a sessão espera por algo que precisa ser lido inteiro (P2, P3, P5). */
export interface FaixaDaSessao {
  type: 'question' | 'permission' | 'error';
  /** O texto inteiro: a pergunta, o pedido de permissão ou o erro. */
  text: string;
  /** "3 opções · responda na conversa ao lado". */
  footer: string;
  since: string;
}

export interface SessaoDoPainel {
  id: string;
  title: string;
  model: string | null;
  startedAt: string;
  status: DisplayStatus;
  state: EstadoDoInbox;
  reason: AwaitingReason | null;
  urgent: boolean;
  /** Desde quando está no estado atual (a espera, ou a última atividade). */
  since: string;
  turn: number;
  activity: AtividadeDaSessao;
  banner: FaixaDaSessao | null;
  account: ContaDoPainel | null;
  branch: string | null;
  cwd: string | null;
}

export interface ContextoDoPainel {
  /** Tokens que o principal mandou na última mensagem (input mais cache). */
  used: number;
  /** Janela do modelo, em tokens (200k, ou 1M no modo longo). */
  limit: number;
  /** 0 a 100. */
  pct: number;
  /** Estouros da sessão: cada compactação automática (a janela encheu). */
  overflows: number;
  /** A partir de 2 estouros (como no Podium). */
  alert: boolean;
  /** Compactações manuais (`/compact`, o botão Compactar): à parte, não são estouro. */
  manualCompactions: number;
  /** "62.6k / 200k (31%)". */
  label: string;
  /** O medidor de cada subagente que já mandou mensagem; `agentId` é o `SubagenteDoPainel.id`. */
  agents: ContextoDoAgente[];
}

export interface ContextoDoAgente {
  agentId: string;
  used: number;
  limit: number;
  pct: number;
  overflows: number;
  alert: boolean;
}

export interface CustoDoPainel {
  /** `null`: há uso, mas nenhum modelo dele tem preço ("sem preço", nunca zero). */
  usd: number | null;
  /** Custo acumulado ao longo da sessão, de 2 a 16 pontos, para a linha do card. */
  series: number[];
  estimate: true;
}

export interface PlanoDoPainel {
  done: number;
  total: number;
  /** O item em andamento. */
  current: string | null;
  /** O próximo a fazer. */
  next: string | null;
  /** Quantos ainda faltam além do próximo. */
  remaining: number;
  /** Quem faz o item em andamento. */
  currentOwner: DonoDoPasso | null;
  /** Hora da última mudança do plano; `null` no plano lido só do TodoWrite (sem plano gravado). */
  changedAt: string | null;
  /** Os passos na ordem do plano (item 1.9). */
  steps: PassoDoPainel[];
}

/** Um plano do histórico da sessão (issue #131). */
export interface PlanoDaSessao {
  /** 1, 2, 3… na ordem em que os planos começaram. */
  number: number;
  outcome: 'current' | 'completed' | 'abandoned';
  /** O primeiro passo do plano. */
  summary: string;
  done: number;
  total: number;
  /** O passo em andamento (só no atual). */
  current: string | null;
  start: string;
  /** `null` no atual. */
  end: string | null;
}

/** O principal, um subagente ou uma sessão filha, quando o passo foi delegado. */
export interface DonoDoPasso {
  type: 'main' | 'subagent' | 'session';
  /** Nome do subagente (tipo ou `owner`) ou da sessão filha; `null` no principal. */
  name: string | null;
  /** Id do agente no núcleo, quando se sabe. */
  agentId: string | null;
}

export interface PassoDoPainel {
  id: string;
  text: string;
  /** O texto no gerúndio, para o passo em andamento. */
  activeText: string | null;
  state: 'pending' | 'in_progress' | 'completed';
  owner: DonoDoPasso;
}

export interface SubagenteDoPainel {
  id: string;
  name: string;
  task: string | null;
  status: 'working' | 'waiting' | 'completed' | 'error';
  since: string;
  until: string | null;
  /** #146: o subagente que disparou este; `null` quando foi a própria sessão. */
  parent: string | null;
  /**
   * #146: a onda, o turno da sessão (1, 2, …) em que o subagente foi disparado; o aninhado herda a
   * do subagente de cima. `null` sem os prompts da sessão: o painel agrupa pela sobreposição no tempo.
   */
  wave: number | null;
}

export interface FilhaDoPainel {
  id: string;
  /** `local_…` do índice do Claude Desktop, para abrir a conversa; `null` na sessão só de terminal. */
  local: string | null;
  title: string;
  state: EstadoDoInbox | 'unknown';
  reason: AwaitingReason | null;
  /** Desde quando está no que faz: a atividade atual, se trabalhando; a espera, se parada. */
  since: string | null;
  /** #131: o que a filha trabalhando está fazendo ("pensando", "rodando Bash"); `null` parada. */
  doing?: string | null;
  /** #145: arquivada no Claude Desktop. O painel a conta e lista por último, e oferece desarquivar. */
  archived?: boolean;
}

export interface TrabalhoDoPainel {
  branch: string;
  /** `dono/repo`, do remote do git. */
  repo: string | null;
  issue: { number: number; title: string; url: string; subIssues: { done: number; total: number } | null } | null;
  pr: {
    number: number;
    url: string;
    state: 'draft' | 'open' | 'merged' | 'closed';
    ci: 'ok' | 'failed' | 'running' | null;
    /** As checagens do último commit, contadas ("CI ✓ 6/6"); `null` sem a contagem. */
    checks?: { total: number; ok: number; failed: number; running: number } | null;
    review: 'approved' | 'changes-requested' | 'pending' | null;
  } | null;
  /** O branch não tem upstream: nada foi enviado ainda. */
  notPushed: boolean;
  /** O GitHub não respondeu; o resto é o último dado bom, ou nada. */
  error: string | null;
}

export interface PrecisaDeVoce {
  id: string;
  /**
   * #140: `needs`, bloqueada até você agir (permissão, pergunta com opções, plano para aprovar,
   * decisão pedida, erro), com destaque e na contagem; `your-turn`, o bate-bola comum, sem destaque.
   */
  level: 'needs' | 'your-turn';
  why: 'permission' | 'question' | 'plan' | 'decision' | 'error' | 'your-turn' | 'interrupted' | 'no-prompt';
  /** `local_…` do índice do Claude Desktop, para abrir a conversa; `null` na sessão só de terminal. */
  local: string | null;
  title: string;
  state: 'waiting' | 'error';
  reason: AwaitingReason | null;
  urgent: boolean;
  since: string;
  /** O que ela espera: o comando, a pergunta, o erro. */
  text: string;
  model: string | null;
  /** Em relação a esta sessão. */
  relation: 'parent' | 'child' | 'sibling' | null;
  /** Mesmo projeto (cwd) desta sessão. */
  sameProject: boolean;
  account: ContaDoPainel | null;
}

export interface PrecisamDoPainel {
  /** Só as que precisam de você (nível `needs`). */
  total: number;
  /** As que só estão na sua vez: fora da contagem, sem destaque. */
  yourTurn: number;
  /** A divisão por conta; "Sem conta" quando não se sabe. Limites nunca entram aqui. */
  byAccount: { account: ContaDoPainel | null; n: number }[];
  /** Só a família desta sessão (quem a abriu e quem ela abriu), urgentes primeiro. */
  family: PrecisaDeVoce[];
  /** A máquina inteira, urgentes primeiro, até 12. */
  machine: PrecisaDeVoce[];
}

/** Um PR aberto por uma sessão que aguarda a sua aprovação (review pendente no GitHub). */
export interface PrAguardando {
  number: number;
  url: string;
  repo: string | null;
  /** A issue do branch, ou o branch. */
  title: string;
  session: { id: string; title: string; local: string | null };
}

export interface PrsDoPainel {
  total: number;
  /** Mais novos primeiro. */
  items: PrAguardando[];
}

export interface Painel {
  version: 1;
  /**
   * A versão da API e, para o rodapé: o commit do código que ela carregou ao subir e o da pasta
   * agora (diferentes, a API precisa reiniciar); `null` fora de um git. `opensSession`: a API abre
   * a conversa no Claude Desktop (`POST /open/<local_…>`).
   */
  api: { version: string; commit: string | null; folder: string | null; opensSession: boolean };
  generatedAt: string;
  /** `null`: o núcleo ainda não viu esta sessão (nem hook, nem transcript). */
  session: SessaoDoPainel | null;
  context: ContextoDoPainel | null;
  cost: CustoDoPainel | null;
  tokens: { input: number; output: number } | null;
  background: { total: number; first: string | null };
  plan: PlanoDoPainel | null;
  /** Os planos da sessão, do mais recente para o mais antigo; o atual, se houver, primeiro. */
  plans: PlanoDaSessao[];
  subagents: { active: number; items: SubagenteDoPainel[] };
  children: FilhaDoPainel[];
  work: TrabalhoDoPainel | null;
  needYou: PrecisamDoPainel;
  /** #140: os PRs aguardando a sua aprovação, em toda a máquina. */
  prs: PrsDoPainel;
  /** `null`: o núcleo subiu sem a porta das decisões. */
  decisions: DecisoesDoPainel | null;
}

/** O escopo da lista de decisões (o Select do P9). */
export type EscopoDasDecisoes = 'session' | 'family' | 'branch';

/** Uma decisão no card 34 × 6 (P9). */
export interface DecisaoDoPainel {
  id: string;
  /** "D4": o número na família. */
  label: string;
  origin: 'question' | 'plan' | 'permission' | 'correction' | 'suggested';
  /** Só os três primeiros entram na lista; a descartada só volta como resposta do Descartar. */
  state: 'current' | 'superseded' | 'to_confirm' | 'dismissed';
  /** O que foi decidido, numa frase. */
  title: string;
  /** O texto inteiro, para o detalhe (na correção, o que a pessoa escreveu). */
  text: string;
  /** A pergunta, o pedido ou a proposta que levou à decisão. */
  context: string | null;
  /** A última ação feita pelo painel, que o Desfazer volta; `null` quando não há. */
  undo: 'confirm' | 'dismiss' | 'adjust' | null;
  /** O que foi descartado ("não: …"). */
  rejected: string[];
  decidedBy: 'user' | 'agent';
  decidedAt: string;
  /** A sugerida que a pessoa confirmou pelo painel: quando. */
  confirmedAt: string | null;
  /** O "D4" da decisão que substituiu esta. */
  supersededBy: string | null;
  /** De que sessão veio, em relação a esta. */
  session: 'this' | 'parent' | 'family' | 'branch';
  /** O `tool_use_id` da mensagem, para o "ver na conversa" quando ela é desta sessão. */
  toolUseId: string | null;
}

export interface ListaDeDecisoes {
  scope: EscopoDasDecisoes;
  /** Vigentes e a confirmar neste escopo. */
  current: number;
  toConfirm: number;
  /** Mais recentes primeiro: vigentes, a confirmar e substituídas. */
  items: DecisaoDoPainel[];
  /**
   * Quantas vigentes e a confirmar cada escopo tem: o seletor mostra as três contagens, e a pessoa
   * vê quando a troca não muda nada (todas da própria sessão).
   */
  byScope?: Record<EscopoDasDecisoes, number>;
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
  from: string | null;
}

export interface DecisoesDoPainel {
  /** Vigentes no escopo família: a linha "N decisões vigentes". */
  current: number;
  toConfirm: number;
  resume: RetomadaDoPainel | null;
  /** A lista aberta, só quando o painel pede (`?decisions=<scope>`). */
  list: ListaDeDecisoes | null;
}

/**
 * O contrato de `GET /api/wall` (#34, wireframe C2 "Mural ao vivo"): um card por sessão aberta nesta
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
