// A configuração sintética da `--demo` (#63): uma pasta de configuração de usuário e um projeto
// fictícios num `mkdtemp` do sistema, com o conteúdo do wireframe C16/C17. A demo nunca lê a
// `~/.claude` real; os backups das gravações também ficam no temporário. `apagar()` remove tudo.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pastaDeConfiguracao, type PastaDeConfiguracao } from '../perfis/descoberta.ts';

export interface ConfigDaDemo {
  /** A pasta temporária inteira. */
  raiz: string;
  pastas: PastaDeConfiguracao[];
  /** O projeto sintético (`<tmp>/motor-de-regras`). */
  projeto: string;
  backups: string;
  apagar(): void;
}

const skill = (nome: string, descricao: string, corpo: string) => `---\nname: ${nome}\ndescription: ${descricao}\n---\n\n# ${nome}\n\n${corpo}\n`;
const agente = (nome: string, descricao: string) => `---\nname: ${nome}\ndescription: ${descricao}\n---\n\nVocê é ${descricao.toLowerCase()}\n`;
const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

export function montarConfigDaDemo(base = tmpdir()): ConfigDaDemo {
  const raiz = mkdtempSync(join(base, 'ahrena-console-demo-'));
  // `<tmp>/.claude` com o `.claude.json` ao lado: o mesmo desenho da pasta padrão (`~/.claude`).
  const pasta = pastaDeConfiguracao(join(raiz, '.claude'), 'padrao', raiz);
  const projeto = join(raiz, 'motor-de-regras');
  const escrever = (caminho: string, conteudo: string) => {
    mkdirSync(dirname(caminho), { recursive: true });
    writeFileSync(caminho, conteudo);
  };

  const u = pasta.dir;
  escrever(join(u, 'skills', 'revisar-pr', 'SKILL.md'), skill('revisar-pr', 'Revisa um PR contra o guia de estilo do projeto', 'Leia o diff, compare com o guia e aponte o que diverge.'));
  escrever(join(u, 'skills', 'rodar-bateria', 'SKILL.md'), skill('rodar-bateria', 'Roda os testes e resume as falhas', 'Rode a bateria inteira e agrupe as falhas por causa.'));
  escrever(join(u, 'agents', 'revisor.md'), agente('revisor', 'Um revisor de código atento a testes.'));
  escrever(join(u, 'agents', 'pesquisador.md'), agente('pesquisador', 'Um pesquisador que lê a documentação antes de responder.'));
  escrever(join(u, 'commands', 'resumo.md'), 'Resuma a sessão em cinco linhas.\n');
  escrever(join(u, 'commands', 'git', 'limpar.md'), 'Liste os branches já integrados.\n');
  escrever(join(u, 'CLAUDE.md'), '# Preferências\n\nResponda em português.\n');
  escrever(
    join(u, 'settings.json'),
    json({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo início' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo antes' }, { type: 'command', command: 'echo de novo' }] }],
      },
      enabledPlugins: { 'revisao@exemplo': true, 'rascunho@exemplo': false },
    }),
  );
  escrever(
    pasta.claudeJson,
    json({
      mcpServers: { documentacao: { type: 'http', url: 'http://127.0.0.1:9/mcp' }, arquivos: { command: 'exemplo-mcp', args: [] } },
      projects: { [projeto]: { mcpServers: { banco: { command: 'exemplo-banco' } } } },
    }),
  );

  const p = join(projeto, '.claude');
  escrever(join(p, 'skills', 'abrir-issue', 'SKILL.md'), skill('abrir-issue', 'Abre uma issue no modelo do repositório', 'Use o modelo de issue do repositório e preencha cada campo.'));
  escrever(join(p, 'skills', 'migracao-segura', 'SKILL.md'), skill('migracao-segura', 'Escreve migrações com volta e teste', 'Toda migração tem a volta e um teste que sobe e desce.'));
  escrever(join(p, 'agents', 'regras.md'), agente('regras', 'Um especialista no motor de regras.'));
  escrever(join(p, 'commands', 'publicar.md'), 'Prepare a versão para publicar.\n');
  escrever(join(p, 'settings.json'), json({ hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo formatar' }] }] }, enabledPlugins: { 'migracoes@exemplo': true } }));
  escrever(join(p, 'settings.local.json'), json({}));
  escrever(join(projeto, 'CLAUDE.md'), '# Motor de regras\n\nRode os testes antes de cada commit.\n');
  escrever(join(projeto, '.mcp.json'), json({ mcpServers: { tickets: { command: 'exemplo-tickets' } } }));

  return {
    raiz,
    pastas: [pasta],
    projeto,
    backups: join(raiz, 'backups'),
    apagar: () => rmSync(raiz, { recursive: true, force: true }),
  };
}
