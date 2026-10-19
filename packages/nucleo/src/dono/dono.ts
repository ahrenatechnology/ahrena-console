// Um núcleo por máquina (decisão 0005; issue #86). Quem sobe primeiro serve; os outros adotam.
//
//   1. `examinar`: a trava diz pid e porta. É viva se a porta responde como núcleo **com o mesmo
//      pid** (o `/api/overview` diz quem é). Senão, a trava é órfã e quem está subindo a recupera.
//   2. `reservarPorta` (sonda.ts): só quem prende a porta abre o banco. Duas subidas ao mesmo tempo
//      dão um núcleo só, porque o sistema dá a porta a um; o outro espera o núcleo responder e adota.
//   3. `assumirTrava`: com a API já ouvindo, o núcleo cria a trava (exclusiva).
//   4. `vigiarPai`: com `--pai`, o núcleo sai quando o pai e todos os clientes registrados somem.

import { execFileSync } from 'node:child_process';
import { clientesVivos } from './clientes.ts';
import { compararVersoes, dormir, ehNucleo, pidVivo, type Visao } from './sonda.ts';
import { criarTrava, liberarTrava, novoToken, pastaPadrao, lerTrava, tirarTrava, type Trava } from './trava.ts';

export type Exame =
  | { estado: 'ausente' }
  | { estado: 'vivo'; trava: Trava; visao: Visao }
  | { estado: 'orfa'; trava: Trava | null; motivo: string };

export async function examinar(pasta = pastaPadrao()): Promise<Exame> {
  const t = lerTrava(pasta);
  if (t === null) return { estado: 'ausente' };
  if (t === 'invalida') return { estado: 'orfa', trava: null, motivo: 'trava ilegível' };
  if (!pidVivo(t.pid)) return { estado: 'orfa', trava: t, motivo: `o pid ${t.pid} não existe mais` };
  const visao = await ehNucleo(t.porta);
  if (!visao) return { estado: 'orfa', trava: t, motivo: `a porta ${t.porta} não responde como núcleo` };
  // O pid da trava pode ter sido reaproveitado por outro processo, com outro núcleo na porta.
  if (visao.pid !== t.pid) return { estado: 'orfa', trava: t, motivo: `a porta ${t.porta} é de outro processo (pid ${visao.pid ?? '?'}), não do pid ${t.pid}` };
  return { estado: 'vivo', trava: t, visao };
}

/** Quem está subindo: a versão e o commit do código (src/dono/codigo.ts). */
export interface Codigo {
  versao: string;
  commit: string | null;
  /** `true` se o commit dado é mais velho que este (ancestral). Sem ela, nenhum é. */
  commitMaisVelho?: (commit: string) => boolean;
}

export type Comparacao = 'igual' | 'mais-novo' | 'mais-velho' | 'outro-codigo';

/** Compara o núcleo no ar com quem está subindo: pela versão e, na mesma versão, pelo commit. */
export function compararCodigo(noAr: { versao: string; commit: string | null }, eu: Codigo): Comparacao {
  const v = compararVersoes(noAr.versao, eu.versao);
  if (v > 0) return 'mais-novo';
  if (v < 0) return 'mais-velho';
  if (!noAr.commit || !eu.commit || noAr.commit === eu.commit) return 'igual';
  return eu.commitMaisVelho?.(noAr.commit) ? 'mais-velho' : 'outro-codigo';
}

/** O aviso para quem adota um núcleo de outro código. `null` se é o mesmo (ou mais novo). */
export function avisoDeCodigo(noAr: { versao: string; commit: string | null; pid: number | null }, eu: Codigo): string | null {
  const c = compararCodigo(noAr, eu);
  const quem = `o núcleo de pé${noAr.pid ? ` (pid ${noAr.pid})` : ''}`;
  if (c === 'mais-velho' && compararVersoes(noAr.versao, eu.versao) < 0) {
    return `${quem} é a versão ${noAr.versao}, mais velha que esta (${eu.versao}). Ele continua servindo; para trocar, suba com --substituir`;
  }
  if (c === 'mais-velho') {
    return `${quem} roda o commit ${noAr.commit}, mais velho que este (${eu.commit}). Ele continua servindo; para trocar, suba com --substituir`;
  }
  if (c === 'outro-codigo') {
    return `${quem} roda o commit ${noAr.commit}, que não é este (${eu.commit}) nem um ancestral dele. Ele continua servindo; pare-o (npm run nucleo -- parar) para subir este`;
  }
  return null;
}

export type Plano =
  | { acao: 'adotar'; trava: Trava; visao: Visao; aviso: string | null }
  | { acao: 'subir'; recuperou: string | null; substituiu: Trava | null };

export interface OpcoesDaSubida extends Codigo {
  pasta?: string;
  /** Se o núcleo vivo for mais velho (versão ou commit ancestral), para ele e sobe este. */
  substituir?: boolean;
  log?: (m: string) => void;
}

/** O que fazer antes de abrir o banco: adotar o núcleo vivo, ou subir (recuperando a trava órfã). */
export async function planejarSubida(o: OpcoesDaSubida): Promise<Plano> {
  const pasta = o.pasta ?? pastaPadrao();
  const ex = await examinar(pasta);
  if (ex.estado === 'ausente') return { acao: 'subir', recuperou: null, substituiu: null };
  if (ex.estado === 'orfa') return { acao: 'subir', recuperou: ex.motivo, substituiu: null };
  const noAr = { versao: ex.trava.versao, commit: ex.visao.commit, pid: ex.trava.pid };
  if (compararCodigo(noAr, o) !== 'mais-velho' || !o.substituir) {
    return { acao: 'adotar', trava: ex.trava, visao: ex.visao, aviso: avisoDeCodigo(noAr, o) };
  }
  o.log?.(`substituindo o núcleo ${noAr.versao}${noAr.commit ? ` (${noAr.commit})` : ''}, pid ${noAr.pid}, por este`);
  if (!(await pararNucleo(ex.trava, { pasta }))) throw new Error(`o núcleo antigo (pid ${noAr.pid}) não saiu`);
  return { acao: 'subir', recuperou: null, substituiu: ex.trava };
}

/**
 * Cria a trava deste processo, com a API já ouvindo em `porta`. A criação é exclusiva: se há uma
 * trava viva de outro núcleo (subiu ao mesmo tempo, noutra porta), devolve-a, e quem chamou fecha e
 * adota. Uma trava órfã sai do lugar (só se ainda é a mesma) e a criação tenta de novo.
 */
export async function assumirTrava(o: { pasta?: string; porta: number; versao: string; pai: number | null }): Promise<Trava | { conflito: Trava }> {
  const pasta = o.pasta ?? pastaPadrao();
  const trava: Trava = { pid: process.pid, porta: o.porta, versao: o.versao, inicio: new Date().toISOString(), token: novoToken(), pai: o.pai };
  for (let tentativa = 0; tentativa < 10; tentativa++) {
    if (criarTrava(trava, pasta)) return trava;
    const ex = await examinar(pasta);
    if (ex.estado === 'vivo') {
      if (ex.trava.pid === process.pid) return ex.trava;
      return { conflito: ex.trava };
    }
    if (ex.estado === 'orfa') tirarTrava(ex.trava?.token ?? null, pasta);
  }
  throw new Error('não consegui criar a trava: outra subida a troca sem parar');
}

/** Para só se a porta ainda responde como este núcleo; ou, sem resposta, se o pid ainda roda a API. */
async function aindaEhONucleo(t: Trava): Promise<boolean> {
  if (!pidVivo(t.pid)) return false;
  const v = await ehNucleo(t.porta, 500);
  if (v) return v.pid === t.pid;
  // A porta já fechou (o núcleo está saindo) ou travou: confere o comando do processo.
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(t.pid)], { encoding: 'utf8', timeout: 2_000 });
    return /node/.test(cmd) && /src[/\\]api[/\\]cli\.ts/.test(cmd);
  } catch {
    return false;
  }
}

/**
 * SIGTERM; se em `timeoutMs` não saiu, SIGKILL. Antes de cada sinal, confere que o pid ainda é
 * o do núcleo (nunca um processo que herdou o número). Apaga a trava se ela ainda é dele.
 * `false` se não era o núcleo ou se ele não saiu.
 */
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
  const sinal = async (s: NodeJS.Signals) => {
    if (!(await aindaEhONucleo(t))) return false;
    try {
      process.kill(t.pid, s);
    } catch {
      /* saiu agora */
    }
    return true;
  };
  if (!(await sinal('SIGTERM'))) {
    if (pidVivo(t.pid)) return false;
    liberarTrava(t.token, pasta);
    return true;
  }
  let saiu = await esperarSair(o.timeoutMs ?? 10_000);
  if (!saiu && (await sinal('SIGKILL'))) saiu = await esperarSair(2000);
  if (saiu) liberarTrava(t.token, pasta);
  return saiu;
}

export const INTERVALO_DO_PAI_MS = 1000;

/**
 * A regra do `--pai`: o núcleo fica de pé enquanto o pai **ou** algum cliente registrado viver.
 * Quando o pai some e não sobra cliente vivo, chama `aoSumir` (uma vez). Sem `--pai`, ninguém vigia:
 * o núcleo subido à mão no terminal só sai com `parar` ou Ctrl-C.
 *
 * O pai é conferido pelo pid. Se ele morrer e o número for reaproveitado por outro processo antes da
 * próxima volta (um segundo), o núcleo não percebe e fica de pé: o erro é ficar, nunca sair à toa
 * nem sinalizar o processo novo. O mesmo vale para os clientes registrados.
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
