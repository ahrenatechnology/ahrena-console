// Repositórios da conta do GitHub (C22, #104) e as métricas de um repositório (C23, #105).
//
// | Rota                                          | Resposta (src/api/repos-types.ts) |
// | --------------------------------------------- | --------------------------------- |
// | `GET /api/repos`                              | `ListaDeRepos`                    |
// | `GET /api/repos/<dono>/<repo>?period=90d`     | `MetricasDoRepo`                  |
//
// `?period=` é `30d`, `90d` (padrão) ou `1y`, e vale para a resposta inteira (#105 critério 6);
// outro valor dá 400. `?refresh=1` é o botão Atualizar: relê o GraphQL ignorando o TTL, com o
// intervalo mínimo de 30 s do cache (decisão 0001). `<dono>` e `<repo>` passam pelo padrão de
// nome do GitHub antes de qualquer coisa; fora dele, 400.
//
// ## Nunca espera o GitHub
//
// Toda resposta é 200 e sai do que já está montado em memória. Se a montagem venceu (60 s) ou não
// existe, ela é disparada por trás e o pedido volta na hora: sem dado ainda, com
// `state: 'loading'`. Cada montagem lê o GitHub pelo `GithubCache` (TTL por chave, ETag no
// REST, dado velho por até 24 h, pausa quando o GitHub limita), o mesmo do trabalho no núcleo, para
// a pausa valer para os dois. Todas as chamadas à fonte, de qualquer montagem (a lista e as
// métricas de vários repositórios ao mesmo tempo), passam por uma fila só (`chamar()`), que no
// núcleo deixa até `GITHUB_CALL_LIMIT` (4) chamadas ao mesmo tempo (#341, emenda o item 6 da
// decisão 0001), e cada pedido tem teto de 20 s, para um pedido pendurado não travar a fila (o
// estouro vira `error`). Quando a montagem muda a resposta, o núcleo
// registra no cursor `{ type: 'repos', key: 'list' }` ou `{ type: 'repos', key: '<dono>/<repo>' }`
// em minúsculas (`chaveDoRepo`, seja qual for a caixa da rota), e a tela relê. A descoberta de
// sessões novas num repositório também registra `list`. As métricas guardam em memória no máximo
// `MAXIMO_DE_ENTRADAS` combinações de repositório e período, as menos lidas saem primeiro.
//
// - `state`: `ready`; `loading` (sem dado ainda, ou a montagem parcial: o cabeçalho do repo já
//   veio e os números ainda não); `no-github` (núcleo sem `gh` ou com `--no-github`); `error`
//   (falhou e não há dado anterior); `not-found` (só nas métricas).
// - `error`: o motivo do dado velho, do limite ou da falha (texto da tela); o último dado vem junto.
// - `computing` (métricas): as estatísticas que o GitHub devolveu 202 (`commits`, `frequency`, `lines`, `contributors`). O campo fica `null`, e o
//   núcleo tenta de novo sozinho em 3 s, 6 s, 12 s, 30 s e depois a cada 60 s, enquanto alguém leu
//   a resposta nos últimos 5 min; depois para, e volta no próximo pedido.
// - Uma falha fora do previsto na montagem vai para o `log` e para o `error` da resposta, com
//   `state: 'error'` quando não há dado anterior.
// - Sem escrita no repositório (`canWrite: false`), as chaves `traffic` e `security` não vêm e o
//   núcleo nem chama esses endpoints (#105 critério 5).
//
// ## O que cada número lê
//
// Lista (#341, in three steps, each one published): the last assembled list from the cache at
// start; `ReposLista` (GraphQL, light: up to 500 repos of the account and its orgs, no archived,
// 100 per page); then, handed to the queue together, `ReposCounts` (open counts and the default
// branch's CI by `nodes(ids:)`, 25 per batch), `ReposResumo` (duas buscas de custo 1) e, por
// repositório com push nas últimas 12 semanas (até 30, os mais recentes), o `stats/commit_activity` do REST com ETag. Escolhido no lugar do `history(since:)`
// do GraphQL porque o REST dá as 52 semanas numa chamada que o 304 deixa de graça, e a mesma chave
// do cache serve as métricas do repositório; o GraphQL pediria 12 contagens por repositório. O CI
// de 7 dias do resumo soma os workflow runs concluídos dos repositórios com push nos 7 dias.
// Métricas: `RepoDetalhe` (GraphQL: o repositório e as releases, PRs, issues fechadas e abertas do
// período, e os totais pelo `issueCount`) e o REST listado em src/github/repos-source.ts. As
// sessões vêm do próprio núcleo (repos-sessions.ts).

import { githubReposTransport, type GithubAccess } from './github-access.ts';
import type { ServerResponse } from 'node:http';
import { GithubCache, MemoryCacheStore } from '../github/cache.ts';
import { GithubCallQueue } from '../github/call-queue.ts';
import {
  ciDosRuns,
  commits12,
  commitsDoPeriodo,
  contarRuns,
  contribuidoresDoPeriodo,
  DIA_MS,
  diaIso,
  frequenciaDoPeriodo,
  inicioDoPeriodo,
  issuesDoPeriodo,
  linguagensDe,
  linhasDe,
  montarLista,
  prsDoPeriodo,
  releasesDoPeriodo,
  repoDoDetalhe,
  rowCounts,
  somarCi,
  temEscrita,
  type ContribuidorCru,
  type RowCounts,
  type RunsCrus,
  type SemanaDeCodigo,
  type SemanaDeCommits,
} from '../github/repos-calculo.ts';
import {
  GithubReposSource,
  incompleteListMessage,
  LIST_COUNTS_BATCH,
  NOME_DO_DONO,
  NOME_DO_REPO,
  SemGithubError,
  type DetalheCru,
  type FonteDosRepos,
  type ListaCrua,
  type ResumoCru,
} from '../github/repos-source.ts';
import { send } from '../ingest/hooks/receiver.ts';
import type { ChangeCursor } from '../changes/cursor.ts';
import type { FleetReader } from '../mcp/fleet.ts';
import { createFakeGithub, DEMO_GITHUB_DATA, demoGit, DEMO_EXTRA_SESSIONS, FAKE_GITHUB_BASE } from '../simulator/fake-github.ts';
import { chaveDoRepo, SessoesPorRepo } from './repos-sessions.ts';
import { PERIODO_PADRAO, PERIODOS, type ComputedStat, type ListaDeRepos, type MetricasDoRepo, type Periodo, type SessoesDoRepo } from './repos-types.ts';

export * from './repos-types.ts';
export { NOME_DO_DONO, NOME_DO_REPO };

/** TTLs das chaves do cache, além da tabela da decisão 0001. */
export const TTL_DOS_REPOS = {
  lista: 5 * 60_000,
  resumo: 5 * 60_000,
  detalhe: 5 * 60_000,
  /** As estatísticas (`stats/*`) o GitHub recalcula a cada push, mas devagar. */
  estatisticas: 60 * 60_000,
  runs: 10 * 60_000,
  linguagens: 60 * 60_000,
  comunidade: 60 * 60_000,
  trafego: 60 * 60_000,
  alertas: 10 * 60_000,
} as const;

/** Espera entre as tentativas enquanto o GitHub devolve 202; a última se repete. */
export const REPETIR_CALCULANDO_MS = [3_000, 6_000, 12_000, 30_000, 60_000] as const;
/** Depois de tanto tempo sem ninguém ler a resposta, a nova tentativa do 202 para. */
export const REPETIR_ENQUANTO_LIDA_MS = 5 * 60_000;
/** Repositórios lidos um a um na lista (commits das 12 semanas e CI), os de push mais recente. */
export const MAXIMO_POR_REPO = 30;
/** Combinações de repositório e período guardadas em memória; acima disso sai a lida há mais tempo. */
export const MAXIMO_DE_ENTRADAS = 50;

const CALCULANDO = 'o GitHub ainda está calculando (202)';

/**
 * The key of the `repos` change for the list (`/api/changes`); a repository's own change has its
 * `owner/repo` in lower case.
 */
export const LIST_CHANGE_KEY = 'list';

/** Cache keys of the list (#341): the light `ReposLista`, the counts and CI, and the last assembled answer. */
export const LIST_KEY = 'repos:list:light';
export const LIST_COUNTS_KEY = 'repos:list:counts';
export const LIST_VIEW_KEY = 'repos:list:view';

/** A promise that never rejects: its value or its error (for reads started together, awaited one by one). */
const settle = <T>(p: Promise<T>): Promise<{ value: T } | { error: unknown }> => p.then((value) => ({ value }), (error: unknown) => ({ error }));

class CalculandoError extends Error {
  constructor() {
    super(CALCULANDO);
  }
}

interface Entrada<T> {
  valor: T | null;
  em: number;
  rodando: Promise<void> | null;
  forcar: boolean;
  /** Tentativas seguidas com 202. */
  tentativas: number;
  agendado: boolean;
  /** Último pedido que leu a resposta (a nova tentativa do 202 só segue enquanto é recente). */
  lidaEm: number;
}

const entrada = <T>(): Entrada<T> => ({ valor: null, em: -Infinity, rodando: null, forcar: false, tentativas: 0, agendado: false, lidaEm: -Infinity });

const motivo = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface LeituraRest<T> {
  valor: T | null;
  calculando: boolean;
  erro: string | null;
}

export interface OpcoesDosRepos {
  /** `null`: núcleo sem GitHub; as respostas vêm com `state: 'no-github'`. */
  fonte: FonteDosRepos | null;
  cache?: GithubCache;
  sessoes?: SessoesPorRepo | null;
  mudancas?: ChangeCursor | null;
  agora?: () => number;
  /** Validade da resposta montada. Padrão 60 s. */
  validadeMs?: number;
  /** Agenda a nova tentativa depois de um 202 (testes trocam). Padrão `setTimeout` sem prender o processo. */
  agendar?: (fn: () => void, ms: number) => void;
  maximoPorRepo?: number;
  /** Falhas fora do previsto numa montagem (no núcleo, o `log` do cli). Padrão: nada. */
  log?: (mensagem: string) => void;
  /** A fila das chamadas ao GitHub; no núcleo, a mesma das instruções dos agentes. Padrão: uma só deste serviço. */
  queue?: GithubCallQueue;
}

const agendarDoSistema = (fn: () => void, ms: number) => {
  setTimeout(fn, ms).unref?.();
};

export class ReposDoGithub {
  private readonly fonte: FonteDosRepos | null;
  private readonly cache: GithubCache;
  private readonly sessoes: SessoesPorRepo | null;
  private readonly mudancas: ChangeCursor | null;
  private readonly agora: () => number;
  private readonly validadeMs: number;
  private readonly agendar: (fn: () => void, ms: number) => void;
  private readonly maximoPorRepo: number;
  private readonly log: (mensagem: string) => void;
  /** A fila global das chamadas à fonte: cada uma começa quando a anterior terminou. */
  private readonly fila: GithubCallQueue;
  private readonly entradaDaLista = entrada<ListaDeRepos>();
  private readonly entradas = new Map<string, Entrada<MetricasDoRepo>>();
  private semToken: string | null = null;
  /** The first read looked for the list kept in the cache (#341). */
  private snapshotChecked = false;
  /** Chamadas que passaram pelo cache até a fonte (medição e testes). */
  chamadas = { fonte: 0 };

  constructor({ fonte, cache, sessoes = null, mudancas = null, agora = Date.now, validadeMs = 60_000, agendar = agendarDoSistema, maximoPorRepo = MAXIMO_POR_REPO, log = () => {}, queue = new GithubCallQueue() }: OpcoesDosRepos) {
    this.fila = queue;
    this.fonte = fonte;
    this.cache = cache ?? new GithubCache({ store: new MemoryCacheStore(), now: agora });
    this.sessoes = sessoes;
    this.mudancas = mudancas;
    this.agora = agora;
    this.validadeMs = validadeMs;
    this.agendar = agendar;
    this.maximoPorRepo = maximoPorRepo;
    this.log = log;
  }

  /** A lista como está agora; dispara a montagem por trás se venceu. Nunca espera o GitHub. */
  async lista({ atualizar = false } = {}): Promise<ListaDeRepos> {
    const e = this.entradaDaLista;
    if (!this.fonte) return listaVazia('no-github', null);
    e.lidaEm = this.agora();
    if (!e.valor && !this.snapshotChecked) await this.restoreList(e);
    if (atualizar) this.vencer(e);
    this.disparar(e, LIST_CHANGE_KEY, () => this.montarLista(e), (msg) => listaVazia('error', msg));
    const base = e.valor ?? listaVazia('loading', null);
    return this.comSessoesNaLista(base, await this.contagens());
  }

  /**
   * #341: the first read after the core starts shows the last list it assembled (kept in the cache,
   * up to 24 h old like any stale read), and the rebuild runs behind it. A change of GitHub identity
   * empties the cache (#241), so a list read with another credential is never restored.
   */
  private async restoreList(e: Entrada<ListaDeRepos>): Promise<void> {
    this.snapshotChecked = true;
    const hit = await this.cache.peek<ListaDeRepos>(LIST_VIEW_KEY).catch(() => null);
    if (hit && !e.valor && hit.value.state === 'ready') e.valor = hit.value;
  }

  /** As métricas de `dono/nome` no período; mesma regra da lista. */
  async metricas(dono: string, nome: string, periodo: Periodo = PERIODO_PADRAO, { atualizar = false } = {}): Promise<MetricasDoRepo> {
    if (!this.fonte) return metricasVazias('no-github', periodo, null);
    const k = chaveDoRepo(`${dono}/${nome}`);
    const alvo = this.entradaDasMetricas(`${k}\0${periodo}`);
    alvo.lidaEm = this.agora();
    if (atualizar) this.vencer(alvo);
    this.disparar(alvo, k, () => this.montarMetricas(alvo, dono, nome, periodo), (msg) => metricasVazias('error', periodo, msg));
    const base = alvo.valor ?? metricasVazias('loading', periodo, null);
    const sessoes = (await this.contagens())?.get(k);
    return { ...base, tabs: { ...base.tabs, sessions: sessoes?.thisMonth ?? 0 } };
  }

  /** Espera as montagens em andamento e a fila do git (testes e o primeiro desenho). */
  async esperar(): Promise<void> {
    for (;;) {
      const rodando = [this.entradaDaLista, ...this.entradas.values()].map((e) => e.rodando).filter(Boolean);
      if (rodando.length === 0) break;
      await Promise.all(rodando);
    }
    await this.sessoes?.esperar();
  }

  /** A entrada de repositório e período, no fim da fila do LRU; acima do teto sai a lida há mais tempo. */
  private entradaDasMetricas(chave: string): Entrada<MetricasDoRepo> {
    let e = this.entradas.get(chave);
    if (e) this.entradas.delete(chave);
    else e = entrada();
    this.entradas.set(chave, e);
    if (this.entradas.size > MAXIMO_DE_ENTRADAS) {
      // A mais antiga que não está montando; se todas estão, a mais antiga mesmo.
      const [velha] = [...this.entradas].find(([, x]) => !x.rodando) ?? [...this.entradas][0];
      this.entradas.delete(velha);
    }
    return e;
  }

  private vencer<T>(e: Entrada<T>): void {
    if (e.rodando) return;
    e.em = -Infinity;
    e.forcar = true;
  }

  /**
   * Monta por trás, se venceu. Uma falha que a montagem não tratou vai para o `log` e para o `error`
   * da resposta (com o dado anterior, se houver; sem ele, `vazia(motivo)`, com `state: 'error'`).
   */
  private disparar<T extends { state: string; error: string | null }>(e: Entrada<T>, chave: string, montar: () => Promise<void>, vazia: (msg: string) => T): void {
    if (e.rodando || this.agora() - e.em < this.validadeMs) return;
    e.rodando = montar()
      .catch((err: unknown) => {
        const msg = motivo(err);
        this.log(`repos: a montagem de ${chave} falhou: ${msg}`);
        const anterior = e.valor && e.valor.state !== 'loading' ? e.valor : null;
        this.publicar(e, anterior ? { ...anterior, error: msg } : vazia(msg), chave);
      })
      .finally(() => {
        e.em = this.agora();
        e.forcar = false;
        e.rodando = null;
      });
  }

  /**
   * Depois de um 202, tenta de novo com espera curta e crescente; sem 202, zera. Só enquanto alguém
   * leu a resposta nos últimos `REPETIR_ENQUANTO_LIDA_MS`: depois para, e o próximo pedido, que acha
   * a montagem vencida, recomeça do 3 s.
   */
  private repetirSeCalculando<T extends { state: string; error: string | null }>(e: Entrada<T>, calculando: boolean, chave: string, montar: () => Promise<void>, vazia: (msg: string) => T): void {
    const lidaHaPouco = () => this.agora() - e.lidaEm <= REPETIR_ENQUANTO_LIDA_MS;
    if (!calculando || !lidaHaPouco()) {
      e.tentativas = 0;
      return;
    }
    if (e.agendado) return;
    const ms = REPETIR_CALCULANDO_MS[Math.min(e.tentativas, REPETIR_CALCULANDO_MS.length - 1)];
    e.tentativas++;
    e.agendado = true;
    this.agendar(() => {
      e.agendado = false;
      if (!lidaHaPouco()) {
        e.tentativas = 0;
        return;
      }
      e.em = -Infinity;
      this.disparar(e, chave, montar, vazia);
    }, ms);
  }

  private publicar<T>(e: Entrada<T>, valor: T, chave: string): void {
    const antes = e.valor === null ? null : JSON.stringify(e.valor);
    e.valor = valor;
    if (antes !== JSON.stringify(valor)) this.mudancas?.record({ type: 'repos', key: chave, sessionId: null, accountId: null });
  }

  private async contagens(): Promise<Map<string, SessoesDoRepo> | null> {
    return this.sessoes ? this.sessoes.ler().catch(() => null) : null;
  }

  private comSessoesNaLista(base: ListaDeRepos, contagens: Map<string, SessoesDoRepo> | null): ListaDeRepos {
    if (!contagens) return base;
    let comSessoes = 0;
    const grupos = base.groups.map((g) => ({
      ...g,
      repos: g.repos.map((r) => {
        const s = contagens.get(chaveDoRepo(r.fullName));
        if (s && s.thisMonth + s.active > 0) comSessoes++;
        return s ? { ...r, sessions: { ...s } } : r;
      }),
    }));
    return { ...base, summary: { ...base.summary, withSessionsThisMonth: comSessoes }, groups: grupos };
  }

  /**
   * Uma chamada à fonte, contada e posta na fila global: começa só quando a anterior, de qualquer
   * montagem, terminou (decisão 0001, item 6). O token que falta vira `no-github`.
   */
  private chamar<T>(fn: (fonte: FonteDosRepos) => Promise<T>): Promise<T> {
    this.chamadas.fonte++;
    return this.fila.run(async () => {
      try {
        const v = await fn(this.fonte!);
        this.semToken = null;
        return v;
      } catch (err) {
        if (err instanceof SemGithubError) this.semToken = err.message;
        throw err;
      }
    });
  }

  private async graphql<T>(chave: string, ttl: number, forcar: boolean, fn: (fonte: FonteDosRepos) => Promise<T>) {
    return this.cache.get<T>(chave, ttl, async () => ({ value: await this.chamar(fn) }), { force: forcar });
  }

  private async rest<T>(chave: string, ttl: number, caminho: string): Promise<LeituraRest<T>> {
    try {
      const r = await this.cache.get<T | null>(chave, ttl, async ({ etag }) => {
        const resp = await this.chamar((f) => f.rest<T>(caminho, etag));
        if (resp.estado === 'calculando') throw new CalculandoError();
        if (resp.estado === 'nao-modificado') return { notModified: true };
        if (resp.estado === 'indisponivel') return { value: null, etag: null };
        return { value: resp.valor, etag: resp.etag };
      });
      return { valor: r.value, calculando: false, erro: r.stale && r.staleReason !== CALCULANDO ? r.staleReason : null };
    } catch (err) {
      const msg = motivo(err);
      if (msg.includes(CALCULANDO)) return { valor: null, calculando: true, erro: null };
      return { valor: null, calculando: false, erro: msg };
    }
  }

  private estadoDaFalha(): 'no-github' | 'error' {
    return this.semToken ? 'no-github' : 'error';
  }

  // ---- Lista (#104) ----

  private async montarLista(e: Entrada<ListaDeRepos>): Promise<void> {
    const agora = this.agora();
    const epoch = this.cache.epoch;
    let crua: { value: ListaCrua; fetchedAt: number; stale: boolean; staleReason: string | null };
    try {
      // A cut list never replaces a longer one already shown: it fails, and the cache keeps serving
      // the old one with the reason (#269).
      const shown = e.valor?.summary.repositories ?? 0;
      crua = await this.graphql(LIST_KEY, TTL_DOS_REPOS.lista, e.forcar, async (f) => {
        const list = await f.lista();
        if (list.incomplete && list.repos.length < shown) throw new Error(incompleteListMessage(list.incomplete));
        return list;
      });
    } catch (err) {
      const msg = this.semToken ?? motivo(err);
      this.publicar(e, e.valor ? { ...e.valor, error: msg } : listaVazia(this.estadoDaFalha(), msg), LIST_CHANGE_KEY);
      return;
    }
    const erros: string[] = crua.stale && crua.staleReason ? [crua.staleReason] : [];
    // A list cut by a page that failed says so first: how many came and why the rest did not.
    const missing = crua.value.incomplete;
    if (missing) erros.unshift(incompleteListMessage(missing));
    const rowsBefore = (e.valor?.groups ?? []).flatMap((g) => g.repos);
    const commitsAntes = new Map(rowsBefore.map((r) => [r.fullName, r.commits12] as const));
    const counts = new Map<string, RowCounts>(rowsBefore.map((r) => [r.fullName, { openIssues: r.openIssues, openPrs: r.openPrs, ci: r.ci }]));
    const ciAntes = e.valor?.summary.ci ?? { greenRate: null, runs: 0 };
    const montar = (resumo: ResumoCru | null, commits: ReadonlyMap<string, number[]>, ci: { greenRate: number | null; runs: number }): ListaDeRepos => ({
      state: 'ready',
      updatedAt: new Date(crua.fetchedAt).toISOString(),
      error: erros[0] ?? null,
      ...montarLista(crua.value, resumo, commits, ci, counts),
    });
    const publish = async (valor: ListaDeRepos) => {
      this.publicar(e, valor, LIST_CHANGE_KEY);
      // The next core start shows it at once (#341), unless the GitHub identity changed meanwhile.
      if (this.cache.epoch === epoch) await this.cache.put(LIST_VIEW_KEY, valor);
    };
    // Primeira etapa: os repositórios já aparecem, com o que se sabia antes de cada um.
    if (!e.valor) await publish(montar(null, commitsAntes, ciAntes));

    // #341: the counts, the summary and the per-repository REST reads start together; the queue
    // caps how many run at once, and the count batches are first in it.
    const countsRead = settle(this.listCounts(crua.value, e.forcar));
    const summaryRead = settle(this.graphql('repos:summary', TTL_DOS_REPOS.resumo, e.forcar, (f) => f.resumo(crua.value.login, crua.value.organizacoes, diaIso(agora - 7 * DIA_MS))));
    const recentes = [...crua.value.repos]
      .filter((r) => r.pushedAt && agora - Date.parse(r.pushedAt) < 12 * 7 * DIA_MS)
      .sort((a, b) => Date.parse(b.pushedAt!) - Date.parse(a.pushedAt!))
      .slice(0, this.maximoPorRepo);
    const desde7 = diaIso(agora - 7 * DIA_MS);
    const perRepo = Promise.all(
      recentes.map((r) => {
        const k = chaveDoRepo(r.nameWithOwner);
        return Promise.all([
          this.rest<SemanaDeCommits[]>(`repos:rest:${k}:commit_activity`, TTL_DOS_REPOS.estatisticas, `/repos/${r.nameWithOwner}/stats/commit_activity`),
          agora - Date.parse(r.pushedAt!) < 7 * DIA_MS ? this.rest<RunsCrus>(`repos:rest:${k}:runs7`, TTL_DOS_REPOS.runs, caminhoDosRuns(r.nameWithOwner, desde7)) : null,
        ]);
      }),
    );

    let resumo: ResumoCru | null = e.valor ? { esperandoReview: e.valor.summary.prsAwaitingReview, fechadasNaSemana: e.valor.summary.issuesClosedThisWeek } : null;
    const summary = await summaryRead;
    if ('error' in summary) erros.push(motivo(summary.error));
    else {
      resumo = summary.value.value;
      if (summary.value.stale && summary.value.staleReason) erros.push(summary.value.staleReason);
    }
    const read = await countsRead;
    if ('error' in read) erros.push(motivo(read.error));
    else {
      for (const [name, c] of Object.entries(read.value.value)) counts.set(name, c);
      if (read.value.stale && read.value.staleReason) erros.push(read.value.staleReason);
    }
    // Segunda etapa: as contagens e o CI de cada linha, antes das leituras por repositório.
    await publish(montar(resumo, commitsAntes, ciAntes));

    const commits = new Map(commitsAntes);
    const partesDoCi: ReturnType<typeof contarRuns>[] = [];
    let calculando = false;
    const lidos = await perRepo;
    recentes.forEach((r, i) => {
      const [atividade, runs] = lidos[i];
      if (atividade.calculando) calculando = true;
      else commits.set(r.nameWithOwner, commits12(atividade.valor));
      if (atividade.erro) erros.push(atividade.erro);
      if (runs?.valor) partesDoCi.push(contarRuns(runs.valor));
      if (runs?.erro) erros.push(runs.erro);
    });
    await publish(montar(resumo, commits, somarCi(partesDoCi)));
    this.repetirSeCalculando(e, calculando, LIST_CHANGE_KEY, () => this.montarLista(e), (msg) => listaVazia('error', msg));
  }

  /**
   * #341: the open counts and CI of every listed repository, by `nameWithOwner`: `LIST_COUNTS_BATCH`
   * per call, all the batches handed to the queue at once.
   */
  private listCounts(list: ListaCrua, force: boolean) {
    return this.cache.get<Record<string, RowCounts>>(
      LIST_COUNTS_KEY,
      TTL_DOS_REPOS.lista,
      async () => {
        const names = new Map(list.repos.map((r) => [r.id, r.nameWithOwner]));
        const ids = [...names.keys()];
        const batches = Array.from({ length: Math.ceil(ids.length / LIST_COUNTS_BATCH) }, (_, i) => ids.slice(i * LIST_COUNTS_BATCH, (i + 1) * LIST_COUNTS_BATCH));
        const read = await Promise.all(batches.map((b) => this.chamar((f) => f.counts(b))));
        const value: Record<string, RowCounts> = {};
        for (const c of read.flat()) {
          const name = names.get(c.id);
          if (name) value[name] = rowCounts(c);
        }
        return { value };
      },
      { force },
    );
  }

  // ---- Métricas (#105) ----

  private async montarMetricas(e: Entrada<MetricasDoRepo>, dono: string, nome: string, periodo: Periodo): Promise<void> {
    // A chave da mudança e do cache é a da entrada: `dono/repo` em minúsculas.
    const chave = chaveDoRepo(`${dono}/${nome}`);
    const agora = this.agora();
    const desde = inicioDoPeriodo(periodo, agora);
    let detalhe: { value: DetalheCru | null; fetchedAt: number; stale: boolean; staleReason: string | null };
    try {
      // A cut sample never replaces a longer one already shown, the same as the list.
      const shownPrs = e.valor?.prs?.sample.read ?? 0;
      detalhe = await this.graphql(`repos:detail:${chave}:${periodo}`, TTL_DOS_REPOS.detalhe, e.forcar, async (f) => {
        const d = await f.detalhe(dono, nome, diaIso(desde));
        if (d?.incomplete && d.prs.length < shownPrs) throw new Error(d.incomplete.join('; '));
        return d;
      });
    } catch (err) {
      const msg = this.semToken ?? motivo(err);
      this.publicar(e, e.valor ? { ...e.valor, error: msg } : metricasVazias(this.estadoDaFalha(), periodo, msg), chave);
      return;
    }
    const d = detalhe.value;
    if (!d) {
      this.publicar(e, metricasVazias('not-found', periodo, null), chave);
      return;
    }
    const completo = d.repo.nameWithOwner;
    const k = chaveDoRepo(completo);
    const escrita = temEscrita(d.repo.viewerPermission);
    // A sample page that failed comes first: it says which part of these numbers is missing.
    const erros: string[] = [...(d.incomplete ?? []), ...(detalhe.stale && detalhe.staleReason ? [detalhe.staleReason] : [])];
    const base: MetricasDoRepo = {
      ...metricasVazias('ready', periodo, null),
      updatedAt: new Date(detalhe.fetchedAt).toISOString(),
      repo: repoDoDetalhe(d.repo),
      tabs: { issues: d.repo.issues.totalCount, prs: d.repo.pullRequests.totalCount, sessions: 0 },
      issues: issuesDoPeriodo(d.fechadas, d.abertas, d.contagens),
      prs: prsDoPeriodo(d.prs, d.repo.pullRequests.totalCount, desde, d.contagens),
      releases: releasesDoPeriodo(d.repo, desde),
      releasesTotal: d.repo.releases.totalCount,
      canWrite: escrita,
    };
    // Primeira etapa: o cabeçalho e o que veio do GraphQL; o REST vem em seguida.
    if (!e.valor) this.publicar(e, { ...base, state: 'loading' }, chave);

    const calculando: ComputedStat[] = [];
    const ler = async <T>(sufixo: string, ttl: number, caminho: string, nomes: ComputedStat[] = []): Promise<T | null> => {
      const r = await this.rest<T>(`repos:rest:${k}:${sufixo}`, ttl, caminho);
      if (r.calculando) calculando.push(...nomes);
      if (r.erro) erros.push(r.erro);
      return r.valor;
    };
    const atividade = await ler<SemanaDeCommits[]>('commit_activity', TTL_DOS_REPOS.estatisticas, `/repos/${completo}/stats/commit_activity`, ['commits']);
    const frequencia = await ler<SemanaDeCodigo[]>('code_frequency', TTL_DOS_REPOS.estatisticas, `/repos/${completo}/stats/code_frequency`, ['frequency', 'lines']);
    const contribuidores = await ler<ContribuidorCru[]>('contributors', TTL_DOS_REPOS.estatisticas, `/repos/${completo}/stats/contributors`, ['contributors']);
    const linguagens = await ler<Record<string, number>>('languages', TTL_DOS_REPOS.linguagens, `/repos/${completo}/languages`);
    const comunidade = await ler<{ health_percentage?: number }>('community', TTL_DOS_REPOS.comunidade, `/repos/${completo}/community/profile`);
    const runs = await ler<RunsCrus>(`runs:${periodo}`, TTL_DOS_REPOS.runs, caminhoDosRuns(completo, diaIso(desde)));

    const resultado: MetricasDoRepo = {
      ...base,
      error: erros[0] ?? null,
      computing: calculando,
      lines: Array.isArray(frequencia) ? linhasDe(frequencia, desde) : null,
      commits: Array.isArray(atividade) ? commitsDoPeriodo(atividade, desde) : null,
      frequency: Array.isArray(frequencia) ? frequenciaDoPeriodo(frequencia, desde) : null,
      contributors: Array.isArray(contribuidores) ? contribuidoresDoPeriodo(contribuidores, desde).slice(0, 100) : null,
      languages: linguagens ? linguagensDe(linguagens) : null,
      community: typeof comunidade?.health_percentage === 'number' ? comunidade.health_percentage : null,
      ci: runs ? ciDosRuns(runs) : null,
    };
    // Tráfego e alertas só com escrita: sem ela, nem a chamada sai (#105 critério 5).
    if (escrita) {
      const visitas = await ler<{ count: number; uniques: number }>('traffic_views', TTL_DOS_REPOS.trafego, `/repos/${completo}/traffic/views`);
      const clones = await ler<{ count: number; uniques: number }>('traffic_clones', TTL_DOS_REPOS.trafego, `/repos/${completo}/traffic/clones`);
      const origens = await ler<{ referrer: string; count: number }[]>('traffic_referrers', TTL_DOS_REPOS.trafego, `/repos/${completo}/traffic/popular/referrers`);
      const dependabot = await ler<unknown[]>('dependabot', TTL_DOS_REPOS.alertas, `/repos/${completo}/dependabot/alerts?state=open&per_page=100`);
      const codeScanning = await ler<unknown[]>('code_scanning', TTL_DOS_REPOS.alertas, `/repos/${completo}/code-scanning/alerts?state=open&per_page=100`);
      resultado.traffic = {
        views: visitas?.count ?? 0,
        uniques: visitas?.uniques ?? 0,
        clones: clones?.count ?? 0,
        referrers: (origens ?? []).map((o) => o.referrer),
        days: 14,
      };
      resultado.security = { dependabot: Array.isArray(dependabot) ? dependabot.length : null, codeScanning: Array.isArray(codeScanning) ? codeScanning.length : null };
    }
    resultado.error = erros[0] ?? null;
    this.publicar(e, resultado, chave);
    this.repetirSeCalculando(e, calculando.length > 0, chave, () => this.montarMetricas(e, dono, nome, periodo), (msg) => metricasVazias('error', periodo, msg));
  }
}

/** Runs concluídos desde o dia, 100 mais recentes (a amostra da taxa e da duração). */
export const caminhoDosRuns = (completo: string, desde: string) =>
  `/repos/${completo}/actions/runs?created=%3E%3D${desde}&status=completed&per_page=100&exclude_pull_requests=true`;

export function listaVazia(estado: ListaDeRepos['state'], erro: string | null): ListaDeRepos {
  return {
    state: estado,
    updatedAt: null,
    error: erro,
    account: null,
    summary: { organizations: 0, repositories: 0, withSessionsThisMonth: 0, openPrs: 0, prsAwaitingReview: 0, openIssues: 0, issuesClosedThisWeek: 0, ci: { greenRate: null, runs: 0, days: 7 } },
    groups: [],
  };
}

export function metricasVazias(estado: MetricasDoRepo['state'], periodo: Periodo, erro: string | null): MetricasDoRepo {
  return {
    state: estado,
    updatedAt: null,
    error: erro,
    computing: [],
    period: periodo,
    repo: null,
    tabs: { issues: 0, prs: 0, sessions: 0 },
    lines: null,
    commits: null,
    frequency: null,
    issues: null,
    prs: null,
    ci: null,
    languages: null,
    contributors: null,
    releases: null,
    releasesTotal: null,
    community: null,
    canWrite: false,
  };
}

/** A rota de `/api/repos`, registrada no servidor (`ApiOptions.repos`). Responde só a `GET`. */
export type RotaDosRepos = (res: ServerResponse, url: URL) => Promise<void>;

export const REPOS_ROUTE = '/api/repos';

export function criarRotaDosRepos(repos: ReposDoGithub): RotaDosRepos {
  return async (res, url) => {
    const atualizar = url.searchParams.get('refresh') === '1';
    if (url.pathname === REPOS_ROUTE || url.pathname === `${REPOS_ROUTE}/`) return send(res, 200, await repos.lista({ atualizar }));
    const m = /^\/api\/repos\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
    if (!m) return send(res, 404, { error: 'não encontrado' });
    let dono: string;
    let nome: string;
    try {
      dono = decodeURIComponent(m[1]);
      nome = decodeURIComponent(m[2]);
    } catch {
      return send(res, 400, { error: 'repositório inválido' });
    }
    if (!NOME_DO_DONO.test(dono) || !NOME_DO_REPO.test(nome)) return send(res, 400, { error: 'repositório inválido: use <dono>/<repo> com o nome do GitHub' });
    const periodo = url.searchParams.get('period') ?? PERIODO_PADRAO;
    if (!(PERIODOS as readonly string[]).includes(periodo)) return send(res, 400, { error: `period: um de ${PERIODOS.join(', ')}` });
    send(res, 200, await repos.metricas(dono, nome, periodo as Periodo, { atualizar }));
  };
}

export interface OpcoesDosReposDoNucleo {
  /** Demonstração: o GitHub falso (src/simulator/fake-github.ts), nunca a API real. */
  demo: boolean;
  /** `--no-github`: as respostas vêm com `state: 'no-github'`. */
  semGithub: boolean;
  /**
   * O cache do GitHub do núcleo (no cli, o mesmo `GithubCache` do trabalho, sobre o banco): uma
   * instância só, para a pausa por limite valer para as duas leituras.
   */
  cache: GithubCache;
  frota: FleetReader;
  mudancas: ChangeCursor;
  /** As falhas fora do previsto das montagens. */
  log?: (mensagem: string) => void;
  /** A fila das chamadas ao GitHub, dividida com as instruções dos agentes. */
  queue?: GithubCallQueue;
  /** The credential provider and transport (#241). Required outside the demo and `--no-github`; the demo takes only its token. */
  github?: GithubAccess | null;
}

/** Monta o serviço e a rota como o núcleo usa (cli.ts): a credencial do provedor (#241), cache no banco, sessões do núcleo. */
export function criarReposDoNucleo({ demo, semGithub, cache, frota, mudancas, log, queue, github, sessions }: OpcoesDosReposDoNucleo & { sessions?: SessoesPorRepo }): { repos: ReposDoGithub; rota: RotaDosRepos; sessions: SessoesPorRepo } {
  // A demo aponta para um endereço que não resolve: mesmo que o falso falhasse, nada sai para o GitHub.
  const fonte = githubReposTransport({
    demo,
    noGithub: semGithub,
    github,
    demoFetch: () => createFakeGithub(DEMO_GITHUB_DATA, { delayMs: 120 }).fetch,
    demoBase: FAKE_GITHUB_BASE,
  });
  const sessoes = sessions ?? new SessoesPorRepo({
    frota,
    aoDescobrir: () => mudancas.record({ type: 'repos', key: LIST_CHANGE_KEY, sessionId: null, accountId: null }),
    ...(demo ? { git: demoGit(), extras: DEMO_EXTRA_SESSIONS } : {}),
  });
  const repos = new ReposDoGithub({ fonte, cache, sessoes, mudancas, log, ...(queue ? { queue } : {}) });
  // `sessions` is also the Delivery tab's session → repository (#266, src/api/delivery-github.ts).
  return { repos, rota: criarRotaDosRepos(repos), sessions: sessoes };
}
