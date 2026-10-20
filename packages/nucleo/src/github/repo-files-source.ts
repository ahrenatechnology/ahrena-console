// Fonte dos arquivos de texto de um repositório (#183; a mesma descoberta serve às ADRs, #174), pela
// decisão 0001 e pelo estudo docs/repo-instructions-install-adrs-study.md:
//
// | Leitura                | Como                                                                       | Custo |
// | ---------------------- | -------------------------------------------------------------------------- | ----: |
// | RepoFilesDiscovery     | GraphQL: até 20 repositórios por consulta (`r<i>`), cada um com o commit do HEAD e, um apelido por caminho, `CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`, `.mcp.json`, `.claude/` em 3 níveis e as 23 pastas de decisão (14 de ADR e 9 de PDR, #174) (`object(expression: "HEAD:…")`) | 1 por lote |
// | Árvore                 | REST `git/trees/HEAD?recursive=1`, com `If-None-Match` (o 304 não gasta o limite primário) | 1 requisição |
// | RepoBlobs              | GraphQL: até 50 arquivos por consulta, por `oid` ou por `<commit>:<caminho>` | 1 por lote |
//
// Só lê: nenhuma escrita no GitHub sai daqui. O token fica no adaptador (repos-source.ts) e nunca
// aparece no que esta fonte devolve, nem nos erros.

import { isInstructionFile } from '../agent-instructions/imports.ts';
import { DECISION_DIRS, isDecisionFile } from '../adrs/parse.ts';
import { GraphqlResponseError } from './github-source.ts';
import type { RespostaRest } from './repos-source.ts';

/** Até quantos arquivos cabem numa consulta de conteúdo. */
export const BLOB_BATCH = 50;
/** Até quantos repositórios cabem numa consulta de descoberta: 1 ponto por lote (estudo, "Custo no GitHub"). */
export const DISCOVERY_BATCH = 20;
/** Até quantos caminhos da árvore a leitura guarda (os que interessam, não a árvore inteira). */
export const MAX_TREE_PATHS = 5_000;

/** O transporte do GitHub: o `GithubReposSource` (token do `gh`, teto por pedido) ou um falso. */
export interface GithubTransport {
  query<T>(operation: string, query: string, variables: Record<string, unknown>): Promise<T>;
  rest<T>(path: string, etag: string | null): Promise<RespostaRest<T>>;
}

export interface RepoFileEntry {
  path: string;
  oid: string;
}

export interface RepoFilesDiscovery {
  /** O nome como o GitHub escreve: `dono/repo`. */
  nameWithOwner: string;
  /** O commit do HEAD; `null` em repositório sem commit. */
  commit: string | null;
  /** O `oid` da árvore do commit. */
  tree: string | null;
  /** Os arquivos achados na raiz e em `.claude/` (até 3 níveis). */
  files: RepoFileEntry[];
  /**
   * Os registros de decisão (#174): os `.md` das pastas de ADR e de PDR (`DECISION_DIRS`), só o primeiro
   * nível, sem índice nem modelo, na ordem das pastas. Ausente num valor guardado antes do #174.
   */
  decisions?: RepoFileEntry[];
  /** As pastas de decisão que existem no repositório, na ordem de busca. */
  decisionFolders?: string[];
}

/** O que a árvore recursiva traz e a leitura guarda: só os caminhos que interessam. */
export interface RepoTreeSummary {
  /** O `oid` da árvore lida; `null` quando o GitHub não tem árvore (repositório vazio). */
  sha: string | null;
  /** O GitHub cortou a lista (acima de 100 mil arquivos, ou 7 MB). */
  truncated: boolean;
  files: RepoFileEntry[];
}

export interface RepoBlob {
  oid: string;
  /** O texto; `''` em arquivo binário. */
  text: string;
  bytes: number;
  /**
   * O texto é o arquivo inteiro: nem binário, nem cortado pelo GitHub (`isTruncated`), e com o
   * tamanho do `byteSize`. Quem reescreve o arquivo (a instalação, #184) só confia nele assim.
   */
  complete: boolean;
}

export type BlobRequest = { oid: string } | { commit: string; path: string };

const RATE = 'rateLimit { cost remaining resetAt }';
const BLOB = '... on Blob { oid }';
const ENTRY = 'name type oid';

/** O que a descoberta pede de cada repositório, sob o apelido `r<i>`; nenhum nome do repositório vai no texto. */
function discoveryFields(i: number): string {
  const dirs = DECISION_DIRS.map((d, k) => `dir${k}: object(expression: "HEAD:${d}") { ... on Tree { entries { ${ENTRY} } } }`).join('\n    ');
  return `r${i}: repository(owner: $o${i}, name: $n${i}) { nameWithOwner
    head: object(expression: "HEAD") { oid ... on Commit { tree { oid } } }
    claudeMd: object(expression: "HEAD:CLAUDE.md") { ${BLOB} }
    agentsMd: object(expression: "HEAD:AGENTS.md") { ${BLOB} }
    dotClaudeMd: object(expression: "HEAD:.claude/CLAUDE.md") { ${BLOB} }
    mcpJson: object(expression: "HEAD:.mcp.json") { ${BLOB} }
    claudeDir: object(expression: "HEAD:.claude") { ... on Tree { entries { ${ENTRY} object { ... on Tree { entries { ${ENTRY} object { ... on Tree { entries { ${ENTRY} } } } } } } } } }
    ${dirs} }`;
}

/**
 * A descoberta comum de até `DISCOVERY_BATCH` repositórios numa consulta (#183 e #174): `object` não é
 * conexão paginada, então o custo fica em 1 ponto; cresce só o tempo de servidor. Dono e nome vão
 * como variáveis (`$o<i>`, `$n<i>`).
 */
export function discoveryQuery(repos: readonly { owner: string; name: string }[]): { query: string; variables: Record<string, string> } {
  if (repos.length < 1 || repos.length > DISCOVERY_BATCH) throw new Error(`descoberta: de 1 a ${DISCOVERY_BATCH} repositórios por consulta`);
  const vars: string[] = [];
  const variables: Record<string, string> = {};
  repos.forEach((r, i) => {
    vars.push(`$o${i}: String!`, `$n${i}: String!`);
    variables[`o${i}`] = r.owner;
    variables[`n${i}`] = r.name;
  });
  return { query: `query RepoFilesDiscovery(${vars.join(', ')}) { ${RATE}\n  ${repos.map((_r, i) => discoveryFields(i)).join('\n  ')} }`, variables };
}

/** A consulta de um lote: `b<i>` por `object(oid:)` ou `object(expression:)`, com variáveis (nada do repositório vai no texto da consulta). */
export function blobsQuery(requests: readonly BlobRequest[]): { query: string; variables: Record<string, string> } {
  const vars: string[] = ['$owner: String!', '$name: String!'];
  const fields: string[] = [];
  const variables: Record<string, string> = {};
  requests.forEach((r, i) => {
    if ('oid' in r) {
      vars.push(`$o${i}: GitObjectID!`);
      variables[`o${i}`] = r.oid;
      fields.push(`b${i}: object(oid: $o${i}) { ... on Blob { oid byteSize isBinary isTruncated text } }`);
    } else {
      vars.push(`$e${i}: String!`);
      variables[`e${i}`] = `${r.commit}:${r.path}`;
      fields.push(`b${i}: object(expression: $e${i}) { ... on Blob { oid byteSize isBinary isTruncated text } }`);
    }
  });
  return { query: `query RepoBlobs(${vars.join(', ')}) { ${RATE}\n  repository(owner: $owner, name: $name) {\n    ${fields.join('\n    ')} } }`, variables };
}

/**
 * Os caminhos da árvore que a leitura guarda: arquivos de instrução de qualquer pasta, `.claude/`,
 * `.mcp.json` e os outros `.md`, alvos prováveis de `@import`: com eles, um import achado vem do
 * cache pelo `oid`, e um que não existe se sabe sem pedir nada ao GitHub.
 */
export function isInterestingPath(path: string): boolean {
  return isInstructionFile(path) || path.startsWith('.claude/') || path === '.mcp.json' || path.endsWith('.md');
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

interface RawEntry {
  name: string;
  type: string;
  oid: string;
  object?: { entries?: RawEntry[] } | null;
}

type RawRepository = {
  nameWithOwner: string;
  head: { oid: string; tree?: { oid: string } } | null;
  claudeMd: { oid?: string } | null;
  agentsMd: { oid?: string } | null;
  dotClaudeMd: { oid?: string } | null;
  mcpJson: { oid?: string } | null;
  claudeDir: { entries?: RawEntry[] } | null;
} & Record<string, unknown>;

interface RawTree {
  sha?: string;
  truncated?: boolean;
  tree?: { path: string; type: string; sha: string }[];
}

type RawBlob = { oid?: string; byteSize?: number; isBinary?: boolean; isTruncated?: boolean; text?: string | null } | null;

export class RepoFilesSource {
  private readonly transport: GithubTransport;

  constructor(transport: GithubTransport) {
    this.transport = transport;
  }

  /** O commit, a raiz, `.claude/` e as pastas de decisão; `null` quando o repositório não existe ou não é visível. */
  async discover(owner: string, name: string): Promise<RepoFilesDiscovery | null> {
    const [d] = await this.discoverMany([{ owner, name }]);
    return d;
  }

  /**
   * A descoberta de vários repositórios, em lotes de até `DISCOVERY_BATCH`, em série: um resultado por
   * repositório pedido, na mesma ordem (`null` onde ele não existe ou não é visível).
   */
  async discoverMany(repos: readonly { owner: string; name: string }[]): Promise<(RepoFilesDiscovery | null)[]> {
    const out: (RepoFilesDiscovery | null)[] = [];
    for (let i = 0; i < repos.length; i += DISCOVERY_BATCH) {
      const batch = repos.slice(i, i + DISCOVERY_BATCH);
      const { query, variables } = discoveryQuery(batch);
      const data = await this.transport.query<Record<string, RawRepository | null>>('RepoFilesDiscovery', query, variables);
      batch.forEach((_r, j) => out.push(readDiscovery(data?.[`r${j}`] ?? null)));
    }
    return out;
  }

  /**
   * A descoberta repositório a repositório, para quem lê muitos de uma vez (as ADRs, #174): um erro num
   * repositório (FORBIDDEN de uma organização com SAML, tempo de servidor numa árvore enorme) não leva
   * os outros do lote. Só uma resposta com `errors` do GraphQL (`GraphqlResponseError`) divide o lote ao
   * meio e tenta de novo, até sobrar o repositório do erro, que volta como `{ error }`. Uma falha do
   * transporte (HTTP 5xx, rede, teto de tempo), o limite, o escopo e a falta de token valem para o lote
   * inteiro: sobem, sem nova chamada.
   */
  async discoverEach(repos: readonly { owner: string; name: string }[]): Promise<({ value: RepoFilesDiscovery | null } | { error: string })[]> {
    const out: ({ value: RepoFilesDiscovery | null } | { error: string })[] = [];
    const run = async (batch: readonly { owner: string; name: string }[]): Promise<void> => {
      try {
        for (const value of await this.discoverMany(batch)) out.push({ value });
      } catch (err) {
        if (!(err instanceof GraphqlResponseError)) throw err;
        if (batch.length === 1) return void out.push({ error: err instanceof Error ? err.message : String(err) });
        const half = Math.ceil(batch.length / 2);
        await run(batch.slice(0, half));
        await run(batch.slice(half));
      }
    };
    for (let i = 0; i < repos.length; i += DISCOVERY_BATCH) await run(repos.slice(i, i + DISCOVERY_BATCH));
    return out;
  }

  /**
   * A árvore recursiva do HEAD, com ETag. Do que vem, fica só o que interessa (`keep`; padrão
   * `isInterestingPath`, a leitura das instruções; a instalação do framework, #184, passa a dela):
   * a árvore inteira pode ter 13 MB. 404 e 409 (repositório vazio) viram árvore vazia.
   */
  async tree(owner: string, name: string, etag: string | null, keep: (path: string) => boolean = isInterestingPath): Promise<{ state: 'ok'; value: RepoTreeSummary; etag: string | null } | { state: 'not-modified' }> {
    const r = await this.transport.rest<RawTree>(`/repos/${owner}/${name}/git/trees/HEAD?recursive=1`, etag);
    if (r.estado === 'nao-modificado') return { state: 'not-modified' };
    if (r.estado === 'indisponivel' || r.estado === 'calculando') return { state: 'ok', value: { sha: null, truncated: false, files: [] }, etag: null };
    const raw = r.valor ?? {};
    const files = (raw.tree ?? [])
      .filter((e) => e && e.type === 'blob' && typeof e.path === 'string' && OID.test(e.sha) && keep(e.path))
      .slice(0, MAX_TREE_PATHS)
      .map((e) => ({ path: e.path, oid: e.sha }));
    return { state: 'ok', value: { sha: typeof raw.sha === 'string' ? raw.sha : null, truncated: raw.truncated === true, files }, etag: r.etag };
  }

  /** O conteúdo, em lotes de até `BLOB_BATCH`, em série. `null` onde o arquivo não existe (ou não é arquivo). */
  async blobs(owner: string, name: string, requests: readonly BlobRequest[]): Promise<(RepoBlob | null)[]> {
    const out: (RepoBlob | null)[] = [];
    for (let i = 0; i < requests.length; i += BLOB_BATCH) {
      const batch = requests.slice(i, i + BLOB_BATCH);
      for (const r of batch) if ('oid' in r ? !OID.test(r.oid) : !OID.test(r.commit) || !validPath(r.path)) throw new Error('pedido de arquivo inválido');
      const { query, variables } = blobsQuery(batch);
      const data = await this.transport.query<{ repository: Record<string, RawBlob> | null }>('RepoBlobs', query, { owner, name, ...variables });
      batch.forEach((_r, j) => {
        const b = data.repository?.[`b${j}`] ?? null;
        if (!b || typeof b.oid !== 'string') return void out.push(null);
        const text = b.isBinary ? '' : (b.text ?? '');
        const bytes = typeof b.byteSize === 'number' ? b.byteSize : 0;
        out.push({ oid: b.oid, text, bytes, complete: !b.isBinary && b.isTruncated !== true && typeof b.text === 'string' && bytes === Buffer.byteLength(text) });
      });
    }
    return out;
  }
}

/** Um repositório da resposta da descoberta, no formato que as leituras usam. */
function readDiscovery(repo: RawRepository | null): RepoFilesDiscovery | null {
  if (!repo || typeof repo.nameWithOwner !== 'string') return null;
  const files: RepoFileEntry[] = [];
  const add = (path: string, oid: string | undefined) => {
    if (oid && OID.test(oid) && !files.some((f) => f.path === path)) files.push({ path, oid });
  };
  add('CLAUDE.md', repo.claudeMd?.oid);
  add('AGENTS.md', repo.agentsMd?.oid);
  add('.claude/CLAUDE.md', repo.dotClaudeMd?.oid);
  add('.mcp.json', repo.mcpJson?.oid);
  const walk = (entries: RawEntry[] | undefined, prefix: string) => {
    for (const e of entries ?? []) {
      if (e.type === 'blob') add(`${prefix}${e.name}`, e.oid);
      else if (e.type === 'tree') walk(e.object?.entries, `${prefix}${e.name}/`);
    }
  };
  walk(repo.claudeDir?.entries, '.claude/');
  const decisions: RepoFileEntry[] = [];
  const decisionFolders: string[] = [];
  DECISION_DIRS.forEach((dir, k) => {
    const tree = repo[`dir${k}`] as { entries?: RawEntry[] } | null | undefined;
    if (!tree || !Array.isArray(tree.entries)) return;
    decisionFolders.push(dir);
    for (const e of tree.entries) {
      if (e && e.type === 'blob' && typeof e.name === 'string' && isDecisionFile(e.name) && OID.test(e.oid) && validPath(`${dir}/${e.name}`)) decisions.push({ path: `${dir}/${e.name}`, oid: e.oid });
    }
  });
  return { nameWithOwner: repo.nameWithOwner, commit: repo.head?.oid ?? null, tree: repo.head?.tree?.oid ?? null, files, decisions, decisionFolders };
}

/** Um caminho relativo do repositório, sem `..`, sem barra no começo e sem caractere de controle. */
export function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith('/') && !/[\u0000-\u001f]/.test(path) && !path.split('/').some((s) => s === '..' || s === '.' || s === '');
}
