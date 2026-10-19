// Conta de cada sessão para o painel (decisão 0006). Vale a fonte de menor ordem entre:
//
// - a conta gravada na sessão (`Session.accountId` e `accountSource`, da porta);
// - `env`: o ambiente da própria sessão, que o painel lê (`CLAUDE_CODE_ACCOUNT_UUID` e
//   `CLAUDE_CODE_ORGANIZATION_UUID`) e manda no pedido; fica lembrada em memória para quando
//   outra sessão perguntar por ela (gravar na sessão é dos hooks, #110);
// - `desktop`: o índice do Claude Desktop, só quando a sessão está numa pasta conta/org só.
//
// Sem nenhuma, a sessão fica em "Sem conta": nunca é atribuída a outra por palpite.
// Rótulo e cor: os de `~/.ahrena-console/contas.json` (`{ "<conta>/<org>": { "rotulo", "cor" } }`,
// cor em hex), que sobrepõem; senão os da `ClaudeAccount` (os perfis, #109, gravam o nome da org
// e uma cor da marca); senão "conta 1", "conta 2"… na ordem em que aparecem, com as cores da
// marca. O id nunca é mostrado.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paleta } from '../../../marca/gerado/marca.ts';
import { accountSourceRank, claudeAccountId, type AccountSource, type ClaudeAccount, type Session } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import type { SessaoDoDesktop } from './indice-desktop.ts';
import type { ContaDoPainel } from './tipos.ts';

/** Cores das contas sem cor própria, da paleta da marca. Laranja e vermelho ficam para status. */
export const CORES_DAS_CONTAS: readonly string[] = [paleta.rose['500'], paleta.green['500'], paleta.yellow['500'], paleta.gray['200']];
const UUID = /^[0-9a-f-]{8,64}$/i;
const HEX = /^#[0-9a-f]{6}$/i;

export function arquivoPadraoDeContas(): string {
  return join(homedir(), '.ahrena-console', 'contas.json');
}

export interface OpcoesDasContas {
  storage?: Pick<StoragePort, 'listAccounts'> | null;
  arquivo?: string | null;
  intervaloMs?: number;
  agora?: () => number;
}

export class Contas {
  private readonly storage: Pick<StoragePort, 'listAccounts'> | null;
  private readonly arquivo: string | null;
  private readonly intervaloMs: number;
  private readonly agora: () => number;
  private configurados = new Map<string, { rotulo?: string; cor?: string }>();
  private daPorta = new Map<string, ClaudeAccount>();
  private readonly ordem: string[] = [];
  /** Conta que o painel de cada sessão informou pelo ambiente. */
  private readonly doAmbiente = new Map<string, string>();
  private mtimeMs = -1;
  private conferidoEm = -Infinity;

  constructor({ storage = null, arquivo = arquivoPadraoDeContas(), intervaloMs = 30_000, agora = Date.now }: OpcoesDasContas = {}) {
    this.storage = storage;
    this.arquivo = arquivo;
    this.intervaloMs = intervaloMs;
    this.agora = agora;
  }

  /** Relê as contas da porta e o arquivo de rótulos; no máximo a cada `intervaloMs`. */
  async atualizar(): Promise<void> {
    if (this.agora() - this.conferidoEm < this.intervaloMs) return;
    this.conferidoEm = this.agora();
    if (this.storage) this.daPorta = new Map((await this.storage.listAccounts()).map((a) => [a.id, a]));
    if (!this.arquivo) return;
    try {
      const { mtimeMs } = await stat(this.arquivo);
      if (mtimeMs === this.mtimeMs) return;
      this.mtimeMs = mtimeMs;
      const o = JSON.parse(await readFile(this.arquivo, 'utf8')) as Record<string, { rotulo?: unknown; cor?: unknown }>;
      const lidos = new Map<string, { rotulo?: string; cor?: string }>();
      for (const [id, v] of Object.entries(o ?? {})) {
        lidos.set(id, {
          rotulo: typeof v?.rotulo === 'string' && v.rotulo.trim() ? v.rotulo.trim().slice(0, 24) : undefined,
          cor: typeof v?.cor === 'string' && HEX.test(v.cor) ? v.cor : undefined,
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
    this.doAmbiente.set(sessionId, claudeAccountId(conta, org));
  }

  /** A conta da sessão: a fonte de menor ordem entre a porta, o ambiente e o índice do Desktop. */
  daSessao(session: Pick<Session, 'id' | 'accountId' | 'accountSource'>, desktop: SessaoDoDesktop | null): ContaDoPainel | null {
    const candidatas: { id: string; fonte: AccountSource }[] = [];
    if (session.accountId && session.accountSource) candidatas.push({ id: session.accountId, fonte: session.accountSource });
    const env = this.doAmbiente.get(session.id);
    if (env) candidatas.push({ id: env, fonte: 'env' });
    if (desktop && desktop.contas.length === 1) candidatas.push({ id: desktop.contas[0], fonte: 'desktop' });
    if (candidatas.length === 0) return null;
    candidatas.sort((a, b) => accountSourceRank(a.fonte) - accountSourceRank(b.fonte));
    return this.montar(candidatas[0].id, candidatas[0].fonte);
  }

  private montar(id: string, fonte: AccountSource): ContaDoPainel {
    if (!this.ordem.includes(id)) this.ordem.push(id);
    const i = this.ordem.indexOf(id);
    const a = this.daPorta.get(id);
    const c = this.configurados.get(id);
    const cor = c?.cor ?? (a?.color && HEX.test(a.color) ? a.color : null) ?? CORES_DAS_CONTAS[i % CORES_DAS_CONTAS.length];
    return { id, rotulo: c?.rotulo ?? a?.label ?? a?.organizationName ?? `conta ${i + 1}`, cor, fonte };
  }
}
