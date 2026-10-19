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

export type FilhaDoPainel = { id: string; titulo: string; estado: EstadoDoInbox | 'desconhecido'; motivo: AwaitingReason | null; desde: string | null }

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

export type Painel = {
  versao: 1
  geradoEm: string
  sessao: SessaoDoPainel | null
  contexto: { usados: number; limite: number; pct: number } | null
  custo: { usd: number | null; serie: number[]; estimativa: true } | null
  tokens: { entrada: number; saida: number } | null
  background: { total: number; primeiro: string | null }
  plano: PlanoDoPainel | null
  subagentes: { ativos: number; itens: SubagenteDoPainel[] }
  filhas: FilhaDoPainel[]
  trabalho: TrabalhoDoPainel | null
  precisam: PrecisamDoPainel
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
  /** `precisam`: a lista de "precisam de você" (P7) no lugar dos cards. */
  tela: 'sessao' | 'precisam'
  /** `null`: o padrão da largura (família no estreito, máquina inteira no largo). */
  escopo: 'familia' | 'maquina' | null
}

declare module 'claude-code' {
  interface PluginState {
    'ahrena-console': { leitura: Leitura; vista: Vista }
  }
}
