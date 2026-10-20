// O trabalho da sessão pelo branch (4.3): o número da issue sai do nome do branch
// (`feat/35-painel`, `35-painel`, `fix/issue-35`), o repositório do remote do git, e a issue,
// o PR, o CI e o review vêm do GitHub pelo cache da decisão 0001 (issue 5 min, PR e CI 60 s).
//
// O pedido do painel nunca espera o GitHub nem o git: devolve o último dado e, se venceu,
// atualiza por trás. Na primeira vez, o painel recebe `null` e o card aparece no pedido seguinte.

import { execFile } from 'node:child_process';
import { GITHUB_TTL, GithubCache, MemoryCacheStore } from '../github/cache.ts';
import type { WorkSource } from '../github/source.ts';
import { workKey, type LinkedPullRequest } from '../github/work.ts';
import type { TrabalhoDoPainel } from './tipos.ts';

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

type PrDoPainel = NonNullable<TrabalhoDoPainel['pr']>;

/** CI do último commit, como o painel e o kanban mostram: `ok`, `falhou`, `rodando` ou `null` sem checagens. */
export function ciDoPr(p: Pick<LinkedPullRequest, 'ci'>): PrDoPainel['ci'] {
  return !p.ci ? null : p.ci === 'SUCCESS' ? 'ok' : p.ci === 'FAILURE' || p.ci === 'ERROR' ? 'falhou' : 'rodando';
}

/** Review do PR: `aprovado`, `ajustes`, `pendente` (aberto sem decisão) ou `null`. */
export function reviewDoPr(p: Pick<LinkedPullRequest, 'review' | 'state'>): PrDoPainel['review'] {
  return p.review === 'APPROVED' ? 'aprovado' : p.review === 'CHANGES_REQUESTED' ? 'ajustes' : p.state === 'OPEN' ? 'pendente' : null;
}

function prDoPainel(prs: readonly LinkedPullRequest[]): TrabalhoDoPainel['pr'] {
  const p = prs.find((x) => x.state === 'OPEN') ?? prs.find((x) => x.state === 'MERGED') ?? prs[0];
  if (!p) return null;
  const estado = p.state === 'MERGED' ? 'mergeado' : p.state === 'CLOSED' ? 'fechado' : p.isDraft ? 'rascunho' : 'aberto';
  return { numero: p.number, url: p.url, estado, ci: ciDoPr(p), checks: p.checks ?? null, review: reviewDoPr(p) };
}

interface Entrada {
  valor: TrabalhoDoPainel | null;
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
  ler(cwd: string | null, branchDoDesktop: string | null): TrabalhoDoPainel | null {
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
  espiar(cwd: string | null, branchDoDesktop: string | null = null): TrabalhoDoPainel | null {
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

  private async montar(cwd: string | null, branchDoDesktop: string | null, anterior: TrabalhoDoPainel | null): Promise<TrabalhoDoPainel | null> {
    const branch = branchDoDesktop ?? (cwd ? await this.rodarGit(cwd, ['branch', '--show-current']) : null);
    if (!branch) return null;
    const remote = cwd ? await this.rodarGit(cwd, ['remote', 'get-url', 'origin']) : null;
    const repo = remote ? repoDoRemote(remote) : null;
    const semPush = cwd ? (await this.rodarGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])) === null : false;
    const numero = issueDoBranch(branch);
    const base: TrabalhoDoPainel = { branch, repo, issue: null, pr: null, semPush, erro: null };
    if (!repo || numero === null || !this.fonte) return base;

    const key = workKey(repo, numero);
    const fonte = this.fonte;
    try {
      this.chamadas.github++;
      const nos = await this.cache.get(`painel:issue:${key}`, GITHUB_TTL.issues, async () => ({ value: await fonte.nodes([key]) }));
      const no = nos.value.find((n) => n.key === key);
      if (!no) return base;
      const detalhe = await this.cache.get(`github:detail:${key}`, GITHUB_TTL.detail, async () => ({ value: await fonte.detail(key) }));
      return {
        ...base,
        issue: {
          numero,
          titulo: no.title,
          url: no.url,
          subIssues: no.progress ? { feitas: no.progress.completed, total: no.progress.total } : null,
        },
        pr: prDoPainel(detalhe.value.pullRequests),
        erro: nos.stale || detalhe.stale ? (nos.staleReason ?? detalhe.staleReason ?? 'GitHub indisponível') : null,
      };
    } catch (err) {
      return { ...(anterior ?? base), branch, semPush, erro: (err as Error).message };
    }
  }
}
