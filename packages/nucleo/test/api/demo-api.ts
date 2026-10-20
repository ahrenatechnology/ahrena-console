// A deterministic demo server: the --demo of scenario p4, the decisions of p9, the workflows, the
// Detail, the history, the repos and the project of the demo, every clock fixed at NOW and the change
// cursor with a fixed generation. `old-routes.test.ts` proves on it that the old Portuguese routes
// are gone (issue #173, phase 6) and `simulator-demo.test.ts` that the demo's old ids are too.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage, type SqliteStorage } from '../../src/adapters/sqlite/sqlite-storage.ts';
import { Accounts, FeedDeEventos, LeiturasDoDetalhe, ListaDeSessoes, MontadorDoPainel, QuadroKanban, TrabalhoPorBranch, startLocalApi, type LocalApi } from '../../src/api/index.ts';
import { RotaAnalytics } from '../../src/api/analytics-route.ts';
import { DecisoesDaUi } from '../../src/api/decisions-ui.ts';
import { criarReposDoNucleo } from '../../src/api/repos.ts';
import { SqliteDecisionStore } from '../../src/decisions/sqlite.ts';
import { GithubCache } from '../../src/github/cache.ts';
import { GithubProject } from '../../src/github/project.ts';
import { SqliteCacheStore } from '../../src/github/sqlite-cache.ts';
import { SessionHistory } from '../../src/history/reading.ts';
import { createMcpServer } from '../../src/mcp/index.ts';
import { ChangeCursor } from '../../src/changes/cursor.ts';
import { withChanges, SessionAccounts, decisionsWithChanges } from '../../src/changes/sources.ts';
import { demoLocal, seedDetail } from '../../src/simulator/detail.ts';
import { seedPanelHistory } from '../../src/simulator/history-ended.ts';
import { SimulatorWorkSource, PANEL_SESSION, seedPanelScenario, seedPanelDecisions } from '../../src/simulator/panel.ts';
import { SIMULATOR_PROJECT, SimulatorProject } from '../../src/simulator/project.ts';
import { seedDemoWorkflows } from '../../src/simulator/workflows.ts';

export const NOW = Date.parse('2026-10-20T15:00:00Z');
/** A fixed core version, so the answers do not follow the app's releases (#261). */
const DEMO_VERSION = '0.0.1';
export const LOCAL = 'local_0b0e1d2c-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
/** The "this session" of the demo panel (p4). */
export const DEMO_SESSION = PANEL_SESSION;
/** The id the mod sends for the demo session: the server reads it as `DEMO_SESSION`. Any other id is read as it is. */
export const DEMO_ALIAS = 'demo';
/** The repository of the demo decisions (p9), whose records folder lives under the temp dir. */
const DEMO_REPO = '/simulacao/ahrena-demo';

export interface DemoApi {
  api: LocalApi;
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

export async function startDemoApi(): Promise<DemoApi> {
  const clock = () => NOW;
  const opened: string[] = [];
  const records = mkdtempSync(join(tmpdir(), 'ahrena-demo-api-'));
  const repoFolder = join(records, 'ahrena-demo');
  const changes = new ChangeCursor({ generation: 'golden' });
  const sqlite: SqliteStorage = openSqliteStorage({ path: ':memory:' });
  const sessionAccounts = new SessionAccounts(sqlite);
  const storage = withChanges(sqlite, changes, sessionAccounts);
  const decisions = decisionsWithChanges(new SqliteDecisionStore(sqlite.db), changes, sessionAccounts);
  const work = new TrabalhoPorBranch({ fonte: new SimulatorWorkSource(), git: SimulatorWorkSource.git, agora: clock });
  const accounts = new Accounts({ storage, file: null });
  const builder = new MontadorDoPainel({ storage, contas: accounts, desktop: null, trabalho: work, decisoes: decisions, agora: clock, apelido: (id) => (id === DEMO_ALIAS ? DEMO_SESSION : id), version: DEMO_VERSION });
  await seedPanelScenario(storage, 'p4', NOW);
  // The decisions of the p9 scenario (p4 has none): a suggested one to confirm and undo.
  await seedPanelDecisions(decisions, 'p9', NOW);
  await seedDemoWorkflows(storage, NOW);
  await seedDetail(storage, NOW);
  await seedPanelHistory(storage, decisions, 'p4', NOW);
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
  const project = new GithubProject({ source: new SimulatorProject(NOW), cache: new GithubCache({ store: new SqliteCacheStore(sqlite.db), now: clock }), project: SIMULATOR_PROJECT });
  const api = await startLocalApi({
    panelBuilder: builder,
    hooks: { storage },
    port: 0,
    log: () => {},
    openInDesktop: async (url) => void opened.push(url),
    changes,
    project: { kanban: project, fonte: 'demo', log: () => {} },
    detail: new LeiturasDoDetalhe({ storage, montador: builder, agora: clock, local: demoLocal }),
    events: new FeedDeEventos({ storage }),
    fleet: mcp.fleet,
    analytics: new RotaAnalytics({ storage, contas: accounts, agora: clock }),
    sessions: new ListaDeSessoes({ storage, contas: accounts, agora: clock }),
    history: new SessionHistory({ storage, decisions, timeZone: 'UTC' }),
    kanban: new QuadroKanban({ storage, contas: accounts, agora: clock }),
    decisionsUi,
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
