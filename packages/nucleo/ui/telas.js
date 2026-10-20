// O registro das telas: a rota, o item da barra e o arquivo de cada uma (veja o README.md).
//
// - `rota`: o caminho no navegador; `:id` casa um segmento.
// - `item`: o item na barra lateral, `{ rotulo, icone, section }`. `section` é o id de uma entrada de
//   `SECTIONS` e diz em que bloco da barra o item fica; dentro do bloco, vale a ordem deste registro. Sem `item`, a tela não aparece na barra e `acende` diz qual item
//   fica aceso quando ela está aberta (o Detalhe acende Sessões, como no A5).
// - `arquivo`: o módulo da tela em `ui/telas/`. Sem ele, a moldura mostra o cabeçalho e o estado vazio.
// - `titulo`, `sub` e `icone`: o cabeçalho do estado vazio e o título da janela.

// Os blocos da barra, na ordem do C24: as telas do dia a dia (sem título), Máquinas e Controle. Um bloco
// sem item não aparece.
export const SECTIONS = [
  { id: 'main', label: null },
  { id: 'machines', label: 'Máquinas' },
  { id: 'control', label: 'Controle' },
];

export const TELAS = [
  {
    id: 'dashboard',
    rota: '/ui',
    item: { rotulo: 'Dashboard', icone: 'dashboard', section: 'main' },
    titulo: 'Dashboard',
    sub: 'O agora das suas sessões',
    icone: 'dashboard',
    arquivo: '/ui/telas/dashboard.js',
  },
  {
    id: 'mural',
    rota: '/ui/mural',
    item: { rotulo: 'Mural ao vivo', icone: 'mural', section: 'main' },
    titulo: 'Mural ao vivo',
    sub: 'Um card por sessão aberta nesta máquina',
    icone: 'mural',
    arquivo: '/ui/telas/mural.js', // #34
  },
  {
    id: 'sessoes',
    rota: '/ui/sessoes',
    item: { rotulo: 'Sessões', icone: 'sessoes', section: 'main' },
    titulo: 'Sessões',
    sub: 'As sessões registradas nesta máquina',
    icone: 'sessoes',
    arquivo: '/ui/telas/sessoes.js', // #28
  },
  {
    id: 'feed',
    rota: '/ui/feed',
    item: { rotulo: 'Feed de atividade', icone: 'atividade', section: 'main' },
    titulo: 'Feed de atividade',
    sub: 'Todos os eventos das sessões, ao vivo',
    icone: 'atividade',
    arquivo: '/ui/telas/feed.js', // #94
  },
  {
    id: 'kanban',
    rota: '/ui/kanban',
    item: { rotulo: 'Kanban', icone: 'kanban', section: 'main' },
    titulo: 'Kanban',
    sub: 'As sessões por status, só leitura',
    icone: 'kanban',
    arquivo: '/ui/telas/kanban.js', // #31
  },
  {
    id: 'detalhe',
    rota: '/ui/sessoes/:id',
    acende: 'sessoes',
    titulo: 'Sessão',
    sub: null,
    icone: 'sessoes',
    arquivo: '/ui/telas/detalhe.js', // #29 e #30
  },
  {
    id: 'projeto',
    rota: '/ui/projeto',
    item: { rotulo: 'Kanban do projeto', icone: 'github', section: 'main' },
    titulo: 'Kanban do projeto',
    sub: 'O GitHub Project por Status',
    icone: 'github',
    arquivo: '/ui/telas/projeto.js', // #80 (C11)
  },
  {
    id: 'repos',
    rota: '/ui/repos',
    item: { rotulo: 'Repositórios', icone: 'repos', section: 'main' },
    titulo: 'Repositórios',
    sub: 'Organizações e repositórios da sua conta do GitHub',
    icone: 'repos',
    arquivo: '/ui/telas/repos.js', // C22
  },
  {
    id: 'repo',
    rota: '/ui/repos/:dono/:repo',
    acende: 'repos',
    titulo: 'Repositório',
    sub: null,
    icone: 'repos',
    arquivo: '/ui/telas/repo.js', // C23
  },
  {
    id: 'dev-console',
    rota: '/ui/dev-console',
    item: { rotulo: 'Dev Console', icone: 'gauge', section: 'main' },
    titulo: 'Dev Console',
    sub: 'PRs, issues e sessões dos repositórios do contexto',
    icone: 'gauge',
    arquivo: '/ui/telas/dev-console.js', // C27, issue 179
  },
  {
    id: 'analytics',
    rota: '/ui/analytics',
    item: { rotulo: 'Analytics', icone: 'analytics', section: 'main' },
    titulo: 'Analytics',
    sub: 'Uso, custo e produtividade das sessões',
    icone: 'analytics',
    arquivo: '/ui/telas/analytics.js', // #95 e #32
  },
  {
    // A aba Custo (/ui/analytics/custo): a mesma tela, que lê a aba de `params.aba`.
    id: 'analytics-aba',
    rota: '/ui/analytics/:aba',
    acende: 'analytics',
    titulo: 'Analytics',
    sub: null,
    icone: 'analytics',
    arquivo: '/ui/telas/analytics.js',
  },
  {
    id: 'workflows',
    rota: '/ui/workflows',
    item: { rotulo: 'Workflows', icone: 'workflows', section: 'main' },
    titulo: 'Workflows',
    sub: 'Como os agentes se orquestram: delegação, rodadas de review e resultado',
    icone: 'workflows',
    arquivo: '/ui/telas/workflows.js', // #96
  },
  {
    id: 'historico',
    rota: '/ui/historico',
    item: { rotulo: 'Histórico', icone: 'historico', section: 'main' },
    titulo: 'Histórico',
    sub: 'Sessões encerradas, por dia',
    icone: 'historico',
    arquivo: '/ui/telas/historico.js', // #33
  },
  {
    id: 'decisoes',
    rota: '/ui/decisoes',
    item: { rotulo: 'Decisões', icone: 'decisao', section: 'main' },
    titulo: 'Decisões',
    sub: 'O que você e os agentes decidiram, em todas as sessões',
    icone: 'decisao',
    arquivo: '/ui/telas/decisoes.js', // issue 103
  },
  { id: 'agent-config', rota: '/ui/agent-config', item: { rotulo: 'Agent Config', icone: 'bot', section: 'control' }, titulo: 'Agent Config', sub: 'Seu Claude Code: skills, subagentes, comandos, MCP, hooks e memória', icone: 'bot', arquivo: '/ui/telas/agent-config.js' }, // #63
];

/**
 * Os blocos da barra com os itens de cada um, na ordem de `SECTIONS`; os blocos vazios ficam de fora.
 * Um item sem `section` conhecida cai no primeiro bloco, para a tela nunca sumir da barra (o teste do
 * registro recusa esse item).
 */
export function sidebarSections(telas = TELAS, sections = SECTIONS) {
  const known = new Set(sections.map((s) => s.id));
  const sectionOf = (t) => (known.has(t.item.section) ? t.item.section : sections[0].id);
  return sections.map((s) => ({ ...s, items: telas.filter((t) => t.item && sectionOf(t) === s.id) })).filter((s) => s.items.length);
}

// Um id de sessão ou um nome do GitHub (ponto, hífen e sublinhado); `.` e `..` nunca.
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A tela e os parâmetros de um caminho, ou `null` se nenhuma casa. */
export function acharTela(caminho, telas = TELAS) {
  const partes = caminho.replace(/\/+$/, '').split('/');
  for (const tela of telas) {
    const molde = tela.rota.split('/');
    if (molde.length !== partes.length) continue;
    const params = {};
    let casa = true;
    for (let i = 0; i < molde.length && casa; i++) {
      if (molde[i].startsWith(':')) {
        let valor = '';
        try {
          valor = decodeURIComponent(partes[i]);
        } catch {}
        if (ID.test(valor) && valor !== '.' && valor !== '..') params[molde[i].slice(1)] = valor;
        else casa = false;
      } else casa = molde[i] === partes[i];
    }
    if (casa) return { tela, params };
  }
  return null;
}
