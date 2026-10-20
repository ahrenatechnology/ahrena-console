// The simulator's Dev Console (#177): a synthetic context of two made-up repositories, with the
// PRs, issues and branches of wireframe C27, on a fake GitHub. No real data. Titles stay pt-BR:
// the screen shows them.
//
// The demo scenario's sessions land in the repositories by folder (fake `git`): `motor-de-regras`
// on #58's branch (on the remote), `vitrine-demo` on #61's (on the remote) and `ahrena-demo` on
// #68's, not pushed yet, which puts that issue in `delegated`.

import { basename } from 'node:path';
import type { Git } from '../api/work.ts';
import type { DevConsoleContext } from '../dev-console/contexts.ts';
import type { IssueFact, MergedPullRequestFact, PullRequestFact } from '../dev-console/model.ts';
import type { DevConsoleSource, RepoBranches, RepoIssues, RepoPullRequests } from '../dev-console/source.ts';

export const DEV_CONSOLE_SIMULATOR_CATALOG = 'dev-sintetico/catalogo-exemplo';
export const DEV_CONSOLE_SIMULATOR_RULES = 'dev-sintetico/motor-de-regras';

export const DEV_CONSOLE_SIMULATOR_CONTEXTS: DevConsoleContext[] = [
  { id: 'loja', name: 'Loja', repos: [DEV_CONSOLE_SIMULATOR_CATALOG, DEV_CONSOLE_SIMULATOR_RULES], blockedLabels: ['blocked'], source: 'file' },
];

/** Demo session folder → repository and branch. */
const FOLDERS: Record<string, { repo: string; branch: string }> = {
  'motor-de-regras': { repo: DEV_CONSOLE_SIMULATOR_RULES, branch: 'feat/58-esquema-pedidos' },
  'vitrine-demo': { repo: DEV_CONSOLE_SIMULATOR_CATALOG, branch: 'feat/61-pagamentos' },
  'ahrena-demo': { repo: DEV_CONSOLE_SIMULATOR_CATALOG, branch: 'feat/68-cupom' },
};

/** Fake `git` for the demo sessions: the remote and the branch by folder. */
export const devConsoleSimulatorGit: Git = async (cwd, args) => {
  const f = FOLDERS[basename(cwd)];
  if (!f) return null;
  if (args[0] === 'remote') return `https://github.com/${f.repo}.git`;
  if (args[0] === 'branch') return f.branch;
  return null;
};

const url = (repo: string, kind: 'pull' | 'issues', n: number) => `https://github.com/${repo}/${kind}/${n}`;

export class SimulatedDevConsoleSource implements DevConsoleSource {
  /** Turn on to simulate GitHub being down: reads fail and the cache answers. */
  offline = false;
  readonly calls: string[] = [];
  private readonly now: () => number;

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this.now = now;
  }

  private ago(hours: number): string {
    return new Date(this.now() - hours * 3_600_000).toISOString();
  }

  private check(call: string) {
    this.calls.push(call);
    if (this.offline) throw new Error('GitHub fora do ar (simulado)');
  }

  async pullRequests(repo: string): Promise<RepoPullRequests> {
    this.check(`pullRequests:${repo}`);
    const p = (n: number, title: string, over: Partial<PullRequestFact>): PullRequestFact => ({
      repo, number: n, title, url: url(repo, 'pull', n), isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      baseRefName: 'main', headRefName: `feat/${n}`, isCrossRepository: false, createdAt: this.ago(10), ci: 'SUCCESS', review: null, closes: [], ...over,
    });
    const m = (n: number, title: string, hours: number): MergedPullRequestFact => ({ repo, number: n, title, url: url(repo, 'pull', n), mergedAt: this.ago(hours) });
    if (repo === DEV_CONSOLE_SIMULATOR_CATALOG) {
      return {
        open: [
          p(81, 'Endpoint de exportação em CSV', { headRefName: 'feat/31-exportacao-csv', createdAt: this.ago(30), review: 'APPROVED', closes: [31] }),
          p(83, 'Retry com backoff na fila', { headRefName: 'feat/72-retry', createdAt: this.ago(3), ci: 'PENDING' }),
          p(77, 'Relatório mensal mais rápido', { headRefName: 'feat/47-relatorio', createdAt: this.ago(40), ci: 'FAILURE', closes: [47] }),
        ],
        merged: [m(80, 'Paginação da listagem', 3), m(78, 'Testes do parser de datas', 13)],
      };
    }
    if (repo === DEV_CONSOLE_SIMULATOR_RULES) {
      return {
        open: [
          p(79, 'Migração do esquema de pedidos', { headRefName: 'feat/58-esquema-pedidos', createdAt: this.ago(20), closes: [58] }),
          p(84, 'Índices da tabela de pedidos', { baseRefName: 'feat/58-esquema-pedidos', headRefName: 'feat/60-indices-pedidos', createdAt: this.ago(26) }),
          p(82, 'Regras de frete por região', { headRefName: 'feat/82-frete', createdAt: this.ago(50), mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
        ],
        merged: [m(76, 'Documentar a autenticação', 18)],
      };
    }
    return { open: [], merged: [] };
  }

  async issues(repo: string): Promise<RepoIssues> {
    this.check(`issues:${repo}`);
    const i = (n: number, title: string, over: Partial<IssueFact> = {}): IssueFact => ({ repo, number: n, title, url: url(repo, 'issues', n), state: 'OPEN', labels: [], closedAt: null, ...over });
    const done = (n: number, title: string, hours: number) => i(n, title, { state: 'CLOSED', closedAt: this.ago(hours) });
    if (repo === DEV_CONSOLE_SIMULATOR_CATALOG) {
      return {
        open: [
          i(64, 'Exportar o catálogo em XLSX'),
          i(66, 'Ordenar categorias pelo uso'),
          i(70, 'Guia de contribuição'),
          i(68, 'Cupom por categoria'),
          i(61, 'Cobrança vira um serviço à parte'),
          i(72, 'Retry com backoff'),
          i(31, 'Exportação em CSV'),
          i(47, 'Relatório mensal'),
          i(55, 'Pagamento por PIX', { labels: ['blocked'] }),
        ],
        closed: [done(52, 'Paginação da listagem', 3), done(50, 'Testes do parser de datas', 13), done(44, 'Ajustar o README', 40)],
      };
    }
    if (repo === DEV_CONSOLE_SIMULATOR_RULES) {
      return { open: [i(58, 'Esquema de pedidos')], closed: [done(49, 'Documentar a autenticação', 18)] };
    }
    return { open: [], closed: [] };
  }

  async branches(repo: string): Promise<RepoBranches> {
    this.check(`branches:${repo}`);
    if (repo === DEV_CONSOLE_SIMULATOR_CATALOG) return { names: ['main', 'feat/31-exportacao-csv', 'feat/61-pagamentos', 'feat/72-retry', 'feat/47-relatorio'] };
    if (repo === DEV_CONSOLE_SIMULATOR_RULES) return { names: ['main', 'feat/58-esquema-pedidos', 'feat/60-indices-pedidos', 'feat/82-frete'] };
    return { names: [] };
  }
}
