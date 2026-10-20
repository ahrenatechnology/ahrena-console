// The deterministic demo server the old-route tests run against (issue #173): the --demo of
// scenario p4, the decisions of p9, the workflows, the Detail, the history, the repos and the
// project of the demo, every clock fixed at NOW and the change cursor with a fixed generation.
// Shared by `legacy-routes.test.ts`, `legacy-golden.test.ts` and `record-legacy-goldens.ts`, so the
// goldens are recorded and replayed on the very same server.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Contas, FeedDeEventos, LeiturasDoDetalhe, ListaDeSessoes, MontadorDoPainel, QuadroKanban, TrabalhoPorBranch, iniciarApiLocal, type ApiLocal } from '../../src/api/index.ts';
import { RotaAnalytics } from '../../src/api/rota-analytics.ts';
import { DecisoesDaUi } from '../../src/api/decisoes-ui.ts';
import { criarReposDoNucleo } from '../../src/api/repos.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { GithubProject } from '../../src/github/project.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { SessionHistory } from '../../src/history/reading.ts';
import { createMcpServer } from '../../src/mcp/index.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { withChanges, SessionAccounts, decisionsWithChanges } from '../../src/changes/sources.ts';
import { localDaDemo, semearDetalhe } from '../../src/simulator/detail.ts';
import { semearHistoricoDoPainel } from '../../src/simulator/history-ended.ts';
import { FonteDeTrabalhoDoSimulador, SESSAO_DO_PAINEL, semearCenariosDoPainel, semearDecisoesDoPainel } from '../../src/simulator/panel.ts';
import { PROJECT_DO_SIMULADOR, ProjetoDoSimulador } from '../../src/simulator/project.ts';
import { semearWorkflowsDoDemo } from '../../src/simulator/workflows.ts';

export const NOW = Date.parse('2026-10-20T15:00:00Z');
export const LOCAL = 'local_0b0e1d2c-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
/** The "this session" of the demo panel (p4). */
export const DEMO_SESSION = SESSAO_DO_PAINEL;
/** The id the mod sends for the demo session: the server reads it as `DEMO_SESSION`. Any other id is read as it is. */
export const DEMO_ALIAS = 'demo';
/** The repository of the demo decisions (p9), whose records folder lives under the temp dir. */
const DEMO_REPO = '/simulacao/ahrena-demo';

export interface LegacyDemo {
  api: ApiLocal;
  /** `127.0.0.1:<port>`, for the page's own `Origin`. */
  host: string;
  /** The `claude://` addresses the server asked the Desktop to open. */
  opened: string[];
  /**
   * Creates the `docs/decisoes` folder of the demo repository, in a temp dir of this server: before
   * it, the repository folder does not exist (the "Promover" draft says so); after it, the promote
   * writes there.
   */
  createRecordsFolder(): void;
  close(): Promise<void>;
}

export async function startLegacyDemo(): Promise<LegacyDemo> {
  const clock = () => NOW;
  const opened: string[] = [];
  const records = mkdtempSync(join(tmpdir(), 'ahrena-legacy-demo-'));
  const repoFolder = join(records, 'ahrena-demo');
  const changes = new ChangeCursor({ generation: 'golden' });
  const sqlite: SqliteStorage = openSqliteStorage({ path: ':memory:' });
  const sessionAccounts = new SessionAccounts(sqlite);
  const storage = withChanges(sqlite, changes, sessionAccounts);
  const decisions = decisionsWithChanges(new SqliteDecisionStore(sqlite.db), changes, sessionAccounts);
  const work = new TrabalhoPorBranch({ fonte: new FonteDeTrabalhoDoSimulador(), git: FonteDeTrabalhoDoSimulador.git, agora: clock });
  const accounts = new Contas({ storage, arquivo: null });
  const builder = new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: work, decisoes: decisions, agora: clock, apelido: (id) => (id === DEMO_ALIAS ? DEMO_SESSION : id) });
  await semearCenariosDoPainel(storage, 'p4', NOW);
  // The decisions of the p9 scenario (p4 has none): a suggested one to confirm and undo.
  await semearDecisoesDoPainel(decisions, 'p9', NOW);
  await semearWorkflowsDoDemo(storage, NOW);
  await semearDetalhe(storage, NOW);
  await semearHistoricoDoPainel(storage, decisions, 'p4', NOW);
  const mcp = createMcpServer({ storage, accounts, desktop: null, now: clock, timeZone: 'UTC', log: () => {} });
  const repos = criarReposDoNucleo({ demo: true, semGithub: false, cache: new GithubCache({ store: new SqliteCacheStore(sqlite.db), now: clock }), frota: mcp.fleet, mudancas: changes, log: () => {} });
  const decisionsUi = new DecisoesDaUi({
    decisions,
    storage,
    alvoDe: (id) => builder.alvoDaSessao(id),
    localDe: async () => null,
    agora: clock,
    raiz: (repo) => (repo === DEMO_REPO ? repoFolder : null),
  });
  const project = new GithubProject({ source: new ProjetoDoSimulador(NOW), cache: new GithubCache({ store: new SqliteCacheStore(sqlite.db), now: clock }), project: PROJECT_DO_SIMULADOR });
  const api = await iniciarApiLocal({
    montador: builder,
    hooks: { storage },
    port: 0,
    log: () => {},
    abrirNoDesktop: async (url) => void opened.push(url),
    mudancas: changes,
    projeto: { kanban: project, fonte: 'demo', log: () => {} },
    detalhe: new LeiturasDoDetalhe({ storage, montador: builder, agora: clock, local: localDaDemo }),
    eventos: new FeedDeEventos({ storage }),
    frota: mcp.fleet,
    analytics: new RotaAnalytics({ storage, contas: accounts, agora: clock }),
    sessoes: new ListaDeSessoes({ storage, contas: accounts, agora: clock }),
    historico: new SessionHistory({ storage, decisions, timeZone: 'UTC' }),
    kanban: new QuadroKanban({ storage, contas: accounts, agora: clock }),
    decisoesUi: decisionsUi,
    repos: repos.rota,
  });
  return {
    api,
    host: new URL(api.url).host,
    opened,
    createRecordsFolder: () => mkdirSync(join(repoFolder, 'docs', 'decisoes'), { recursive: true }),
    close: async () => {
      await api.close();
      sqlite.close();
      rmSync(records, { recursive: true, force: true });
    },
  };
}
