// Contrato do painel do Ahrena Console: a resposta de `GET /api/panel/<session>` e o estado
// que o mod guarda. Os tipos da resposta repetem packages/nucleo/src/api/tipos.ts; mudar um é
// mudar os dois (o teste do núcleo confere os nomes dos campos).

export type DisplayStatus = 'active' | 'completed' | 'error' | 'abandoned' | 'waiting'
export type InboxState = DisplayStatus | 'delegating' | 'background'
export type AwaitingReason = 'notification' | 'interrupted' | 'stop' | 'session_start'
/** `color` em hex; `source` pela ordem da decisão 0006. */
export type PanelAccount = { id: string; label: string; color: string; source: 'env' | 'config' | 'transcript' | 'desktop' | 'profile' }

export type SessionActivity = {
  type: 'tool' | 'delegating' | 'question' | 'permission' | 'error' | 'prompt' | 'your-turn' | 'interrupted' | 'completed' | 'abandoned' | 'idle'
  text: string
}

export type SessionBanner = { type: 'question' | 'permission' | 'error'; text: string; footer: string; since: string }

/** #245: `blocked` ("Precisa de você") or `idle` ("Ociosa"), with the reason (packages/nucleo/src/api/attention.ts). */
export type SessionAttention = {
  level: 'blocked' | 'idle'
  reason: 'permission' | 'question' | 'plan' | 'decision' | 'error' | 'turn_ended' | 'interrupted' | 'first_prompt'
}

export type PanelSession = {
  id: string
  title: string
  model: string | null
  startedAt: string
  status: DisplayStatus
  state: InboxState
  reason: AwaitingReason | null
  urgent: boolean
  /** `null` when the session is not waiting on you and not in error; absent from a core before #245. */
  attention?: SessionAttention | null
  since: string
  turn: number
  activity: SessionActivity
  banner: SessionBanner | null
  account: PanelAccount | null
  branch: string | null
  cwd: string | null
}

export type PanelPlan = {
  done: number
  total: number
  current: string | null
  next: string | null
  remaining: number
  /** Item 1.9: quem faz o item em andamento, a hora da última mudança e os passos com o dono. */
  currentOwner?: StepOwner | null
  changedAt?: string | null
  steps?: PanelStep[]
}

/** Um plano do histórico da sessão (issue #131): o atual, ou um anterior concluído ou abandonado (X de Y). */
export type SessionPlan = {
  number: number
  outcome: 'current' | 'completed' | 'abandoned'
  /** O primeiro passo do plano. */
  summary: string
  done: number
  total: number
  /** O passo em andamento, só no atual. */
  current: string | null
  start: string
  end: string | null
}

export type StepOwner = { type: 'main' | 'subagent' | 'session'; name: string | null; agentId: string | null }

export type PanelStep = {
  id: string
  text: string
  activeText: string | null
  state: 'pending' | 'in_progress' | 'completed'
  owner: StepOwner
}

export type PanelSubagent = {
  id: string
  name: string
  task: string | null
  status: 'working' | 'waiting' | 'completed' | 'error'
  since: string
  until: string | null
  /** #146: o subagente que disparou este; `null` quando foi a própria sessão. Núcleo antigo não manda. */
  parent?: string | null
  /** #146: o turno da sessão em que foi disparado (o aninhado herda o de cima); `null`: sem os prompts. */
  wave?: number | null
}

export type PanelChild = {
  id: string
  local?: string | null
  title: string
  state: InboxState | 'unknown'
  reason: AwaitingReason | null
  since: string | null
  /** #131: o que a filha trabalhando faz ("pensando", "rodando Bash"); ausente no núcleo antigo. */
  doing?: string | null
  /** #145: arquivada no Claude Desktop; ausente no núcleo antigo. */
  archived?: boolean
}

export type PanelWork = {
  branch: string
  repo: string | null
  issue: { number: number; title: string; url: string; subIssues: { done: number; total: number } | null } | null
  pr: {
    number: number
    url: string
    state: 'draft' | 'open' | 'merged' | 'closed'
    ci: 'ok' | 'failed' | 'running' | null
    /** As checagens do último commit, contadas ("CI ✓ 6/6"); ausente no núcleo antigo. */
    checks?: { total: number; ok: number; failed: number; running: number } | null
    review: 'approved' | 'changes-requested' | 'pending' | null
  } | null
  notPushed: boolean
  error: string | null
}

export type NeedsYou = {
  id: string
  /**
   * #245: `blocked` ("Precisa de você"), with highlight and in the count; `idle` ("Ociosa"), neutral.
   * The core before #245 sends `needs` and `your-turn`; before #140, nothing (counts as blocked).
   */
  level?: 'blocked' | 'idle' | 'needs' | 'your-turn'
  why?: SessionAttention['reason'] | 'your-turn' | 'no-prompt'
  /** `local_…` do Claude Desktop, para abrir a conversa; sem ele, a sessão é só de terminal. */
  local?: string | null
  title: string
  state: 'waiting' | 'error'
  reason: AwaitingReason | null
  urgent: boolean
  since: string
  text: string
  model: string | null
  relation: 'parent' | 'child' | 'sibling' | null
  sameProject: boolean
  account: PanelAccount | null
  /**
   * #262: the machine the session runs on: `null` (or absent, from an older core) for this Mac,
   * `{ id, label }` of machines.json for a remote one.
   */
  machine?: { id: string; label: string } | null
}

/** #262: the scope of the "Ver" list: the family, every machine, this Mac, or the id of a remote. */
export type NeedYouScope = 'family' | 'all' | 'local' | (string & {})

/** #262: a remote machine of machines.json, as the panel's need-you list sees it. */
export type NeedYouMachine = {
  id: string
  label: string
  /** `connected`, or why not (as `GET /api/machines`). */
  state: string
  reason: string | null
  lastReadAt: string | null
  connection: PanelMachineConnection | null
  /** When it went down (or its last reading); `null` when unknown. */
  since: string | null
}

export type PanelNeedYou = {
  /** Só as que precisam de você. */
  total: number
  /** #245: the idle ones, out of the count. */
  idle?: number
  /** The idle ones as the core before #245 names them. */
  yourTurn?: number
  byAccount: { account: PanelAccount | null; n: number }[]
  family: NeedsYou[]
  machine: NeedsYou[]
  /** #262, with `needYou=<scope>` on the request: the scope answered (an unknown id answers `all`). */
  scope?: NeedYouScope
  /** #262: the list for the scope, needs first then idle, each oldest first. Absent from an older core. */
  items?: NeedsYou[]
  /** #262: the scope's list before the core's cap of `items`: how many in all, and of them blocked and idle. Absent from an older core. */
  itemsTotal?: number
  itemsNeeds?: number
  itemsYourTurn?: number
  /** #262: the blocked count per machine, this Mac first (`local`), then each remote. */
  byMachine?: { id: string; label: string; n: number }[]
  /** #262: every remote machine of machines.json, in its order; empty without remotes. */
  machines?: NeedYouMachine[]
}

/** O escopo da lista de decisões (o Select do P9). */
export type DecisionScope = 'session' | 'family' | 'branch'

/** Uma decisão no card 34 × 6 (P9). */
export type PanelDecision = {
  id: string
  /** "D4": o número na família. */
  label: string
  origin: 'question' | 'plan' | 'permission' | 'correction' | 'suggested'
  /** A descartada só volta como resposta do Descartar. */
  state: 'current' | 'superseded' | 'to_confirm' | 'dismissed'
  /** Numa frase. */
  title: string
  /** #131: o texto inteiro e o contexto, para o detalhe, e a ação do painel que o Desfazer volta. */
  text?: string
  context?: string | null
  undo?: 'confirm' | 'dismiss' | 'adjust' | null
  /** O que foi descartado ("não: …"). */
  rejected: string[]
  decidedBy: 'user' | 'agent'
  decidedAt: string
  confirmedAt: string | null
  /** O "D4" da decisão que substituiu esta. */
  supersededBy: string | null
  session: 'this' | 'parent' | 'family' | 'branch'
  /** Para o "ver na conversa", quando a mensagem é desta sessão. */
  toolUseId: string | null
}

export type DecisionList = {
  scope: DecisionScope
  current: number
  toConfirm: number
  items: PanelDecision[]
  /** Vigentes e a confirmar em cada escopo, para o seletor; ausente no núcleo antigo. */
  byScope?: Record<DecisionScope, number>
}

/** A faixa do P10, depois de um /clear; vem com a reinjeição (#100). */
export type PanelResume = { n: number; tokens: number | null; from: string | null }

export type PanelDecisions = {
  /** Vigentes no escopo família: a linha "N decisões vigentes". */
  current: number
  toConfirm: number
  resume: PanelResume | null
  /** A lista aberta, só quando o painel pede (`?decisions=<scope>`). */
  list: DecisionList | null
}

/** Um PR aberto por uma sessão que aguarda a sua aprovação (#140). */
export type WaitingPr = { number: number; url: string; repo: string | null; title: string; session: { id: string; title: string; local: string | null } }

/** Medidor de contexto (item 1.7). `overflows`: compactações automáticas; `alert`: a partir de 2; as manuais à parte. */
export type PanelContext = {
  used: number
  limit: number
  pct: number
  overflows: number
  alert: boolean
  manualCompactions: number
  label: string
  agents: { agentId: string; used: number; limit: number; pct: number; overflows: number; alert: boolean }[]
}

export type Panel = {
  version: 1
  /**
   * A versão da API, o commit do código que ela carregou e o da pasta agora (diferentes: reiniciar
   * a API), e se ela abre a sessão no Claude Desktop (`POST /open/<local_…>`, no macOS).
   */
  api?: { version: string; commit: string | null; folder?: string | null; opensSession?: boolean }
  generatedAt: string
  session: PanelSession | null
  context: PanelContext | null
  cost: { usd: number | null; series: number[]; estimate: true } | null
  tokens: { input: number; output: number } | null
  background: { total: number; first: string | null }
  plan: PanelPlan | null
  /** Do mais recente para o mais antigo. Núcleo anterior à #131 não manda. */
  plans?: SessionPlan[]
  subagents: { active: number; items: PanelSubagent[] }
  children: PanelChild[]
  work: PanelWork | null
  needYou: PanelNeedYou
  /** #140: os PRs aguardando a sua aprovação; núcleo antigo não manda. */
  prs?: { total: number; items: WaitingPr[] }
  /** `null`: o núcleo subiu sem as decisões (ou é de antes delas). */
  decisions?: PanelDecisions | null
  /**
   * #278 (P14): the remote machine the session runs on, with its connection as `GET /api/machines`
   * serves it. Absent or `null` for a session of this machine, and from a core that does not send it
   * yet: then the panel shows no band.
   */
  machine?: PanelMachine | null
}

/** Why the connection is down: the core's closed list (`CONNECTION_REASONS`). */
export type ConnectionReason = 'sso-expired' | 'port-busy' | 'core-not-answering' | 'ssm-agent-offline' | 'host-unknown' | 'key-refused' | 'exit-code'

/** The part of a remote machine's `connection` the panel reads (#278). */
export type PanelMachineConnection = {
  state: 'up' | 'down' | 'starting' | 'stopping' | 'failing' | 'stopped'
  since: string | null
  lastError: { reason: ConnectionReason | string; at?: string | null; exitCode?: number | null; holder?: string | null } | null
}

export type PanelMachine = {
  id: string
  label: string
  /** The newest reading of the machine: what the panel shows is from then. */
  lastReadAt: string | null
  connection: PanelMachineConnection | null
}

/** A última leitura do núcleo e como ela foi. */
export type Reading = {
  panel: Panel | null
  /** Quando a última leitura boa chegou (ms desde a época). */
  readAt: number | null
  /** A última tentativa falhou: o núcleo está fora. */
  offline: boolean
  error: string | null
  /** Quando a próxima tentativa sai (ms desde a época). */
  nextAt: number | null
  /**
   * O contexto desta sessão lido do engine (`$.session.usage()`), o mesmo da barra do Claude Code:
   * acompanha a compactação na hora. Sem ele, vale o do núcleo.
   */
  liveContext?: { used: number | null; limit: number; pct: number } | null
}

/** O que a pessoa abriu no painel. */
export type View = {
  /** `need-you`: a lista de "precisam de você" (P7); `decisions`: as decisões (P9); `plans`: os planos da sessão (#131); `subagents`: o grafo da sessão (#146). */
  screen: 'session' | 'need-you' | 'decisions' | 'plans' | 'decision' | 'subagents' | 'children' | 'prs'
  /** `decision`: a decisão aberta no detalhe, como chegou da lista ou da última ação. */
  decision?: PanelDecision | null
  /** O detalhe com o campo do Ajustar aberto. */
  adjusting?: boolean
  /** A última ação do painel numa decisão, para o "Desfazer" de alguns segundos. */
  lastAction?: { id: string; label: string; action: 'confirm' | 'dismiss' | 'adjust'; at: number } | null
  /**
   * Os `tool_use_id` das decisões abertas cuja mensagem ainda está na conversa (`$.session.messages()`):
   * só elas têm "ver na conversa". As de antes de uma compactação mostram o trecho original no detalhe.
   */
  reachable?: string[]
  /** O "Compactar" do card Contexto: a confirmação aberta, ou a compactação em andamento. */
  compact?: 'confirm' | 'compacting' | null
  /**
   * The scope of the "Ver" list (#262): `family`, `all`, `local` or a remote's id; `null`, the width's
   * default (family in the narrow panel, every machine in the wide one). The old `machine` reads as `all`.
   */
  scope: NeedYouScope | null
  /** O escopo das decisões; `null`: o padrão da largura (sessão no estreito, família no largo). */
  decisionsScope?: DecisionScope | null
  /** #146: o grafo da sessão (tela `subagents`): a página, as ondas abertas e fechadas, o filtro. */
  graph?: { page: number; opened: number[]; closed: number[]; filter: 'all' | 'active' }
}

/**
 * #140 (critérios 6 e 7): a pergunta com que esta sessão terminou o turno, capturada no próprio mod.
 * - `wrap-up`: a caixa de próximo passo do Desktop (`wrap_up` com `ask`); cada ação com mensagem
 *   vira um botão que manda a mensagem ao chat; as ações do app (commit, criar PR) ficam no chat;
 * - `question`: o AskUserQuestion, com as perguntas e as opções inteiras; responde-se no chat.
 */
export type SessionQuestion =
  | { type: 'wrap-up'; text: string; actions: { label: string; message: string | null; fromApp: boolean }[]; at: number }
  | { type: 'question'; questions: { text: string; header: string | null; options: { label: string; description: string | null }[]; multiple: boolean }[]; at: number }

declare module 'claude-code' {
  interface PluginState {
    'ahrena-console': { reading: Reading; view: View; question: SessionQuestion | null }
  }
}
