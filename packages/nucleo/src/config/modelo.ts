// O contrato da tela Agent Config (#63, wireframes C16 e C17): o que o núcleo lê das pastas de
// configuração do Claude Code e da `.claude` do projeto. Só nomes, caminhos e contagens: nenhum
// valor de settings, nenhum comando de hook, nenhum `env`/`command`/`url` de MCP, nenhum conteúdo
// de memória. O conteúdo só sai de uma skill, pela rota da skill (skills.ts).

export type EscopoDaConfig = 'usuario' | 'projeto';

/**
 * Um cartão de raiz. `home` é a pasta de configuração; `configuracao`, o `.claude.json` dela;
 * `claude-projeto`, `<projeto>/.claude`; `projeto`, a raiz do projeto. Só `home` e
 * `claude-projeto` recebem skill (o `id` delas é a `raiz` das rotas da skill).
 */
export interface RaizDaConfig {
  /** Opaco e estável enquanto as pastas não mudam: `u0`, `u1`… (home), `c0`… (`.claude.json`), `p`, `r`. */
  id: string;
  escopo: EscopoDaConfig;
  tipo: 'home' | 'claude-projeto' | 'projeto' | 'configuracao';
  rotulo: string;
  caminho: string;
}

export interface Contagem {
  total: number;
  usuario: number;
  projeto: number;
}

export interface SkillListada {
  /** O nome da pasta da skill: é a chave de leitura e de gravação. */
  nome: string;
  /** O `name` do frontmatter, quando difere da pasta (o Claude Code mostra este). */
  nomeDeclarado: string | null;
  descricao: string | null;
  escopo: EscopoDaConfig;
  raiz: string;
  caminho: string;
  editadoEm: number;
  /** `false` quando o nome da pasta não passa no padrão de gravação: só leitura. */
  editavel: boolean;
}

export interface SubagenteListado {
  nome: string;
  descricao: string | null;
  escopo: EscopoDaConfig;
  raiz: string;
  caminho: string;
}

export interface ComandoListado {
  /** Caminho relativo a `commands/` sem `.md`, com `:` no lugar de `/` (como o Claude Code chama). */
  nome: string;
  escopo: EscopoDaConfig;
  raiz: string;
  caminho: string;
}

export interface MemoriaListada {
  nome: string;
  escopo: EscopoDaConfig;
  caminho: string;
  /** `instrucoes`: um `CLAUDE.md`/`CLAUDE.local.md`; `automatica`: a memória automática do projeto. */
  tipo: 'instrucoes' | 'automatica';
}

export interface McpListado {
  nome: string;
  escopo: EscopoDaConfig;
  origem: '.claude.json' | '.mcp.json';
}

export interface PluginListado {
  /** `nome@marketplace`, como em `enabledPlugins`. */
  nome: string;
  escopo: EscopoDaConfig;
}

export interface HookListado {
  evento: string;
  /** Quantos hooks o evento tem nesse escopo, somados entre os arquivos. */
  quantos: number;
  escopo: EscopoDaConfig;
}

export interface ConfiguracaoListada {
  arquivo: 'settings.json' | 'settings.local.json' | '.claude.json';
  escopo: EscopoDaConfig;
  caminho: string;
}

export interface ConfigDoAgente {
  projeto: string | null;
  projetos: string[];
  raizes: RaizDaConfig[];
  resumo: Record<'skills' | 'subagentes' | 'comandos' | 'mcp' | 'plugins' | 'hooks' | 'memoria' | 'configuracoes', Contagem>;
  skills: SkillListada[];
  subagentes: SubagenteListado[];
  comandos: ComandoListado[];
  memoria: MemoriaListada[];
  mcp: McpListado[];
  plugins: PluginListado[];
  hooks: HookListado[];
  configuracoes: ConfiguracaoListada[];
  edicao: true;
}

/** Erro com o status HTTP que a rota devolve. */
export class ErroDaConfig extends Error {
  readonly status: number;
  constructor(status: number, mensagem: string) {
    super(mensagem);
    this.status = status;
  }
}
