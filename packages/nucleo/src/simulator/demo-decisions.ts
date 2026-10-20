// The demo's decision records (#174, wireframes C28 to C31 and C38): ADRs and PDRs in several formats,
// in the demo repositories of the fake GitHub (fake-github.ts). Synthetic: no client, no real person,
// no internal infrastructure. The text of each record is in the repository's language (painel-de-metricas
// and cli-de-notas write in English); only the screen is pt-BR.
//
// - `exemplo-labs/motor-de-regras`: docs/adr, MADR 4, nine ADRs with the chain 0005 → 0007 → 0008, an
//   obsolete one and one without consequences;
// - `exemplo-labs/vitrine-demo`: docs/decisoes, a mixed folder in free pt-BR: ADRs and two PDRs
//   separated by the field "Tipo: produto";
// - `exemplo-labs/painel-de-metricas`: doc/adr, adr-tools (Nygard), in English, one rejected;
// - `estudio-ficticio/app-receitas`: docs/decisions with a Y-statement and an incomplete ADR (no status,
//   no date), and docs/product-decisions, a PDR-only folder in MADR 4 with a supersede chain;
// - `dev-sintetico/cli-de-notas`: adr/, the adr-tools first record;
// - the other three: no decision folder (the "Sem ADR em 3 repositórios" line).

const madr4 = (o: { status: string; date: string; makers: string; consulted?: string; informed?: string; title: string; context: string; drivers?: string[]; options: string[]; chosen: string; because: string; good: string[]; bad: string[]; confirmation?: string; pros?: Record<string, { good: string[]; bad: string[] }>; more?: string }) =>
  [
    '---',
    `status: ${o.status}`,
    `date: ${o.date}`,
    `decision-makers: ${o.makers}`,
    ...(o.consulted ? [`consulted: ${o.consulted}`] : []),
    ...(o.informed ? [`informed: ${o.informed}`] : []),
    '---',
    `# ${o.title}`,
    '',
    '## Context and Problem Statement',
    '',
    o.context,
    '',
    ...(o.drivers ? ['## Decision Drivers', '', ...o.drivers.map((d) => `* ${d}`), ''] : []),
    '## Considered Options',
    '',
    ...o.options.map((x) => `* ${x}`),
    '',
    '## Decision Outcome',
    '',
    `Chosen option: "${o.chosen}", because ${o.because}`,
    '',
    ...(o.good.length || o.bad.length ? ['### Consequences', '', ...o.good.map((g) => `* Good, because ${g}`), ...o.bad.map((b) => `* Bad, because ${b}`), ''] : []),
    ...(o.confirmation ? ['### Confirmation', '', o.confirmation, ''] : []),
    ...(o.pros ? ['## Pros and Cons of the Options', '', ...Object.entries(o.pros).flatMap(([name, p]) => [`### ${name}`, '', ...p.good.map((g) => `* Good, because ${g}`), ...p.bad.map((b) => `* Bad, because ${b}`), ''])] : []),
    ...(o.more ? ['## More Information', '', o.more, ''] : []),
  ].join('\n');

const free = (o: { n: string; title: string; status: string; date: string; type?: string; deciders?: string; extra?: string[]; context: string; decision: string; options?: string[]; consequences?: string }) =>
  [
    `# ${o.n} · ${o.title}`,
    '',
    `- **Status:** ${o.status}`,
    `- **Data:** ${o.date}`,
    ...(o.type ? [`- **Tipo:** ${o.type}`] : []),
    ...(o.deciders ? [`- **Decisores:** ${o.deciders}`] : []),
    ...(o.extra ?? []),
    '',
    '## Contexto',
    '',
    o.context,
    '',
    '## Decisão',
    '',
    o.decision,
    '',
    ...(o.options ? ['## Alternativas consideradas', '', ...o.options.map((x) => `- ${x}`), ''] : []),
    ...(o.consequences ? ['## Consequências', '', o.consequences, ''] : []),
  ].join('\n');

const nygard = (o: { n: number; title: string; date: string; status: string; context: string; decision: string; consequences: string }) =>
  [`# ${o.n}. ${o.title}`, '', `Date: ${o.date}`, '', '## Status', '', o.status, '', '## Context', '', o.context, '', '## Decision', '', o.decision, '', '## Consequences', '', o.consequences, ''].join('\n');

const MOTOR = 'docs/adr';
const motor: Record<string, string> = {
  [`${MOTOR}/README.md`]: '# Decisões de arquitetura\n\nUm arquivo por decisão, no formato MADR 4.\n',
  [`${MOTOR}/0001-registrar-decisoes-em-madr.md`]: madr4({ status: 'accepted', date: '2026-01-08', makers: 'dev-sintetico', title: 'Registrar decisões em MADR', context: 'As decisões se perdiam nas conversas do time.', options: ['MADR', 'Páginas de wiki'], chosen: 'MADR', because: 'fica ao lado do código e passa pelo mesmo review.', good: ['o review vê a decisão no mesmo PR'], bad: [] }),
  [`${MOTOR}/0002-node-24-no-servico.md`]: madr4({ status: 'accepted', date: '2026-01-10', makers: 'dev-sintetico', title: 'Node 24 no serviço', context: 'O serviço rodava em Node 18, fora de suporte.', options: ['Node 24', 'Node 22'], chosen: 'Node 24', because: 'é a versão com suporte mais longo.', good: ['remove o polyfill de fetch'], bad: ['a imagem base muda'] }),
  [`${MOTOR}/0003-testes-de-regra-por-tabela.md`]: madr4({ status: 'accepted', date: '2026-01-15', makers: 'dev-sintetico, colega-a', title: 'Testes de regra por tabela', context: 'Cada regra tinha um teste escrito à mão, e metade não cobria os limites.', options: ['Tabela de casos por regra', 'Testes escritos à mão'], chosen: 'Tabela de casos por regra', because: 'os limites ficam visíveis na tabela.', good: ['um caso novo é uma linha'], bad: ['casos com estado não cabem'] }),
  [`${MOTOR}/0004-regras-escritas-em-yaml.md`]: madr4({ status: 'accepted', date: '2026-02-02', makers: 'colega-a', title: 'Regras escritas em YAML', context: 'As regras eram objetos no código.', options: ['YAML', 'JSON', 'Código'], chosen: 'YAML', because: 'o time de produto consegue ler.', good: ['a revisão de regra não exige saber o código'], bad: ['o YAML precisa de esquema'] }),
  [`${MOTOR}/0005-avaliar-regras-no-banco.md`]: [
    '---',
    'status: "superseded by [0007](0007-motor-de-regras-em-processo.md)"',
    'date: 2026-03-20',
    'decision-makers: dev-sintetico',
    '---',
    '# Avaliar regras no banco',
    '',
    '## Context and Problem Statement',
    '',
    'As regras rodavam no serviço e liam o pedido inteiro a cada avaliação.',
    '',
    '## Considered Options',
    '',
    '* Procedimentos no banco',
    '* Avaliação no serviço',
    '',
    '## Decision Outcome',
    '',
    'Chosen option: "Procedimentos no banco", because evita trazer o pedido para o serviço.',
    '',
  ].join('\n'),
  [`${MOTOR}/0006-fila-entre-pedidos-e-cobranca.md`]: madr4({ status: 'deprecated', date: '2026-05-11', makers: 'colega-a', title: 'Fila entre pedidos e cobrança', context: 'Pedidos e cobrança se chamavam direto e estouravam o tempo nos picos.', options: ['Fila', 'Chamada direta com retentativa'], chosen: 'Fila', because: 'desacopla os picos.', good: ['a cobrança absorve os picos'], bad: ['a cobrança fica eventual'], more: 'Obsoleta desde que a cobrança virou proposta de serviço à parte (0009).' }),
  [`${MOTOR}/0007-motor-de-regras-em-processo.md`]: madr4({
    status: '"superseded by [0008](0008-regras-em-tabela.md)"',
    date: '2026-07-02',
    makers: 'dev-sintetico',
    title: 'Motor de regras em processo',
    context: 'Avaliar no banco travou as migrações e escondeu os erros das regras.',
    options: ['Motor em processo', 'Procedimentos no banco'],
    chosen: 'Motor em processo',
    because: 'os erros voltam com a pilha do serviço.',
    good: ['as regras rodam nos testes de unidade'],
    bad: ['cada mudança de regra é um deploy'],
    more: 'Supersedes [Avaliar regras no banco](0005-avaliar-regras-no-banco.md).',
  }),
  [`${MOTOR}/0008-regras-em-tabela.md`]: madr4({
    status: 'accepted',
    date: '2026-09-30',
    makers: 'dev-sintetico, colega-a',
    consulted: 'colega-b',
    informed: 'time de produto',
    title: 'Regras em tabela de decisão versionada',
    context: 'As regras de preço mudam toda semana e hoje moram no código do motor. Cada mudança é um deploy, e o time de produto não consegue revisar o que mudou entre duas versões.',
    drivers: ['Mudar uma regra sem deploy', 'Ver o que mudou entre duas versões, linha a linha', 'Testar uma regra antes de valer'],
    options: ['Tabela de decisão versionada', 'Motor de regras em processo (a de hoje, 0007)', 'Serviço de regras gerenciado'],
    chosen: 'Tabela de decisão versionada',
    because: 'é a única que deixa revisar a mudança no pull request e voltar uma versão sem deploy.',
    good: ['mudar uma regra vira um PR de uma linha', 'o histórico das regras é o do git'],
    bad: ['a tabela precisa de validação na CI', 'regras com laço não cabem numa tabela'],
    confirmation: 'O job de CI recusa a tabela se uma linha não tiver teste.',
    pros: {
      'Tabela de decisão versionada': { good: ['é revisada no PR', 'volta uma versão sem deploy', 'o produto lê'], bad: ['laços não cabem'] },
      'Motor de regras em processo (a de hoje, 0007)': { good: ['já existe'], bad: ['cada mudança é um deploy', 'o produto não revisa', 'o histórico se perde no código'] },
      'Serviço de regras gerenciado': { good: ['tem editor visual', 'escala sozinho'], bad: ['custo por avaliação', 'as regras saem do repositório'] },
    },
    more: 'Supersedes [Motor de regras em processo](0007-motor-de-regras-em-processo.md).\n\nA proposta [0009](0009-cobranca-vira-servico.md) tira a cobrança do motor.',
  }),
  [`${MOTOR}/0009-cobranca-vira-servico.md`]: madr4({
    status: 'proposed',
    date: '2026-10-17',
    makers: 'colega-a',
    title: 'Cobrança vira um serviço à parte',
    context: 'A cobrança divide o deploy com o motor de regras, e uma falha numa derruba a outra.',
    options: ['Serviço à parte', 'Módulo no mesmo deploy'],
    chosen: 'Serviço à parte',
    because: 'isola as falhas.',
    good: ['as falhas não se propagam'],
    bad: ['mais um serviço para operar'],
  }).replace('## Context and Problem Statement', '- Mexe em: [0008](0008-regras-em-tabela.md)\n\n## Context and Problem Statement'),
};

const VIT = 'docs/decisoes';
const vitrine: Record<string, string> = {
  [`${VIT}/0001-cards-com-cor-por-status.md`]: free({ n: '0001', title: 'Cards com cor por status', status: 'aceita', date: '12/08/2026', context: 'Os cards não diziam o estado sem abrir.', decision: 'Cada card leva a cor do status na borda.', options: ['**Cor na borda.** Discreta.', '**Fundo colorido.** Pesa demais.'], consequences: 'Os tokens de status passam a ser obrigatórios.' }),
  [`${VIT}/0002-lista-de-espera.md`]: free({ n: '0002', title: 'Lista de espera antes do lançamento', status: 'rejeitada', date: '20/08/2026', type: 'produto', deciders: 'produto-sintetico', context: 'Queríamos medir o interesse antes de abrir a vitrine.', decision: 'Não fazer lista de espera: abrir direto, com convite.', options: ['**Lista de espera.** Mede o interesse, mas atrasa o retorno.', '**Convite.** Abre para quem já usa.'], consequences: 'O primeiro retorno vem de quem já usa o produto.' }),
  [`${VIT}/0003-cards-de-altura-fixa.md`]: free({ n: '0003', title: 'Cards de altura fixa', status: 'aceita', date: '2026-09-02', context: 'A grade pulava quando um card ganhava uma linha.', decision: 'Altura fixa, com o texto cortado em duas linhas.', options: ['**Altura fixa.**', '**Altura livre com grade de alvenaria.**'], consequences: 'O título longo aparece inteiro só no detalhe.' }),
  [`${VIT}/0004-postgres-no-docker-nos-testes.md`]: free({ n: '0004', title: 'Postgres no Docker nos testes', status: 'substituída por [0005](0005-sqlite-em-memoria-nos-testes.md)', date: '2026-09-20', context: 'Os testes precisavam de um banco.', decision: 'Um Postgres em contêiner por suíte.', consequences: 'A suíte leva quatro minutos.' }),
  [`${VIT}/0005-sqlite-em-memoria-nos-testes.md`]: free({ n: '0005', title: 'SQLite em memória nos testes', status: 'aceita', date: '2026-10-09', extra: ['- **Substitui:** [0004](0004-postgres-no-docker-nos-testes.md)'], context: 'A suíte sobe um Postgres e leva quatro minutos.', decision: 'Os testes usam SQLite em memória.', options: ['**Postgres no Docker.** Igual à produção, mas lento.', '**Repositório falso.** Rápido, mas não testa o SQL.'], consequences: 'A suíte roda em 40 s; os operadores de JSON precisam de um calço.' }),
  [`${VIT}/0006-kanban-so-leitura.md`]: free({ n: '0006', title: 'Kanban só leitura, sem arrastar', status: 'aceita', date: '2026-10-12', context: 'Arrastar um card mudaria o estado de uma sessão de outra pessoa.', decision: 'O Kanban só mostra; mudar o estado é na sessão.', options: ['**Só leitura.**', '**Arrastar com confirmação.**'], consequences: 'Ninguém muda a sessão de outro sem querer.' }),
  [`${VIT}/0007-kanban-so-do-usuario.md`]: free({ n: '0007', title: 'Kanban mostra só as sessões do usuário', status: 'aceita', date: '2026-10-14', type: 'produto', deciders: 'produto-sintetico, dev-sintetico', context: 'Quem abre o Kanban procura o próprio trabalho primeiro.', decision: 'O Kanban abre filtrado nas sessões de quem está olhando, com um seletor para o time.', consequences: 'O time inteiro fica a um clique.' }),
};

const PAINEL = 'doc/adr';
const painel: Record<string, string> = {
  [`${PAINEL}/0001-record-architecture-decisions.md`]: nygard({ n: 1, title: 'Record architecture decisions', date: '2026-01-05', status: 'Accepted', context: 'We need to record the architectural decisions made on this project.', decision: 'We will use Architecture Decision Records, as described by Michael Nygard.', consequences: 'See the adr-tools documentation.' }),
  [`${PAINEL}/0002-use-timescaledb-for-metrics.md`]: nygard({ n: 2, title: 'Use TimescaleDB for metrics', date: '2026-06-14', status: 'Accepted', context: 'Metrics arrive every minute per account and queries aggregate by month.', decision: 'We will store metrics in TimescaleDB hypertables.', consequences: 'Monthly aggregates come from continuous aggregates.' }),
  [`${PAINEL}/0003-materialized-views-for-the-report.md`]: nygard({ n: 3, title: 'Materialized views for the report', date: '2026-09-28', status: 'Rejected', context: 'The monthly report takes 40 s.', decision: 'We will not add materialized views; the refresh would lock the report table.', consequences: 'The report stays slow until the index of 0004.' }),
  [`${PAINEL}/0004-composite-index-on-month-account.md`]: nygard({ n: 4, title: 'Composite index on (month, account)', date: '2026-10-15', status: 'Proposed', context: 'The report filters by month and account.', decision: 'We will add a composite index on (month, account).', consequences: 'Writes get slightly slower.' }),
};

const RECEITAS_ADR = 'docs/decisions';
const RECEITAS_PDR = 'docs/product-decisions';
const receitas: Record<string, string> = {
  [`${RECEITAS_ADR}/0001-kotlin-multiplatform.md`]: '# 0001 · Kotlin Multiplatform no app\n\n## Contexto\n\nO app de iOS e o de Android repetem a mesma regra de receita.\n\n## Decisão\n\nA regra de receita vai para um módulo Kotlin Multiplatform.\n',
  [`${RECEITAS_ADR}/0002-cache-offline-das-receitas.md`]: [
    '# 0002 · Cache offline das receitas',
    '',
    '- Status: aceita',
    '- Data: 03/08/2026',
    '',
    'No contexto do app de receitas, diante de cozinhas sem sinal, decidimos por guardar as últimas 50 receitas abertas no aparelho e descartamos baixar o catálogo inteiro e o modo avião manual, para alcançar receitas que abrem sem rede, aceitando que uma receita editada no site demora até a próxima sincronização.',
    '',
  ].join('\n'),
  [`${RECEITAS_PDR}/0001-teste-gratis-de-14-dias.md`]: madr4({ status: '"superseded by [0003](0003-plano-gratuito-com-3-colecoes.md)"', date: '2026-03-03', makers: 'produto-sintetico', title: 'Teste grátis de 14 dias', context: 'Quem instala o app não sabe se vale pagar.', options: ['Teste de 14 dias', 'Plano gratuito limitado'], chosen: 'Teste de 14 dias', because: 'é o padrão das lojas.', good: ['a conversão é medida em duas semanas'], bad: ['quem cozinha pouco não chega a testar'] }),
  [`${RECEITAS_PDR}/0002-busca-por-ingrediente.md`]: madr4({ status: 'accepted', date: '2026-07-12', makers: 'produto-sintetico', title: 'Busca por ingrediente antes de busca por nome', context: 'Quem abre o app tem ingredientes na mão e não sabe o nome da receita.', options: ['Ingrediente primeiro', 'Nome primeiro'], chosen: 'Ingrediente primeiro', because: 'é a pergunta de quem está na cozinha.', good: ['a primeira busca acha receita'], bad: ['o índice de ingredientes precisa de sinônimos'] }),
  [`${RECEITAS_PDR}/0003-plano-gratuito-com-3-colecoes.md`]: madr4({
    status: 'accepted',
    date: '2026-09-01',
    makers: 'produto-sintetico, dev-sintetico',
    consulted: 'colega-b',
    title: 'Plano gratuito com até 3 coleções',
    context: 'O teste de 14 dias corta quem cozinha pouco antes de ver o valor das coleções.',
    options: ['Plano gratuito com 3 coleções', 'Teste de 30 dias', 'Tudo grátis com anúncio'],
    chosen: 'Plano gratuito com 3 coleções',
    because: 'mostra o valor sem prazo.',
    good: ['quem cozinha pouco continua no app'],
    bad: ['a conversão passa a ser medida por coleção'],
    confirmation: 'O painel de produto mede a conversão na quarta coleção.',
    more: 'Supersedes [Teste grátis de 14 dias](0001-teste-gratis-de-14-dias.md).',
  }),
  [`${RECEITAS_PDR}/0004-receitas-salvas-sem-conta.md`]: madr4({ status: 'proposed', date: '2026-10-16', makers: 'produto-sintetico', title: 'Receitas salvas funcionam sem conta', context: 'Pedir conta para salvar uma receita derruba metade dos primeiros acessos.', options: ['Salvar no aparelho, sem conta', 'Exigir conta'], chosen: 'Salvar no aparelho, sem conta', because: 'a conta vira um passo depois do valor.', good: ['o primeiro acesso salva sem atrito'], bad: ['as receitas salvas não sincronizam até criar a conta'] }),
};

const notas: Record<string, string> = {
  'adr/0001-record-architecture-decisions.md': nygard({ n: 1, title: 'Record architecture decisions', date: '2026-01-05', status: 'Accepted', context: 'We need to record the architectural decisions made on this project.', decision: 'We will use Architecture Decision Records.', consequences: 'New contributors can read why things are the way they are.' }),
};

/** The decision files of each demo repository, path → text, added to its other files. */
export const DEMO_DECISION_FILES: Record<string, Record<string, string>> = {
  'exemplo-labs/motor-de-regras': motor,
  'exemplo-labs/vitrine-demo': vitrine,
  'exemplo-labs/painel-de-metricas': painel,
  'estudio-ficticio/app-receitas': receitas,
  'dev-sintetico/cli-de-notas': notas,
};
