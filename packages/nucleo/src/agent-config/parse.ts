// O que se lê da configuração de um agente, sem disco e sem rede: o front matter de skills, agentes e
// regras, os eventos de hook (nunca o comando), os plugins habilitados e os nomes dos servidores MCP.
// Serve às duas leituras: a do disco desta máquina (Agent Config, reading.ts, #63) e a de um
// repositório do GitHub (src/agent-instructions, #183). Quem chama traz o texto; aqui só se interpreta.

export { readFrontmatter } from './frontmatter.ts';

/** Um evento de hook: quantos comandos tem e os matchers. O comando em si nunca sai daqui. */
export interface HookSummary {
  event: string;
  count: number;
  matchers: string[];
}

/** Um plugin habilitado, `nome@marketplace` separado. */
export interface EnabledPlugin {
  name: string;
  marketplace: string | null;
}

export function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function keysOf(v: unknown): string[] {
  const o = asObject(v);
  return o ? Object.keys(o) : [];
}

/**
 * Os eventos de `hooks` e quantos comandos cada um tem (`hooks.<Evento>[].hooks[]`), com os
 * matchers que são texto. Um evento que não é lista vem com 0; um grupo sem `hooks` não conta.
 */
export function hooksOf(settings: unknown): HookSummary[] {
  const hooks = asObject(asObject(settings)?.hooks);
  if (!hooks) return [];
  return Object.entries(hooks).map(([event, groups]) => {
    const list = Array.isArray(groups) ? groups : [];
    return {
      event,
      count: list.reduce((n: number, g) => n + (Array.isArray(asObject(g)?.hooks) ? (asObject(g)!.hooks as unknown[]).length : 0), 0),
      matchers: list.map((g) => asObject(g)?.matcher).filter((m): m is string => typeof m === 'string' && m !== ''),
    };
  });
}

/**
 * As chaves de `enabledPlugins` cujo valor é `enabled` (`true` no JSON lido normalmente; a leitura
 * sem valores do Agent Config troca `true` por uma marca e passa a marca aqui).
 */
export function enabledPluginKeys(settings: unknown, enabled: unknown = true): string[] {
  const map = asObject(asObject(settings)?.enabledPlugins);
  return map ? Object.keys(map).filter((k) => map[k] === enabled) : [];
}

/** Os plugins habilitados, com o marketplace de `nome@marketplace`. */
export function pluginsOf(settings: unknown, enabled: unknown = true): EnabledPlugin[] {
  return enabledPluginKeys(settings, enabled).map((key) => {
    const at = key.indexOf('@');
    return at < 0 ? { name: key, marketplace: null } : { name: key.slice(0, at), marketplace: key.slice(at + 1) || null };
  });
}

/** Os marketplaces declarados em `extraKnownMarketplaces`. */
export function marketplacesOf(settings: unknown): string[] {
  return keysOf(asObject(settings)?.extraKnownMarketplaces);
}

/** Os nomes dos servidores de um `.mcp.json` (ou de `.claude.json`); os valores não saem. */
export function mcpServersOf(json: unknown): string[] {
  return keysOf(asObject(json)?.mcpServers);
}

/** A marca que a leitura sem valores põe no lugar de `true`. */
export const ENABLED_MARK = 1;

/**
 * Lê um JSON guardando só a forma: objetos, listas, chaves e `ENABLED_MARK` no lugar de `true`.
 * Todo texto e número some durante a própria leitura, então nenhum valor (`env`, `command`, `url`,
 * tokens) existe no objeto que sai. `null`: não é JSON, ou não é um objeto.
 */
export function parseJsonShape(text: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(text, (_k, v: unknown) => (v === true ? ENABLED_MARK : v !== null && typeof v === 'object' ? v : undefined)));
  } catch {
    return null;
  }
}

/** Um JSON comum, só se for objeto; `undefined` quando não dá para ler. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(text)) ?? undefined;
  } catch {
    return undefined;
  }
}

const OPENING = /^﻿?---[ \t]*\r?\n/;
const KEY = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/;
const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, '$2');

/**
 * As listas do front matter (`paths:` com itens `- …`, `[a, b]` na linha, ou um valor só), que o
 * `readFrontmatter` ignora. Só as chaves do nível de cima.
 */
export function readFrontmatterLists(text: string): Record<string, string[]> {
  const opening = OPENING.exec(text);
  if (!opening) return {};
  const rest = text.slice(opening[0].length);
  const end = /^---[ \t]*$/m.exec(rest);
  if (!end) return {};
  const lines = rest.slice(0, end.index).split(/\r?\n/);
  const out: Record<string, string[]> = {};
  for (let i = 0; i < lines.length; i++) {
    const m = KEY.exec(lines[i]);
    if (!m) continue;
    const value = m[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      out[m[1]] = value.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else if (value !== '') {
      out[m[1]] = [unquote(value)];
    } else {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*(-\s+|$)/.test(lines[i + 1])) {
        const item = lines[++i].replace(/^\s*-\s+/, '');
        if (item.trim()) items.push(unquote(item));
      }
      out[m[1]] = items;
    }
  }
  return out;
}
