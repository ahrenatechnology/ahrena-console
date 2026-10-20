// The session's work by branch (4.3): the issue number comes from the branch name
// (`feat/35-painel`, `35-painel`, `fix/issue-35`), the repository from the git remote, and the issue,
// the PR, the CI and the review come from GitHub through the cache of decision 0001 (issue 5 min, PR and CI 60 s).
//
// The panel's request never waits for GitHub or git: it returns the last data and, if it expired,
// refreshes in the background. The first time, the panel gets `null` and the card shows up on the next request.

import { execFile } from 'node:child_process';
import { GITHUB_TTL, GithubCache, MemoryCacheStore } from '../github/cache.ts';
import type { WorkSource } from '../github/source.ts';
import { workKey, type LinkedPullRequest } from '../github/work.ts';
import type { PanelWork } from './types.ts';

export type Git = (cwd: string, args: string[]) => Promise<string | null>;

/** `git -C <cwd> …`, com timeout curto; `null` em qualquer falha. */
export const gitDoSistema: Git = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 3000 }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });

/** Número da issue no nome do branch, ou `null`. */
export function issueDoBranch(branch: string): number | null {
  const m = /(?:^|[/_-])(?:issue-|gh-)?(\d{1,6})(?=$|[/_-])/i.exec(branch);
  return m ? Number(m[1]) : null;
}

/** `dono/repo` de um remote do GitHub (https ou ssh). */
export function repoDoRemote(remote: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

type PrDoPainel = NonNullable<PanelWork['pr']>;

export type PrCi = NonNullable<PrDoPainel['ci']>;
export type PrReview = NonNullable<PrDoPainel['review']>;

/** CI do último commit, como o painel e o kanban do projeto mostram: `ok`, `failed`, `running` ou `null` sem checagens. */
export function ciDoPr(p: Pick<LinkedPullRequest, 'ci'>): PrCi | null {
  return !p.ci ? null : p.ci === 'SUCCESS' ? 'ok' : p.ci === 'FAILURE' || p.ci === 'ERROR' ? 'failed' : 'running';
}

/** Review do PR: `approved`, `changes-requested`, `pending` (aberto sem decisão) ou `null`. */
export function reviewDoPr(p: Pick<LinkedPullRequest, 'review' | 'state'>): PrReview | null {
  return p.review === 'APPROVED' ? 'approved' : p.review === 'CHANGES_REQUESTED' ? 'changes-requested' : p.state === 'OPEN' ? 'pending' : null;
}

function prDoPainel(prs: readonly LinkedPullRequest[]): PanelWork['pr'] {
  const p = prs.find((x) => x.state === 'OPEN') ?? prs.find((x) => x.state === 'MERGED') ?? prs[0];
  if (!p) return null;
  const state = p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : p.isDraft ? 'draft' : 'open';
  const checks = p.checks ? { total: p.checks.total, ok: p.checks.ok, failed: p.checks.falhas, running: p.checks.rodando } : null;
  return { number: p.number, url: p.url, state, ci: ciDoPr(p), checks, review: reviewDoPr(p) };
}

interface Entrada {
  valor: PanelWork | null;
  em: number;
  rodando: Promise<void> | null;
}

export interface OpcoesDoTrabalho {
  /** Sem fonte (sem `gh`, ou desligado), o card mostra só o branch. */
  fonte: WorkSource | null;
  cache?: GithubCache;
  git?: Git;
  /** Validade do resultado montado; o GitHub tem os TTLs próprios no cache. Padrão 60 s. */
  validadeMs?: number;
  agora?: () => number;
}

export class TrabalhoPorBranch {
  private readonly fonte: WorkSource | null;
  private readonly cache: GithubCache;
  private readonly git: Git;
  private readonly validadeMs: number;
  private readonly agora: () => number;
  private readonly entradas = new Map<string, Entrada>();
  private readonly branches = new Map<string, { valor: string | null; em: number; rodando: Promise<void> | null }>();
  /** Montagens que passaram pelo cache do GitHub e chamadas ao git (para a medição de carga). */
  chamadas = { github: 0, git: 0 };

  constructor({ fonte, cache, git = gitDoSistema, validadeMs = 60_000, agora = Date.now }: OpcoesDoTrabalho) {
    this.fonte = fonte;
    this.cache = cache ?? new GithubCache({ store: new MemoryCacheStore(), now: agora });
    this.git = git;
    this.validadeMs = validadeMs;
    this.agora = agora;
  }

  /** O último trabalho conhecido de `cwd` (e do branch do Desktop, se houver); atualiza por trás se venceu. */
  ler(cwd: string | null, branchDoDesktop: string | null): PanelWork | null {
    if (!cwd && !branchDoDesktop) return null;
    const chave = `${cwd ?? ''}\0${branchDoDesktop ?? ''}`;
    let e = this.entradas.get(chave);
    if (!e) {
      e = { valor: null, em: -Infinity, rodando: null };
      this.entradas.set(chave, e);
    }
    if (!e.rodando && this.agora() - e.em >= this.validadeMs) {
      const alvo = e;
      alvo.rodando = this.montar(cwd, branchDoDesktop, alvo.valor)
        .then((v) => {
          alvo.valor = v;
        })
        .catch(() => undefined)
        .finally(() => {
          alvo.em = this.agora();
          alvo.rodando = null;
        });
    }
    return e.valor;
  }

  /** O último trabalho conhecido de `cwd`, sem atualizar: quem lê muitas pastas (o mural) não dispara git nem GitHub. */
  espiar(cwd: string | null, branchDoDesktop: string | null = null): PanelWork | null {
    if (!cwd && !branchDoDesktop) return null;
    return this.entradas.get(`${cwd ?? ''}\0${branchDoDesktop ?? ''}`)?.valor ?? null;
  }

  /**
   * Só o branch da pasta, pelo `git branch --show-current`: em cache, atualizado por trás quando vence,
   * sem remote nem GitHub. Para o mural, que lê todas as sessões abertas.
   */
  branchDaPasta(cwd: string | null): string | null {
    if (!cwd) return null;
    let e = this.branches.get(cwd);
    if (!e) {
      e = { valor: null, em: -Infinity, rodando: null };
      this.branches.set(cwd, e);
    }
    if (!e.rodando && this.agora() - e.em >= this.validadeMs) {
      const alvo = e;
      alvo.rodando = this.rodarGit(cwd, ['branch', '--show-current'])
        .then((b) => {
          alvo.valor = b;
        })
        .catch(() => undefined)
        .finally(() => {
          alvo.em = this.agora();
          alvo.rodando = null;
        });
    }
    return e.valor;
  }

  /** Espera as atualizações em andamento (testes e o primeiro desenho). */
  async esperar(): Promise<void> {
    await Promise.all([...this.entradas.values(), ...this.branches.values()].map((e) => e.rodando));
  }

  private async rodarGit(cwd: string, args: string[]): Promise<string | null> {
    this.chamadas.git++;
    return this.git(cwd, args);
  }

  private async montar(cwd: string | null, branchDoDesktop: string | null, anterior: PanelWork | null): Promise<PanelWork | null> {
    const branch = branchDoDesktop ?? (cwd ? await this.rodarGit(cwd, ['branch', '--show-current']) : null);
    if (!branch) return null;
    const remote = cwd ? await this.rodarGit(cwd, ['remote', 'get-url', 'origin']) : null;
    const repo = remote ? repoDoRemote(remote) : null;
    const notPushed = cwd ? (await this.rodarGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])) === null : false;
    const numero = issueDoBranch(branch);
    const base: PanelWork = { branch, repo, issue: null, pr: null, notPushed, error: null };
    if (!repo || numero === null || !this.fonte) return base;

    const key = workKey(repo, numero);
    const fonte = this.fonte;
    try {
      this.chamadas.github++;
      const nos = await this.cache.get(`panel:issue:${key}`, GITHUB_TTL.issues, async () => ({ value: await fonte.nodes([key]) }));
      const no = nos.value.find((n) => n.key === key);
      if (!no) return base;
      const detalhe = await this.cache.get(`github:detail:${key}`, GITHUB_TTL.detail, async () => ({ value: await fonte.detail(key) }));
      return {
        ...base,
        issue: {
          number: numero,
          title: no.title,
          url: no.url,
          subIssues: no.progress ? { done: no.progress.completed, total: no.progress.total } : null,
        },
        pr: prDoPainel(detalhe.value.pullRequests),
        error: nos.stale || detalhe.stale ? (nos.staleReason ?? detalhe.staleReason ?? 'GitHub indisponível') : null,
      };
    } catch (err) {
      return { ...(anterior ?? base), branch, notPushed, error: (err as Error).message };
    }
  }
}
