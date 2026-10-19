#!/usr/bin/env node
// O comando do núcleo para o app, a extensão e o terminal: `npm run nucleo -- status|subir|parar`.
// `subir` adota o núcleo vivo ou sobe um em segundo plano e só volta quando ele responde.

import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { VERSAO_DA_API } from '../api/servidor.ts';
import { registrarCliente } from './clientes.ts';
import { examinar, pararNucleo, planejarSubida } from './dono.ts';
import { dormir, ehNucleo, pidVivo } from './sonda.ts';
import { apagarTrava, pastaPadrao, type Trava } from './trava.ts';

const AJUDA = `Uso: npm run nucleo -- <comando> [opções] [-- opções da API]

  status              Diz se há um núcleo de pé nesta máquina. Sai com 0 se há, 1 se não
  subir               Adota o núcleo de pé ou sobe um em segundo plano (log em
                      ~/.ahrena-console/nucleo.log) e espera ele responder
  parar               Para o núcleo de pé (SIGTERM, depois SIGKILL) e apaga a trava

  --porta <n>         Para subir. Padrão AHRENA_CONSOLE_PORT ou 4720. Se já há núcleo, vale o dele
  --pai <pid>         Para subir: o núcleo sai quando este processo some, a menos que outro cliente
                      esteja registrado. Se adotar, registra o pid como cliente
  --substituir        Para subir: troca o núcleo de pé se ele for mais velho que este
  --json              Uma linha JSON na saída, para o app e a extensão
  --help

Depois de --, as opções vão para a API (npm run api -- --help), por exemplo -- --sem-github.
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    porta: { type: 'string' },
    pai: { type: 'string' },
    substituir: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
const [comando, ...repasse] = positionals;
if (o.help || !comando) {
  process.stdout.write(AJUDA);
  process.exit(o.help ? 0 : 2);
}

const log = (m: string) => console.error(`[ahrena-console] ${m}`);
const pasta = pastaPadrao();

interface Saida {
  estado: 'de-pe' | 'parado';
  url?: string;
  porta?: number;
  pid?: number;
  versao?: string;
  inicio?: string;
  pai?: number | null;
  /** Em `subir`: `true` se este comando subiu o núcleo; `false` se adotou um que já estava de pé. */
  subiu?: boolean;
  aviso?: string;
  motivo?: string;
}

function sair(s: Saida, texto: string, codigo = 0): never {
  process.stdout.write(o.json ? `${JSON.stringify(s)}\n` : `${texto}\n`);
  process.exit(codigo);
}

const dePe = (t: Trava, extra: Partial<Saida> = {}): Saida => ({
  estado: 'de-pe',
  url: `http://127.0.0.1:${t.porta}`,
  porta: t.porta,
  pid: t.pid,
  versao: t.versao,
  inicio: t.inicio,
  pai: t.pai,
  ...extra,
});
const linha = (t: Trava, como: string) => `núcleo de pé em http://127.0.0.1:${t.porta} · versão ${t.versao} · pid ${t.pid} (${como})`;

async function status(): Promise<never> {
  const ex = await examinar(pasta);
  if (ex.estado === 'vivo') sair(dePe(ex.trava), linha(ex.trava, `desde ${ex.trava.inicio}`));
  if (ex.estado === 'orfa') sair({ estado: 'parado', motivo: `trava órfã: ${ex.motivo}` }, `nenhum núcleo de pé (trava órfã: ${ex.motivo})`, 1);
  sair({ estado: 'parado' }, 'nenhum núcleo de pé', 1);
}

async function parar(): Promise<never> {
  const ex = await examinar(pasta);
  if (ex.estado === 'ausente') sair({ estado: 'parado' }, 'nenhum núcleo de pé');
  if (ex.estado === 'orfa') {
    apagarTrava(pasta);
    sair({ estado: 'parado', motivo: `trava órfã apagada: ${ex.motivo}` }, `nenhum núcleo de pé; trava órfã apagada (${ex.motivo})`);
  }
  if (!(await pararNucleo(ex.trava, { pasta }))) sair({ estado: 'de-pe', pid: ex.trava.pid, motivo: 'não saiu' }, `o núcleo (pid ${ex.trava.pid}) não saiu`, 1);
  sair({ estado: 'parado', pid: ex.trava.pid }, `núcleo parado (pid ${ex.trava.pid})`);
}

async function subir(): Promise<never> {
  const pai = o.pai === undefined ? null : Number(o.pai);
  if (pai !== null && !(Number.isInteger(pai) && pai > 0 && pidVivo(pai))) throw new Error('--pai: o pid de um processo vivo');
  const porta = Number(o.porta ?? process.env.AHRENA_CONSOLE_PORT ?? 4720);

  const plano = await planejarSubida({ pasta, versao: VERSAO_DA_API, substituir: o.substituir, log });
  if (plano.acao === 'adotar') {
    if (plano.aviso) log(`atenção: ${plano.aviso}`);
    if (pai !== null) registrarCliente(pai, pasta);
    sair(dePe(plano.trava, { subiu: false, ...(plano.aviso ? { aviso: plano.aviso } : {}) }), linha(plano.trava, 'adotado'));
  }

  // O núcleo roda à parte, sem prender este processo nem o terminal.
  mkdirSync(pasta, { recursive: true, mode: 0o700 });
  const saida = openSync(join(pasta, 'nucleo.log'), 'a', 0o600);
  const api = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'cli.ts');
  const args = ['--disable-warning=ExperimentalWarning', api, '--porta', String(porta), ...(pai !== null ? ['--pai', String(pai)] : []), ...repasse];
  const filho = spawn(process.execPath, args, { detached: true, stdio: ['ignore', saida, saida] });
  let codigo: number | null = null;
  filho.on('exit', (c) => (codigo = c ?? 1));
  filho.unref();

  const fim = Date.now() + 60_000;
  while (Date.now() < fim) {
    const ex = await examinar(pasta);
    if (ex.estado === 'vivo') {
      const subiu = ex.trava.pid === filho.pid;
      // Outro subiu junto e ganhou a porta: este adota, como o filho adotou.
      if (!subiu && pai !== null) registrarCliente(pai, pasta);
      sair(dePe(ex.trava, { subiu }), linha(ex.trava, subiu ? 'subiu agora' : 'adotado'));
    }
    if (codigo !== null && codigo !== 0) sair({ estado: 'parado', motivo: `o núcleo saiu com código ${codigo}; veja ${join(pasta, 'nucleo.log')}` }, `o núcleo não subiu (código ${codigo}); veja ${join(pasta, 'nucleo.log')}`, 1);
    // O filho adotou um núcleo sem trava (uma --demo ou --sem-trava na mesma porta).
    if (codigo === 0) {
      const v = await ehNucleo(porta);
      if (v) sair({ estado: 'de-pe', url: `http://127.0.0.1:${porta}`, porta, versao: v.versao, subiu: false }, `núcleo de pé em http://127.0.0.1:${porta} · versão ${v.versao} (adotado, sem trava)`);
    }
    await dormir(100);
  }
  sair({ estado: 'parado', motivo: 'o núcleo não respondeu em 60 s' }, 'o núcleo não respondeu em 60 s', 1);
}

if (comando === 'status') await status();
else if (comando === 'subir') await subir();
else if (comando === 'parar') await parar();
else {
  process.stderr.write(`comando desconhecido: ${comando}\n\n${AJUDA}`);
  process.exit(2);
}
