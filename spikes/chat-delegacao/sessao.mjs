// Uma sessão do Claude Code CLI conversando em stream-json, como o núcleo faria (spike #120).
// É o mesmo protocolo que o Agent SDK usa por baixo: uma linha JSON por mensagem em stdin e stdout,
// com control_request / control_response para interromper e para os pedidos de permissão.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/**
 * @param {object} o
 * @param {string} o.configDir  pasta de configuração da conta (CLAUDE_CONFIG_DIR)
 * @param {string} o.cwd        pasta do projeto
 * @param {string} [o.resume]   id da sessão a retomar
 * @param {string} [o.sessionId] id escolhido para uma sessão nova
 * @param {boolean} [o.fork]    retomar numa sessão nova (--fork-session)
 * @param {object} [o.env]      ambiente extra (na prova: a API falsa)
 */
export function abrirSessao({ configDir, cwd, resume, sessionId, fork, env = {}, claude = 'claude', args = [] }) {
  const ev = new EventEmitter();
  const argv = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    // Os pedidos de permissão vêm para este processo (o "host"), como no Agent SDK.
    '--permission-prompt-tool', 'stdio', ...args];
  if (resume) argv.push('--resume', resume);
  if (sessionId) argv.push('--session-id', sessionId);
  if (fork) argv.push('--fork-session');
  const filho = spawn(claude, argv, { cwd, env: { ...env, CLAUDE_CONFIG_DIR: configDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  filho.stderr.on('data', (c) => (stderr += c));
  const pendentes = new Map();
  const escrever = (o) => filho.stdin.write(JSON.stringify(o) + '\n');
  const controle = (request) => {
    const request_id = randomUUID();
    escrever({ type: 'control_request', request_id, request });
    return new Promise((ok) => pendentes.set(request_id, ok));
  };

  createInterface({ input: filho.stdout }).on('line', (linha) => {
    let m;
    try { m = JSON.parse(linha); } catch { return; }
    if (m.type === 'control_response') {
      const id = m.response?.request_id;
      pendentes.get(id)?.(m.response);
      pendentes.delete(id);
      return;
    }
    if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
      const responder = (behavior, extra = {}) => escrever({
        type: 'control_response',
        response: { subtype: 'success', request_id: m.request_id,
          response: behavior === 'allow' ? { behavior, updatedInput: m.request.input, ...extra } : { behavior, message: extra.message ?? 'Negado pelo console' } },
      });
      ev.emit('permissao', { ferramenta: m.request.tool_name, entrada: m.request.input, responder });
      return;
    }
    if (m.type === 'system' && m.subtype === 'init') ev.emit('init', m);
    if (m.type === 'assistant') {
      for (const b of m.message.content) if (b.type === 'text') ev.emit('texto', b.text);
    }
    if (m.type === 'result') ev.emit('fim', m);
    ev.emit('mensagem', m);
  });
  filho.on('exit', (code) => ev.emit('saiu', { code, stderr }));

  return Object.assign(ev, {
    pid: filho.pid,
    // priority: 'next' (padrão: entra no turno em curso), 'later' (vira turno novo), 'now' (interrompe)
    enviar(texto, { priority } = {}) {
      escrever({ type: 'user', message: { role: 'user', content: texto }, parent_tool_use_id: null,
        origin: { kind: 'human' }, ...(priority ? { priority } : {}) });
    },
    interromper: () => controle({ subtype: 'interrupt' }),
    fechar() { filho.stdin.end(); },
    matar() { filho.kill('SIGTERM'); },
  });
}

export const esperar = (ev, nome) => new Promise((ok) => ev.once(nome, ok));
