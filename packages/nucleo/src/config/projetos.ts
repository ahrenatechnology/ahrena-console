// Os projetos que a tela Agent Config pode abrir: os `cwd` das sessões que o núcleo já viu, das
// mais recentes para as mais velhas, sem repetir. Só entra caminho absoluto que existe como pasta
// nesta máquina (uma sessão por SSH tem o cwd da máquina remota). O `?projeto=` da rota só aceita
// um destes: o pedido nunca escolhe uma pasta qualquer do disco.

import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { StoragePort } from '../storage-port.ts';

export const MAX_PROJETOS = 50;
/** Quantas sessões, no máximo, se olham para montar a lista (páginas de 500). */
const MAX_SESSOES_OLHADAS = 5000;

export async function projetosConhecidos(storage: Pick<StoragePort, 'listSessions'>, limite = MAX_PROJETOS): Promise<string[]> {
  const vistos = new Set<string>();
  const projetos: string[] = [];
  let cursor: string | null = null;
  let olhadas = 0;
  do {
    const pagina = await storage.listSessions({ limit: 500, cursor });
    for (const s of pagina.items) {
      const cwd = s.cwd;
      if (!cwd || vistos.has(cwd)) continue;
      vistos.add(cwd);
      if (!isAbsolute(cwd) || /[\0\n]/.test(cwd)) continue;
      if (!(await stat(cwd).catch(() => null))?.isDirectory()) continue;
      projetos.push(cwd);
      if (projetos.length >= limite) return projetos;
    }
    olhadas += pagina.items.length;
    cursor = pagina.nextCursor;
  } while (cursor && olhadas < MAX_SESSOES_OLHADAS);
  return projetos;
}
