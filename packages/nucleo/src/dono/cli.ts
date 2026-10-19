#!/usr/bin/env node
// O comando do núcleo para o app, a extensão e o terminal: `npm run nucleo -- status|subir|parar`.
// `subir` adota o núcleo vivo ou sobe um em segundo plano e só volta quando ele responde.

import { parseArgs } from 'node:util';
import { examinar, pararNucleo } from './dono.ts';
import { pidVivo } from './sonda.ts';
import { dePe, subirOuAdotar, type Saida } from './subir.ts';
import { pastaPadrao, tirarTrava, type Trava } from './trava.ts';

const AJUDA = `Uso: npm run nucleo -- <comando> [opções] [-- opções da API]

  status              Diz se há um núcleo de pé nesta máquina. Sai com 0 se há, 1 se não
  subir               Adota o núcleo de pé ou sobe um em segundo plano (log em
                      ~/.ahrena-console/nucleo.log) e espera ele responder
  parar               Para o núcleo de pé (SIGTERM, depois SIGKILL) e apaga a trava

  --porta <n>         Para subir. Padrão AHRENA_CONSOLE_PORT ou 4720. Se já há núcleo, vale o dele
  --pai <pid>         Para subir: o núcleo sai quando este processo some, a menos que outro cliente
                      esteja registrado. Se adotar, registra o pid como cliente
  --substituir        Para subir: troca o núcleo de pé se ele for mais velho que este (versão
                      ou commit ancestral). De outro código, só avisa
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

function sair(s: Saida, texto: string, codigo = 0): never {
  process.stdout.write(o.json ? `${JSON.stringify(s)}\n` : `${texto}\n`);
  process.exit(codigo);
}

const linha = (t: Trava, como: string) => `núcleo de pé em http://127.0.0.1:${t.porta} · versão ${t.versao} · pid ${t.pid} (${como})`;

async function status(): Promise<never> {
  const ex = await examinar(pasta);
  if (ex.estado === 'vivo') sair(dePe(ex.trava, { commit: ex.visao.commit }), linha(ex.trava, `desde ${ex.trava.inicio}`));
  if (ex.estado === 'orfa') sair({ estado: 'parado', motivo: `trava órfã: ${ex.motivo}` }, `nenhum núcleo de pé (trava órfã: ${ex.motivo})`, 1);
  sair({ estado: 'parado' }, 'nenhum núcleo de pé', 1);
}

async function parar(): Promise<never> {
  const ex = await examinar(pasta);
  if (ex.estado === 'ausente') sair({ estado: 'parado' }, 'nenhum núcleo de pé');
  if (ex.estado === 'orfa') {
    tirarTrava(ex.trava?.token ?? null, pasta);
    sair({ estado: 'parado', motivo: `trava órfã apagada: ${ex.motivo}` }, `nenhum núcleo de pé; trava órfã apagada (${ex.motivo})`);
  }
  if (!(await pararNucleo(ex.trava, { pasta }))) sair({ estado: 'de-pe', pid: ex.trava.pid, motivo: 'não saiu' }, `o núcleo (pid ${ex.trava.pid}) não saiu`, 1);
  sair({ estado: 'parado', pid: ex.trava.pid }, `núcleo parado (pid ${ex.trava.pid})`);
}

async function subir(): Promise<never> {
  const pai = o.pai === undefined ? null : Number(o.pai);
  if (pai !== null && !(Number.isInteger(pai) && pai > 0 && pidVivo(pai))) throw new Error('--pai: o pid de um processo vivo');
  const porta = Number(o.porta ?? process.env.AHRENA_CONSOLE_PORT ?? 4720);
  const s = await subirOuAdotar({ pasta, porta, pai, substituir: o.substituir, repasse, log });
  if (s.estado !== 'de-pe') sair(s, `o núcleo não subiu: ${s.motivo}`, 1);
  const como = s.subiu ? 'subiu agora' : 'adotado';
  sair(s, `núcleo de pé em ${s.url} · versão ${s.versao}${s.commit ? ` (${s.commit})` : ''}${s.pid ? ` · pid ${s.pid}` : ''} (${como})`);
}

if (comando === 'status') await status();
else if (comando === 'subir') await subir();
else if (comando === 'parar') await parar();
else {
  process.stderr.write(`comando desconhecido: ${comando}\n\n${AJUDA}`);
  process.exit(2);
}
