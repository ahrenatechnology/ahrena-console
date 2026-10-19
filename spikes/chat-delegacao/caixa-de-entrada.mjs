// Entrega um prompt a uma sessão do Claude Code que já está aberta (num terminal, por exemplo),
// pela caixa de entrada da mensageria entre sessões (spike #120). A sessão viva se anuncia em
// $CLAUDE_CONFIG_DIR/sessions/<pid>.json com status e messagingSocketPath; o token fica no
// <pid>.<hash>.key ao lado. O formato da linha é o do exemplo embutido no CLI 2.1.302: uma linha
// de auth e uma mensagem de usuário em stream-json. Não documentado como interface estável.
import { connect } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function sessoesVivas(configDir) {
  const dir = join(configDir, 'sessions');
  let nomes = [];
  try { nomes = readdirSync(dir); } catch { return []; }
  return nomes.filter((n) => /^\d+\.json$/.test(n)).map((n) => {
    const s = JSON.parse(readFileSync(join(dir, n), 'utf8'));
    const chave = nomes.find((k) => k.startsWith(`${s.pid}.`) && k.endsWith('.key'));
    const token = chave ? JSON.parse(readFileSync(join(dir, chave), 'utf8')).peerToken : undefined;
    return { pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, status: s.status, kind: s.kind, socket: s.messagingSocketPath, token };
  });
}

export function entregar({ socket, token }, texto) {
  return new Promise((ok, falha) => {
    const c = connect(socket, () => {
      if (token) c.write(JSON.stringify({ type: 'auth', token }) + '\n');
      c.end(JSON.stringify({ type: 'user', message: { role: 'user', content: texto } }) + '\n');
    });
    let resposta = '';
    c.on('data', (d) => (resposta += d));
    c.on('close', () => ok(resposta.trim()));
    c.on('error', falha);
  });
}
