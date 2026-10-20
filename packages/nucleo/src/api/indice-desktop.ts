// Índice de sessões do Claude Desktop: `claude-code-sessions/<conta>/<org>/local_*.json`.
// Dá ao painel o que o transcript não tem: o título da barra lateral, o branch, a sessão mãe
// (`spawnedFrom.sessionId`, para a família) e a conta pela pasta (ordem 4 da decisão 0006).
//
// Consumo: a primeira leitura lê cada arquivo uma vez; depois, só o `stat` das pastas e dos
// arquivos, no máximo a cada `intervaloMs`, e relê só o arquivo cujo mtime mudou. Nunca a
// cada pedido do painel. Lê só os campos abaixo; o resto do JSON é ignorado.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SessaoDoDesktop {
  /** `local_…`: o id do Desktop. */
  localId: string;
  /** O `sessionId` do transcript (o que o núcleo usa). */
  cliSessionId: string | null;
  titulo: string | null;
  branch: string | null;
  cwd: string | null;
  /** `local_…` da sessão que abriu esta, quando foi aberta por outra. */
  maeLocalId: string | null;
  arquivada: boolean;
  /** Pastas `<conta>/<org>` em que a sessão aparece. Mais de uma: a pasta não diz a conta. */
  contas: string[];
}

export function raizPadraoDoDesktop(): string {
  return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
}

interface Arquivo {
  mtimeMs: number;
  escopo: string;
  sessao: SessaoDoDesktop;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

async function lista(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export interface OpcoesDoIndice {
  raiz?: string;
  /** Intervalo mínimo entre duas conferências do disco. Padrão 30 s. */
  intervaloMs?: number;
  agora?: () => number;
}

export class IndiceDoDesktop {
  readonly raiz: string;
  private readonly intervaloMs: number;
  private readonly agora: () => number;
  private readonly arquivos = new Map<string, Arquivo>();
  private porCli = new Map<string, SessaoDoDesktop>();
  private porLocal = new Map<string, SessaoDoDesktop>();
  private filhas = new Map<string, SessaoDoDesktop[]>();
  private conferidoEm = -Infinity;
  private rodada: Promise<void> | null = null;
  /** Arquivos lidos desde o início (para a medição de carga). */
  lidos = 0;

  constructor({ raiz = raizPadraoDoDesktop(), intervaloMs = 30_000, agora = Date.now }: OpcoesDoIndice = {}) {
    this.raiz = raiz;
    this.intervaloMs = intervaloMs;
    this.agora = agora;
  }

  /** Confere o disco se o intervalo passou; pedidos ao mesmo tempo esperam a mesma rodada. */
  async atualizar(forcar = false): Promise<void> {
    if (!forcar && this.agora() - this.conferidoEm < this.intervaloMs) return;
    this.rodada ??= this.conferir().finally(() => {
      this.conferidoEm = this.agora();
      this.rodada = null;
    });
    return this.rodada;
  }

  sessaoPorCli(cliSessionId: string): SessaoDoDesktop | null {
    return this.porCli.get(cliSessionId) ?? null;
  }

  sessaoPorLocal(localId: string): SessaoDoDesktop | null {
    return this.porLocal.get(localId) ?? null;
  }

  /** As sessões abertas por esta; as arquivadas vêm junto, com `arquivada` (#145). */
  filhasDe(localId: string): SessaoDoDesktop[] {
    return this.filhas.get(localId) ?? [];
  }

  private async conferir(): Promise<void> {
    const vistos = new Set<string>();
    for (const conta of await lista(this.raiz)) {
      for (const org of await lista(join(this.raiz, conta))) {
        const dir = join(this.raiz, conta, org);
        for (const nome of await lista(dir)) {
          if (!nome.startsWith('local_') || !nome.endsWith('.json')) continue;
          const caminho = join(dir, nome);
          vistos.add(caminho);
          let mtimeMs: number;
          try {
            mtimeMs = (await stat(caminho)).mtimeMs;
          } catch {
            continue;
          }
          const antes = this.arquivos.get(caminho);
          if (antes && antes.mtimeMs === mtimeMs) continue;
          const sessao = await this.ler(caminho, nome.slice(0, -'.json'.length));
          if (sessao) this.arquivos.set(caminho, { mtimeMs, escopo: `${conta}/${org}`, sessao });
        }
      }
    }
    for (const caminho of [...this.arquivos.keys()]) if (!vistos.has(caminho)) this.arquivos.delete(caminho);
    this.reindexar();
  }

  private async ler(caminho: string, localId: string): Promise<SessaoDoDesktop | null> {
    try {
      const o = JSON.parse(await readFile(caminho, 'utf8')) as Record<string, unknown>;
      this.lidos++;
      const mae = o.spawnedFrom && typeof o.spawnedFrom === 'object' ? str((o.spawnedFrom as Record<string, unknown>).sessionId) : null;
      return {
        localId: str(o.sessionId) ?? localId,
        cliSessionId: str(o.cliSessionId),
        titulo: str(o.title),
        branch: str(o.branch),
        cwd: str(o.cwd),
        maeLocalId: mae,
        arquivada: o.isArchived === true,
        contas: [],
      };
    } catch {
      return null;
    }
  }

  // A mesma sessão pode estar em várias pastas conta/org (sincronização entre orgs): junta por id.
  private reindexar(): void {
    const porLocal = new Map<string, SessaoDoDesktop>();
    for (const { escopo, sessao } of this.arquivos.values()) {
      const atual = porLocal.get(sessao.localId);
      if (atual) {
        if (!atual.contas.includes(escopo)) atual.contas.push(escopo);
      } else porLocal.set(sessao.localId, { ...sessao, contas: [escopo] });
    }
    const porCli = new Map<string, SessaoDoDesktop>();
    const filhas = new Map<string, SessaoDoDesktop[]>();
    for (const s of porLocal.values()) {
      if (s.cliSessionId) porCli.set(s.cliSessionId, s);
      if (s.maeLocalId) filhas.set(s.maeLocalId, [...(filhas.get(s.maeLocalId) ?? []), s]);
    }
    this.porLocal = porLocal;
    this.porCli = porCli;
    this.filhas = filhas;
  }
}
