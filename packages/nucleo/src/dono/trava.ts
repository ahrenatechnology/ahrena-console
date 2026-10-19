// A trava do núcleo: `~/.ahrena-console/nucleo.json`, com pid, porta, versão, hora e um token para
// os clientes locais (decisão 0005, item 4). Escrita atômica (arquivo temporário e `rename`) e só
// legível pelo dono (0600). Quem escreve é o núcleo, depois que a porta já é dele.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

const inteiro = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** A trava, `null` se não existe, ou `'invalida'` se o arquivo não é uma trava (conta como órfã). */
export function lerTrava(pasta = pastaPadrao()): Trava | 'invalida' | null {
  let texto: string;
  try {
    texto = readFileSync(arquivoDaTrava(pasta), 'utf8');
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

/** Grava a trava inteira de uma vez: quem lê vê a antiga ou a nova, nunca metade. */
export function gravarTrava(trava: Trava, pasta = pastaPadrao()): void {
  mkdirSync(pasta, { recursive: true, mode: 0o700 });
  const tmp = join(pasta, `.${ARQUIVO_DA_TRAVA}.${process.pid}.${randomBytes(4).toString('hex')}`);
  try {
    writeFileSync(tmp, `${JSON.stringify(trava, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, arquivoDaTrava(pasta));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Apaga a trava só se ela ainda é a deste token (outro núcleo pode tê-la recuperado). */
export function liberarTrava(token: string, pasta = pastaPadrao()): boolean {
  const t = lerTrava(pasta);
  if (!t || t === 'invalida' || t.token !== token) return false;
  rmSync(arquivoDaTrava(pasta), { force: true });
  return true;
}

export function apagarTrava(pasta = pastaPadrao()): void {
  rmSync(arquivoDaTrava(pasta), { force: true });
}
