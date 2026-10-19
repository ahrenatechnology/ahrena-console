// Perfis (decisão 0006, seção 2): as pastas de configuração que o núcleo conhece, a conta atual
// de cada uma e onde ficam os transcripts. Cada conta lida vira uma `ClaudeAccount` na porta,
// com o nome da org como rótulo padrão e uma cor da marca. O que a pessoa já editou na conta
// (rótulo, cor) não é sobrescrito, e o `~/.ahrena-console/contas.json` continua por cima na API.

import { homedir } from 'node:os';
import { CORES_DAS_CONTAS } from '../api/contas.ts';
import { claudeAccountId, type ClaudeAccount } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { arquivoPadraoDePerfis, descobrirPastas, normalizarPasta, pareceConfiguracao, pastaDeConfiguracao, type PastaDeConfiguracao } from './descoberta.ts';
import { lerContaDoClaudeJson, type ContaDoPerfil } from './leitura.ts';

export interface Perfil extends PastaDeConfiguracao {
  /** A conta logada agora na pasta; `null` sem login OAuth (sem login, ou chave de API). */
  conta: ContaDoPerfil | null;
  /** `ClaudeAccount.id` da conta atual, ou `null`. */
  accountId: string | null;
}

export interface OpcoesDosPerfis {
  storage?: Pick<StoragePort, 'getAccount' | 'putAccount' | 'listAccounts'> | null;
  home?: string;
  /** `~/.ahrena-console/perfis.json`; `null` não lê pastas configuradas. */
  arquivo?: string | null;
  agora?: () => string;
}

export class Perfis {
  private readonly storage: OpcoesDosPerfis['storage'];
  private readonly home: string;
  private readonly arquivo: string | null;
  private readonly agora: () => string;
  private readonly reveladas = new Set<string>();
  /** Gravações em fila: duas pastas da mesma conta não se atropelam no `configDirs`. */
  private fila: Promise<unknown> = Promise.resolve();

  constructor({ storage = null, home = homedir(), arquivo, agora = () => new Date().toISOString() }: OpcoesDosPerfis = {}) {
    this.storage = storage;
    this.home = home;
    this.arquivo = arquivo === undefined ? arquivoPadraoDePerfis(home) : arquivo;
    this.agora = agora;
  }

  /** Lembra uma pasta que um hook revelou (`CLAUDE_CONFIG_DIR`), para as próximas listagens. */
  revelar(dir: string): void {
    if (dir.trim()) this.reveladas.add(normalizarPasta(dir.trim(), this.home));
  }

  /** Os perfis desta máquina com a conta atual de cada um, sem gravar nada. */
  async listar(): Promise<Perfil[]> {
    const pastas = await descobrirPastas({ home: this.home, arquivo: this.arquivo, reveladas: this.reveladas });
    return Promise.all(pastas.map((p) => this.lerPerfil(p)));
  }

  /** Lista os perfis e grava a conta de cada um na porta. */
  async sincronizar(): Promise<Perfil[]> {
    const perfis = await this.listar();
    for (const p of perfis) if (p.conta) await this.gravar(p.conta, p.dir);
    return perfis;
  }

  /**
   * A conta atual da pasta de configuração `dir` (ordem 2, `config`, no `SessionStart`; ordem 5,
   * `profile`, na importação), já gravada na porta. Revela a pasta. `null` quando a pasta não
   * existe, não tem a estrutura de uma pasta de configuração ou não tem login OAuth.
   */
  async contaDaPasta(dir: string): Promise<ClaudeAccount | null> {
    const pasta = pastaDeConfiguracao(dir, 'hook', this.home);
    if (!(await pareceConfiguracao(pasta))) return null;
    this.revelar(pasta.dir);
    const { conta } = await this.lerPerfil(pasta);
    return conta ? this.gravar(conta, pasta.dir) : null;
  }

  private async lerPerfil(p: PastaDeConfiguracao): Promise<Perfil> {
    const conta = await lerContaDoClaudeJson(p.claudeJson);
    return { ...p, conta, accountId: conta ? claudeAccountId(conta.accountUuid, conta.organizationUuid) : null };
  }

  private gravar(conta: ContaDoPerfil, dir: string): Promise<ClaudeAccount> {
    const feito = this.fila.then(() => this.gravarAgora(conta, dir));
    this.fila = feito.catch(() => undefined);
    return feito;
  }

  private async gravarAgora(conta: ContaDoPerfil, dir: string): Promise<ClaudeAccount> {
    const id = claudeAccountId(conta.accountUuid, conta.organizationUuid);
    const agora = this.agora();
    const gravada = this.storage ? await this.storage.getAccount(id) : null;
    const cor = gravada?.color ?? (this.storage ? CORES_DAS_CONTAS[(await this.storage.listAccounts()).length % CORES_DAS_CONTAS.length] : CORES_DAS_CONTAS[0]);
    const a: ClaudeAccount = {
      id,
      accountUuid: conta.accountUuid,
      organizationUuid: conta.organizationUuid,
      organizationName: conta.organizationName ?? gravada?.organizationName ?? null,
      organizationType: conta.organizationType ?? gravada?.organizationType ?? null,
      label: gravada?.label ?? conta.rotuloSugerido,
      color: cor,
      configDirs: [...new Set([...(gravada?.configDirs ?? []), dir])].sort(),
      firstSeenAt: gravada?.firstSeenAt ?? agora,
      lastSeenAt: agora,
      metadata: gravada?.metadata ?? {},
    };
    if (this.storage) await this.storage.putAccount(a);
    return a;
  }
}
