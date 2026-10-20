// API local do núcleo para o painel lateral (4.1, 4.2, 4.3 e 4.8; começo da #21).
export * from './tipos.ts';
export { Contas, arquivoPadraoDeContas, type OpcoesDasContas } from './contas.ts';
export { IndiceDoDesktop, raizPadraoDoDesktop, type OpcoesDoIndice, type SessaoDoDesktop } from './indice-desktop.ts';
export { DecisoesDaSessao, ErroDaDecisao, ESCOPOS_DAS_DECISOES, type AcaoNaDecisao, type AlvoDasDecisoes, type RegistroDoPainel } from './decisoes.ts';
export { MontadorDoPainel, atividadeDe, subagentesDe, LIMITE_PADRAO_DE_CONTEXTO, type LeituraDaSessao, type OpcoesDoPainel, type PedidoDoPainel } from './painel.ts';
export { MontadorDoMural, ehAberta, muralDoPainel, responderMural, RECENTE_DO_MURAL_MS, ROTA_DO_MURAL, WALL_ROUTE, type OpcoesDoMural } from './mural.ts';
export { ResumosDeSessao, aplicarEvento, iniciosDosTurnos, resumoVazio, type ResumoDosEventos, type ItemDoPlano } from './resumo.ts';
export { TrabalhoPorBranch, gitDoSistema, issueDoBranch, repoDoRemote, type Git, type OpcoesDoTrabalho } from './trabalho.ts';
export { iniciarApiLocal, VERSAO_DA_API, PANEL_ROUTE, OPEN_ROUTE, LOAD_ROUTE, DECISIONS_ROUTE, type ApiLocal, type OpcoesDaApi } from './servidor.ts';
export { LEGACY_PARAMS, normalizeLegacyPath, normalizeLegacyQuery, normalizeLegacyUrl } from './legacy-routes.ts';
export * from './workflows.ts';
export { criarRotaDoProjeto, quadroDe, mesmaOrigemMovendo, PROJECT_ROUTE, PROJECT_MOVE_ROUTE, type CardDoProjeto, type KanbanDoProjeto, type OpcoesDoProjeto, type QuadroDoProjeto } from './projeto.ts';
export { LeiturasDoDetalhe, ROTA_DO_DETALHE, DETAIL_ROUTE, filtroDe, type CabecaDoDetalhe, type AgentesDoDetalhe, type ConversaDoDetalhe, type EventosDoDetalhe, type OpcoesDoDetalhe } from './detalhe.ts';
export { FeedDeEventos, ROTA_DOS_EVENTOS, EVENTS_ROUTE, statusDoEvento, TIPOS_POR_STATUS, type EventoDoFeed, type RespostaDoFeed, type StatusDoEvento } from './eventos.ts';
export { montarAtencao, MOTIVO_CURTO, ROTA_DA_ATENCAO, ATTENTION_ROUTE, type ItemDaAtencao, type RespostaDaAtencao } from './rota-atencao.ts';
export { montarDashboard, MontadorDoDashboard, ROTA_DO_DASHBOARD, type RespostaDoDashboard, type AgenteDoDashboard, type AtividadeDoDashboard, type NumerosDoDashboard } from './rota-dashboard.ts';
export { ListaDeSessoes, SESSIONS_ROUTE, POR_PAGINA, FILTROS_DE_STATUS, ORDENS, pedidoDeSessoes, type LinhaDeSessao, type ListaDeSessoesHttp, type PedidoDeSessoes } from './sessoes.ts';
export { QuadroKanban, pedidoDoKanban, rotuloDoModelo, colunaDoAgente, COLUNAS_DAS_SESSOES, COLUNAS_DOS_AGENTES, type CardDeAgente, type CardDeSessao, type Coluna, type KanbanHttp, type PedidoDoKanban } from './kanban.ts';
