export { Aleatorio, hash32 } from './random.ts';
export {
  LIMITE_DE_CONTEXTO,
  MINUTOS_ATE_ABANDONO,
  TIPOS_DE_CAOS,
  gerarCenario,
  type Cenario,
  type Gravacao,
  type OpcoesDoCenario,
  type Operacao,
  type Roteiro,
  type TipoDeCaos,
} from './scenario.ts';
export { semearHistorico, type OpcoesDoHistorico, type ResumoDoHistorico } from './history.ts';
export { PRECOS_ILUSTRATIVOS, simular, type Modo, type OpcoesDaSimulacao, type Resumo } from './simulator.ts';
export { SIMULATED_WORKSTATION, SimulatedCollector, seedTelemetry, simulatedReading, type SimulatedProfile } from './telemetry.ts';
