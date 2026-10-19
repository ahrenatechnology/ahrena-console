// Contrato do painel do Ahrena Console: a resposta de `GET /api/painel/<sessão>` e o estado
// que o mod guarda. Os tipos da resposta repetem packages/nucleo/src/api/tipos.ts; mudar um é
// mudar os dois (o teste do núcleo confere os nomes dos campos).

export type DisplayStatus = 'active' | 'completed' | 'error' | 'abandoned' | 'waiting'
export type EstadoDoInbox = DisplayStatus | 'delegating' | 'background'
export type AwaitingReason = 'notification' | 'interrupted' | 'stop' | 'session_start'
/** `cor` em hex; `fonte` pela ordem da decisão 0006. */
export type ContaDoPainel = { id: string; rotulo: string; cor: string; fonte: 'env' | 'config' | 'transcript' | 'desktop' | 'profile' }

export type AtividadeDaSessao = {
  tipo: 'ferramenta' | 'delegando' | 'pergunta' | 'permissao' | 'erro' | 'prompt' | 'sua-vez' | 'interrompida' | 'concluida' | 'abandonada' | 'ociosa'
  texto: string
}

export type FaixaDaSessao = { tipo: 'pergunta' | 'permissao' | 'erro'; texto: string; rodape: string; desde: string }

export type SessaoDoPainel = {
  id: string
  titulo: string
  modelo: string | null
  iniciadaEm: string
  status: DisplayStatus
  estado: EstadoDoInbox
  motivo: AwaitingReason | null
  urgente: boolean
  desde: string
  turno: number
  atividade: AtividadeDaSessao
  faixa: FaixaDaSessao | null
  conta: ContaDoPainel | null
  branch: string | null
  cwd: string | null
}

export type PlanoDoPainel = {
  feitos: number
  total: number
  atual: string | null
  proximo: string | null
  restantes: number
  /** Item 1.9: quem faz o item em andamento, a hora da última mudança e os passos com o dono. */
  atualDono?: DonoDoPasso | null
  mudouEm?: string | null
  passos?: PassoDoPainel[]
}

/** Um plano do histórico da sessão (issue #131): o atual, ou um anterior concluído ou abandonado (X de Y). */
export type PlanoDaSessao = {
  numero: number
  resultado: 'atual' | 'concluido' | 'abandonado'
  /** O primeiro passo do plano. */
  resumo: string
  feitos: number
  total: number
  /** O passo em andamento, só no atual. */
  atual: string | null
  inicio: string
  fim: string | null
}

export type DonoDoPasso = { tipo: 'principal' | 'subagente' | 'sessao'; nome: string | null; agenteId: string | null }

export type PassoDoPainel = {
  id: string
  texto: string
  textoAtivo: string | null
  estado: 'pending' | 'in_progress' | 'completed'
  dono: DonoDoPasso
}

export type SubagenteDoPainel = {
  id: string
  nome: string
  tarefa: string | null
  status: 'working' | 'waiting' | 'completed' | 'error'
  desde: string
  ate: string | null
}

export type FilhaDoPainel = { id: string; local?: string | null; titulo: string; estado: EstadoDoInbox | 'desconhecido'; motivo: AwaitingReason | null; desde: string | null }

export type TrabalhoDoPainel = {
  branch: string
  repo: string | null
  issue: { numero: number; titulo: string; url: string; subIssues: { feitas: number; total: number } | null } | null
  pr: {
    numero: number
    url: string
    estado: 'rascunho' | 'aberto' | 'mergeado' | 'fechado'
    ci: 'ok' | 'falhou' | 'rodando' | null
    review: 'aprovado' | 'ajustes' | 'pendente' | null
  } | null
  semPush: boolean
  erro: string | null
}

export type PrecisaDeVoce = {
  id: string
  /** `local_…` do Claude Desktop, para abrir a conversa; sem ele, a sessão é só de terminal. */
  local?: string | null
  titulo: string
  estado: 'waiting' | 'error'
  motivo: AwaitingReason | null
  urgente: boolean
  desde: string
  texto: string
  modelo: string | null
  relacao: 'mae' | 'filha' | 'irma' | null
  mesmoProjeto: boolean
  conta: ContaDoPainel | null
}

export type PrecisamDoPainel = {
  total: number
  porConta: { conta: ContaDoPainel | null; n: number }[]
  familia: PrecisaDeVoce[]
  maquina: PrecisaDeVoce[]
}

/** O escopo da lista de decisões (o Select do P9). */
export type EscopoDasDecisoes = 'sessao' | 'familia' | 'branch'

/** Uma decisão no card 34 × 6 (P9). */
export type DecisaoDoPainel = {
  id: string
  /** "D4": o número na família. */
  rotulo: string
  origem: 'pergunta' | 'plano' | 'permissao' | 'correcao' | 'sugerida'
  /** A descartada só volta como resposta do Descartar. */
  estado: 'vigente' | 'substituida' | 'a_confirmar' | 'descartada'
  /** Numa frase. */
  titulo: string
  /** #131: o texto inteiro e o contexto, para o detalhe, e a ação do painel que o Desfazer volta. */
  texto?: string
  contexto?: string | null
  desfazer?: 'confirmar' | 'descartar' | 'ajustar' | null
  /** O que foi descartado ("não: …"). */
  nao: string[]
  decididaPor: 'usuario' | 'agente'
  decididaEm: string
  confirmadaEm: string | null
  /** O "D4" da decisão que substituiu esta. */
  substituidaPor: string | null
  sessao: 'esta' | 'mae' | 'familia' | 'branch'
  /** Para o "ver na conversa", quando a mensagem é desta sessão. */
  toolUseId: string | null
}

export type ListaDeDecisoes = {
  escopo: EscopoDasDecisoes
  vigentes: number
  aConfirmar: number
  itens: DecisaoDoPainel[]
}

/** A faixa do P10, depois de um /clear; vem com a reinjeição (#100). */
export type RetomadaDoPainel = { n: number; tokens: number | null; de: string | null }

export type DecisoesDoPainel = {
  /** Vigentes no escopo família: a linha "N decisões vigentes". */
  vigentes: number
  aConfirmar: number
  retomada: RetomadaDoPainel | null
  /** A lista aberta, só quando o painel pede (`?decisoes=<escopo>`). */
  lista: ListaDeDecisoes | null
}

export type Painel = {
  versao: 1
  /** A versão da API e o commit do checkout em que ela roda (`null` fora de um git), para o rodapé. */
  api?: { versao: string; commit: string | null }
  geradoEm: string
  sessao: SessaoDoPainel | null
  contexto: { usados: number; limite: number; pct: number } | null
  custo: { usd: number | null; serie: number[]; estimativa: true } | null
  tokens: { entrada: number; saida: number } | null
  background: { total: number; primeiro: string | null }
  plano: PlanoDoPainel | null
  /** Do mais recente para o mais antigo. Núcleo anterior à #131 não manda. */
  planos?: PlanoDaSessao[]
  subagentes: { ativos: number; itens: SubagenteDoPainel[] }
  filhas: FilhaDoPainel[]
  trabalho: TrabalhoDoPainel | null
  precisam: PrecisamDoPainel
  /** `null`: o núcleo subiu sem as decisões (ou é de antes delas). */
  decisoes?: DecisoesDoPainel | null
}

/** A última leitura do núcleo e como ela foi. */
export type Leitura = {
  painel: Painel | null
  /** Quando a última leitura boa chegou (ms desde a época). */
  lidoEm: number | null
  /** A última tentativa falhou: o núcleo está fora. */
  offline: boolean
  erro: string | null
  /** Quando a próxima tentativa sai (ms desde a época). */
  proximaEm: number | null
}

/** O que a pessoa abriu no painel. */
export type Vista = {
  /** `precisam`: a lista de "precisam de você" (P7); `decisoes`: as decisões (P9); `planos`: os planos da sessão (#131). */
  tela: 'sessao' | 'precisam' | 'decisoes' | 'planos' | 'decisao' | 'subagentes' | 'filhas'
  /** `decisao`: a decisão aberta no detalhe, como chegou da lista ou da última ação. */
  decisao?: DecisaoDoPainel | null
  /** O detalhe com o campo do Ajustar aberto. */
  ajustando?: boolean
  /** A última ação do painel numa decisão, para o "Desfazer" de alguns segundos. */
  ultimaAcao?: { id: string; rotulo: string; acao: 'confirmar' | 'descartar' | 'ajustar'; em: number } | null
  /** `null`: o padrão da largura (família no estreito, máquina inteira no largo). */
  escopo: 'familia' | 'maquina' | null
  /** O escopo das decisões; `null`: o padrão da largura (sessão no estreito, família no largo). */
  escopoDecisoes?: EscopoDasDecisoes | null
}

declare module 'claude-code' {
  interface PluginState {
    'ahrena-console': { leitura: Leitura; vista: Vista }
  }
}
