// API falsa para a prova do spike #120. Responde /v1/messages em streaming com um eco:
// "eco #<n>: <último texto da pessoa>", em que n é quantas mensagens da pessoa a conversa
// já tem. Assim dá para ver, sem modelo nenhum, se a retomada trouxe o histórico.
// Texto com "devagar" demora ~4 s, em pedaços, para testar sessão ocupada e interrupção.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 4891);
const log = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const textos = (m) =>
  typeof m.content === 'string'
    ? [m.content]
    : m.content.filter((b) => b.type === 'text').map((b) => b.text);

// O CLI soma lembretes (<system-reminder>) ao turno: o texto da pessoa é o último bloco que não é lembrete.
const textoDaPessoa = (m) =>
  textos(m).filter((t) => !t.trimStart().startsWith('<system-reminder>')).at(-1) ?? '';

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    const pedido = JSON.parse(body);
    const daPessoa = pedido.messages.filter((m) => m.role === 'user' && textoDaPessoa(m));
    const ultimo = textoDaPessoa(daPessoa.at(-1) ?? { content: '' }).trim();
    // Pedidos auxiliares do CLI (título, sugestões) não têm ferramentas: respondem curto e não entram no log.
    const principal = Array.isArray(pedido.tools) && pedido.tools.length > 0;
    if (principal && log) appendFileSync(log, JSON.stringify({ n: daPessoa.length, ultimo }) + '\n');
    const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(ev('message_start', { message: { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model: pedido.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }));
    // "rode <comando>" pede a ferramenta Bash, para ver o pedido de permissão chegar ao chat.
    // O resultado da ferramenta pode vir junto de lembretes, depois da última resposta do assistente.
    const depois = pedido.messages.slice(pedido.messages.findLastIndex((m) => m.role === 'assistant') + 1);
    const resultado = depois.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result');
    if (principal && !resultado && ultimo.startsWith('rode ')) {
      res.write(ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_' + Date.now(), name: 'Bash', input: {} } }));
      res.write(ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: ultimo.slice(5), description: 'Comando da prova' }) } }));
      res.write(ev('content_block_stop', { index: 0 }));
      res.write(ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }));
      return res.end(ev('message_stop', {}));
    }
    const saida = resultado && (typeof resultado.content === 'string' ? resultado.content : resultado.content?.map((b) => b.text).join(''));
    const resposta = !principal ? 'Sessão de teste' : resultado ? `ferramenta devolveu: ${String(saida).trim()}` : `eco #${daPessoa.length}: ${ultimo}`;
    res.write(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
    const pedacos = principal && ultimo.includes('devagar') ? resposta.match(/.{1,6}/g) : [resposta];
    for (const p of pedacos) {
      if (res.destroyed) return;
      res.write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: p } }));
      if (pedacos.length > 1) await sleep(4000 / pedacos.length);
    }
    res.write(ev('content_block_stop', { index: 0 }));
    res.write(ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }));
    res.end(ev('message_stop', {}));
  });
}).listen(port, '127.0.0.1');
