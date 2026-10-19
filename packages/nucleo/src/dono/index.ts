// Núcleo com dono único (issue #86): a trava, a adoção e a saída quando o pai some.
export { examinar, planejarSubida, assumirTrava, pararNucleo, vigiarPai, INTERVALO_DO_PAI_MS, type Exame, type Plano, type OpcoesDaSubida } from './dono.ts';
export { lerTrava, gravarTrava, liberarTrava, apagarTrava, arquivoDaTrava, pastaPadrao, novoToken, ARQUIVO_DA_TRAVA, type Trava } from './trava.ts';
export { registrarCliente, removerCliente, clientesVivos } from './clientes.ts';
export { pidVivo, sondar, ehNucleo, esperarNucleo, compararVersoes, reservarPorta, soltarPorta, NOME_DO_NUCLEO, type Visao } from './sonda.ts';
