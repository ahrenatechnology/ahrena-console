#!/usr/bin/env node
// O MCP do núcleo por stdio, para quem só fala stdio (o `claude_desktop_config.json` do Claude
// Desktop). É uma ponte para o `/mcp` do núcleo que já roda (`npm run api`): o mesmo servidor e
// um só processo lendo o banco. `npm run mcp -- --help`.
//
// The core comes from the single owner (src/owner, #86): the bridge adopts the machine's core
// through the lock or, if nobody started one, starts one with `--parent` on itself. When the bridge
// exits (Claude Desktop closes), the core exits too, unless another client (the app, another
// bridge) is registered.

import { parseArgs } from 'node:util';
import { examine } from '../owner/owner.ts';
import { startOrAdopt } from '../owner/start.ts';
import { CAMINHO_DO_MCP } from './http.ts';
import { servidorSemNucleo } from './index.ts';
import { atenderPorStdio, ponteHttp } from './stdio.ts';

const AJUDA = `Uso: npm run mcp -- [opções]

  --porta <n>   Fala só com o núcleo desta porta, sem adotar nem subir (o modo de antes)
  --sem-subir   Adota o núcleo da trava, mas não sobe um se não houver
  --help

Sem --porta, a ponte adota o núcleo desta máquina (~/.ahrena-console/nucleo.json) ou sobe um na
AHRENA_CONSOLE_PORT ou 4720, com --pai nela: o núcleo sai quando a ponte e todos os clientes
registrados saem.

Lê JSON-RPC do stdin e responde no stdout, uma mensagem por linha. Sem o núcleo no ar, a lista de
ferramentas responde e cada chamada diz como subi-lo.
`;

const { values: o } = parseArgs({
  options: { porta: { type: 'string' }, 'sem-subir': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
});
if (o.help) {
  process.stdout.write(AJUDA);
  process.exit(0);
}
const fixa = o.porta !== undefined;
const porta = Number(o.porta ?? process.env.AHRENA_CONSOLE_PORT ?? 4720);
if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
  process.stderr.write(`--porta inválida: ${o.porta}\n`);
  process.exit(2);
}
const log = (m: string): void => {
  process.stderr.write(`[ahrena-console mcp] ${m}\n`);
};
const url = (p: number) => `http://127.0.0.1:${p}${CAMINHO_DO_MCP}`;

// A porta do núcleo: a da trava viva, conferida a cada pedido (o núcleo pode ter sido trocado).
async function portaDoNucleo(): Promise<number> {
  if (fixa) return porta;
  const ex = await examine();
  return ex.state === 'alive' ? ex.lock.port : porta;
}

// Adota ou sobe, em segundo plano: o `initialize` responde na hora, com o núcleo ou sem ele.
let subindo: Promise<void> | null = null;
function garantirNucleo(): void {
  if (fixa || o['sem-subir'] || subindo) return;
  subindo = startOrAdopt({ port: porta, parent: process.pid, log })
    .then((r) => log(r.estado === 'de-pe' ? `núcleo em ${r.url} (${r.subiu ? 'subiu agora' : 'adotado'})` : `o núcleo não subiu: ${r.motivo}`))
    .catch((e) => log(`o núcleo não subiu: ${(e as Error).message}`))
    .finally(() => {
      subindo = null;
    });
}
garantirNucleo();

const comoSubir = fixa
  ? `Suba com \`npm run api -- --porta ${porta}\` em packages/nucleo e chame de novo.`
  : o['sem-subir']
    ? 'Suba com `npm run core -- start` em packages/nucleo e chame de novo.'
    : 'A ponte está subindo o núcleo; chame de novo em alguns segundos.';
await atenderPorStdio({
  atender: async (m) => {
    const p = await portaDoNucleo();
    return ponteHttp(url(p), {
      semNucleo: (msg) => {
        // O núcleo caiu ou foi parado: na próxima, ele já está de pé de novo.
        garantirNucleo();
        return servidorSemNucleo(`O núcleo do Ahrena Console não respondeu em ${url(p)}. ${comoSubir}`).atender(msg);
      },
    })(m);
  },
  log,
});
