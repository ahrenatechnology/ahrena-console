// Núcleo com dono único (issue #86): a trava, a adoção e a saída quando o pai some.
export {
  examinar,
  planejarSubida,
  assumirTrava,
  pararNucleo,
  vigiarPai,
  compararCodigo,
  avisoDeCodigo,
  INTERVALO_DO_PAI_MS,
  type Exame,
  type Plano,
  type OpcoesDaSubida,
  type Codigo,
  type Comparacao,
} from './dono.ts';
export { subirOuAdotar, type Saida, type OpcoesDoSubir } from './subir.ts';
export { commitDoCodigo, commitMaisVelho } from './codigo.ts';
export { lerTrava, gravarTrava, criarTrava, tirarTrava, liberarTrava, prepararPasta, arquivoDaTrava, pastaPadrao, novoToken, ARQUIVO_DA_TRAVA, type Trava } from './trava.ts';
export { registrarCliente, removerCliente, clientesVivos } from './clientes.ts';
export { pidVivo, sondar, ehNucleo, esperarNucleo, compararVersoes, reservarPorta, soltarPorta, NOME_DO_NUCLEO, type Visao } from './sonda.ts';
