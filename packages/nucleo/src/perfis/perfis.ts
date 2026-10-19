// Perfis (decisão 0006, seção 2): as pastas de configuração que o núcleo conhece, a conta atual
// de cada uma e onde ficam os transcripts. Cada conta lida vira uma `ClaudeAccount` na porta,
// com o nome atual da org e uma cor da marca. O `label` fica nulo até a pessoa editar: o rótulo
// padrão é derivado na leitura (o nome da org, ou "conta N"), para uma org renomeada aparecer
// com o nome novo. O e-mail nunca entra. O `~/.ahrena-console/contas.json` continua por cima.

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeAccountId, type ClaudeAccount } from '../model.ts';
import type { StoragePort } from '../storage-port.ts';
import { corLivre } from './cores.ts';
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
    const pasta = pastaDeConfiguracao(await this.caminhoCanonico(dir), 'hook', this.home);
    if (!(await pareceConfiguracao(pasta))) return null;
    this.revelar(pasta.dir);
    const { conta } = await this.lerPerfil(pasta);
    return conta ? this.gravar(conta, pasta.dir) : null;
  }

  /**
   * Grava na porta uma conta vista por outra fonte (o ambiente do hook, ordem 1), com a pasta de
   * configuração em que apareceu, se houver. Mesma gravação de `contaDaPasta`: uma rota só.
   */
  async registrar(conta: ContaDoPerfil, dir: string | null): Promise<ClaudeAccount> {
    return this.gravar(conta, dir ? await this.caminhoCanonico(dir) : null);
  }

  /** Um symlink para a pasta padrão é a pasta padrão; os outros ficam como vieram. */
  private async caminhoCanonico(dir: string): Promise<string> {
    const abs = normalizarPasta(dir.trim(), this.home);
    const padrao = join(this.home, '.claude');
    const [real, realPadrao] = await Promise.all([realpath(abs).catch(() => abs), realpath(padrao).catch(() => padrao)]);
    return real === realPadrao ? padrao : abs;
  }

  private async lerPerfil(p: PastaDeConfiguracao): Promise<Perfil> {
    const conta = await lerContaDoClaudeJson(p.claudeJson);
    return { ...p, conta, accountId: conta ? claudeAccountId(conta.accountUuid, conta.organizationUuid) : null };
  }

  private gravar(conta: ContaDoPerfil, dir: string | null): Promise<ClaudeAccount> {
    const feito = this.fila.then(() => this.gravarAgora(conta, dir));
    this.fila = feito.catch(() => undefined);
    return feito;
  }

  private async gravarAgora(conta: ContaDoPerfil, dir: string | null): Promise<ClaudeAccount> {
    const id = claudeAccountId(conta.accountUuid, conta.organizationUuid);
    const agora = this.agora();
    const gravada = this.storage ? await this.storage.getAccount(id) : null;
    const cor = gravada?.color ?? corLivre(this.storage ? (await this.storage.listAccounts()).map((a) => a.color) : []);
    const a: ClaudeAccount = {
      id,
      accountUuid: conta.accountUuid,
      organizationUuid: conta.organizationUuid,
      organizationName: conta.organizationName ?? gravada?.organizationName ?? null,
      organizationType: conta.organizationType ?? gravada?.organizationType ?? null,
      label: gravada?.label ?? null,
      color: cor,
      configDirs: [...new Set([...(gravada?.configDirs ?? []), ...(dir ? [dir] : [])])].sort(),
      firstSeenAt: gravada?.firstSeenAt ?? agora,
      lastSeenAt: agora,
      metadata: gravada?.metadata ?? {},
    };
    // Sem mudança além do `lastSeenAt`, não grava: a releitura periódica não acorda quem espera
    // por mudanças na porta (long polling, #24).
    if (gravada && semMudanca(gravada, a)) return gravada;
    if (this.storage) await this.storage.putAccount(a);
    return a;
  }
}

function semMudanca(antes: ClaudeAccount, depois: ClaudeAccount): boolean {
  return (
    antes.organizationName === depois.organizationName &&
    antes.organizationType === depois.organizationType &&
    antes.color === depois.color &&
    antes.configDirs.length === depois.configDirs.length &&
    antes.configDirs.every((d, i) => d === depois.configDirs[i])
  );
}
