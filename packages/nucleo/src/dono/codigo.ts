// O commit do código deste núcleo, para quem sobe comparar com o que está no ar: a `VERSAO_DA_API`
// muda pouco, e dois checkouts da mesma versão podem ser códigos bem diferentes.

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: AQUI, encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** O commit curto do checkout deste arquivo, ou `null` fora de um repositório (o app empacotado). */
export function commitDoCodigo(): string | null {
  return git(['rev-parse', '--short', 'HEAD']);
}

/** `true` se `outro` é um commit mais velho deste checkout (ancestral do HEAD, e não o próprio). */
export function commitMaisVelho(outro: string): boolean {
  if (!/^[0-9a-f]{4,40}$/.test(outro)) return false;
  const meu = git(['rev-parse', 'HEAD']);
  const dele = git(['rev-parse', '--verify', '--quiet', `${outro}^{commit}`]);
  if (!meu || !dele || meu === dele) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', dele, meu], { cwd: AQUI, timeout: 2_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
