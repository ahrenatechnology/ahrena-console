// `subir` como função, para o comando (cli.ts) e para quem fala com o núcleo por outro processo (a
// ponte stdio do MCP, a extensão): adota o núcleo vivo ou sobe um em segundo plano e espera responder.

import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSAO_DA_API } from '../api/versao.ts';
import { registrarCliente } from './clientes.ts';
import { commitDoCodigo, commitMaisVelho } from './codigo.ts';
import { avisoDeCodigo, examinar, planejarSubida } from './dono.ts';
import { dormir, ehNucleo } from './sonda.ts';
import { pastaPadrao, prepararPasta, type Trava } from './trava.ts';

export interface Saida {
  estado: 'de-pe' | 'parado';
  url?: string;
  porta?: number;
  pid?: number | null;
  versao?: string;
  commit?: string | null;
  inicio?: string;
  pai?: number | null;
  /** `true` se esta chamada subiu o núcleo; `false` se adotou um que já estava de pé. */
  subiu?: boolean;
  aviso?: string;
  motivo?: string;
}

export interface OpcoesDoSubir {
  pasta?: string;
  /** A porta para subir, se ninguém está de pé. Se há núcleo, vale a dele. */
  porta: number;
  pai?: number | null;
  substituir?: boolean;
  /** Opções a mais para a API (`src/api/cli.ts`). */
  repasse?: string[];
  log?: (m: string) => void;
  timeoutMs?: number;
}

export const dePe = (t: Trava, extra: Partial<Saida> = {}): Saida => ({
  estado: 'de-pe',
  url: `http://127.0.0.1:${t.porta}`,
  porta: t.porta,
  pid: t.pid,
  versao: t.versao,
  inicio: t.inicio,
  pai: t.pai,
  ...extra,
});

export async function subirOuAdotar(o: OpcoesDoSubir): Promise<Saida> {
  const pasta = o.pasta ?? pastaPadrao();
  const pai = o.pai ?? null;
  const codigo = { versao: VERSAO_DA_API, commit: commitDoCodigo(), commitMaisVelho };
  const adotou = (s: Saida): Saida => {
    if (pai !== null) registrarCliente(pai, pasta);
    if (s.aviso) o.log?.(`atenção: ${s.aviso}`);
    return s;
  };

  const plano = await planejarSubida({ pasta, ...codigo, substituir: o.substituir, log: o.log });
  if (plano.acao === 'adotar') {
    return adotou(dePe(plano.trava, { subiu: false, commit: plano.visao.commit, ...(plano.aviso ? { aviso: plano.aviso } : {}) }));
  }

  // O núcleo roda à parte, sem prender quem chamou nem o terminal.
  prepararPasta(pasta);
  const log = join(pasta, 'nucleo.log');
  const saida = openSync(log, 'a', 0o600);
  const api = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'cli.ts');
  const args = ['--disable-warning=ExperimentalWarning', api, '--porta', String(o.porta), ...(pai !== null ? ['--pai', String(pai)] : []), ...(o.repasse ?? [])];
  const filho = spawn(process.execPath, args, { detached: true, stdio: ['ignore', saida, saida] });
  let codigoDeSaida: number | null = null;
  filho.on('exit', (c) => (codigoDeSaida = c ?? 1));
  filho.unref();

  const fim = Date.now() + (o.timeoutMs ?? 60_000);
  while (Date.now() < fim) {
    const ex = await examinar(pasta);
    if (ex.estado === 'vivo') {
      const subiu = ex.trava.pid === filho.pid;
      const extra = { subiu, commit: ex.visao.commit };
      // Outro subiu junto e ganhou a porta: esta chamada adota, como o filho adotou.
      if (subiu) return dePe(ex.trava, extra);
      const aviso = avisoDeCodigo({ versao: ex.trava.versao, commit: ex.visao.commit, pid: ex.trava.pid }, codigo);
      return adotou(dePe(ex.trava, { ...extra, ...(aviso ? { aviso } : {}) }));
    }
    if (codigoDeSaida !== null && codigoDeSaida !== 0) return { estado: 'parado', motivo: `o núcleo saiu com código ${codigoDeSaida}; veja ${log}` };
    // O filho adotou um núcleo sem trava (uma --demo ou --sem-trava, ou um de antes da #86).
    if (codigoDeSaida === 0) {
      const v = await ehNucleo(o.porta);
      if (v) {
        const aviso = [
          'o núcleo nesta porta não tem trava (uma --demo, uma --sem-trava ou um núcleo de antes da #86)',
          avisoDeCodigo(v, codigo),
        ].filter(Boolean).join('; ');
        return adotou({ estado: 'de-pe', url: `http://127.0.0.1:${o.porta}`, porta: o.porta, pid: v.pid, versao: v.versao, commit: v.commit, subiu: false, aviso });
      }
    }
    await dormir(100);
  }
  return { estado: 'parado', motivo: `o núcleo não respondeu em ${Math.round((o.timeoutMs ?? 60_000) / 1000)} s; veja ${log}` };
}
