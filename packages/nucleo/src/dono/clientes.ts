// Clientes registrados: quem adotou o núcleo com `--pai <pid>` e quer que ele continue de pé.
// Um arquivo por pid em `~/.ahrena-console/clientes/`, para dois clientes nunca brigarem pelo
// mesmo arquivo. Cliente morto é apagado por quem lê.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidVivo } from './sonda.ts';
import { pastaPadrao, prepararPasta } from './trava.ts';

const pastaDosClientes = (pasta: string) => join(pasta, 'clientes');

export function registrarCliente(pid: number, pasta = pastaPadrao()): void {
  prepararPasta(pasta);
  const dir = pastaDosClientes(pasta);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, String(pid)), `${JSON.stringify({ pid, desde: new Date().toISOString() })}\n`, { mode: 0o600 });
}

export function removerCliente(pid: number, pasta = pastaPadrao()): void {
  rmSync(join(pastaDosClientes(pasta), String(pid)), { force: true });
}

/** Os pids registrados que ainda vivem; os mortos saem da pasta. */
export function clientesVivos(pasta = pastaPadrao()): number[] {
  let nomes: string[];
  try {
    nomes = readdirSync(pastaDosClientes(pasta));
  } catch {
    return [];
  }
  const vivos: number[] = [];
  for (const nome of nomes) {
    const pid = Number(nome);
    if (Number.isInteger(pid) && pid > 0 && pidVivo(pid)) vivos.push(pid);
    else rmSync(join(pastaDosClientes(pasta), nome), { force: true });
  }
  return vivos;
}
