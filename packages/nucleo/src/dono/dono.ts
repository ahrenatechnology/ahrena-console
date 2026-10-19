// Um núcleo por máquina (decisão 0005; issue #86). Quem sobe primeiro serve; os outros adotam.
//
//   1. `examinar`: a trava diz pid e porta. Pid vivo e porta respondendo como núcleo: vivo.
//      Senão, a trava é órfã e quem está subindo a recupera.
//   2. `reservarPorta` (sonda.ts): só quem prende a porta abre o banco. Duas subidas ao mesmo tempo
//      dão um núcleo só, porque o sistema dá a porta a um; o outro espera o núcleo responder e adota.
//   3. `assumirTrava`: com a API já ouvindo, o núcleo grava a trava.
//   4. `vigiarPai`: com `--pai`, o núcleo sai quando o pai e todos os clientes registrados somem.

import { clientesVivos } from './clientes.ts';
import { compararVersoes, dormir, ehNucleo, pidVivo } from './sonda.ts';
import { gravarTrava, lerTrava, liberarTrava, novoToken, pastaPadrao, type Trava } from './trava.ts';

export type Exame =
  | { estado: 'ausente' }
  | { estado: 'vivo'; trava: Trava }
  | { estado: 'orfa'; trava: Trava | null; motivo: string };

export async function examinar(pasta = pastaPadrao()): Promise<Exame> {
  const t = lerTrava(pasta);
  if (t === null) return { estado: 'ausente' };
  if (t === 'invalida') return { estado: 'orfa', trava: null, motivo: 'trava ilegível' };
  if (!pidVivo(t.pid)) return { estado: 'orfa', trava: t, motivo: `o pid ${t.pid} não existe mais` };
  if (!(await ehNucleo(t.porta))) return { estado: 'orfa', trava: t, motivo: `a porta ${t.porta} não responde como núcleo` };
  return { estado: 'vivo', trava: t };
}

export type Plano =
  | { acao: 'adotar'; trava: Trava; aviso: string | null }
  | { acao: 'subir'; recuperou: string | null; substituiu: Trava | null };

export interface OpcoesDaSubida {
  pasta?: string;
  /** A versão de quem está subindo. */
  versao: string;
  /** Se o núcleo vivo for mais velho, para ele e sobe este. */
  substituir?: boolean;
  log?: (m: string) => void;
}

/** O que fazer antes de abrir o banco: adotar o núcleo vivo, ou subir (recuperando a trava órfã). */
export async function planejarSubida(o: OpcoesDaSubida): Promise<Plano> {
  const pasta = o.pasta ?? pastaPadrao();
  const ex = await examinar(pasta);
  if (ex.estado === 'ausente') return { acao: 'subir', recuperou: null, substituiu: null };
  if (ex.estado === 'orfa') return { acao: 'subir', recuperou: ex.motivo, substituiu: null };
  const vivo = ex.trava;
  if (compararVersoes(vivo.versao, o.versao) >= 0) return { acao: 'adotar', trava: vivo, aviso: null };
  if (!o.substituir) {
    return {
      acao: 'adotar',
      trava: vivo,
      aviso: `o núcleo de pé (pid ${vivo.pid}) é a versão ${vivo.versao}, mais velha que esta (${o.versao}). Ele continua servindo; para trocar, suba com --substituir`,
    };
  }
  o.log?.(`substituindo o núcleo ${vivo.versao} (pid ${vivo.pid}) por este, ${o.versao}`);
  if (!(await pararNucleo(vivo, { pasta }))) throw new Error(`o núcleo antigo (pid ${vivo.pid}) não saiu`);
  return { acao: 'subir', recuperou: null, substituiu: vivo };
}

/**
 * Grava a trava deste processo, com a API já ouvindo em `porta`. Se, entre o exame e aqui, outro
 * núcleo vivo gravou a dele (numa porta diferente), devolve-o: quem chamou fecha e adota.
 */
export async function assumirTrava(o: { pasta?: string; porta: number; versao: string; pai: number | null }): Promise<Trava | { conflito: Trava }> {
  const pasta = o.pasta ?? pastaPadrao();
  const ex = await examinar(pasta);
  if (ex.estado === 'vivo' && ex.trava.pid !== process.pid) return { conflito: ex.trava };
  const trava: Trava = { pid: process.pid, porta: o.porta, versao: o.versao, inicio: new Date().toISOString(), token: novoToken(), pai: o.pai };
  gravarTrava(trava, pasta);
  return trava;
}

/** SIGTERM; se em `timeoutMs` não saiu, SIGKILL. Apaga a trava se ela ainda é dele. */
export async function pararNucleo(t: Trava, o: { pasta?: string; timeoutMs?: number } = {}): Promise<boolean> {
  const pasta = o.pasta ?? pastaPadrao();
  const esperarSair = async (ms: number) => {
    const fim = Date.now() + ms;
    while (Date.now() < fim) {
      if (!pidVivo(t.pid)) return true;
      await dormir(50);
    }
    return !pidVivo(t.pid);
  };
  try {
    process.kill(t.pid, 'SIGTERM');
  } catch {
    /* já tinha saído */
  }
  let saiu = await esperarSair(o.timeoutMs ?? 10_000);
  if (!saiu) {
    try {
      process.kill(t.pid, 'SIGKILL');
    } catch {
      /* saiu agora */
    }
    saiu = await esperarSair(2000);
  }
  if (saiu) liberarTrava(t.token, pasta);
  return saiu;
}

export const INTERVALO_DO_PAI_MS = 1000;

/**
 * A regra do `--pai`: o núcleo fica de pé enquanto o pai **ou** algum cliente registrado viver.
 * Quando o pai some e não sobra cliente vivo, chama `aoSumir` (uma vez). Sem `--pai`, ninguém vigia:
 * o núcleo subido à mão no terminal só sai com `parar` ou Ctrl-C.
 */
export function vigiarPai(o: { pai: number; pasta?: string; intervaloMs?: number; aoSumir: (motivo: string) => void }): () => void {
  const pasta = o.pasta ?? pastaPadrao();
  let avisado = false;
  const timer = setInterval(() => {
    if (pidVivo(o.pai)) return;
    const vivos = clientesVivos(pasta);
    if (vivos.length) return;
    if (avisado) return;
    avisado = true;
    clearInterval(timer);
    o.aoSumir(`o pai (pid ${o.pai}) sumiu e não há cliente registrado`);
  }, o.intervaloMs ?? INTERVALO_DO_PAI_MS);
  timer.unref();
  return () => clearInterval(timer);
}
