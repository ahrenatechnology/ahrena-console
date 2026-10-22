// The contract of `GET /api/panel/<session>`: everything the side panel draws, in a single request.
// Since #173 phase 2b the keys and fixed values are English. The mod reads this route since 0.0.31
// (#187), and its types (plugins/ahrena-console/types) repeat these: changing one is changing both
// (test/api/panel.test.ts checks the field names).
// Dates in ISO 8601 (UTC); the panel computes "how long ago" with its own clock.

import type { SessionAttention } from './attention.ts';
import type { SessionOpen } from './session-open.ts';
import type { AccountSource, AwaitingReason, DisplayStatus } from '../model.ts';
import type { InboxState } from '../states/inbox.ts';

/** A session's account on the panel (decision 0006). */
export interface PanelAccount {
  /** `<accountUuid>/<organizationUuid>`; só para agrupar, nunca para mostrar. */
  id: string;
  label: string;
  /** Hex: a cor da `ClaudeAccount`, a do arquivo de rótulos ou uma da paleta da marca. */
  color: string;
  /** De onde veio, pela ordem da decisão 0006. */
  source: AccountSource;
}

/** The bottom line of the "Esta sessão" card: what the session is doing now. */
export interface SessionActivity {
  type: 'tool' | 'delegating' | 'question' | 'permission' | 'error' | 'prompt' | 'your-turn' | 'interrupted' | 'completed' | 'abandoned' | 'idle';
  text: string;
}

/** The top banner, when the session waits for something that must be read in full (P2, P3, P5). */
export interface SessionBanner {
  type: 'question' | 'permission' | 'error';
  /** O texto inteiro: a pergunta, o pedido de permissão ou o erro. */
  text: string;
  /** "3 opções · responda na conversa ao lado". */
  footer: string;
  since: string;
}

/** The "Esta sessão" card. */
export interface PanelSession {
  id: string;
  title: string;
  model: string | null;
  startedAt: string;
  status: DisplayStatus;
  state: InboxState;
  reason: AwaitingReason | null;
  urgent: boolean;
  /**
   * #245: `blocked` ("Precisa de você": the session is stuck until you act) or `idle` ("Ociosa": the
   * turn ended), with the reason; `null` when it is not waiting on you and not in error.
   * `sessionAttention` in api/attention.ts; the old routes leave it out.
   */
  attention: SessionAttention | null;
  /** Desde quando está no estado atual (a espera, ou a última atividade). */
  since: string;
  turn: number;
  activity: SessionActivity;
  banner: SessionBanner | null;
  account: PanelAccount | null;
  branch: string | null;
  cwd: string | null;
}

/** The context meter of the session, and of each subagent. */
export interface PanelContext {
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
  /** O medidor de cada subagente que já mandou mensagem; `agentId` é o `PanelSubagent.id`. */
  agents: AgentContext[];
}

/** A subagent's context meter. */
export interface AgentContext {
  agentId: string;
  used: number;
  limit: number;
  pct: number;
  overflows: number;
  alert: boolean;
}

/** The session's estimated cost. */
export interface PanelCost {
  /** `null`: há uso, mas nenhum modelo dele tem preço ("sem preço", nunca zero). */
  usd: number | null;
  /** Custo acumulado ao longo da sessão, de 2 a 16 pontos, para a linha do card. */
  series: number[];
  estimate: true;
}

/** The current plan: progress, the current and next steps, and the steps in order. */
export interface PanelPlan {
  done: number;
  total: number;
  /** O item em andamento. */
  current: string | null;
  /** O próximo a fazer. */
  next: string | null;
  /** Quantos ainda faltam além do próximo. */
  remaining: number;
  /** Quem faz o item em andamento. */
  currentOwner: StepOwner | null;
  /** Hora da última mudança do plano; `null` no plano lido só do TodoWrite (sem plano gravado). */
  changedAt: string | null;
  /** Os passos na ordem do plano (item 1.9). */
  steps: PanelStep[];
}

/** A plan of the session's history (issue #131). */
export interface PlanHistoryEntry {
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

/** The main agent, a subagent or a child session, when the step was delegated. */
export interface StepOwner {
  type: 'main' | 'subagent' | 'session';
  /** Nome do subagente (tipo ou `owner`) ou da sessão filha; `null` no principal. */
  name: string | null;
  /** Id do agente no núcleo, quando se sabe. */
  agentId: string | null;
}

/** A step of the plan. */
export interface PanelStep {
  id: string;
  text: string;
  /** O texto no gerúndio, para o passo em andamento. */
  activeText: string | null;
  state: 'pending' | 'in_progress' | 'completed';
  owner: StepOwner;
}

/** A subagent of the session. */
export interface PanelSubagent {
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

/** A session this one opened. */
export interface PanelChild {
  id: string;
  /** `local_…` do índice do Claude Desktop, para abrir a conversa; `null` na sessão só de terminal. */
  local: string | null;
  title: string;
  state: InboxState | 'unknown';
  reason: AwaitingReason | null;
  /** Desde quando está no que faz: a atividade atual, se trabalhando; a espera, se parada. */
  since: string | null;
  /** #131: o que a filha trabalhando está fazendo ("pensando", "rodando Bash"); `null` parada. */
  doing?: string | null;
  /** #145: arquivada no Claude Desktop. O painel a conta e lista por último, e oferece desarquivar. */
  archived?: boolean;
}

/** The branch's work: the issue, the PR and its CI. */
export interface PanelWork {
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

/** A session that needs you (or whose turn it is). */
export interface NeedsYouItem {
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
  account: PanelAccount | null;
}

/** "Precisam de você": the count, by account, the family and the machine. */
export interface PanelNeedYou {
  /** Só as que precisam de você (nível `needs`). */
  total: number;
  /** As ociosas (#245: o turno acabou, nada trava): fora da contagem, sem destaque. */
  yourTurn: number;
  /** A divisão por conta; "Sem conta" quando não se sabe. Limites nunca entram aqui. */
  byAccount: { account: PanelAccount | null; n: number }[];
  /** Só a família desta sessão (quem a abriu e quem ela abriu), urgentes primeiro. */
  family: NeedsYouItem[];
  /** A máquina inteira, urgentes primeiro, até 12. */
  machine: NeedsYouItem[];
}

/** A PR opened by a session that awaits your approval (review pending on GitHub). */
export interface AwaitingPr {
  number: number;
  url: string;
  repo: string | null;
  /** A issue do branch, ou o branch. */
  title: string;
  session: { id: string; title: string; local: string | null };
}

/** The PRs awaiting your approval, across the machine (#140). */
export interface PanelPrs {
  total: number;
  /** Mais novos primeiro. */
  items: AwaitingPr[];
}

/** The body of `GET /api/panel/<session>`. */
export interface Panel {
  version: 1;
  /**
   * A versão da API e, para o rodapé: o commit do código que ela carregou ao subir e o da pasta
   * agora (diferentes, a API precisa reiniciar); `null` fora de um git. `opensSession`: a API abre
   * a conversa no Claude Desktop (`POST /open/<local_…>`).
   */
  api: { version: string; commit: string | null; folder: string | null; opensSession: boolean };
  generatedAt: string;
  /** `null`: o núcleo ainda não viu esta sessão (nem hook, nem transcript). */
  session: PanelSession | null;
  context: PanelContext | null;
  cost: PanelCost | null;
  tokens: { input: number; output: number } | null;
  background: { total: number; first: string | null };
  plan: PanelPlan | null;
  /** Os planos da sessão, do mais recente para o mais antigo; o atual, se houver, primeiro. */
  plans: PlanHistoryEntry[];
  subagents: { active: number; items: PanelSubagent[] };
  children: PanelChild[];
  work: PanelWork | null;
  needYou: PanelNeedYou;
  /** #140: os PRs aguardando a sua aprovação, em toda a máquina. */
  prs: PanelPrs;
  /** `null`: o núcleo subiu sem a porta das decisões. */
  decisions: PanelDecisions | null;
}

/** The scope of the decision list (P9's Select). */
export type PanelDecisionScope = 'session' | 'family' | 'branch';

/** A decision in the 34 × 6 card (P9). */
export interface PanelDecision {
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

/** The open decision list of a scope. */
export interface PanelDecisionList {
  scope: PanelDecisionScope;
  /** Vigentes e a confirmar neste escopo. */
  current: number;
  toConfirm: number;
  /** Mais recentes primeiro: vigentes, a confirmar e substituídas. */
  items: PanelDecision[];
  /**
   * Quantas vigentes e a confirmar cada escopo tem: o seletor mostra as três contagens, e a pessoa
   * vê quando a troca não muda nada (todas da própria sessão).
   */
  byScope?: Record<PanelDecisionScope, number>;
}

/**
 * P10's banner: the previous session's decisions that hold in this one after a /clear. Only comes
 * when the reinjection (#100) recorded what it injected; until then, always `null`.
 */
export interface PanelResume {
  /** Quantas decisões foram injetadas. */
  n: number;
  /** Tokens que a injeção custou (estimativa). */
  tokens: number | null;
  /** O título da sessão anterior. */
  from: string | null;
}

/** The panel's decisions line and, when asked, the open list. */
export interface PanelDecisions {
  /** Vigentes no escopo família: a linha "N decisões vigentes". */
  current: number;
  toConfirm: number;
  resume: PanelResume | null;
  /** A lista aberta, só quando o painel pede (`?decisions=<scope>`). */
  list: PanelDecisionList | null;
}

/**
 * The contract of `GET /api/wall` (#34, wireframe C2 "Mural ao vivo"): one card per open session on this
 * machine. "Open" and the order are in api/wall.ts. Dates in ISO 8601 (UTC).
 */
export interface Wall {
  version: 1;
  generatedAt: string;
  /**
   * Para o seletor Todas / Esperando / Ativas. `waiting`: estado `waiting` ou `error` (precisa de
   * você); `active`: estado `active`, `delegating` ou `background`. As concluídas só contam em `all`.
   */
  count: {
    all: number;
    waiting: number;
    active: number;
    /** #245: as que precisam de você (`attention.level` `blocked`, as de erro incluídas). */
    blocked: number;
    /** #245: as ociosas (`attention.level` `idle`). */
    idle: number;
  };
  /** Primeiro as que precisam de você (as urgentes antes), depois as ociosas, depois a atividade mais recente (#245). */
  cards: WallCard[];
}

/** A wall card. */
export interface WallCard {
  /** Id da sessão: o card leva a `/ui/sessions/<id>`. */
  id: string;
  /** Like `PanelSession.title`. */
  title: string;
  /** O nome da pasta da sessão (basename do cwd); `null` sem pasta. */
  project: string | null;
  branch: string | null;
  /** O badge. */
  status: DisplayStatus;
  state: InboxState;
  reason: AwaitingReason | null;
  /** Espera `notification` ou `interrupted`, e o erro (like `NeedsYouItem.urgent`). */
  urgent: boolean;
  /** #245: `blocked` or `idle`, with the reason; `null` when not waiting on you (like `PanelSession.attention`). */
  attention: SessionAttention | null;
  /** Desde quando está no estado atual (a espera, o erro, ou a última atividade). */
  since: string;
  /** A linha do meio: o que pede (waiting), o erro, "terminou sem erro", ou o que está fazendo. */
  activity: SessionActivity;
  model: string | null;
  /** O esforço (`effort`) da sessão, do índice do Claude Desktop; `null` quando o núcleo não sabe. */
  effort: string | null;
  /** Agentes: o principal mais os subagentes; os trabalhando agora e todos os que a sessão já teve. */
  agents: { active: number; total: number };
  /** `usd: null`: há uso, mas sem preço ("sem preço", nunca zero). */
  cost: { usd: number | null; estimate: true };
  plan: { done: number; total: number; current: string | null } | null;
  context: { pct: number; used: number; limit: number; label: string } | null;
  /** #285: where the card's open button goes (Claude Desktop, a terminal, the live terminal) and the command to copy. */
  open: SessionOpen;
}
