// API local do núcleo para o painel lateral (4.1, 4.2, 4.3 e 4.8; começo da #21).
export * from './types.ts';
export { Contas, arquivoPadraoDeContas, type OpcoesDasContas } from './accounts.ts';
export { IndiceDoDesktop, raizPadraoDoDesktop, type OpcoesDoIndice, type SessaoDoDesktop } from './desktop-index.ts';
export {
  DecisoesDaUi,
  responderDecisoesDaUi,
  slugDaDecisao,
  type AgrupamentoDasDecisoes,
  type DecisaoDaUi,
  type DecisoesDaAba,
  type DecisoesDaPagina,
  type FiltroDeEstado,
  type GrupoDeDecisoes,
  type OpcoesDasDecisoesDaUi,
  type RascunhoDeRegistro,
} from './decisions-ui.ts';
export { DecisoesDaSessao, ErroDaDecisao, ESCOPOS_DAS_DECISOES, type AcaoNaDecisao, type AlvoDasDecisoes, type RegistroDoPainel } from './decisions.ts';
export { MontadorDoPainel, atividadeDe, subagentesDe, LIMITE_PADRAO_DE_CONTEXTO, type LeituraDaSessao, type OpcoesDoPainel, type PedidoDoPainel } from './panel.ts';
export { MontadorDoMural, ehAberta, muralDoPainel, responderMural, RECENTE_DO_MURAL_MS, ROTA_DO_MURAL, WALL_ROUTE, type OpcoesDoMural } from './wall.ts';
export { ResumosDeSessao, aplicarEvento, iniciosDosTurnos, resumoVazio, type ResumoDosEventos, type ItemDoPlano } from './summary.ts';
export { TrabalhoPorBranch, gitDoSistema, issueDoBranch, repoDoRemote, type Git, type OpcoesDoTrabalho } from './work.ts';
export { iniciarApiLocal, VERSAO_DA_API, PANEL_ROUTE, OPEN_ROUTE, LOAD_ROUTE, DECISIONS_ROUTE, type ApiLocal, type OpcoesDaApi } from './server.ts';
export {
  LEGACY_BODIES,
  LEGACY_PARAMS,
  legacyRequestBody,
  legacyResponseFor,
  legacyRouteOf,
  normalizeLegacyPath,
  normalizeLegacyQuery,
  normalizeLegacyUrl,
  rawPathnameOf,
  translateBody,
  type LegacyBodySpec,
  type LegacyRoute,
  type LegacyRouteSpec,
} from './legacy-routes.ts';
export * from './workflows.ts';
export { criarRotaDoProjeto, quadroDe, mesmaOrigemMovendo, PROJECT_ROUTE, PROJECT_MOVE_ROUTE, type CardDoProjeto, type KanbanDoProjeto, type OpcoesDoProjeto, type QuadroDoProjeto } from './project.ts';
export { LeiturasDoDetalhe, ROTA_DO_DETALHE, DETAIL_ROUTE, filtroDe, type CabecaDoDetalhe, type AgentesDoDetalhe, type ConversaDoDetalhe, type EventosDoDetalhe, type OpcoesDoDetalhe } from './session-detail.ts';
export { FeedDeEventos, ROTA_DOS_EVENTOS, EVENTS_ROUTE, statusDoEvento, TIPOS_POR_STATUS, type EventoDoFeed, type RespostaDoFeed, type StatusDoEvento } from './events.ts';
export { montarAtencao, MOTIVO_CURTO, remoteAttentionItems, ROTA_DA_ATENCAO, ATTENTION_ROUTE, type ItemDaAtencao, type RemoteAttentionSource, type RespostaDaAtencao } from './attention-route.ts';
export { montarDashboard, MontadorDoDashboard, ROTA_DO_DASHBOARD, type RespostaDoDashboard, type AgenteDoDashboard, type AtividadeDoDashboard, type NumerosDoDashboard } from './dashboard-route.ts';
export { ListaDeSessoes, SESSIONS_ROUTE, POR_PAGINA, FILTROS_DE_STATUS, ORDENS, pedidoDeSessoes, type LinhaDeSessao, type ListaDeSessoesHttp, type PedidoDeSessoes } from './sessions.ts';
export { QuadroKanban, pedidoDoKanban, rotuloDoModelo, colunaDoAgente, COLUNAS_DAS_SESSOES, COLUNAS_DOS_AGENTES, type CardDeAgente, type CardDeSessao, type Coluna, type KanbanHttp, type PedidoDoKanban } from './kanban.ts';
export {
  createFrameworkInstallRoute,
  createCoreFrameworkInstall,
  frameworkInstallWriteFromSameOrigin,
  FrameworkInstallService,
  FRAMEWORK_INSTALL_ROUTE,
  FRAMEWORK_REPO_ENV,
  type FrameworkInstallPlan,
  type FrameworkInstallRoute,
  type InstallAnswer,
  type PullRequestAnswer,
} from './framework-install.ts';
export { createAgentConfigRoute, agentConfigWriteFromSameOrigin, MAX_SKILL_BODY, AGENT_CONFIG_ROUTE, SKILL_ROUTE, type AgentConfigOptions, type AgentConfigRoute } from './agent-config.ts';
export { MACHINES_ROUTE, TELEMETRY_ROUTE, isTelemetryRoute, readTelemetryRequest, respondTelemetry } from './telemetry.ts';
