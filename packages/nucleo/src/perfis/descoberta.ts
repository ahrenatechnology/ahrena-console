// Descoberta das pastas de configuração do Claude Code (decisão 0006, "Perfis"): `~/.claude`, as
// `~/.claude-*` que existirem, as que a pessoa configurar em `~/.ahrena-console/perfis.json` e as
// que os hooks revelarem (`CLAUDE_CONFIG_DIR`). Só a estrutura é lida: se a pasta existe e tem
// as entradas de uma pasta de configuração. Nenhum arquivo é aberto aqui.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** De onde o núcleo soube da pasta. A primeira origem que a revelou fica. */
export type OrigemDoPerfil = 'padrao' | 'nome' | 'configurada' | 'hook';

export interface PastaDeConfiguracao {
  /** Caminho absoluto da pasta (ex.: `/Users/x/.claude-cliente`). */
  dir: string;
  /** Onde fica o `.claude.json`: `~/.claude.json` na pasta padrão, dentro da pasta nas outras. */
  claudeJson: string;
  /** Pasta dos transcripts (`<dir>/projects`). */
  projetos: string;
  /** A pasta padrão (`~/.claude`), que o Claude Desktop também usa. */
  padrao: boolean;
  origem: OrigemDoPerfil;
}

/** Entradas que só uma pasta de configuração do Claude Code tem. Basta uma. */
const MARCAS = ['.claude.json', 'settings.json', 'projects', 'sessions'] as const;

export function arquivoPadraoDePerfis(home = homedir()): string {
  return join(home, '.ahrena-console', 'perfis.json');
}

/** Caminho absoluto, com `~` expandido para o `home`. */
export function normalizarPasta(dir: string, home = homedir()): string {
  const d = dir === '~' ? home : dir.startsWith('~/') ? join(home, dir.slice(2)) : dir;
  return isAbsolute(d) ? resolve(d) : resolve(home, d);
}

/** A pasta, com o lugar do `.claude.json` e dos transcripts; não toca o disco. */
export function pastaDeConfiguracao(dir: string, origem: OrigemDoPerfil, home = homedir()): PastaDeConfiguracao {
  const abs = normalizarPasta(dir, home);
  const padrao = abs === join(home, '.claude');
  return {
    dir: abs,
    claudeJson: padrao ? join(home, '.claude.json') : join(abs, '.claude.json'),
    projetos: join(abs, 'projects'),
    padrao,
    origem: padrao ? 'padrao' : origem,
  };
}

/** Pastas configuradas em `perfis.json` (`{ "pastas": ["~/.claude-cliente"] }`). Sem arquivo, nenhuma. */
export async function pastasConfiguradas(arquivo: string | null, home = homedir()): Promise<string[]> {
  if (!arquivo) return [];
  try {
    const o = JSON.parse(await readFile(arquivo, 'utf8')) as { pastas?: unknown };
    if (!Array.isArray(o?.pastas)) return [];
    return o.pastas.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => normalizarPasta(p.trim(), home));
  } catch {
    return [];
  }
}

/** Se a pasta existe e parece uma pasta de configuração: só `stat` e a lista de entradas. */
export async function pareceConfiguracao(p: PastaDeConfiguracao): Promise<boolean> {
  try {
    if (!(await stat(p.dir)).isDirectory()) return false;
  } catch {
    return false;
  }
  if (p.padrao) return true;
  try {
    const entradas = new Set(await readdir(p.dir));
    return MARCAS.some((m) => entradas.has(m));
  } catch {
    return false;
  }
}

export interface OpcoesDaDescoberta {
  home?: string;
  /** `perfis.json`; `null` não lê configuração. */
  arquivo?: string | null;
  /** Pastas que os hooks revelaram (`CLAUDE_CONFIG_DIR`). */
  reveladas?: Iterable<string>;
}

/**
 * As pastas de configuração desta máquina, sem repetir: a padrão primeiro, depois as `~/.claude-*`
 * em ordem de nome, as configuradas e as reveladas pelos hooks. Só entram as que existem e têm
 * a estrutura de uma pasta de configuração.
 */
export async function descobrirPastas({ home = homedir(), arquivo = arquivoPadraoDePerfis(home), reveladas = [] }: OpcoesDaDescoberta = {}): Promise<PastaDeConfiguracao[]> {
  const candidatas: PastaDeConfiguracao[] = [pastaDeConfiguracao(join(home, '.claude'), 'padrao', home)];
  try {
    const nomes = (await readdir(home)).filter((n) => n.startsWith('.claude-')).sort();
    for (const n of nomes) candidatas.push(pastaDeConfiguracao(join(home, n), 'nome', home));
  } catch {
    // HOME ilegível: só as configuradas e as reveladas.
  }
  for (const d of await pastasConfiguradas(arquivo, home)) candidatas.push(pastaDeConfiguracao(d, 'configurada', home));
  for (const d of reveladas) candidatas.push(pastaDeConfiguracao(d, 'hook', home));

  const vistas = new Set<string>();
  const pastas: PastaDeConfiguracao[] = [];
  for (const p of candidatas) {
    if (vistas.has(p.dir)) continue;
    vistas.add(p.dir);
    if (await pareceConfiguracao(p)) pastas.push(p);
  }
  return pastas;
}
