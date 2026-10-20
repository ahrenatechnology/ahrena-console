// Records the panel's response in each scenario (P1 to P7 and P9) for the plugin's tests, which run
// with no network or disk. Fixed time (T0), simulator data. In P9, it also records the decision list
// of each scope, which the panel asks for with `?decisoes=<escopo>`.
//   node test/api/record-scenarios.ts > ../../plugins/ahrena-console/tests/cenarios.ts
//
// #173 phase 2b: the panel's JSON is English now, but the published mod (v0.0.30) reads the old
// route `/api/painel/<id>`, which answers the old Portuguese body. So the fixtures keep the OLD body:
// the panel and the lists go through the back-translator of the old routes (`panel` and
// `decisions/scope` in src/api/legacy-routes.ts), exactly what the mod gets. When the mod migrates to
// `/api/panel`, drop the translation here together with its types.
import { openSqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, ESCOPOS_DAS_DECISOES, LEGACY_BODIES, MontadorDoPainel, TrabalhoPorBranch, translateBody } from '../../src/api/index.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { PANEL_SCENARIOS, SimulatorWorkSource, PANEL_SESSION, seedPanelScenario, seedPanelDecisions } from '../../src/simulator/panel.ts';
import { T0 } from '../fixtures.ts';

const AGORA = Date.parse(T0);
/** The old scope of the decisions, as the mod names it (the key of `LISTAS_DO_P9`). */
const ESCOPO_ANTIGO = { session: 'sessao', family: 'familia', branch: 'branch' } as const;
const saida: Record<string, unknown> = {};
const listas: Record<string, unknown> = {};
for (const nome of PANEL_SCENARIOS) {
  const storage = openSqliteStorage({ path: ':memory:' });
  const decisoes = new SqliteDecisionStore(storage.db);
  await seedPanelScenario(storage, nome, AGORA);
  await seedPanelDecisions(decisoes, nome, AGORA);
  const trabalho = new TrabalhoPorBranch({ fonte: new SimulatorWorkSource(), git: SimulatorWorkSource.git, agora: () => AGORA });
  const montador = new MontadorDoPainel({
    storage, contas: new Accounts({ storage, file: null }), desktop: null, trabalho, decisoes, agora: () => AGORA, apelido: () => PANEL_SESSION,
  });
  const pedido = { sessionId: 'sessao-teste', modelo: 'claude-sonnet-5-5', cwd: '/simulacao/cli-de-notas' };
  await montador.montar(pedido);
  await trabalho.esperar();
  saida[nome] = translateBody(LEGACY_BODIES.panel.response, await montador.montar(pedido));
  if (nome === 'p9') {
    for (const escopo of ESCOPOS_DAS_DECISOES) {
      const lista = (await montador.montar({ ...pedido, decisoes: escopo })).decisions!.list!;
      listas[ESCOPO_ANTIGO[escopo]] = translateBody(LEGACY_BODIES['decisions/scope'].response, lista);
    }
  }
  await storage.close();
}
const chaves = PANEL_SCENARIOS.map((c) => `'${c}'`).join(' | ');
process.stdout.write(
  `// Gerado por packages/nucleo/test/api/record-scenarios.ts: a resposta de /api/painel em cada cenário\n` +
    `// do simulador (P1 a P7, P9, P12 e P13), com a hora fixa AGORA, e as listas de decisões do P9 por escopo.\n` +
    `// Não edite: rode o script de novo.\n` +
    `import type { EscopoDasDecisoes, ListaDeDecisoes, Painel } from '../types'\n\n` +
    `export const AGORA = ${AGORA}\n\n` +
    `export const CENARIOS: Record<${chaves}, Painel> = ${JSON.stringify(saida, null, 2)}\n\n` +
    `export const LISTAS_DO_P9: Record<EscopoDasDecisoes, ListaDeDecisoes> = ${JSON.stringify(listas, null, 2)}\n`,
);
