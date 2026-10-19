// Sonda de processo vivo: em que diretórios há um processo `claude` rodando agora.
// macOS com `ps` + `lsof`; Linux por `/proc`. Desligada (devolve `null`) no Windows, em contêiner
// e na nuvem, onde o processo não está na mesma máquina. `null` quer dizer "não sei": o vigia não encerra nada.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { normalizarDiretorio } from './vigia.ts';

export interface SondaDeProcesso {
  diretoriosVivos(): Promise<ReadonlySet<string> | null>;
}

/** Para testes e para quem já sabe a resposta. */
export function sondaFixa(diretorios: Iterable<string> | null): SondaDeProcesso {
  const vivos = diretorios === null ? null : new Set([...diretorios].map(normalizarDiretorio));
  return { diretoriosVivos: async () => vivos };
}

export type Executar = (comando: string, args: string[]) => Promise<string>;

export interface OpcoesDaSonda {
  plataforma?: NodeJS.Platform;
  executar?: Executar;
  /** Raiz do `/proc` no Linux. */
  proc?: string;
  /** `true` dentro de contêiner; o padrão olha `/.dockerenv`. */
  emConteiner?: boolean;
}

const executarPadrao: Executar = (comando, args) =>
  new Promise((resolve, reject) => {
    execFile(comando, args, { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // `lsof` sai com 1 quando algum pid sumiu no meio; o que ele achou continua valendo.
      if (err && !stdout) reject(err);
      else resolve(stdout);
    });
  });

/** A linha de comando é do Claude Code? Binário `claude` ou o pacote npm rodando no node. */
export function ehClaude(linhaDeComando: string): boolean {
  const [primeiro = ''] = linhaDeComando.trim().split(/\s+/);
  return /(^|\/)claude$/.test(primeiro) || linhaDeComando.includes('@anthropic-ai/claude-code');
}

/** Saída de `ps -axo pid=,args=` → pids do Claude Code. */
export function pidsDoPs(saida: string): number[] {
  const pids: number[] = [];
  for (const linha of saida.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(linha);
    if (m && ehClaude(m[2])) pids.push(Number(m[1]));
  }
  return pids;
}

/** Saída de `lsof -Fn -a -d cwd -p ...` → diretórios (linhas `n<caminho>`). */
export function diretoriosDoLsof(saida: string): string[] {
  return saida
    .split('\n')
    .filter((l) => l.startsWith('n') && l.length > 1)
    .map((l) => normalizarDiretorio(l.slice(1)));
}

export function sondaDoSistema(opcoes: OpcoesDaSonda = {}): SondaDeProcesso {
  const plataforma = opcoes.plataforma ?? process.platform;
  const executar = opcoes.executar ?? executarPadrao;
  const proc = opcoes.proc ?? '/proc';
  const emConteiner = opcoes.emConteiner ?? existsSync('/.dockerenv');
  if (emConteiner) return sondaFixa(null);

  if (plataforma === 'darwin') {
    return {
      async diretoriosVivos() {
        try {
          const pids = pidsDoPs(await executar('ps', ['-axo', 'pid=,args=']));
          if (pids.length === 0) return new Set();
          const saida = await executar('lsof', ['-Fn', '-a', '-d', 'cwd', '-p', pids.join(',')]);
          return new Set(diretoriosDoLsof(saida));
        } catch {
          return null;
        }
      },
    };
  }

  if (plataforma === 'linux') {
    return {
      async diretoriosVivos() {
        try {
          const vivos = new Set<string>();
          for (const nome of await readdir(proc)) {
            if (!/^\d+$/.test(nome)) continue;
            try {
              const linha = (await readFile(`${proc}/${nome}/cmdline`, 'utf8')).split('\0').join(' ');
              if (!ehClaude(linha)) continue;
              vivos.add(normalizarDiretorio(await readlink(`${proc}/${nome}/cwd`)));
            } catch {
              // O processo acabou entre a listagem e a leitura.
            }
          }
          return vivos;
        } catch {
          return null;
        }
      },
    };
  }

  return sondaFixa(null);
}
