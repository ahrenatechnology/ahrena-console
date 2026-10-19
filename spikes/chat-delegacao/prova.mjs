// Prova do spike #120: o console conversa em stream-json com sessões reais do Claude Code CLI,
// em duas pastas de configuração temporárias (duas contas sintéticas), com HOME falso e a API falsa
// em 127.0.0.1. Não toca no login, no Keychain nem no ~/.claude de quem roda, e não gasta plano.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { abrirSessao, esperar } from './sessao.mjs';
import { sessoesVivas, entregar } from './caixa-de-entrada.mjs';

const aqui = dirname(fileURLToPath(import.meta.url));
const porta = Number(process.env.PORTA ?? 4891);
const tmp = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'spike-120-'));
for (const p of ['home', 'proj', 'conta-a', 'conta-b']) mkdirSync(join(tmp, p));
const proj = join(tmp, 'proj');
const api = spawn(process.execPath, [join(aqui, 'api-falsa.mjs'), String(porta), join(tmp, 'api.log')], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 400));

const claude = process.env.CLAUDE_BIN ?? 'claude';
const env = {
  HOME: join(tmp, 'home'), PATH: process.env.PATH, TERM: 'dumb',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${porta}`, ANTHROPIC_API_KEY: 'chave-falsa-da-prova',
  DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_ERROR_REPORTING: '1',
};
const conta = (c) => join(tmp, `conta-${c}`);
const abrir = (c, o = {}) => abrirSessao({ configDir: conta(c), cwd: proj, env, claude, args: ['--model', 'claude-sonnet-5-5'], ...o });
const log = (...a) => console.log(...a);
const titulo = (t) => log(`\n== ${t}`);

// Um turno: manda o texto e devolve o texto da resposta e o result.
async function turno(s, texto, o) {
  const textos = [];
  const ouvir = (t) => textos.push(t);
  s.on('texto', ouvir);
  s.enviar(texto, o);
  const fim = await esperar(s, 'fim');
  s.off('texto', ouvir);
  return { texto: textos.join(' | '), fim };
}
const encerrar = async (s) => { s.fechar(); await esperar(s, 'saiu'); };

// 1. Sessão nova, com id escolhido pelo console, e dois turnos no mesmo processo.
titulo('1. sessão nova na conta A, id escolhido pelo console, dois turnos');
const id = randomUUID();
let s = abrir('a', { sessionId: id });
let r = await turno(s, 'primeira mensagem');
log('resposta:', r.texto, '| session_id igual ao escolhido:', r.fim.session_id === id);
r = await turno(s, 'segunda mensagem');
log('resposta:', r.texto);
await encerrar(s);

// 2. Retomar pelo id num processo novo: o histórico volta (eco #3).
titulo('2. retomar pelo id num processo novo');
s = abrir('a', { resume: id });
r = await turno(s, 'terceira, depois de retomar');
log('resposta:', r.texto, '| mesmo id:', r.fim.session_id === id);

// 3. Sessão ocupada: mensagem enviada no meio do turno, sem prioridade e com 'later'.
titulo('3. mensagem no meio de um turno');
{
  const vistos = [];
  const ouvir = (m) => { if (m.type === 'result') vistos.push(`result(${m.subtype}, ${m.num_turns ?? '?'} turnos)`); if (m.type === 'assistant') vistos.push(`assistant: ${m.message.content.map((b) => b.text).join('')}`); };
  s.on('mensagem', ouvir);
  s.enviar('devagar, por favor');
  await new Promise((r) => setTimeout(r, 1000));
  s.enviar('chegou no meio (sem prioridade)');
  s.enviar('chegou no meio (later)', { priority: 'later' });
  // Espera até a fila esvaziar: dois results ou 15 s.
  await new Promise((ok) => { const t = setTimeout(ok, 15000); s.on('fim', () => vistos.filter((v) => v.startsWith('result')).length >= 2 && (clearTimeout(t), ok())); });
  s.off('mensagem', ouvir);
  for (const v of vistos) log(' ', v);
}

// 4. Interromper um turno longo.
titulo('4. interromper');
{
  const fim = esperar(s, 'fim');
  s.enviar('devagar de novo');
  await new Promise((r) => setTimeout(r, 1000));
  const resp = await s.interromper();
  const m = await fim;
  log('resposta do interrupt:', JSON.stringify(resp?.response ?? resp), '| result:', m.subtype, m.is_error ? '(erro)' : '');
}

// 5. Pedido de permissão chega ao console, que nega uma vez e depois permite uma vez.
titulo('5. permissão respondida pelo console');
{
  s.once('permissao', (p) => { log('pediu:', p.ferramenta, JSON.stringify(p.entrada.command)); p.responder('deny', { message: 'Negado pela prova' }); });
  r = await turno(s, 'rode touch negado.txt');
  log('depois de negar:', r.texto);
  s.once('permissao', (p) => { log('pediu:', p.ferramenta, JSON.stringify(p.entrada.command)); p.responder('allow'); });
  r = await turno(s, 'rode touch permitido.txt');
  log('depois de permitir:', r.texto);
}
await encerrar(s);

// 6. Dois processos retomam o mesmo id ao mesmo tempo (o "aberto em outro terminal").
titulo('6. dois processos na mesma sessão');
{
  const a1 = abrir('a', { resume: id });
  const a2 = abrir('a', { resume: id });
  const [x, y] = await Promise.all([turno(a1, 'do processo 1'), turno(a2, 'do processo 2')]);
  log('processo 1:', x.texto, '| id', x.fim.session_id === id ? 'igual' : 'outro');
  log('processo 2:', y.texto, '| id', y.fim.session_id === id ? 'igual' : 'outro');
  await Promise.all([encerrar(a1), encerrar(a2)]);
  s = abrir('a', { resume: id });
  r = await turno(s, 'quem ficou no histórico?');
  log('retomada depois dos dois:', r.texto);
  await encerrar(s);
}

// 7. Fork: retomar sem escrever na sessão original.
titulo('7. --fork-session');
s = abrir('a', { resume: id, fork: true });
r = await turno(s, 'num fork');
log('resposta:', r.texto, '| id novo:', r.fim.session_id !== id);
await encerrar(s);

// 8. Conta B: a mesma caixa, outra pasta de configuração, ao mesmo tempo que a A.
titulo('8. contas A e B ao mesmo tempo');
{
  const sa = abrir('a', { resume: id });
  const sb = abrir('b');
  const [x, y] = await Promise.all([turno(sa, 'na conta A'), turno(sb, 'na conta B')]);
  log('A:', x.texto, '| B:', y.texto);
  await Promise.all([encerrar(sa), encerrar(sb)]);
  const tr = (c) => readdirSync(join(conta(c), 'projects')).flatMap((d) => readdirSync(join(conta(c), 'projects', d)).filter((f) => f.endsWith('.jsonl')));
  log('transcripts em A:', tr('a').length, '| em B:', tr('b').length, '| B tem o id de A:', tr('b').includes(`${id}.jsonl`));
  log('HOME falso vazio:', execFileSync('find', [join(tmp, 'home'), '-type', 'f']).toString().trim() === '');
}

// 9. Sessão aberta por outro processo (o terminal da pessoa): o console não é dono dela e entrega
// o prompt pela caixa de entrada da mensageria entre sessões.
titulo('9. entregar a uma sessão aberta por outro processo');
{
  const terminal = abrir('a', { resume: id });
  await turno(terminal, 'a pessoa digitou no terminal');
  const [viva] = sessoesVivas(conta('a'));
  log('sessão viva:', JSON.stringify({ status: viva.status, kind: viva.kind, mesmoId: viva.sessionId === id, socket: !!viva.socket, token: !!viva.token }));
  const textos = [];
  terminal.on('texto', (t) => textos.push(t));
  const fim = esperar(terminal, 'fim');
  await entregar(viva, 'delegado pelo console');
  await fim;
  log('a sessão recebeu:', JSON.stringify(textos.join(' ').split('\n').slice(0, 2).join(' / ')));
  await encerrar(terminal);
}

api.kill();
writeFileSync(join(tmp, 'id.txt'), id);
log('\npasta da prova:', tmp);
