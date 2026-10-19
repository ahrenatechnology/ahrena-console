// Conta de cada sessão para o painel (decisão 0006), pela primeira fonte que responder:
//
// 1. `env`: o ambiente da própria sessão, que o painel lê (`CLAUDE_CODE_ACCOUNT_UUID` e
//    `CLAUDE_CODE_ORGANIZATION_UUID`) e manda no pedido. Vale para a sessão do painel e fica
//    lembrada para quando outra sessão perguntar por ela;
// 2. `simulador`: `metadata.conta` das sessões do simulador, sintéticas;
// 3. `desktop`: o índice do Claude Desktop, só quando a sessão está numa pasta conta/org só.
//
// Sem nenhuma, a sessão fica em "Sem conta": nunca é atribuída a outra por palpite.
// O rótulo e a cor vêm de `~/.ahrena-console/contas.json` (`{ "<conta>/<org>": { "rotulo", "cor" } }`);
// sem ele, "conta 1", "conta 2"… na ordem em que aparecem. O id nunca é mostrado.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../model.ts';
import type { ContaDoPainel, CorDaConta } from './tipos.ts';
import type { SessaoDoDesktop } from './indice-desktop.ts';

const CORES: readonly CorDaConta[] = ['rose', 'green', 'yellow', 'gray'];
const UUID = /^[0-9a-f-]{8,64}$/i;

export function arquivoPadraoDeContas(): string {
  return join(homedir(), '.ahrena-console', 'contas.json');
}

export interface OpcoesDasContas {
  arquivo?: string | null;
  intervaloMs?: number;
  agora?: () => number;
}

export class Contas {
  private readonly arquivo: string | null;
  private readonly intervaloMs: number;
  private readonly agora: () => number;
  private configurados = new Map<string, { rotulo?: string; cor?: CorDaConta }>();
  private readonly ordem: string[] = [];
  /** Conta que o painel de cada sessão informou pelo ambiente. */
  private readonly doAmbiente = new Map<string, string>();
  private mtimeMs = -1;
  private conferidoEm = -Infinity;

  constructor({ arquivo = arquivoPadraoDeContas(), intervaloMs = 30_000, agora = Date.now }: OpcoesDasContas = {}) {
    this.arquivo = arquivo;
    this.intervaloMs = intervaloMs;
    this.agora = agora;
  }

  /** Relê o arquivo de rótulos se ele mudou; no máximo a cada `intervaloMs`. */
  async atualizar(): Promise<void> {
    if (!this.arquivo || this.agora() - this.conferidoEm < this.intervaloMs) return;
    this.conferidoEm = this.agora();
    try {
      const { mtimeMs } = await stat(this.arquivo);
      if (mtimeMs === this.mtimeMs) return;
      this.mtimeMs = mtimeMs;
      const o = JSON.parse(await readFile(this.arquivo, 'utf8')) as Record<string, { rotulo?: unknown; cor?: unknown }>;
      const lidos = new Map<string, { rotulo?: string; cor?: CorDaConta }>();
      for (const [id, v] of Object.entries(o ?? {})) {
        lidos.set(id, {
          rotulo: typeof v?.rotulo === 'string' && v.rotulo.trim() ? v.rotulo.trim().slice(0, 24) : undefined,
          cor: CORES.includes(v?.cor as CorDaConta) ? (v.cor as CorDaConta) : undefined,
        });
      }
      this.configurados = lidos;
    } catch {
      // Sem arquivo, ou inválido: os rótulos padrão valem.
    }
  }

  /** Grava a conta que o painel leu do ambiente da própria sessão. Ignora o que não parece UUID. */
  informar(sessionId: string, conta: string | null, org: string | null): void {
    if (!conta || !org || !UUID.test(conta) || !UUID.test(org)) return;
    this.doAmbiente.set(sessionId, `${conta}/${org}`);
  }

  /** A conta da sessão, pela ordem acima. */
  daSessao(session: Pick<Session, 'id' | 'metadata'>, desktop: SessaoDoDesktop | null): ContaDoPainel | null {
    const env = this.doAmbiente.get(session.id);
    if (env) return this.montar(env, 'env');
    const sim = session.metadata?.conta as { id?: unknown; rotulo?: unknown; cor?: unknown } | undefined;
    if (sim && typeof sim.id === 'string') {
      return {
        id: sim.id,
        rotulo: typeof sim.rotulo === 'string' ? sim.rotulo : this.montar(sim.id, 'simulador').rotulo,
        cor: CORES.includes(sim.cor as CorDaConta) ? (sim.cor as CorDaConta) : this.montar(sim.id, 'simulador').cor,
        fonte: 'simulador',
      };
    }
    if (desktop && desktop.contas.length === 1) return this.montar(desktop.contas[0], 'desktop');
    return null;
  }

  private montar(id: string, fonte: ContaDoPainel['fonte']): ContaDoPainel {
    if (!this.ordem.includes(id)) this.ordem.push(id);
    const i = this.ordem.indexOf(id);
    const c = this.configurados.get(id);
    return { id, rotulo: c?.rotulo ?? `conta ${i + 1}`, cor: c?.cor ?? CORES[i % CORES.length], fonte };
  }
}
