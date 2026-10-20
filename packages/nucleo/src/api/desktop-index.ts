// The Claude Desktop session index: `claude-code-sessions/<account>/<org>/local_*.json`.
// Gives the panel what the transcript lacks: the sidebar title, the branch, the parent session
// (`spawnedFrom.sessionId`, for the family), the account by folder (order 4 of decision 0006) and the
// effort chosen in the Desktop (`effort`, for the wall of #34).
//
// Cost: the first read reads each file once; after that, only the `stat` of the folders and the
// files, at most every `intervaloMs`, and it re-reads only the file whose mtime changed. Never on
// every panel request. It reads only the fields below; the rest of the JSON is ignored.

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
  /** O esforço (`effort`) da sessão no Desktop: `low`, `medium`, `high`…; ausente ou `null` quando não se sabe. */
  esforco?: string | null;
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
        esforco: str(o.effort),
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
