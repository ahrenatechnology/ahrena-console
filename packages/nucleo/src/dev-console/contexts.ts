// Os contextos do Dev Console (decisão 0008, seção 4): conjuntos de repositórios. Vêm de
// `~/.ahrena-console/dev-console.json`:
//
//   { "contexts": [{ "id": "loja", "name": "Loja", "repos": ["owner/repo"] }], "blockedLabels": ["blocked"] }
//
// `blockedLabels` (opcional, no topo ou por contexto) é a etiqueta da coluna "Bloqueada"; o
// padrão é `blocked`. Sem arquivo (ou sem um contexto válido nele), um contexto por repositório
// que teve sessão nos últimos 7 dias. O arquivo é relido quando muda, como o `contas.json`.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BLOCKED_LABELS, repoKey } from './model.ts';

export interface DevConsoleContext {
  id: string;
  name: string;
  repos: string[];
  blockedLabels: string[];
  /** `file`: do `dev-console.json`; `sessions`: um por repositório com sessão recente. */
  source: 'file' | 'sessions';
}

export const CONTEXT_ID = /^[A-Za-z0-9_.\/-]{1,128}$/;
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const MAX_CONTEXTS = 32;
const MAX_REPOS = 32;
const MAX_LABELS = 8;

export function defaultDevConsoleFile(): string {
  return join(homedir(), '.ahrena-console', 'dev-console.json');
}

const labelsOf = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out = v.filter((l): l is string => typeof l === 'string' && l.trim().length > 0 && l.length <= 64).map((l) => l.trim());
  return out.length > 0 ? out.slice(0, MAX_LABELS) : null;
};

/** Os contextos válidos do arquivo; o inválido fica de fora, sem derrubar os outros. */
export function parseContexts(json: unknown): DevConsoleContext[] {
  const root = json as { contexts?: unknown; blockedLabels?: unknown } | null;
  if (!root || !Array.isArray(root.contexts)) return [];
  const defaultLabels = labelsOf(root.blockedLabels) ?? [...DEFAULT_BLOCKED_LABELS];
  const out: DevConsoleContext[] = [];
  const ids = new Set<string>();
  for (const c of root.contexts.slice(0, MAX_CONTEXTS) as { id?: unknown; name?: unknown; repos?: unknown; blockedLabels?: unknown }[]) {
    if (typeof c?.id !== 'string' || !CONTEXT_ID.test(c.id) || ids.has(c.id) || !Array.isArray(c.repos)) continue;
    const repos = [...new Set(c.repos.filter((r): r is string => typeof r === 'string' && REPO_NAME.test(r)).map(repoKey))].slice(0, MAX_REPOS);
    if (repos.length === 0) continue;
    ids.add(c.id);
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 64) : c.id;
    out.push({ id: c.id, name, repos, blockedLabels: labelsOf(c.blockedLabels) ?? defaultLabels, source: 'file' });
  }
  return out;
}

/** Um contexto por repositório, com o próprio `owner/repo` de id e o nome do repositório. */
export function contextsFromRepos(repos: readonly string[]): DevConsoleContext[] {
  return [...new Set(repos.filter((r) => REPO_NAME.test(r)).map(repoKey))]
    .slice(0, MAX_CONTEXTS)
    .map((repo) => ({ id: repo, name: repo.split('/')[1], repos: [repo], blockedLabels: [...DEFAULT_BLOCKED_LABELS], source: 'sessions' as const }));
}

export interface DevConsoleContextsOptions {
  /** `null` desliga o arquivo (a demo e os testes). */
  file?: string | null;
  /** Contextos dados de antemão (o simulador): valem no lugar do arquivo e das sessões. */
  fixed?: readonly DevConsoleContext[] | null;
  /** Os repositórios com sessão nos últimos 7 dias, para quando não há arquivo. */
  recentRepos: () => Promise<string[]>;
  /** De quanto em quanto tempo o arquivo e as sessões são conferidos de novo. Padrão 30 s. */
  intervalMs?: number;
  now?: () => number;
}

export class DevConsoleContexts {
  private readonly file: string | null;
  private readonly fixed: readonly DevConsoleContext[] | null;
  private readonly recentRepos: () => Promise<string[]>;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private fromFile: DevConsoleContext[] = [];
  private fromSessions: DevConsoleContext[] = [];
  private mtimeMs = -1;
  private checkedAt = -Infinity;

  constructor({ file = defaultDevConsoleFile(), fixed = null, recentRepos, intervalMs = 30_000, now = Date.now }: DevConsoleContextsOptions) {
    this.file = file;
    this.fixed = fixed;
    this.recentRepos = recentRepos;
    this.intervalMs = intervalMs;
    this.now = now;
  }

  async list(): Promise<DevConsoleContext[]> {
    if (this.fixed) return [...this.fixed];
    if (this.now() - this.checkedAt >= this.intervalMs) {
      this.checkedAt = this.now();
      await this.readFile();
      if (this.fromFile.length === 0) this.fromSessions = contextsFromRepos(await this.recentRepos());
    }
    return this.fromFile.length > 0 ? this.fromFile : this.fromSessions;
  }

  async get(id: string): Promise<DevConsoleContext | null> {
    return (await this.list()).find((c) => c.id === id) ?? null;
  }

  private async readFile(): Promise<void> {
    if (!this.file) return;
    try {
      const { mtimeMs } = await stat(this.file);
      if (mtimeMs === this.mtimeMs) return;
      this.mtimeMs = mtimeMs;
      this.fromFile = parseContexts(JSON.parse(await readFile(this.file, 'utf8')));
    } catch {
      // Sem arquivo, ou inválido: os contextos saem das sessões.
      this.mtimeMs = -1;
      this.fromFile = [];
    }
  }
}
