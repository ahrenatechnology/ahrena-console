// Vocabulário sintético. Tudo aqui é inventado: nenhum nome de pessoa, projeto de cliente
// ou caminho de máquina real. Os caminhos ficam sob /simulacao para deixar isso evidente.

export const PROJETOS = [
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

export const RAIZ = '/simulacao';

export const TAREFAS = [
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

export const PEDIDOS_DE_SEGUIMENTO = [
  'pode seguir',
  'agora roda os testes',
  'faz o commit',
  'explica a mudança antes de continuar',
  'cobre também o caso vazio',
  'deixa mais simples',
  'abre o PR',
] as const;

export const MODELOS = {
  principal: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  subagente: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
} as const;

export const TIPOS_DE_SUBAGENTE = ['Explore', 'general-purpose', 'Plan', 'code-reviewer', 'test-runner'] as const;

export const TAREFAS_DE_SUBAGENTE = [
  'mapear onde a função é chamada',
  'ler os testes existentes do módulo',
  'propor um plano de migração',
  'revisar o diff em busca de regressões',
  'rodar a bateria e resumir as falhas',
  'procurar usos do campo obsoleto',
  'comparar as duas abordagens',
  'checar a cobertura do pacote',
] as const;

export const ARQUIVOS = [
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

export const COMANDOS = [
  'npm test',
  'npm run lint',
  'git status',
  'git diff --stat',
  'npx tsc --noEmit',
  'node --test test/datas.test.ts',
] as const;

export const BUSCAS = ['TODO', 'formatarData', 'class Pedido', 'export function', 'process.env'] as const;

/** Ferramentas com o peso relativo com que aparecem numa sessão típica. */
export const FERRAMENTAS: readonly (readonly [string, number])[] = [
  ['Read', 30],
  ['Edit', 18],
  ['Bash', 20],
  ['Grep', 12],
  ['Glob', 6],
  ['Write', 5],
  ['TodoWrite', 5],
  ['WebFetch', 4],
];

export const ERROS = [
  'Command failed with exit code 1: 3 testes falharam',
  'API Error: 529 overloaded',
  'ENOENT: arquivo não encontrado',
  'Timeout depois de 120000 ms',
] as const;
