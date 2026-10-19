// A trava do núcleo: `~/.ahrena-console/nucleo.json`, com pid, porta, versão, hora e um token para
// os clientes locais (decisão 0005, item 4). Escrita atômica (arquivo temporário e `rename`) e só
// legível pelo dono (0600). Quem escreve é o núcleo, depois que a porta já é dele.

import { randomBytes } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Trava {
  pid: number;
  porta: number;
  versao: string;
  /** ISO 8601. */
  inicio: string;
  /** Aleatório, para os clientes locais provarem que leram a trava. Nunca vai para log nem `status`. */
  token: string;
  /** O processo que pediu `--pai`, se houver. */
  pai: number | null;
}

export const ARQUIVO_DA_TRAVA = 'nucleo.json';

export function pastaPadrao(): string {
  return join(homedir(), '.ahrena-console');
}

export function arquivoDaTrava(pasta = pastaPadrao()): string {
  return join(pasta, ARQUIVO_DA_TRAVA);
}

export function novoToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Cria a pasta com 0700 e, se ela já existia mais aberta (o `mkdir` de antes da #86 dava 0755),
 * fecha. O banco mora nela: com a pasta fechada, outro usuário não chega ao SQLite.
 */
export function prepararPasta(pasta = pastaPadrao()): void {
  mkdirSync(pasta, { recursive: true, mode: 0o700 });
  chmodSync(pasta, 0o700);
}

const inteiro = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** A trava, `null` se não existe, ou `'invalida'` se o arquivo não é uma trava (conta como órfã). */
export function lerTrava(pasta = pastaPadrao()): Trava | 'invalida' | null {
  return lerArquivo(arquivoDaTrava(pasta));
}

function lerArquivo(arquivo: string): Trava | 'invalida' | null {
  let texto: string;
  try {
    texto = readFileSync(arquivo, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const t = JSON.parse(texto) as Partial<Trava>;
    if (!inteiro(t.pid) || !inteiro(t.porta) || typeof t.versao !== 'string' || typeof t.inicio !== 'string' || typeof t.token !== 'string') {
      return 'invalida';
    }
    return { pid: t.pid!, porta: t.porta!, versao: t.versao, inicio: t.inicio, token: t.token, pai: inteiro(t.pai) ? t.pai! : null };
  } catch {
    return 'invalida';
  }
}

const temporario = (pasta: string, rotulo: string) => join(pasta, `.${ARQUIVO_DA_TRAVA}.${rotulo}.${process.pid}.${randomBytes(4).toString('hex')}`);

function escreverTemporario(trava: Trava, pasta: string): string {
  prepararPasta(pasta);
  const tmp = temporario(pasta, 'nova');
  writeFileSync(tmp, `${JSON.stringify(trava, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return tmp;
}

/** Grava a trava inteira de uma vez, por cima da que houver: quem lê vê a antiga ou a nova, nunca metade. */
export function gravarTrava(trava: Trava, pasta = pastaPadrao()): void {
  const tmp = escreverTemporario(trava, pasta);
  try {
    renameSync(tmp, arquivoDaTrava(pasta));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Cria a trava só se não houver nenhuma (`link` falha se o arquivo existe): de dois que tentam ao
 * mesmo tempo, um só consegue. `false` se já havia trava.
 */
export function criarTrava(trava: Trava, pasta = pastaPadrao()): boolean {
  const tmp = escreverTemporario(trava, pasta);
  try {
    linkSync(tmp, arquivoDaTrava(pasta));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Tira a trava do lugar só se ela é a esperada (`token`, ou `null` para uma ilegível). Move antes de
 * ler: se nesse meio-tempo outro núcleo gravou a dele, ela volta para o lugar. `true` se tirou.
 */
export function tirarTrava(token: string | null, pasta = pastaPadrao()): boolean {
  const arquivo = arquivoDaTrava(pasta);
  const movida = temporario(pasta, 'velha');
  try {
    renameSync(arquivo, movida);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  const t = lerArquivo(movida);
  const era = token === null ? t === 'invalida' : t !== null && t !== 'invalida' && t.token === token;
  if (!era) {
    try {
      linkSync(movida, arquivo);
    } catch (e) {
      // EEXIST: já há uma mais nova que a que tiramos sem querer; essa fica.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  rmSync(movida, { force: true });
  return era;
}

/** Apaga a trava só se ela ainda é a deste token (outro núcleo pode tê-la recuperado). */
export function liberarTrava(token: string, pasta = pastaPadrao()): boolean {
  return tirarTrava(token, pasta);
}
