#!/usr/bin/env node
// O MCP do núcleo por stdio, para quem só fala stdio (o `claude_desktop_config.json` do Claude
// Desktop). É uma ponte para o `/mcp` do núcleo que já roda (`npm run api`): o mesmo servidor e
// um só processo lendo o banco. `npm run mcp -- --help`.

import { parseArgs } from 'node:util';
import { CAMINHO_DO_MCP } from './http.ts';
import { servidorSemNucleo } from './index.ts';
import { atenderPorStdio, ponteHttp } from './stdio.ts';

const AJUDA = `Uso: npm run mcp -- [opções]

  --porta <n>   Porta do núcleo em 127.0.0.1. Padrão AHRENA_CONSOLE_PORT ou 4720
  --help

Lê JSON-RPC do stdin e responde no stdout, uma mensagem por linha. Sem o núcleo no ar, a lista de
ferramentas responde e cada chamada diz como subi-lo.
`;

const { values: o } = parseArgs({ options: { porta: { type: 'string' }, help: { type: 'boolean', default: false } } });
if (o.help) {
  process.stdout.write(AJUDA);
  process.exit(0);
}
const porta = Number(o.porta ?? process.env.AHRENA_CONSOLE_PORT ?? 4720);
if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
  process.stderr.write(`--porta inválida: ${o.porta}\n`);
  process.exit(2);
}
const url = `http://127.0.0.1:${porta}${CAMINHO_DO_MCP}`;
const semNucleo = servidorSemNucleo(`O núcleo do Ahrena Console não respondeu em ${url}. Suba com \`npm run api\` em packages/nucleo e chame de novo.`);
await atenderPorStdio({
  atender: ponteHttp(url, { semNucleo: (m) => semNucleo.atender(m) }),
  log: (m) => process.stderr.write(`[ahrena-console mcp] ${m}\n`),
});
