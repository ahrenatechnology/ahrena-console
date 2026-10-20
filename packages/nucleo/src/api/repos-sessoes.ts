// As sessões de cada repositório (#104 critério 2): ativas, quantas precisam de você e quantas
// tiveram atividade no mês. Tudo sai das sessões do próprio núcleo, pela mesma leitura do MCP
// (`LeituraDaFrota`): ativas são as vivas (`active` e `error`); "precisa de você" é o nível
// `precisa` de `atencaoDe` (#140), o grupo `blocking` do MCP, e nada além disso.
//
// O repositório de uma sessão vem do cwd → `git remote get-url origin` → `repoDoRemote`. O git
// nunca roda no caminho do pedido: o cwd ainda desconhecido entra numa fila que roda por trás, em
// série, e quando ela descobre algo novo chama `aoDescobrir` (o serviço registra a mudança no
// cursor e a tela relê). O remote de cada cwd vale por `remoteMs`.

import { diaDe } from '../custo/agregacao.ts';
import type { LeituraDaFrota } from '../mcp/frota.ts';
import type { SessoesDoRepo } from './repos-tipos.ts';
import { gitDoSistema, repoDoRemote, type Git } from './trabalho.ts';

/** Chave dos mapas: `dono/repo` em minúsculas (o GitHub não diferencia caixa). */
export const chaveDoRepo = (completo: string): string => completo.toLowerCase();

export interface OpcoesDasSessoesPorRepo {
  frota: Pick<LeituraDaFrota, 'vivas' | 'atencao' | 'hoje' | 'storage' | 'fusoHorario' | 'agora'>;
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
    if (this.cache && this.frota.agora() - this.cache.em < this.cacheMs) return this.cache.mapa;
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
    if (!r || this.frota.agora() - r.em >= this.remoteMs) this.enfileirar(cwd);
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
      this.remotes.set(cwd, { repo, em: this.frota.agora() });
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
    for (const s of await this.frota.vivas()) {
      const repo = s.session.cwd ? this.repoDe(s.session.cwd) : null;
      if (!repo) continue;
      const c = de(repo);
      c.active++;
      if (s.inbox.precisaDeVoce && (await this.frota.atencao(s)).grupo === 'blocking') c.needYou++;
    }
    // Do mês corrente, no fuso da máquina: a porta lista da mais recente para a mais antiga.
    const inicioDoMes = `${this.frota.hoje().slice(0, 8)}01`;
    let cursor: string | null = null;
    pagina: do {
      const page = await this.frota.storage.listSessions({ limit: 500, cursor });
      for (const s of page.items) {
        if (diaDe(s.updatedAt, this.frota.fusoHorario) < inicioDoMes) break pagina;
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
    this.cache = { em: this.frota.agora(), mapa };
    return mapa;
  }
}
