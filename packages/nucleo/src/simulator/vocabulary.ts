// Synthetic vocabulary. Everything here is made up: no person's name, client project or real
// machine path. Paths live under /simulacao to make that obvious.

export const PROJECTS = [
  'vitrine-demo',
  'motor-de-regras',
  'app-receitas',
  'gateway-sandbox',
  'catalogo-exemplo',
  'agenda-ficticia',
  'blog-estatico',
  'cli-de-notas',
  'fila-de-tarefas',
  'painel-de-metricas',
] as const;

export const ROOT = '/simulacao';

/**
 * Two synthetic accounts, so the account filter and grouping show up (decision 0006).
 * The UUIDs come from the example block `00000000-…`: they do not exist in Claude.
 */
export const ACCOUNTS = [
  {
    accountUuid: '00000000-0000-4000-8000-00000000c0a1',
    organizationUuid: '00000000-0000-4000-8000-00000000c0b1',
    organizationName: 'Org Exemplo Pessoal',
    organizationType: 'claude_max',
    label: 'Pessoal (simulada)',
    color: '#5b8def',
    configDir: `${ROOT}/.claude`,
    source: 'env',
  },
  {
    accountUuid: '00000000-0000-4000-8000-00000000c0a2',
    organizationUuid: '00000000-0000-4000-8000-00000000c0b2',
    organizationName: 'Org Exemplo Equipe',
    organizationType: 'claude_team',
    label: 'Equipe (simulada)',
    color: '#e0803c',
    configDir: `${ROOT}/.claude-equipe`,
    source: 'config',
  },
] as const;

export const TASKS = [
  'corrigir a paginação da listagem',
  'adicionar testes ao parser de datas',
  'migrar a configuração para variáveis de ambiente',
  'revisar o tratamento de erros da API',
  'implementar o filtro por categoria',
  'documentar o fluxo de autenticação',
  'otimizar a consulta do relatório mensal',
  'trocar o cliente HTTP por fetch nativo',
  'quebrar o módulo de pagamentos em serviços',
  'criar o endpoint de exportação em CSV',
  'atualizar dependências e rodar a bateria',
  'investigar o teste intermitente do carrinho',
  'escrever a migração do esquema de pedidos',
  'ajustar o layout da tela de cadastro',
] as const;

export const FOLLOW_UP_PROMPTS = [
  'pode seguir',
  'agora roda os testes',
  'faz o commit',
  'explica a mudança antes de continuar',
  'cobre também o caso vazio',
  'deixa mais simples',
  'abre o PR',
] as const;

export const MODELS = {
  main: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  subagent: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
} as const;

export const SUBAGENT_TYPES = ['Explore', 'general-purpose', 'Plan', 'code-reviewer', 'test-runner'] as const;

export const SUBAGENT_TASKS = [
  'mapear onde a função é chamada',
  'ler os testes existentes do módulo',
  'propor um plano de migração',
  'revisar o diff em busca de regressões',
  'rodar a bateria e resumir as falhas',
  'procurar usos do campo obsoleto',
  'comparar as duas abordagens',
  'checar a cobertura do pacote',
] as const;

export const FILES = [
  'src/index.ts',
  'src/api/rotas.ts',
  'src/servicos/pedidos.ts',
  'src/util/datas.ts',
  'src/config.ts',
  'test/pedidos.test.ts',
  'test/datas.test.ts',
  'README.md',
  'package.json',
] as const;

export const COMMANDS = [
  'npm test',
  'npm run lint',
  'git status',
  'git diff --stat',
  'npx tsc --noEmit',
  'node --test test/datas.test.ts',
] as const;

export const SEARCHES = ['TODO', 'formatarData', 'class Pedido', 'export function', 'process.env'] as const;

/** Tools with the relative weight they show up with in a typical session. */
export const TOOLS: readonly (readonly [string, number])[] = [
  ['Read', 30],
  ['Edit', 18],
  ['Bash', 20],
  ['Grep', 12],
  ['Glob', 6],
  ['Write', 5],
  ['TodoWrite', 5],
  ['WebFetch', 4],
];

export const ERRORS = [
  'Command failed with exit code 1: 3 testes falharam',
  'API Error: 529 overloaded',
  'ENOENT: arquivo não encontrado',
  'Timeout depois de 120000 ms',
] as const;
