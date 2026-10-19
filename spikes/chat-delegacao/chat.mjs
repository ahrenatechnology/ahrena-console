// Chat de terminal falso (spike #120): faz no terminal o que a janela de chat do app faria.
// Conversa em streaming com uma sessão do Claude Code, nova ou retomada pelo id, na pasta de
// configuração de uma conta. Comandos: /parar interrompe o turno, /sair encerra.
//
//   node chat.mjs --conta <CLAUDE_CONFIG_DIR> --pasta <projeto> [--sessao <id>] [--api-falsa <porta>]
//
// Com --api-falsa, o HOME é falso e o modelo é a API falsa em 127.0.0.1: nada de login nem de plano.
// Sem ele, usa o login que a própria pessoa fez naquela pasta (claude auth login) — não usado na prova.
import { createInterface } from 'node:readline/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { abrirSessao } from './sessao.mjs';

const { values: o } = parseArgs({ options: { conta: { type: 'string' }, pasta: { type: 'string' }, sessao: { type: 'string' }, 'api-falsa': { type: 'string' } } });
if (!o.conta || !o.pasta) { console.error('uso: node chat.mjs --conta <pasta de configuração> --pasta <projeto> [--sessao <id>] [--api-falsa <porta>]'); process.exit(2); }

const env = o['api-falsa']
  ? { HOME: mkdtempSync(join(tmpdir(), 'chat-home-')), PATH: process.env.PATH, TERM: 'dumb', ANTHROPIC_BASE_URL: `http://127.0.0.1:${o['api-falsa']}`, ANTHROPIC_API_KEY: 'chave-falsa-da-prova', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1' }
  : { ...process.env };
// Credencial no ambiente passa na frente do login da pasta e misturaria as contas (decisão 0006).
if (!o['api-falsa']) for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[k];

const s = abrirSessao({ configDir: o.conta, cwd: o.pasta, resume: o.sessao, env, args: o['api-falsa'] ? ['--model', 'claude-sonnet-5-5'] : [] });
const rl = createInterface({ input: process.stdin, output: process.stdout });
let ocupada = false;

s.on('init', (m) => console.log(`[sessão ${m.session_id} · ${m.cwd}]`));
s.on('texto', (t) => console.log(`claude › ${t}`));
s.on('fim', (m) => { ocupada = false; console.log(`[fim do turno: ${m.subtype}${m.total_cost_usd != null ? ` · US$ ${m.total_cost_usd.toFixed(4)}` : ''}]`); });
s.on('permissao', async (p) => {
  const r = await rl.question(`permitir ${p.ferramenta} ${JSON.stringify(p.entrada.command ?? p.entrada)} uma vez? [s/N] `);
  p.responder(r.trim().toLowerCase() === 's' ? 'allow' : 'deny');
});
s.on('saiu', ({ code, stderr }) => { if (code) console.error(stderr.trim()); process.exit(code ?? 0); });

rl.on('line', async (linha) => {
  const t = linha.trim();
  if (!t) return;
  if (t === '/sair') return s.fechar();
  if (t === '/parar') return console.log('[interrompido]', JSON.stringify((await s.interromper())?.response ?? {}));
  if (ocupada) console.log('[sessão ocupada: a mensagem entra na fila]');
  ocupada = true;
  s.enviar(t);
});
