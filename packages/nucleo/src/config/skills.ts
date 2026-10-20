// Ler e gravar uma skill (#63, wireframe C17): o único conteúdo que a tela Agent Config abre e o
// único arquivo que ela escreve. As defesas valem para as duas rotas:
//
// - o nome passa em `NOME_DE_SKILL` e não tem `..`: nunca é um caminho;
// - a raiz é um id conhecido, de tipo `home` ou `claude-projeto` (nunca um caminho do pedido);
// - a pasta `skills`, a pasta da skill e o `SKILL.md` que existirem têm o `realpath` dentro do
//   `realpath` da raiz: um symlink para fora é recusado (403), e o `SKILL.md` gravado nunca é
//   symlink;
// - só se escreve um arquivo chamado `SKILL.md`, com no máximo `MAX_CONTEUDO` bytes, pelo caminho
//   atômico (temporário na mesma pasta + `rename`);
// - a skill que existe ganha um backup antes, na pasta de backups do núcleo; a `versao` que veio e
//   não bate com a atual dá 409 sem gravar (alguém editou por fora).
//
// Apagar fica fora (#63): arriscado demais para esta entrega.

import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { ErroDaConfig, type EscopoDaConfig, type RaizDaConfig } from './modelo.ts';

/** Nome de skill gravável: minúsculas, dígitos, `.`, `_` e `-`; até 64; sem `..` (conferido à parte). */
export const NOME_DE_SKILL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** O maior `SKILL.md` aceito, em bytes. */
export const MAX_CONTEUDO = 256 * 1024;

export function pastaPadraoDeBackups(home = homedir()): string {
  return join(home, '.ahrena-console', 'backups');
}

export interface SkillLida {
  raiz: string;
  nome: string;
  escopo: EscopoDaConfig;
  caminho: string;
  conteudo: string;
  /** sha256 do conteúdo, em hex: o que o `POST` manda de volta para provar que leu a última. */
  versao: string;
  editadoEm: number;
}

export interface SkillGravada {
  ok: true;
  caminho: string;
  backup: string | null;
  versao: string;
  editadoEm: number;
}

export interface PedidoDeGravacao {
  raiz: RaizDaConfig;
  nome: unknown;
  conteudo: unknown;
  versao?: unknown;
  /** A pasta de backups (padrão `~/.ahrena-console/backups`). */
  backups: string;
  agora?: () => Date;
}

export const versaoDe = (conteudo: string | Buffer): string => createHash('sha256').update(conteudo).digest('hex');

/** O nome validado, ou 400. */
export function validarNome(nome: unknown): string {
  if (typeof nome !== 'string' || !NOME_DE_SKILL.test(nome) || nome.includes('..')) {
    throw new ErroDaConfig(400, 'nome: minúsculas, dígitos, ".", "_" e "-", até 64, sem ".."');
  }
  return nome;
}

/** A raiz pelo id, entre as conhecidas; só `home` e `claude-projeto` recebem skill. */
export function raizDeSkill(id: unknown, raizes: readonly RaizDaConfig[]): RaizDaConfig {
  const raiz = typeof id === 'string' ? raizes.find((r) => r.id === id) : undefined;
  if (!raiz || (raiz.tipo !== 'home' && raiz.tipo !== 'claude-projeto')) throw new ErroDaConfig(400, 'raiz: um id de `raizes` do tipo home ou claude-projeto');
  return raiz;
}

/** O caminho real de `caminho`, que tem de ficar dentro de `realRaiz`; `null` se não existe. */
async function realDentro(realRaiz: string, caminho: string): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(caminho);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  if (!real.startsWith(realRaiz + sep)) throw new ErroDaConfig(403, 'fora da raiz: a skill aponta (symlink) para fora da pasta de configuração');
  return real;
}

/** Os caminhos da skill, conferidos contra a raiz. `criar` faz as pastas que faltam. */
async function caminhosDaSkill(raiz: RaizDaConfig, nome: string, criar: boolean): Promise<{ pasta: string; arquivo: string } | null> {
  if (criar && raiz.tipo === 'claude-projeto') {
    // A `.claude` do projeto pode não existir ainda: nasce dentro do projeto, que tem de existir.
    if (!(await stat(dirname(raiz.caminho)).catch(() => null))?.isDirectory()) throw new ErroDaConfig(404, 'o projeto não existe mais');
    await mkdir(raiz.caminho).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
  }
  const realRaiz = await realpath(raiz.caminho).catch(() => null);
  if (!realRaiz) {
    if (criar) throw new ErroDaConfig(404, 'a pasta da raiz não existe');
    return null;
  }
  // A `.claude` do projeto como symlink para fora do projeto (um repositório clonado pode trazer
  // uma) faria a skill "do projeto" cair em outra pasta, até na de usuário.
  if (raiz.tipo === 'claude-projeto') {
    const realProjeto = await realpath(dirname(raiz.caminho)).catch(() => null);
    if (!realProjeto || !realRaiz.startsWith(realProjeto + sep)) throw new ErroDaConfig(403, 'fora da raiz: a .claude do projeto aponta (symlink) para fora dele');
  }
  const skills = join(raiz.caminho, 'skills');
  const pasta = join(skills, nome);
  for (const p of [skills, pasta]) {
    if (await realDentro(realRaiz, p)) {
      if (!(await stat(p)).isDirectory()) throw new ErroDaConfig(400, `${basename(p)} não é uma pasta`);
      continue;
    }
    if (!criar) return null;
    await mkdir(p).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    // Criada agora (ou por outro ao mesmo tempo): confere de novo.
    await realDentro(realRaiz, p);
  }
  const arquivo = join(pasta, 'SKILL.md');
  const info = await lstat(arquivo).catch(() => null);
  if (info?.isSymbolicLink()) {
    if (criar) throw new ErroDaConfig(403, 'SKILL.md é um symlink: edite o arquivo de destino');
    await realDentro(realRaiz, arquivo);
  } else if (info && !info.isFile()) {
    throw new ErroDaConfig(400, 'SKILL.md não é um arquivo');
  }
  return { pasta, arquivo };
}

/**
 * Se a gravação aceitaria esta skill: o nome passa, as pastas ficam dentro da raiz e o `SKILL.md`
 * não é symlink. É o `editavel` da listagem, com as mesmas regras da gravação.
 */
export async function skillEditavel(raiz: RaizDaConfig, nome: string): Promise<boolean> {
  try {
    validarNome(nome);
    const c = await caminhosDaSkill(raiz, nome, false);
    return c !== null && !(await lstat(c.arquivo)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Gravações em fila por arquivo: duas no mesmo `SKILL.md` não passam juntas pela conferência da versão. */
const filas = new Map<string, Promise<unknown>>();

export async function lerSkill(raiz: RaizDaConfig, nomePedido: unknown): Promise<SkillLida | null> {
  const nome = validarNome(nomePedido);
  const c = await caminhosDaSkill(raiz, nome, false);
  if (!c) return null;
  let bytes: Buffer;
  try {
    bytes = await readFile(c.arquivo);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const info = await stat(c.arquivo);
  return { raiz: raiz.id, nome, escopo: raiz.escopo, caminho: c.arquivo, conteudo: bytes.toString('utf8'), versao: versaoDe(bytes), editadoEm: Math.round(info.mtimeMs) };
}

/**
 * Grava o `SKILL.md`: cria a skill que não existe (o "Nova", `backup: null`), ou faz o backup da
 * atual e troca. `versao` que veio e não bate com a atual (ou veio para uma skill que não existe):
 * 409, nada gravado.
 */
export async function gravarSkill(p: PedidoDeGravacao): Promise<SkillGravada> {
  const nome = validarNome(p.nome);
  if (typeof p.conteudo !== 'string') throw new ErroDaConfig(400, 'conteudo: o texto do SKILL.md');
  if (Buffer.byteLength(p.conteudo) > MAX_CONTEUDO) throw new ErroDaConfig(413, `conteudo: no máximo ${MAX_CONTEUDO / 1024} KiB`);
  if (p.versao !== undefined && p.versao !== null && typeof p.versao !== 'string') throw new ErroDaConfig(400, 'versao: a `versao` lida no GET');
  const versaoPedida = typeof p.versao === 'string' ? p.versao : null;

  const { pasta, arquivo } = (await caminhosDaSkill(p.raiz, nome, true))!;
  const anterior = filas.get(arquivo) ?? Promise.resolve();
  const feito = anterior.catch(() => undefined).then(() => gravarAgora(p, nome, pasta, arquivo, versaoPedida, p.conteudo as string));
  const fim = feito.catch(() => undefined);
  filas.set(arquivo, fim);
  void fim.then(() => {
    if (filas.get(arquivo) === fim) filas.delete(arquivo);
  });
  return feito;
}

async function gravarAgora(p: PedidoDeGravacao, nome: string, pasta: string, arquivo: string, versaoPedida: string | null, conteudo: string): Promise<SkillGravada> {
  const atual = await readFile(arquivo).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (versaoPedida !== null && (!atual || versaoDe(atual) !== versaoPedida)) {
    throw new ErroDaConfig(409, atual ? 'a skill mudou desde a leitura: releia antes de gravar' : 'a skill não existe mais');
  }

  let backup: string | null = null;
  if (atual) {
    const agora = (p.agora ?? (() => new Date()))();
    const carimbo = agora.toISOString().replace(/[:.]/g, '-');
    backup = join(p.backups, carimbo.slice(0, 10), pastaSeguraDa(p.raiz), nome, `SKILL.md.bak-${carimbo}-${randomBytes(3).toString('hex')}`);
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    await writeFile(backup, atual, { flag: 'wx', mode: 0o600 });
  }

  const tmp = join(pasta, `.SKILL.md.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(tmp, conteudo, { flag: 'wx', mode: 0o644 });
    await rename(tmp, arquivo);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  const info = await stat(arquivo);
  return { ok: true, caminho: arquivo, backup, versao: versaoDe(conteudo), editadoEm: Math.round(info.mtimeMs) };
}

/**
 * Um nome de pasta para os backups de uma raiz: as duas últimas partes do caminho, legíveis, e um
 * pedaço do hash do caminho inteiro (duas raízes com o mesmo nome não se misturam). O id `u0` não
 * serve: muda quando a descoberta muda.
 */
function pastaSeguraDa(raiz: RaizDaConfig): string {
  const legivel = `${basename(dirname(raiz.caminho))}_${basename(raiz.caminho)}`.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '');
  return `${legivel.slice(0, 80)}-${versaoDe(raiz.caminho).slice(0, 8)}`;
}
