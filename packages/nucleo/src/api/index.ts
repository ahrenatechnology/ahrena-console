// API local do núcleo para o painel lateral (4.1, 4.2, 4.3 e 4.8; começo da #21).
export * from './tipos.ts';
export { Contas, arquivoPadraoDeContas, type OpcoesDasContas } from './contas.ts';
export { IndiceDoDesktop, raizPadraoDoDesktop, type OpcoesDoIndice, type SessaoDoDesktop } from './indice-desktop.ts';
export { DecisoesDaSessao, ErroDaDecisao, ESCOPOS_DAS_DECISOES, type AcaoNaDecisao, type AlvoDasDecisoes, type RegistroDoPainel } from './decisoes.ts';
export { MontadorDoPainel, atividadeDe, subagentesDe, LIMITE_PADRAO_DE_CONTEXTO, type OpcoesDoPainel, type PedidoDoPainel } from './painel.ts';
export { ResumosDeSessao, aplicarEvento, iniciosDosTurnos, resumoVazio, type ResumoDosEventos, type ItemDoPlano } from './resumo.ts';
export { TrabalhoPorBranch, gitDoSistema, issueDoBranch, repoDoRemote, type Git, type OpcoesDoTrabalho } from './trabalho.ts';
export { iniciarApiLocal, VERSAO_DA_API, type ApiLocal, type OpcoesDaApi } from './servidor.ts';
export * from './workflows.ts';
export { LeiturasDoDetalhe, ROTA_DO_DETALHE, filtroDe, type CabecaDoDetalhe, type AgentesDoDetalhe, type ConversaDoDetalhe, type EventosDoDetalhe, type OpcoesDoDetalhe } from './detalhe.ts';
export { montarAtencao, MOTIVO_CURTO, ROTA_DA_ATENCAO, type ItemDaAtencao, type RespostaDaAtencao } from './rota-atencao.ts';
export { montarDashboard, MontadorDoDashboard, ROTA_DO_DASHBOARD, type RespostaDoDashboard, type AgenteDoDashboard, type AtividadeDoDashboard, type NumerosDoDashboard } from './rota-dashboard.ts';
export { ListaDeSessoes, POR_PAGINA, FILTROS_DE_STATUS, ORDENS, pedidoDeSessoes, type LinhaDeSessao, type ListaDeSessoesHttp, type PedidoDeSessoes } from './sessoes.ts';
