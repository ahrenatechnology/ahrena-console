// Prova do spike #120 com o Claude Agent SDK (TypeScript) 0.3.302, que acompanha o CLI 2.1.302.
// Mesmo cenário da prova.mjs, em menor escala: conversa em streaming numa pasta de configuração
// temporária (env.CLAUDE_CONFIG_DIR), retomada pelo id, permissão por canUseTool e interrupt().
// O SDK roda o CLI já instalado (pathToClaudeCodeExecutable): instalado com --omit=optional,
// sem o binário que ele traz. HOME falso e API falsa em 127.0.0.1, como na prova.mjs.
import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
const porta = Number(process.env.PORTA ?? 4891);
const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'spike-120-sdk-'));
for (const p of ['home', 'proj', 'conta-a']) mkdirSync(join(tmp, p));
const api = spawn(process.execPath, [join(aqui, 'api-falsa.mjs'), String(porta)], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 400));

const claude = process.env.CLAUDE_BIN ?? execFileSync('sh', ['-c', 'command -v claude']).toString().trim();
const configDir = join(tmp, 'conta-a');
const base = {
  cwd: join(tmp, 'proj'),
  model: 'claude-sonnet-5-5',
  pathToClaudeCodeExecutable: claude,
  // env substitui o ambiente do processo filho: é aqui que entra a pasta da conta.
  env: { HOME: join(tmp, 'home'), PATH: process.env.PATH, CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${porta}`, ANTHROPIC_API_KEY: 'chave-falsa-da-prova', DISABLE_TELEMETRY: '1' },
  canUseTool: async (nome, entrada) => {
    console.log('  canUseTool:', nome, JSON.stringify(entrada.command));
    return { behavior: 'deny', message: 'Negado pelo console (SDK)' };
  },
};

// Fila de mensagens que o chat empurra; o SDK lê como AsyncIterable (modo streaming).
function caixa() {
  const fila = []; let acordar;
  return {
    enviar(texto) { fila.push({ type: 'user', message: { role: 'user', content: texto }, parent_tool_use_id: null }); acordar?.(); },
    async *[Symbol.asyncIterator]() { for (;;) { while (fila.length) yield fila.shift(); await new Promise((r) => (acordar = r)); } },
  };
}

console.log('== 1. sessão nova, dois turnos em streaming');
let entrada = caixa();
let q = query({ prompt: entrada, options: base });
let id;
entrada.enviar('olá pelo SDK');
let turnos = 0;
for await (const m of q) {
  if (m.type === 'assistant') console.log('  ', m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  if (m.type === 'result') {
    id = m.session_id; turnos++;
    if (turnos === 1) entrada.enviar('rode touch pelo-sdk.txt');
    else break;
  }
}
q.close();

console.log('== 2. retomar pelo id (options.resume) e interromper');
entrada = caixa();
q = query({ prompt: entrada, options: { ...base, resume: id } });
entrada.enviar('devagar, depois de retomar');
setTimeout(async () => console.log('  interrupt():', JSON.stringify(await q.interrupt())), 1000);
for await (const m of q) {
  if (m.type === 'assistant') console.log('  ', m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  if (m.type === 'result') { console.log('  result:', m.subtype, '| mesmo id:', m.session_id === id); break; }
}
q.close();

console.log('== 3. listSessions e getSessionMessages na pasta da conta');
process.env.CLAUDE_CONFIG_DIR = configDir; // as funções de leitura rodam neste processo, não no filho
const lista = await listSessions({ dir: base.cwd });
console.log('  sessões:', lista.length, '| primeira mensagem:', JSON.stringify(lista[0]?.firstPrompt));
console.log('  mensagens da sessão:', (await getSessionMessages(id, { dir: base.cwd })).length);
api.kill();
console.log('pasta da prova:', tmp);
