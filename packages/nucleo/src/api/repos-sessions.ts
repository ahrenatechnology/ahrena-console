// The sessions of each repository (#104 criterion 2): active ones, how many need you and how many
// had activity in the month. Everything comes from the core's own sessions, through the same reading as
// the MCP (`FleetReader`): active are the live ones (`active` and `error`); "needs you" is the
// `precisa` level of `atencaoDe` (#140), the MCP's `blocking` group, and nothing beyond that.
//
// A session's repository comes from cwd → `git remote get-url origin` → `repoDoRemote`. Git
// never runs in the request's path: a cwd not yet known goes into a queue that runs in the background,
// serially, and when it finds something new it calls `aoDescobrir` (the service records the change in
// the cursor and the screen re-reads). Each cwd's remote holds for `remoteMs`.

import { dayOf } from '../cost/aggregation.ts';
import type { FleetReader } from '../mcp/fleet.ts';
import type { SessoesDoRepo } from './repos-types.ts';
import { gitDoSistema, repoDoRemote, type Git } from './work.ts';

/** Chave dos mapas: `dono/repo` em minúsculas (o GitHub não diferencia caixa). */
export const chaveDoRepo = (completo: string): string => completo.toLowerCase();

export interface OpcoesDasSessoesPorRepo {
  frota: Pick<FleetReader, 'live' | 'attention' | 'today' | 'storage' | 'timeZone' | 'now'>;
  git?: Git;
  /** Chamado quando a fila do git descobre o repositório de um cwd novo (ou ele muda). */
  aoDescobrir?: () => void;
  /** Validade da contagem montada. Padrão 3 s. */
  cacheMs?: number;
  /** Validade do remote de um cwd. Padrão 10 min. */
  remoteMs?: number;
  /** Somas fixas por repositório (só a demonstração usa: sessões que o cenário não tem). */
  extras?: Readonly<Record<string, Partial<SessoesDoRepo>>>;
}

interface Remote {
  repo: string | null;
  em: number;
}

export class SessoesPorRepo {
  private readonly frota: OpcoesDasSessoesPorRepo['frota'];
  private readonly git: Git;
  private readonly aoDescobrir: () => void;
  private readonly cacheMs: number;
  private readonly remoteMs: number;
  private readonly extras: Readonly<Record<string, Partial<SessoesDoRepo>>>;
  private readonly remotes = new Map<string, Remote>();
  private readonly fila = new Set<string>();
  private rodandoFila: Promise<void> | null = null;
  private cache: { em: number; mapa: Map<string, SessoesDoRepo> } | null = null;
  private montando: Promise<Map<string, SessoesDoRepo>> | null = null;
  /** Chamadas ao git (medição e testes). */
  chamadasAoGit = 0;

  constructor({ frota, git = gitDoSistema, aoDescobrir = () => {}, cacheMs = 3_000, remoteMs = 10 * 60_000, extras = {} }: OpcoesDasSessoesPorRepo) {
    this.frota = frota;
    this.git = git;
    this.aoDescobrir = aoDescobrir;
    this.cacheMs = cacheMs;
    this.remoteMs = remoteMs;
    this.extras = extras;
  }

  /** Contagem por repositório (chave `chaveDoRepo`). Lê só o banco do núcleo; o git fica por trás. */
  async ler(): Promise<Map<string, SessoesDoRepo>> {
    if (this.cache && this.frota.now() - this.cache.em < this.cacheMs) return this.cache.mapa;
    this.montando ??= this.montar().finally(() => {
      this.montando = null;
    });
    return this.montando;
  }

  /** Espera a fila do git (testes e o primeiro desenho). */
  async esperar(): Promise<void> {
    while (this.rodandoFila) await this.rodandoFila;
  }

  /** O repositório de um cwd já resolvido, ou `undefined` (a resolução entra na fila). */
  repoDe(cwd: string): string | null | undefined {
    const r = this.remotes.get(cwd);
    if (!r || this.frota.now() - r.em >= this.remoteMs) this.enfileirar(cwd);
    return r?.repo;
  }

  private enfileirar(cwd: string): void {
    this.fila.add(cwd);
    this.rodandoFila ??= this.rodarFila().finally(() => {
      this.rodandoFila = null;
    });
  }

  private async rodarFila(): Promise<void> {
    let mudou = false;
    while (this.fila.size > 0) {
      const cwd = this.fila.values().next().value as string;
      this.fila.delete(cwd);
      this.chamadasAoGit++;
      const remote = await this.git(cwd, ['remote', 'get-url', 'origin']).catch(() => null);
      const repo = remote ? repoDoRemote(remote) : null;
      const antes = this.remotes.get(cwd);
      this.remotes.set(cwd, { repo, em: this.frota.now() });
      if (antes?.repo !== repo) mudou = true;
    }
    if (mudou) {
      this.cache = null;
      this.aoDescobrir();
    }
  }

  private async montar(): Promise<Map<string, SessoesDoRepo>> {
    const mapa = new Map<string, SessoesDoRepo>();
    const de = (repo: string) => {
      const k = chaveDoRepo(repo);
      let c = mapa.get(k);
      if (!c) mapa.set(k, (c = { active: 0, needYou: 0, thisMonth: 0 }));
      return c;
    };
    for (const s of await this.frota.live()) {
      const repo = s.session.cwd ? this.repoDe(s.session.cwd) : null;
      if (!repo) continue;
      const c = de(repo);
      c.active++;
      if (s.inbox.needsYou && (await this.frota.attention(s)).group === 'blocking') c.needYou++;
    }
    // Do mês corrente, no fuso da máquina: a porta lista da mais recente para a mais antiga.
    const inicioDoMes = `${this.frota.today().slice(0, 8)}01`;
    let cursor: string | null = null;
    pagina: do {
      const page = await this.frota.storage.listSessions({ limit: 500, cursor });
      for (const s of page.items) {
        if (dayOf(s.updatedAt, this.frota.timeZone) < inicioDoMes) break pagina;
        const repo = s.cwd ? this.repoDe(s.cwd) : null;
        if (repo) de(repo).thisMonth++;
      }
      cursor = page.nextCursor;
    } while (cursor);
    for (const [repo, extra] of Object.entries(this.extras)) {
      const c = de(repo);
      c.active += extra.active ?? 0;
      c.needYou += extra.needYou ?? 0;
      c.thisMonth += extra.thisMonth ?? 0;
    }
    this.cache = { em: this.frota.now(), mapa };
    return mapa;
  }
}
