// Grava a resposta do painel em cada cenário (P1 a P7) para os testes do plugin, que rodam
// sem rede nem disco. Hora fixa (T0), dados do simulador.
//   node test/api/gravar-cenarios.ts > ../../plugins/ahrena-console/tests/cenarios.ts
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, MontadorDoPainel, TrabalhoPorBranch, type Painel } from '../../src/api/index.ts';
import { CENARIOS_DO_PAINEL, FonteDeTrabalhoDoSimulador, SESSAO_DO_PAINEL, semearCenariosDoPainel } from '../../src/simulador/painel.ts';
import { T0 } from '../fixtures.ts';

const AGORA = Date.parse(T0);
const saida: Record<string, Painel> = {};
for (const nome of CENARIOS_DO_PAINEL) {
  const storage = openSqliteStorage({ path: ':memory:' });
  await semearCenariosDoPainel(storage, nome, AGORA);
  const trabalho = new TrabalhoPorBranch({ fonte: new FonteDeTrabalhoDoSimulador(), git: FonteDeTrabalhoDoSimulador.git, agora: () => AGORA });
  const montador = new MontadorDoPainel({ storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho, agora: () => AGORA, apelido: () => SESSAO_DO_PAINEL });
  const pedido = { sessionId: 'sessao-teste', modelo: 'claude-sonnet-5-5', cwd: '/simulacao/cli-de-notas' };
  await montador.montar(pedido);
  await trabalho.esperar();
  saida[nome] = await montador.montar(pedido);
  await storage.close();
}
process.stdout.write(
  `// Gerado por packages/nucleo/test/api/gravar-cenarios.ts: a resposta de /api/painel em cada cenário\n` +
    `// do simulador (P1 a P7), com a hora fixa AGORA. Não edite: rode o script de novo.\n` +
    `import type { Painel } from '../types'\n\n` +
    `export const AGORA = ${AGORA}\n\n` +
    `export const CENARIOS: Record<'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7', Painel> = ${JSON.stringify(saida, null, 2)}\n`,
);
