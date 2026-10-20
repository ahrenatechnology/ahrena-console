// O catálogo do framework: os plugins do marketplace (`.claude-plugin/marketplace.json`) e, de cada
// um, as regras com o enunciado e o modo de cumprir, lidos do frontmatter (`id`, `title`,
// `statement`, `enforcement`). É o que o spike `catalog.mjs` fazia num checkout; aqui sai do texto
// lido do GitHub (api/framework-install.ts). `catalog-snapshot.json` é o retrato do spike, para os
// testes e para a demonstração.

import { readFileSync } from 'node:fs';
import { MARKETPLACE, type Catalog, type CatalogPlugin, type CatalogRule } from './model.ts';

export const MARKETPLACE_PATH = '.claude-plugin/marketplace.json';

/** O retrato do framework guardado no pacote (o `catalog.json` do spike). */
export function catalogSnapshot(): Catalog {
  const raw = JSON.parse(readFileSync(new URL('./catalog-snapshot.json', import.meta.url), 'utf8')) as Catalog;
  return {
    marketplace: raw.marketplace,
    repo: raw.repo,
    commit: raw.commit,
    plugins: raw.plugins.map((p) => ({ name: p.name, path: p.path, description: p.description, keywords: p.keywords ?? [], rules: p.rules })),
  };
}

interface RawMarketplace {
  name?: unknown;
  plugins?: { name?: unknown; description?: unknown; keywords?: unknown; source?: unknown }[];
}

/** A pasta do plugin: `source.path` (git-subdir) ou `source` como caminho relativo (`./foundation`). */
function sourcePath(source: unknown): string | null {
  const raw = typeof source === 'string' ? source : source && typeof source === 'object' ? (source as { path?: unknown }).path : null;
  if (typeof raw !== 'string') return null;
  const p = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  return p && !p.split('/').includes('..') ? p : null;
}

export interface MarketplaceEntry {
  name: string;
  path: string;
  description: string;
  keywords: string[];
}

/** Os plugins do marketplace; `null` quando o texto não é o JSON esperado. */
export function parseMarketplace(text: string): { name: string; plugins: MarketplaceEntry[] } | null {
  let raw: RawMarketplace;
  try {
    raw = JSON.parse(text) as RawMarketplace;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.plugins)) return null;
  const plugins: MarketplaceEntry[] = [];
  for (const p of raw.plugins) {
    const path = sourcePath(p?.source);
    if (typeof p?.name !== 'string' || !path) continue;
    plugins.push({
      name: p.name,
      path,
      description: typeof p.description === 'string' ? p.description : '',
      keywords: Array.isArray(p.keywords) ? p.keywords.filter((k): k is string => typeof k === 'string') : [],
    });
  }
  return { name: typeof raw.name === 'string' ? raw.name : MARKETPLACE, plugins };
}

/** Um campo de uma linha do frontmatter (`chave: valor`), sem aspas em volta. */
function field(front: string, key: string): string | null {
  const m = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(front);
  if (!m) return null;
  const v = m[1].trim();
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
}

/** A regra pelo frontmatter; `null` sem frontmatter ou sem `id`. */
export function parseRule(text: string, path: string): CatalogRule | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const id = field(m[1], 'id');
  if (!id) return null;
  return { id, title: field(m[1], 'title') ?? id, statement: field(m[1], 'statement') ?? '', enforcement: field(m[1], 'enforcement') ?? 'judgment', path };
}

/** Os caminhos do repositório do framework que o catálogo lê: o marketplace e as regras. */
export function isCatalogPath(path: string): boolean {
  return path === MARKETPLACE_PATH || /^[^/]+(?:\/[^/]+)*\/rules\/[^/]+\.md$/.test(path);
}

/** Monta o catálogo com o marketplace e os textos das regras (caminho → texto). */
export function buildCatalog(repo: string, commit: string | null, marketplaceText: string, ruleTexts: ReadonlyMap<string, string>): Catalog {
  const market = parseMarketplace(marketplaceText);
  if (!market) throw new Error(`${MARKETPLACE_PATH} do framework não é o JSON esperado`);
  const plugins: CatalogPlugin[] = market.plugins.map((p) => {
    const rules: CatalogRule[] = [];
    for (const [path, text] of [...ruleTexts].sort(([a], [b]) => a.localeCompare(b))) {
      if (!path.startsWith(`${p.path}/rules/`)) continue;
      const r = parseRule(text, path);
      if (r) rules.push(r);
    }
    return { ...p, rules };
  });
  return { marketplace: market.name, repo, commit, plugins };
}
