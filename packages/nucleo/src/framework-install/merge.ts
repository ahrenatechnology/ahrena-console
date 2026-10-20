// Mesclar, nunca sobrescrever (#184, estudo "Mesclar, nunca sobrescrever"): nos arquivos de texto só
// muda o que está entre os marcadores do framework; o `.claude/settings.json` é lido como JSON e só
// ganha o marketplace e os plugins que ainda não aparecem. JSON inválido não é reescrito: é recusado
// (o instalador antigo trocava por `{}`).

import { BLOCK, DEFAULT_FRAMEWORK_REPO, MARKETPLACE } from './model.ts';

/** Troca só o que está entre os marcadores; sem marcadores, acrescenta o bloco no fim. Nunca apaga o resto. */
export function upsertBlock(text: string | null | undefined, body: string, marks: { start: string; end: string } = BLOCK): string {
  const block = `${marks.start}\n${body.trimEnd()}\n${marks.end}`;
  if (text == null || text === '') return `${block}\n`;
  const i = text.indexOf(marks.start);
  const j = text.indexOf(marks.end, i + marks.start.length);
  if (i >= 0 && j > i) return text.slice(0, i) + block + text.slice(j + marks.end.length);
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

/** O texto sem o bloco do framework: o que é da pessoa. */
export function withoutBlock(text: string): string {
  const i = text.indexOf(BLOCK.start);
  const j = text.indexOf(BLOCK.end, i + BLOCK.start.length);
  return i >= 0 && j > i ? text.slice(0, i) + text.slice(j + BLOCK.end.length) : text;
}

/** O texto tem o bloco do framework (a instalação já passou por aqui). */
export function hasBlock(text: string | null | undefined): boolean {
  if (!text) return false;
  const i = text.indexOf(BLOCK.start);
  return i >= 0 && text.indexOf(BLOCK.end, i + BLOCK.start.length) > i;
}

/** O `CLAUDE.md` da pessoa já importa o `AGENTS.md` (fora do nosso bloco). */
export function importsAgents(claudeMd: string | null | undefined): boolean {
  return claudeMd != null && /^@AGENTS\.md\s*$/m.test(withoutBlock(claudeMd));
}

/** O bloco do `CLAUDE.md`: sempre o `@AGENTS.md`, salvo quando a pessoa já o importa (decisão 5 de 20/10). */
export function claudeBlock(claudeMd: string | null | undefined): string {
  return importsAgents(claudeMd) ? 'The Ahrena Framework index lives in AGENTS.md, imported above.' : '@AGENTS.md';
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** O recuo do JSON de hoje (2 espaços, 4 ou tab), para o arquivo mesclado não mudar de forma. */
function indentOf(text: string): string | number {
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return 2;
  return m[1].startsWith('\t') ? '\t' : m[1].length;
}

export type SettingsMerge = { text: string } | { refused: string };

/**
 * `.claude/settings.json`: acrescenta o marketplace e habilita os plugins. Chaves que já existem
 * ficam; um plugin que a pessoa desligou (`false`) continua desligado. JSON inválido, ou que não é
 * um objeto, não é reescrito: o plano recusa o arquivo e diz por quê.
 */
export function mergeClaudeSettings(text: string | null | undefined, plugins: readonly string[], frameworkRepo: string = DEFAULT_FRAMEWORK_REPO): SettingsMerge {
  let cur: unknown = {};
  if (text != null && text.trim() !== '') {
    try {
      cur = JSON.parse(text);
    } catch {
      return { refused: 'JSON inválido: corrija o arquivo antes de instalar' };
    }
  }
  if (!isPlainObject(cur)) return { refused: 'o arquivo não é um objeto JSON: corrija-o antes de instalar' };
  for (const k of ['extraKnownMarketplaces', 'enabledPlugins'] as const) {
    if (k in cur && !isPlainObject(cur[k])) return { refused: `"${k}" não é um objeto: corrija o arquivo antes de instalar` };
  }
  const next = structuredClone(cur) as Record<string, unknown> & { extraKnownMarketplaces?: Record<string, unknown>; enabledPlugins?: Record<string, unknown> };
  next.extraKnownMarketplaces = { ...next.extraKnownMarketplaces };
  next.extraKnownMarketplaces[MARKETPLACE] ??= { source: { source: 'github', repo: frameworkRepo } };
  next.enabledPlugins = { ...next.enabledPlugins };
  for (const p of plugins) if (!Object.hasOwn(next.enabledPlugins, `${p}@${MARKETPLACE}`)) next.enabledPlugins[`${p}@${MARKETPLACE}`] = true;
  return { text: `${JSON.stringify(next, null, text ? indentOf(text) : 2)}\n` };
}

/** O framework já está habilitado no `settings.json` (algum `<plugin>@ahrena` com `true`). */
export function enablesFramework(settings: string | null | undefined): boolean {
  if (!settings) return false;
  try {
    const s = JSON.parse(settings) as { enabledPlugins?: unknown };
    return isPlainObject(s?.enabledPlugins) && Object.entries(s.enabledPlugins).some(([k, v]) => k.endsWith(`@${MARKETPLACE}`) && v === true);
  } catch {
    return false;
  }
}
