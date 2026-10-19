// API falsa para a prova do spike #106: responde /v1/messages em streaming com "ok".
import { createServer } from 'node:http';
const port = Number(process.argv[2] ?? 4799);
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    console.error(req.method, req.url);
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    const model = (() => { try { return JSON.parse(body).model; } catch { return 'claude-sintetico'; } })();
    const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      ev('message_start', { message: { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }) +
      ev('content_block_stop', { index: 0 }) +
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) +
      ev('message_stop', {}),
    );
  });
}).listen(port, '127.0.0.1');
