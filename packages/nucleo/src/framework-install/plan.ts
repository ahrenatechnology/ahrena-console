// O plano (#184, estudo "O que instalar num repositório escreve"): por plataforma, cada arquivo com o
// antes, o depois e a ação (criar, mesclar, igual ou recusado), sem escrever nada. O texto que vai
// para o repositório fica em inglês, como o framework; só a tela (`why`) é pt-BR.
//
// | Plataforma          | Arquivo                       | O que entra |
// | ------------------- | ----------------------------- | ----------- |
// | Claude Code         | `.claude/settings.json`       | o marketplace e `enabledPlugins["<plugin>@ahrena"] = true` |
// | Claude Code         | `CLAUDE.md`                   | `@AGENTS.md` no bloco, sem duplicar o import da pessoa |
// | Claude Code e Codex | `AGENTS.md`                   | os plugins e o índice das regras de julgamento, uma linha mais o link |
// | Cursor              | `.cursor/rules/ahrena-*.mdc`  | a confirmar: o plano sabe gerar, a tela e a rota não oferecem |
//
// Codex: só o `AGENTS.md` (decisão 2 de 20/10); `.codex/config.toml` fica a confirmar e nada é escrito.

import { createHash } from 'node:crypto';
import { claudeBlock, enablesFramework, hasBlock, mergeClaudeSettings, upsertBlock } from './merge.ts';
import { DEFAULT_FRAMEWORK_REPO, MARKETPLACE, type Catalog, type Choice, type PlanFile } from './model.ts';

export interface PlanOptions {
  /** `dono/repo` do framework, para o marketplace e os links do índice. */
  frameworkRepo?: string;
}

const ruleLink = (frameworkRepo: string, path: string) => `https://github.com/${frameworkRepo}/blob/main/${path}`;

/** Uma linha por regra de julgamento dos plugins escolhidos, com o link: o índice que o framework manda escrever. */
export function rulesIndex(catalog: Catalog, plugins: readonly string[], { frameworkRepo = DEFAULT_FRAMEWORK_REPO }: PlanOptions = {}): string[] {
  const lines: string[] = [];
  for (const p of catalog.plugins.filter((x) => plugins.includes(x.name))) {
    for (const r of p.rules.filter((x) => x.enforcement === 'judgment')) {
      lines.push(`- **${r.title}.** ${r.statement} ([${p.name}](${ruleLink(frameworkRepo, r.path)}))`);
    }
  }
  return lines;
}

/** O plano para os arquivos de hoje (caminho → texto; ausente = não existe), o catálogo e a escolha. */
export function plan(files: Readonly<Record<string, string>>, catalog: Catalog, choice: Choice, { frameworkRepo = DEFAULT_FRAMEWORK_REPO }: PlanOptions = {}): PlanFile[] {
  const out: PlanFile[] = [];
  const current = (path: string) => (Object.hasOwn(files, path) ? files[path] : null);
  const put = (path: string, after: string, why: string) => {
    const before = current(path);
    out.push({ path, before, after, why, action: before === null ? 'create' : before === after ? 'unchanged' : 'merge' });
  };
  const index = rulesIndex(catalog, choice.plugins, { frameworkRepo });
  const agentsBody = [
    '## Ahrena Framework',
    '',
    `Plugins: ${choice.plugins.map((p) => `\`${p}\``).join(', ')} (marketplace \`${MARKETPLACE}\`).`,
    '',
    'Judgment rules, one line each; the full text is behind the link:',
    '',
    ...index,
    ...(choice.agency ? ['', 'Build work enters through the `athena` agent, who plans, routes and delegates; do not implement it directly.'] : []),
  ].join('\n');
  if (choice.platforms.includes('codex') || choice.platforms.includes('claude')) {
    put('AGENTS.md', upsertBlock(current('AGENTS.md'), agentsBody), 'índice das regras, lido pelo Codex e importado pelo CLAUDE.md');
  }
  if (choice.platforms.includes('claude')) {
    // O import que conta é o da pessoa, fora do nosso bloco; o de dentro é nosso e volta igual.
    put('CLAUDE.md', upsertBlock(current('CLAUDE.md'), claudeBlock(current('CLAUDE.md'))), 'o Claude Code carrega o AGENTS.md por import');
    const before = current('.claude/settings.json');
    const s = mergeClaudeSettings(before, choice.plugins, frameworkRepo);
    if ('refused' in s) out.push({ path: '.claude/settings.json', action: 'refused', before, after: null, why: s.refused });
    else put('.claude/settings.json', s.text, 'quem clonar recebe a oferta de instalar os plugins');
  }
  if (choice.platforms.includes('cursor')) {
    for (const p of catalog.plugins.filter((x) => choice.plugins.includes(x.name))) {
      for (const r of p.rules.filter((x) => x.enforcement === 'judgment')) {
        put(
          `.cursor/rules/ahrena-${r.id}.mdc`,
          `---\ndescription: ${r.statement}\nalwaysApply: false\n---\n\n${r.title}. Full text: ${ruleLink(frameworkRepo, r.path)}\n`,
          'regra de julgamento no formato do Cursor',
        );
      }
    }
  }
  return out;
}

/** O framework já está no repositório: o bloco no `CLAUDE.md` ou no `AGENTS.md`, ou um plugin `@ahrena` ligado. */
export function isInstalled(files: Readonly<Record<string, string>>): boolean {
  return hasBlock(files['CLAUDE.md']) || hasBlock(files['AGENTS.md']) || enablesFramework(files['.claude/settings.json']);
}

/**
 * O hash do plano (sha256): a escolha (ordenada) e, por arquivo, o caminho, a ação e o conteúdo
 * depois. Muda quando o repositório muda o que o PR escreveria; o `POST` recusa (409) com outro.
 */
export function planHash(files: readonly PlanFile[], choice: Choice): string {
  const canonical = {
    platforms: [...choice.platforms].sort(),
    plugins: [...choice.plugins].sort(),
    agency: choice.agency === true,
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.action, f.after]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
