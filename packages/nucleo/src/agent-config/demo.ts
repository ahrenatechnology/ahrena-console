// The synthetic configuration of `--demo` (#63): a fictitious user configuration folder and project
// in a system `mkdtemp`, with the content of wireframe C16/C17. The demo never reads the real
// `~/.claude`; the write backups also stay in the temporary folder. `remove()` deletes everything.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configFolder, type ConfigFolder } from '../profiles/discovery.ts';

export interface DemoAgentConfig {
  /** The whole temporary folder. */
  root: string;
  folders: ConfigFolder[];
  /** The synthetic project (`<tmp>/motor-de-regras`). */
  project: string;
  backups: string;
  remove(): void;
}

const skill = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
const agent = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nVocê é ${description.toLowerCase()}\n`;
const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

export function mountDemoAgentConfig(base = tmpdir()): DemoAgentConfig {
  const root = mkdtempSync(join(base, 'ahrena-console-demo-'));
  // `<tmp>/.claude` with `.claude.json` beside it: the same layout as the default folder (`~/.claude`).
  const folder = configFolder(join(root, '.claude'), 'padrao', root);
  const project = join(root, 'motor-de-regras');
  const write = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };

  const u = folder.dir;
  write(join(u, 'skills', 'revisar-pr', 'SKILL.md'), skill('revisar-pr', 'Revisa um PR contra o guia de estilo do projeto', 'Leia o diff, compare com o guia e aponte o que diverge.'));
  write(join(u, 'skills', 'rodar-bateria', 'SKILL.md'), skill('rodar-bateria', 'Roda os testes e resume as falhas', 'Rode a bateria inteira e agrupe as falhas por causa.'));
  write(join(u, 'agents', 'revisor.md'), agent('revisor', 'Um revisor de código atento a testes.'));
  write(join(u, 'agents', 'pesquisador.md'), agent('pesquisador', 'Um pesquisador que lê a documentação antes de responder.'));
  write(join(u, 'commands', 'resumo.md'), 'Resuma a sessão em cinco linhas.\n');
  write(join(u, 'commands', 'git', 'limpar.md'), 'Liste os branches já integrados.\n');
  write(join(u, 'CLAUDE.md'), '# Preferências\n\nResponda em português.\n');
  write(
    join(u, 'settings.json'),
    json({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo início' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo antes' }, { type: 'command', command: 'echo de novo' }] }],
      },
      enabledPlugins: { 'revisao@exemplo': true, 'rascunho@exemplo': false },
    }),
  );
  write(
    folder.claudeJson,
    json({
      mcpServers: { documentacao: { type: 'http', url: 'http://127.0.0.1:9/mcp' }, arquivos: { command: 'exemplo-mcp', args: [] } },
      projects: { [project]: { mcpServers: { banco: { command: 'exemplo-banco' } } } },
    }),
  );

  const p = join(project, '.claude');
  write(join(p, 'skills', 'abrir-issue', 'SKILL.md'), skill('abrir-issue', 'Abre uma issue no modelo do repositório', 'Use o modelo de issue do repositório e preencha cada campo.'));
  write(join(p, 'skills', 'migracao-segura', 'SKILL.md'), skill('migracao-segura', 'Escreve migrações com volta e teste', 'Toda migração tem a volta e um teste que sobe e desce.'));
  write(join(p, 'agents', 'regras.md'), agent('regras', 'Um especialista no motor de regras.'));
  write(join(p, 'commands', 'publicar.md'), 'Prepare a versão para publicar.\n');
  write(join(p, 'settings.json'), json({ hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo formatar' }] }] }, enabledPlugins: { 'migracoes@exemplo': true } }));
  write(join(p, 'settings.local.json'), json({}));
  write(join(project, 'CLAUDE.md'), '# Motor de regras\n\nRode os testes antes de cada commit.\n');
  write(join(project, '.mcp.json'), json({ mcpServers: { tickets: { command: 'exemplo-tickets' } } }));

  return {
    root,
    folders: [folder],
    project,
    backups: join(root, 'backups'),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
