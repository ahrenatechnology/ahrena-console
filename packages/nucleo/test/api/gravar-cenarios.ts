// Grava a resposta do painel em cada cenário (P1 a P7 e P9) para os testes do plugin, que rodam
// sem rede nem disco. Hora fixa (T0), dados do simulador. No P9, grava também a lista de
// decisões de cada escopo, que o painel pede com `?decisoes=<escopo>`.
//   node test/api/gravar-cenarios.ts > ../../plugins/ahrena-console/tests/cenarios.ts
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, ESCOPOS_DAS_DECISOES, MontadorDoPainel, TrabalhoPorBranch, type ListaDeDecisoes, type Painel } from '../../src/api/index.ts';
import { SqliteDecisionStore } from '../../src/decisoes/sqlite.ts';
import { CENARIOS_DO_PAINEL, FonteDeTrabalhoDoSimulador, SESSAO_DO_PAINEL, semearCenariosDoPainel, semearDecisoesDoPainel } from '../../src/simulador/painel.ts';
import { T0 } from '../fixtures.ts';

const AGORA = Date.parse(T0);
const saida: Record<string, Painel> = {};
const listas: Record<string, ListaDeDecisoes> = {};
for (const nome of CENARIOS_DO_PAINEL) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const decisoes = new SqliteDecisionStore(storage.db);
  await semearCenariosDoPainel(storage, nome, AGORA);
  await semearDecisoesDoPainel(decisoes, nome, AGORA);
  const trabalho = new TrabalhoPorBranch({ fonte: new FonteDeTrabalhoDoSimulador(), git: FonteDeTrabalhoDoSimulador.git, agora: () => AGORA });
  const montador = new MontadorDoPainel({
    storage, contas: new Contas({ storage, arquivo: null }), desktop: null, trabalho, decisoes, agora: () => AGORA, apelido: () => SESSAO_DO_PAINEL,
  });
  const pedido = { sessionId: 'sessao-teste', modelo: 'claude-sonnet-5-5', cwd: '/simulacao/cli-de-notas' };
  await montador.montar(pedido);
  await trabalho.esperar();
  saida[nome] = await montador.montar(pedido);
  if (nome === 'p9') {
    for (const escopo of ESCOPOS_DAS_DECISOES) listas[escopo] = (await montador.montar({ ...pedido, decisoes: escopo })).decisoes!.lista!;
  }
  await storage.close();
}
const chaves = CENARIOS_DO_PAINEL.map((c) => `'${c}'`).join(' | ');
process.stdout.write(
  `// Gerado por packages/nucleo/test/api/gravar-cenarios.ts: a resposta de /api/painel em cada cenário\n` +
    `// do simulador (P1 a P7 e P9), com a hora fixa AGORA, e as listas de decisões do P9 por escopo.\n` +
    `// Não edite: rode o script de novo.\n` +
    `import type { EscopoDasDecisoes, ListaDeDecisoes, Painel } from '../types'\n\n` +
    `export const AGORA = ${AGORA}\n\n` +
    `export const CENARIOS: Record<${chaves}, Painel> = ${JSON.stringify(saida, null, 2)}\n\n` +
    `export const LISTAS_DO_P9: Record<EscopoDasDecisoes, ListaDeDecisoes> = ${JSON.stringify(listas, null, 2)}\n`,
);
