// O que toda ferramenta faz igual: ler os argumentos, paginar por tamanho e limpar o texto que
// vem das sessões.
//
// Paginação por tamanho (proposta 0.0.1, feature 9): uma página para no `limit` de itens ou
// quando o JSON dos itens passa de `BYTES_POR_PAGINA`, o que vier primeiro, e devolve
// `nextCursor`. O cursor é opaco para o cliente.
//
// Transcript é conteúdo não confiável (proposta, feature 11; 2.5): as ferramentas não devolvem
// texto de conversa (prompts, respostas, perguntas, comandos). O que sai das sessões é o título,
// curto e sem caractere de controle, e nomes de ferramenta que passam por um padrão estrito.

import { ErroDeArgumento, type Esquema, type Json, type ObjetoJson } from './protocolo.ts';

export const LIMITE_PADRAO = 10;
export const LIMITE_MAXIMO = 50;
/** Teto do JSON dos itens de uma página. Cerca de 3 mil tokens. */
export const BYTES_POR_PAGINA = 12_000;
const TITULO_MAXIMO = 60;

/** Os argumentos comuns no JSON Schema: `account`, `limit`, `cursor`. */
export const ARGS_COMUNS: ObjetoJson = {
  account: {
    description:
      'Filtra por conta do Claude: o rótulo (ex.: "equipe") ou o id, um ou vários; "none" pede as sessões "Sem conta". Sem isto, todas as contas.',
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 20 }],
  },
  limit: { type: 'integer', minimum: 1, maximum: LIMITE_MAXIMO, default: LIMITE_PADRAO, description: 'Itens por página.' },
  cursor: { type: 'string', description: 'O `nextCursor` da página anterior.' },
};

export function esquema(propriedades: ObjetoJson): Esquema {
  return { type: 'object', properties: propriedades, additionalProperties: false };
}

/**
 * Objeto da saída: todos os campos obrigatórios e nenhum a mais. O cliente oficial valida o
 * `structuredContent` contra o `outputSchema`; campo que sai sem estar aqui derruba a chamada.
 */
export function objeto(propriedades: ObjetoJson): Esquema {
  return { ...esquema(propriedades), required: Object.keys(propriedades) };
}

export const lista = (items: Json): ObjetoJson => ({ type: 'array', items });
/** O mesmo esquema, aceitando também `null`. */
export const ouNulo = (e: ObjetoJson): ObjetoJson => ({ anyOf: [e, { type: 'null' }] });
export const T = { texto: { type: 'string' }, inteiro: { type: 'integer', minimum: 0 }, numero: { type: 'number' }, booleano: { type: 'boolean' } } satisfies Record<string, ObjetoJson>;

/** A conta como sai (ferramentas/comum.ts), ou `null` para "Sem conta". */
export const ESQUEMA_DA_CONTA = ouNulo(objeto({ label: T.texto, color: T.texto, source: T.texto }));

export interface Comuns {
  contas: string[] | null;
  limite: number;
  /** Onde a página começa. */
  inicio: number;
}

export function lerComuns(args: ObjetoJson, permitidos: readonly string[]): Comuns {
  for (const k of Object.keys(args)) {
    if (!permitidos.includes(k)) throw new ErroDeArgumento(`argumento desconhecido: ${k}. Use ${permitidos.join(', ')}`);
  }
  return { contas: lerContas(args.account), limite: lerLimite(args.limit), inicio: lerCursor(args.cursor) };
}

function lerContas(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  const lista = typeof v === 'string' ? [v] : Array.isArray(v) ? v : null;
  if (!lista || lista.length === 0 || lista.length > 20 || lista.some((x) => typeof x !== 'string' || !x.trim() || x.length > 200)) {
    throw new ErroDeArgumento('account precisa ser um texto ou uma lista de textos (rótulo, id ou "none")');
  }
  return lista.map((x) => (x as string).trim());
}

function lerLimite(v: unknown): number {
  if (v === undefined || v === null) return LIMITE_PADRAO;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > LIMITE_MAXIMO) throw new ErroDeArgumento(`limit precisa ser inteiro de 1 a ${LIMITE_MAXIMO}`);
  return v as number;
}

function lerCursor(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as { i?: unknown };
      if (Number.isInteger(o?.i) && (o.i as number) >= 0) return o.i as number;
    } catch {
      // cai no erro abaixo
    }
  }
  throw new ErroDeArgumento('cursor inválido: use o nextCursor da página anterior, ou nada para a primeira');
}

const cursorPara = (i: number) => Buffer.from(JSON.stringify({ i })).toString('base64url');

/** Corta a lista numa página: até `limite` itens e até `BYTES_POR_PAGINA` de JSON (ao menos um item). */
export function paginar<T>(itens: readonly T[], { inicio, limite }: Pick<Comuns, 'inicio' | 'limite'>, bytes = BYTES_POR_PAGINA): { pagina: T[]; nextCursor: string | null } {
  const pagina: T[] = [];
  let usados = 0;
  let i = inicio;
  for (; i < itens.length && pagina.length < limite; i++) {
    const n = Buffer.byteLength(JSON.stringify(itens[i]));
    if (pagina.length > 0 && usados + n > bytes) break;
    pagina.push(itens[i]);
    usados += n;
  }
  return { pagina, nextCursor: i < itens.length ? cursorPara(i) : null };
}

/** Título para mostrar: sem controle nem quebra de linha, espaços colapsados, até 60 caracteres. */
export function tituloSeguro(t: string | null | undefined): string | null {
  if (!t) return null;
  // eslint-disable-next-line no-control-regex
  const limpo = t.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  return limpo.length > TITULO_MAXIMO ? `${limpo.slice(0, TITULO_MAXIMO - 1)}…` : limpo;
}

const NOME_DE_FERRAMENTA = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/** Nome de ferramenta (`Bash`, `mcp__x__y`) só se tiver cara de nome; senão nada. */
export function ferramentaSegura(n: string | null | undefined): string | null {
  return n && NOME_DE_FERRAMENTA.test(n) ? n : null;
}

/** "agora", "há 5 min", "há 2 h", "há 3 d". */
export function haQuanto(minutos: number): string {
  if (minutos < 1) return 'agora';
  if (minutos < 60) return `há ${minutos} min`;
  if (minutos < 48 * 60) return `há ${Math.round(minutos / 60)} h`;
  return `há ${Math.round(minutos / 1440)} d`;
}
