export * from './modelo.ts';
export { aplicarAoPlano, eventoDoPlano, ferramentaDoPlano } from './extracao.ts';
export { atualizarPlano, reconstruirPlano } from './gravacao.ts';
export { historicoDe, mudancaIncremental, seguirHistorico, semelhanca, separarPlano, SEMELHANCA_MINIMA, type EstadoDoHistorico, type Separacao } from './historico.ts';
