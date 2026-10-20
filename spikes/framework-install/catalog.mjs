// Gera catalog.json a partir de um checkout do ahrena-framework: os plugins do marketplace e, de
// cada um, as regras com o enunciado e o modo de cumprir (hook ou julgamento). É o que o núcleo
// leria do GitHub; aqui fica um retrato para os testes não dependerem da rede.
// node spikes/framework-install/catalog.mjs <checkout> [ref] > spikes/framework-install/catalog.json
import { execFileSync } from 'node:child_process';

const [dir, ref = 'origin/main'] = process.argv.slice(2);
const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
const show = (p) => git('show', `${ref}:${p}`);
const market = JSON.parse(show('.claude-plugin/marketplace.json'));
const files = git('ls-tree', '-r', '--name-only', ref).split('\n');
const field = (text, k) => text.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null;

const plugins = market.plugins.map((p) => {
  const root = p.source.path;
  const rules = files.filter((f) => f.startsWith(`${root}/rules/`) && f.endsWith('.md')).map((f) => {
    const t = show(f);
    return { id: field(t, 'id'), title: field(t, 'title'), statement: field(t, 'statement'), enforcement: field(t, 'enforcement'), path: f };
  });
  const count = (d) => files.filter((f) => f.startsWith(`${root}/${d}/`) && (d === 'skills' ? f.endsWith('/SKILL.md') : f.endsWith('.md'))).length;
  return {
    name: p.name, path: root, description: p.description, keywords: p.keywords ?? [],
    platforms: ['claude', 'codex', 'cursor'].filter((x) => files.includes(`${root}/.${x}-plugin/plugin.json`)),
    rules, skills: count('skills'), agents: count('agents'), commands: count('commands'),
  };
});
console.log(JSON.stringify({ marketplace: market.name, repo: 'ahrenatechnology/ahrena-framework', commit: git('rev-parse', '--short', ref).trim(), plugins }, null, 2));
