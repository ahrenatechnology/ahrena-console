// O cursor de mudanças do núcleo (item 2.4): uma sequência que avança a cada mudança relevante,
// guardada numa fila curta em memória, e a espera em cima dela (long polling).
//
// - `registrar()` custa O(esperas abertas): não lê o banco e não varre nada.
// - `aguardar()` responde assim que há novidade que passa nos filtros, ou no timeout. Sem polling
//   interno: parado, o núcleo só tem um timer por espera aberta, acordada por `registrar()`.
// - Cada espera responde no mínimo `intervaloMinimoMs` depois de começar (padrão 1 s). Com hooks
//   chegando sem parar, quem faz long polling em laço acorda no máximo uma vez por intervalo, e a
//   rajada sai numa resposta só.
// - O cursor devolvido é o de agora, mesmo com filtros: as mudanças que não passaram ficam para trás e
//   não voltam num pedido seguinte com outros filtros.
// - No máximo `maximoDeEsperas` abertas (padrão 256); acima disso, `ErroDeLotacao`.
// - O cursor é opaco (`<geração>.<seq>`). A geração muda a cada vez que o núcleo sobe; cursor de
//   outra geração, ou mais velho que a fila, volta na hora com `reiniciar: true` (releia tudo).
// - Relógio injetável, para os testes serem determinísticos.

// `repos` (#104, #105): a lista ou as métricas de um repositório mudaram; chave `lista` ou `<dono>/<repo>`
// em minúsculas. Só a rota HTTP o expõe; o `wait_for_changes` do MCP o filtra (mcp.ts).
export const TIPOS_DE_MUDANCA = ['sessao', 'estado', 'precisa-de-voce', 'plano', 'decisao', 'conta', 'repos'] as const;
export type TipoDeMudanca = (typeof TIPOS_DE_MUDANCA)[number];

export interface MudancaRegistrada {
  seq: number;
  tipo: TipoDeMudanca;
  /** O que mudou: o id da sessão, da decisão ou da conta; em `repos`, `lista` ou `<dono>/<repo>`. */
  chave: string;
  /** A sessão a que a mudança pertence; `null` em mudança de conta e de repositórios. */
  sessionId: string | null;
  /** A conta da sessão; `null` é "Sem conta". */
  accountId: string | null;
}

export type NovaMudanca = Omit<MudancaRegistrada, 'seq'>;

export interface FiltrosDeMudanca {
  sessionIds?: readonly string[];
  /** `null` na lista pede as mudanças "Sem conta". */
  accountIds?: readonly (string | null)[];
  tipos?: readonly TipoDeMudanca[];
  /** Filtro de conta por regra (o rótulo da conta no MCP), além de `accountIds`. */
  casaConta?: (accountId: string | null) => boolean;
}

export interface OpcoesDaEspera {
  filtros?: FiltrosDeMudanca;
  /** Padrão `ESPERA_PADRAO_MS`, limitado a `ESPERA_MAXIMA_MS`. 0 responde na hora. */
  timeoutMs?: number;
  /** Abortar responde na hora com o que houver (o cliente HTTP desistiu, o servidor fechou). */
  signal?: AbortSignal;
}

export interface RespostaDaEspera {
  /** Cursor para o próximo pedido: o de agora, que pula também as mudanças que os filtros deixaram de fora. */
  cursor: string;
  /** O que mudou e passa nos filtros, uma vez por (tipo, chave), na ordem da última mudança. */
  mudancas: MudancaRegistrada[];
  /** O cursor não serve (vazio, de outra geração ou velho demais): releia tudo e siga com `cursor`. */
  reiniciar: boolean;
  /** Voltou pelo timeout, sem novidade. */
  expirou: boolean;
}

export interface Relogio {
  agora(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const relogioDoSistema: Relogio = {
  agora: () => performance.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const ESPERA_PADRAO_MS = 25_000;
/** Abaixo dos ~130 s que o app espera por uma resposta de ferramenta (validação V2) e dos 120 s do HTTP. */
export const ESPERA_MAXIMA_MS = 110_000;
export const CAPACIDADE_PADRAO = 1024;
/** Quanto a espera segura depois da primeira novidade, para uma rajada sair numa resposta só. */
export const AGRUPAR_PADRAO_MS = 50;
/** Intervalo mínimo entre o começo de uma espera e a resposta, para o laço de long polling não girar a cada hook. */
export const INTERVALO_MINIMO_PADRAO_MS = 1000;
export const MAXIMO_DE_ESPERAS_PADRAO = 256;
/** Teto de mudanças por resposta; acima disso a resposta pede `reiniciar`. */
export const MAXIMO_POR_RESPOSTA = 200;

export interface OpcoesDoCursor {
  capacidade?: number;
  agruparMs?: number;
  intervaloMinimoMs?: number;
  maximoDeEsperas?: number;
  relogio?: Relogio;
  /** Padrão: aleatória. Fixa nos testes. */
  geracao?: string;
}

/** Esperas abertas demais: a API responde 503. */
export class ErroDeLotacao extends Error {
  constructor(maximo: number) {
    super(`esperas abertas demais (máximo ${maximo})`);
    this.name = 'ErroDeLotacao';
  }
}

interface Espera {
  desde: number;
  /** Hora (do relógio) antes da qual a espera não responde. */
  responderEm: number;
  filtros: FiltrosDeMudanca;
  timer: unknown;
  agrupando: boolean;
  responder(expirou: boolean): void;
}

export class CursorDeMudancas {
  readonly geracao: string;
  private readonly capacidade: number;
  private readonly agruparMs: number;
  private readonly intervaloMinimoMs: number;
  private readonly maximoDeEsperas: number;
  private readonly relogio: Relogio;
  /** Fila circular das últimas `capacidade` mudanças, em ordem de `seq`. */
  private readonly fila: MudancaRegistrada[] = [];
  private seq = 0;
  private readonly esperas = new Set<Espera>();

  constructor(opcoes: OpcoesDoCursor = {}) {
    this.geracao = opcoes.geracao ?? Math.floor(Math.random() * 36 ** 6).toString(36);
    this.capacidade = Math.max(1, opcoes.capacidade ?? CAPACIDADE_PADRAO);
    this.agruparMs = Math.max(0, opcoes.agruparMs ?? AGRUPAR_PADRAO_MS);
    this.intervaloMinimoMs = Math.max(0, opcoes.intervaloMinimoMs ?? INTERVALO_MINIMO_PADRAO_MS);
    this.maximoDeEsperas = Math.max(1, opcoes.maximoDeEsperas ?? MAXIMO_DE_ESPERAS_PADRAO);
    this.relogio = opcoes.relogio ?? relogioDoSistema;
  }

  /** O cursor de agora. */
  get atual(): string {
    return `${this.geracao}.${this.seq}`;
  }

  /** Quantas esperas estão abertas. */
  get abertas(): number {
    return this.esperas.size;
  }

  registrar(nova: NovaMudanca): MudancaRegistrada {
    const mudanca = { ...nova, seq: ++this.seq };
    this.fila.push(mudanca);
    if (this.fila.length > this.capacidade) this.fila.shift();
    for (const espera of [...this.esperas]) {
      if (!espera.agrupando && passa(mudanca, espera.filtros)) this.agendar(espera);
    }
    return mudanca;
  }

  /** A espera tem novidade: responde depois do agrupamento e do intervalo mínimo. */
  private agendar(espera: Espera): void {
    espera.agrupando = true;
    this.relogio.clearTimeout(espera.timer);
    const ms = Math.max(this.agruparMs, espera.responderEm - this.relogio.agora());
    if (ms <= 0) espera.responder(false);
    else espera.timer = this.relogio.setTimeout(() => espera.responder(false), ms);
  }

  /** Rejeita com `ErroDeLotacao` quando já há `maximoDeEsperas` abertas. */
  aguardar(cursor: string | null | undefined, opcoes: OpcoesDaEspera = {}): Promise<RespostaDaEspera> {
    const filtros = opcoes.filtros ?? {};
    const desde = this.seqDe(cursor);
    if (desde === null) return Promise.resolve({ cursor: this.atual, mudancas: [], reiniciar: true, expirou: false });
    const ja = this.ler(desde, filtros);
    const timeoutMs = limitarEspera(opcoes.timeoutMs);
    if (ja.reiniciar || timeoutMs === 0 || opcoes.signal?.aborted) return Promise.resolve(ja);
    if (this.esperas.size >= this.maximoDeEsperas) return Promise.reject(new ErroDeLotacao(this.maximoDeEsperas));

    return new Promise((resolve) => {
      const aoAbortar = () => espera.responder(false);
      const espera: Espera = {
        desde,
        responderEm: this.relogio.agora() + this.intervaloMinimoMs,
        filtros,
        timer: null,
        agrupando: false,
        responder: (expirou) => {
          if (!this.esperas.delete(espera)) return;
          this.relogio.clearTimeout(espera.timer);
          opcoes.signal?.removeEventListener('abort', aoAbortar);
          const r = this.ler(desde, filtros);
          resolve({ ...r, expirou: expirou && r.mudancas.length === 0 && !r.reiniciar });
        },
      };
      this.esperas.add(espera);
      opcoes.signal?.addEventListener('abort', aoAbortar, { once: true });
      if (ja.mudancas.length > 0) this.agendar(espera);
      else espera.timer = this.relogio.setTimeout(() => espera.responder(true), timeoutMs);
    });
  }

  /** Responde todas as esperas abertas com o que houver (ao desligar o núcleo). */
  encerrar(): void {
    for (const espera of [...this.esperas]) espera.responder(false);
  }

  private seqDe(cursor: string | null | undefined): number | null {
    const m = /^([0-9a-z]+)\.(\d{1,15})$/.exec(cursor ?? '');
    if (!m || m[1] !== this.geracao) return null;
    const seq = Number(m[2]);
    return seq <= this.seq ? seq : null;
  }

  private ler(desde: number, filtros: FiltrosDeMudanca): RespostaDaEspera {
    const cursor = this.atual;
    const primeira = this.fila[0]?.seq ?? this.seq + 1;
    // A fila já descartou mudanças que este cursor não viu.
    if (desde < primeira - 1) return { cursor, mudancas: [], reiniciar: true, expirou: false };
    const porChave = new Map<string, MudancaRegistrada>();
    for (let i = this.fila.length - 1; i >= 0 && this.fila[i].seq > desde; i--) {
      const m = this.fila[i];
      if (!passa(m, filtros)) continue;
      const k = `${m.tipo}\0${m.chave}`;
      if (!porChave.has(k)) porChave.set(k, m);
    }
    if (porChave.size > MAXIMO_POR_RESPOSTA) return { cursor, mudancas: [], reiniciar: true, expirou: false };
    const mudancas = [...porChave.values()].sort((a, b) => a.seq - b.seq);
    return { cursor, mudancas, reiniciar: false, expirou: false };
  }
}

export function limitarEspera(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return ESPERA_PADRAO_MS;
  return Math.min(ESPERA_MAXIMA_MS, Math.max(0, Math.floor(timeoutMs)));
}

function passa(m: MudancaRegistrada, f: FiltrosDeMudanca): boolean {
  if (f.tipos && !f.tipos.includes(m.tipo)) return false;
  if (f.sessionIds && (m.sessionId === null || !f.sessionIds.includes(m.sessionId))) return false;
  if (f.accountIds && !f.accountIds.includes(m.accountId)) return false;
  if (f.casaConta && !f.casaConta(m.accountId)) return false;
  return true;
}

/** Atalho do item 2.4: espera no cursor dado. */
export function aguardarMudancas(
  mudancas: CursorDeMudancas,
  cursor: string | null | undefined,
  opcoes: OpcoesDaEspera = {},
): Promise<RespostaDaEspera> {
  return mudancas.aguardar(cursor, opcoes);
}
