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

export type FilhaDoPainel = {
  id: string
  local?: string | null
  titulo: string
  estado: EstadoDoInbox | 'desconhecido'
  motivo: AwaitingReason | null
  desde: string | null
  /** #131: o que a filha trabalhando faz ("pensando", "rodando Bash"); ausente no núcleo antigo. */
  fazendo?: string | null
}

export type TrabalhoDoPainel = {
  branch: string
  repo: string | null
  issue: { numero: number; titulo: string; url: string; subIssues: { feitas: number; total: number } | null } | null
  pr: {
    numero: number
    url: string
    estado: 'rascunho' | 'aberto' | 'mergeado' | 'fechado'
    ci: 'ok' | 'falhou' | 'rodando' | null
    /** As checagens do último commit, contadas ("CI ✓ 6/6"); ausente no núcleo antigo. */
    checks?: { total: number; ok: number; falhas: number; rodando: number } | null
    review: 'aprovado' | 'ajustes' | 'pendente' | null
  } | null
  semPush: boolean
  erro: string | null
}

export type PrecisaDeVoce = {
  id: string
  /** #140: `precisa`, bloqueada até você agir, com destaque; `sua-vez`, o bate-bola comum, neutra. Núcleo antigo: ausente (conta como `precisa`). */
  nivel?: 'precisa' | 'sua-vez'
  porque?: 'permissao' | 'pergunta' | 'plano' | 'decisao' | 'erro' | 'sua-vez' | 'interrompida' | 'no-prompt'
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
  /** Só as que precisam de você. */
  total: number
  /** As que só estão na sua vez: fora da contagem. */
  suaVez?: number
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

/** Um PR aberto por uma sessão que aguarda a sua aprovação (#140). */
export type PrAguardando = { numero: number; url: string; repo: string | null; titulo: string; sessao: { id: string; titulo: string; local: string | null } }

/** Medidor de contexto (item 1.7). `estouros`: compactações automáticas; `alerta`: a partir de 2; as manuais à parte. */
export type ContextoDoPainel = {
  usados: number
  limite: number
  pct: number
  estouros: number
  alerta: boolean
  compactacoesManuais: number
  rotulo: string
  agentes: { agenteId: string; usados: number; limite: number; pct: number; estouros: number; alerta: boolean }[]
}

export type Painel = {
  versao: 1
  /**
   * A versão da API, o commit do código que ela carregou e o da pasta agora (diferentes: reiniciar
   * a API), e se ela abre a sessão no Claude Desktop (`POST /abrir/<local_…>`, no macOS).
   */
  api?: { versao: string; commit: string | null; pasta?: string | null; abreSessao?: boolean }
  geradoEm: string
  sessao: SessaoDoPainel | null
  contexto: ContextoDoPainel | null
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
  /** #140: os PRs aguardando a sua aprovação; núcleo antigo não manda. */
  prs?: { total: number; itens: PrAguardando[] }
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
  /**
   * O contexto desta sessão lido do engine (`$.session.usage()`), o mesmo da barra do Claude Code:
   * acompanha a compactação na hora. Sem ele, vale o do núcleo.
   */
  contextoAoVivo?: { usados: number | null; limite: number; pct: number } | null
}

/** O que a pessoa abriu no painel. */
export type Vista = {
  /** `precisam`: a lista de "precisam de você" (P7); `decisoes`: as decisões (P9); `planos`: os planos da sessão (#131). */
  tela: 'sessao' | 'precisam' | 'decisoes' | 'planos' | 'decisao' | 'subagentes' | 'filhas' | 'prs'
  /** `decisao`: a decisão aberta no detalhe, como chegou da lista ou da última ação. */
  decisao?: DecisaoDoPainel | null
  /** O detalhe com o campo do Ajustar aberto. */
  ajustando?: boolean
  /** A última ação do painel numa decisão, para o "Desfazer" de alguns segundos. */
  ultimaAcao?: { id: string; rotulo: string; acao: 'confirmar' | 'descartar' | 'ajustar'; em: number } | null
  /**
   * Os `tool_use_id` das decisões abertas cuja mensagem ainda está na conversa (`$.session.messages()`):
   * só elas têm "ver na conversa". As de antes de uma compactação mostram o trecho original no detalhe.
   */
  alcancaveis?: string[]
  /** O "Compactar" do card Contexto: a confirmação aberta, ou a compactação em andamento. */
  compactar?: 'confirmar' | 'compactando' | null
  /** `null`: o padrão da largura (família no estreito, máquina inteira no largo). */
  escopo: 'familia' | 'maquina' | null
  /** O escopo das decisões; `null`: o padrão da largura (sessão no estreito, família no largo). */
  escopoDecisoes?: EscopoDasDecisoes | null
}

/**
 * #140 (critérios 6 e 7): a pergunta com que esta sessão terminou o turno, capturada no próprio mod.
 * - `fechamento`: a caixa de próximo passo do Desktop (`wrap_up` com `ask`); cada ação com mensagem
 *   vira um botão que manda a mensagem ao chat; as ações do app (commit, criar PR) ficam no chat;
 * - `pergunta`: o AskUserQuestion, com as perguntas e as opções inteiras; responde-se no chat.
 */
export type PerguntaDaSessao =
  | { tipo: 'fechamento'; texto: string; acoes: { rotulo: string; mensagem: string | null; doApp: boolean }[]; em: number }
  | { tipo: 'pergunta'; perguntas: { texto: string; cabecalho: string | null; opcoes: { rotulo: string; descricao: string | null }[]; varias: boolean }[]; em: number }

declare module 'claude-code' {
  interface PluginState {
    'ahrena-console': { leitura: Leitura; vista: Vista; pergunta: PerguntaDaSessao | null }
  }
}
