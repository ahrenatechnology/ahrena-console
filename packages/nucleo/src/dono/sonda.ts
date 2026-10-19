// O que diz se um núcleo está vivo: o pid existe e a porta responde `/api/overview` com o nome
// `ahrena-console`. Uma coisa sem a outra é trava órfã (o pid foi reaproveitado, ou a porta mudou).

import { get } from 'node:http';
import { createServer, type Server } from 'node:net';

export const NOME_DO_NUCLEO = 'ahrena-console';

export function pidVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: existe, mas é de outro usuário.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface Visao {
  nome: string;
  versao: string;
  /** O pid de quem responde. `null` num núcleo de antes da #86. */
  pid: number | null;
  /** O commit do código no ar, se ele sabe. */
  commit: string | null;
}

/** `GET /api/overview` em 127.0.0.1. `null` se ninguém responde, ou se não é JSON. */
export function sondar(porta: number, timeoutMs = 1000): Promise<Visao | null> {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port: porta, path: '/api/overview', timeout: timeoutMs }, (res) => {
      let corpo = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        corpo += c;
        if (corpo.length > 64 * 1024) req.destroy();
      });
      res.on('end', () => {
        try {
          const v = JSON.parse(corpo) as Partial<Visao>;
          resolve(
            typeof v.nome === 'string'
              ? {
                  nome: v.nome,
                  versao: typeof v.versao === 'string' ? v.versao : '?',
                  pid: Number.isInteger(v.pid) ? v.pid! : null,
                  commit: typeof v.commit === 'string' ? v.commit : null,
                }
              : null,
          );
        } catch {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

export async function ehNucleo(porta: number, timeoutMs = 1000): Promise<Visao | null> {
  const v = await sondar(porta, timeoutMs);
  return v?.nome === NOME_DO_NUCLEO ? v : null;
}

/** -1, 0 ou 1, comparando `a.b.c` por número; o que vem depois de `-` ou `+` não conta. */
export function compararVersoes(a: string, b: string): number {
  const partes = (v: string) => v.split(/[-+]/)[0].split('.').map((p) => Number.parseInt(p, 10) || 0);
  const x = partes(a);
  const y = partes(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * Prende a porta em 127.0.0.1 antes de abrir o banco. É o que garante um núcleo só quando dois
 * sobem ao mesmo tempo: o sistema dá a porta a um, e o outro adota. `'ocupada'` se já tem dono.
 */
export function reservarPorta(porta: number): Promise<Server | 'ocupada'> {
  return new Promise((resolve, reject) => {
    const s = createServer((c) => c.destroy());
    s.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? resolve('ocupada') : reject(e)));
    s.listen({ port: porta, host: '127.0.0.1', exclusive: true }, () => resolve(s));
  });
}

export function soltarPorta(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

export const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Espera a porta responder como núcleo. `null` se o tempo acaba. */
export async function esperarNucleo(porta: number, timeoutMs: number): Promise<Visao | null> {
  const fim = Date.now() + timeoutMs;
  while (Date.now() < fim) {
    const v = await ehNucleo(porta, 500);
    if (v) return v;
    await dormir(100);
  }
  return null;
}
