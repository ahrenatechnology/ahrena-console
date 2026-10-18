# Backlog: Ahrena Console 0.0.1

Status: **proposta para confirmação.** Nada foi criado no GitHub ainda.

Base: o estudo do Claude Code Agent Monitor ([benchmark/00-agent-monitor-detalhado.md](benchmark/00-agent-monitor-detalhado.md), seção 7, e o inventário das telas), as [validações](validacoes-0.0.1.md) e as decisões de 2026-10-18:

- **Referência de produto:** o Claude Code Agent Monitor (CCAM). Mesmas telas centrais, mesma máquina de estados, mesmo cuidado com custo.
- **Local e nuvem, mesmo código.** Desenvolve local primeiro e sobe para a AWS logo em seguida.
- **Nuvem:** AWS, serverless, barata.
- **Prazo:** nas mãos do time no mês que vem.

## Marcos

| Marco | O quê | Quando |
| --- | --- | --- |
| **M1 · Local** | Uma pessoa usa o console completo no próprio Mac: painel lateral, artefato, MCP | primeiras 2 semanas |
| **M2 · Nuvem** | O time usa o mesmo console pelo hub na AWS, com o agente local enviando de cada máquina | 2 semanas seguintes |
| **Depois** | Feed de atividade, analytics completa, alertas e webhooks, controle das sessões | depois da entrega ao time |

## Iniciativa

**Ahrena Console 0.0.1:** console MCP-first, na linha do Claude Code Agent Monitor, para ver e acompanhar sessões, agentes e trabalho de dentro do Claude Desktop, local e na nuvem.

## Do Claude Code Agent Monitor para o backlog

Cada tela e recurso do Claude Code Agent Monitor (CCAM), e onde ele entra aqui. O detalhe de cada um está no [estudo](benchmark/00-agent-monitor-detalhado.md).

### Telas

| Tela do CCAM | O que faz lá | Onde entra | Como fica aqui |
| --- | --- | --- | --- |
| **Dashboard** | 6 cards de números, árvore de agentes ativos, atividade recente, aba de saúde do servidor | **3.2** (M1); saúde em **1.8** | Igual, com o inbox "quem precisa de você" em destaque. O resumo também vai para o painel lateral (**4.1**) |
| **Kanban** | Duas visões (agentes e sessões), colunas por status, só leitura, 10 por coluna | **3.6** (M1) | Igual. O painel lateral ganha o kanban do trabalho do GitHub (**4.3**) |
| **Sessions** | Tabela com busca, filtro por diretório, pílulas de status, ordenação, paginação | **3.3** (M1); resumo em **4.2** | Igual. No hub ganha colunas de pessoa e máquina (**7.8**) |
| **Session Detail** | Abas Agentes (números, árvore, custo por modelo), Conversa e Linha do tempo; faixa "esperando sua resposta" | **3.4** e **3.5** (M1) | Igual |
| **Activity Feed** | Stream de eventos com filtros facetados, pausa, paginação | Depois da entrega | Entra logo após M2. O painel mostra os últimos eventos |
| **Analytics** | Heatmap de 52 semanas, custo por dia, modelo e dia da semana, tokens, ferramentas, exportação | Custo básico em **3.7** (M1); o resto depois | A tela de custo vem primeiro; o resto, depois da entrega |
| **Workflows** | 11 visualizações de orquestração (DAG, Sankey, concorrência) e os runs do Workflow tool | Depois da entrega | Valor alto para demonstração, baixo no dia a dia |
| **Agent Config** (editor de configuração) | Explora e edita skills, subagentes, comandos, memória, hooks e MCP, com backup | 0.0.2 | Entra com o controle, porque escreve em `~/.claude` |
| **Run** | Lança e retoma sessões do Claude Code e do Codex pelo navegador | 0.0.2 | Entra com o controle das sessões (responder, aprovar, retomar) |
| **Settings** | Preços, hooks, locais dos dados, importação, máquinas remotas, notificações, alertas, limpeza | Preços em **1.6**; hooks em **1.4** e **6.2**; importação em **1.2**; diagnóstico em **1.8**; alertas no hub (depois) | Sem tela de configurações própria na 0.0.1: cada parte vive no item que a usa |

### Recursos por baixo

| Recurso do CCAM | Onde entra | Como fica aqui |
| --- | --- | --- |
| Máquina de estados (waiting como camada, motivos, watchdog de 120 s, sonda de processo, abandoned em 180 min, cura de erro) | **1.5** | Copiamos as regras, não o código |
| Custo pelo transcript (preço por modelo, cache 5 min e 1 h, piso na compactação, "sem preço") | **1.6** | Igual, sempre marcado como estimativa |
| Importação do histórico no início | **1.2** | Igual |
| Tempo real por WebSocket | **2.4** | Long polling (`wait_for_changes`), porque é o que o artefato do Claude Desktop aceita |
| Instalação dos hooks | **1.4** e **6.2** | Pelo plugin do Claude Code, sem caminho absoluto do checkout |
| MCP com 103 ferramentas espelhando a API | **Épico 2** | Cerca de 10 ferramentas, desenhadas pelas perguntas do usuário |
| Plugins com skills (relatórios, standup, custo) | Depois da entrega | Relatórios viram skills do plugin |
| Statusline (contexto, custo, branch) | **1.6** e **1.7** | Também é a fonte dos limites oficiais de uso |
| Paleta de comandos ⌘K | Depois da entrega | No artefato |
| Notificações e sons | Depois da entrega | Aviso no painel e, no hub, Slack ou push |
| Alertas por regra e webhooks | Depois da entrega, no hub | As regras valem para o time inteiro |
| Máquinas remotas por SSH | **Épico 7** | Substituído pelo envio da máquina para o hub |
| App desktop (Electron) e extensão do VS Code | Não entra | O Claude Desktop já é a casa: painel lateral e artefato |
| Gato assistente (Tabby) | Não entra na 0.0.1 | A ideia útil, perguntar ao console, é o próprio MCP |
| Codex e Cursor | Em aberto | Depende de você querer acompanhar outros agentes além do Claude Code |
| Multiusuário | **Épico 7** (o CCAM não tem) | Território novo, sem referência |

---

## Épico 1 · Núcleo e máquina de estados (M1)

Estratégia: **por camada**, de baixo para cima. Tudo atrás de portas (armazenamento, relógio, processo), para o mesmo código rodar com SQLite no Mac e com DynamoDB na AWS.

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 1.1 | Tech task | Modelo de dados e porta de armazenamento, com adaptador SQLite (`node:sqlite`) | sessão, agente, evento, uso de tokens, tabela de preços | — |
| 1.2 | Tech task | Importar o histórico de `~/.claude/projects`, incluindo subagentes, sem contar duas vezes | backfill | 1.1 |
| 1.3 | Tech task | Seguir os transcripts em tempo real | atualização incremental | 1.2 |
| 1.4 | Tech task | Receber os hooks do Claude Code (SessionStart/End, Pre/PostToolUse, Stop, SubagentStop, Notification, UserPromptSubmit) | eventos ao vivo | 1.1 |
| 1.5 | Tech task | Máquina de estados como a do CCAM: `active/waiting/completed/error/abandoned`, motivo do waiting (`notification`, `interrupted`, `stop`, `session_start`), watchdog de turno morto (120 s), sonda de processo vivo, `abandoned` após 180 min, cura de erro já superado | estados confiáveis para o inbox | 1.4 |
| 1.6 | Tech task | Custo e tokens: tabela de preços editável, cache de 5 min e 1 h, piso depois da compactação, "sem preço" explícito, tudo marcado como estimativa | custo por sessão, agente, modelo, dia | 1.2 |
| 1.7 | Tech task | Medidor de contexto por sessão e agente | "62.6k / 200k (31%)" | 1.3 |
| 1.8 | Tech task | Saúde da coleta e `doctor` | hooks falhando, última leitura, o que falta | 1.4 |

## Épico 2 · Servidor MCP (M1)

Estratégia: **pelas perguntas do usuário**, não pelos endpoints. O CCAM espelhou a REST e chegou a 103 ferramentas; aqui são cerca de 10.

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 2.1 | User story, API | Quem precisa de mim e visão geral (`sessions_needing_attention`, `fleet_overview`) | as perguntas do inbox | 1.5 |
| 2.2 | User story, API | Sessões: listar, detalhar e buscar (`list_sessions`, `get_session`, `search_sessions`) | consulta por conversa | 1.5, 1.6 |
| 2.3 | User story, API | Relatório de uso e custo (`usage_report`) e SQL só de leitura (`query_sql`) | análise por conversa | 1.6 |
| 2.4 | Tech task | `wait_for_changes` (long polling) para as telas ficarem ao vivo | atualização quase instantânea | 1.5 |
| 2.5 | Tech task | Respostas paginadas, transcript tratado como conteúdo não confiável, ferramentas de escrita desligadas | segurança e limite de contexto | 2.2 |

## Épico 3 · Artefato: o console completo (M1)

Estratégia: **por tela**, na ordem do CCAM. Cada tela funciona sozinha. Gráficos em SVG próprio, sem biblioteca, como no CCAM.

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 3.1 | Tech task | Moldura do artefato: barra lateral de navegação, indicador Live, tema com a paleta do Ahrena, leitura do núcleo por `host:` com long polling | base de todas as telas | 2.4 |
| 3.2 | User story, frontend | Dashboard como o do CCAM: 6 cards (sessões, agentes ativos, subagentes ativos, eventos hoje, eventos no total, custo), inbox "quem precisa de você", árvore de agentes ativos com subagentes e atividade recente com link para a sessão | tela inicial | 3.1, 2.1 |
| 3.3 | User story, frontend | Sessões como no CCAM: tabela (Sessão, Status com motivo, Última atividade, Duração, Agentes, Custo, Diretório), busca, filtro por diretório, pílulas de status (Todas, Ativas, Esperando, Concluídas, Erro, Abandonadas), ordenação por atividade, duração e custo, 10 por página | tela de sessões | 3.1, 2.2 |
| 3.4 | User story, frontend | Detalhe da sessão, aba Agentes: números, ferramentas mais usadas, fluxo de tokens, árvore de subagentes com custo por nó, progresso das tarefas | tela de detalhe | 3.3 |
| 3.5 | User story, frontend | Detalhe da sessão, abas Conversa e Linha do tempo: mensagens, blocos de ferramenta que expandem, seletor de subagente; eventos filtráveis e expansíveis; faixa "esperando sua resposta" com o motivo | leitura da conversa e dos eventos | 3.4 |
| 3.6 | User story, frontend | Kanban só leitura, com duas visões como no CCAM: sessões (Ativas, Esperando, Concluídas, Erro, Abandonadas) e agentes (Trabalhando, Esperando, Concluídos, Erro); 10 cards por coluna com "mostrar mais" | quadro | 3.3 |
| 3.7 | User story, frontend | Custo: linha diária, divisão por modelo, por projeto | tela de custo | 3.1, 2.3 |

## Épico 4 · Painel lateral (M1)

Estratégia: **o essencial ao lado do trabalho.** O que é pesado fica no artefato.

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 4.1 | User story, frontend | Inbox e contadores: quem precisa de você, com motivo e tempo esperando; ativas, esperando, com erro, custo de hoje | coração do painel | 2.1 |
| 4.2 | User story, frontend | Sessões em resumo: as 10 mais recentes, com status colorido, medidor de contexto e link para o detalhe no artefato | lista curta | 2.2, 1.7 |
| 4.3 | User story, frontend | Trabalho do GitHub: hierarquia e kanban (o que foi testado no spike) | aba Trabalho | 5.2 |
| 4.4 | Tech task | Layout responsivo validado em larguras de 36 a 160 colunas, e estado salvo compatível entre versões | painel sem estouro | 4.1, 4.2 |

## Épico 5 · Integração com o GitHub (M1)

Estratégia: **leve e sob demanda.** O spike estourou o limite do GitHub; esta versão consulta pouco e guarda em cache.

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 5.1 | Spike | Consulta enxuta, cache em disco e busca sob demanda ao expandir (timebox: 1 dia) | decisão | — |
| 5.2 | Tech task | Hierarquia iniciativa → épico → item → plano, com PR, CI e review por item | dados de trabalho | 5.1, 1.1 |

## Épico 6 · Distribuição (M1)

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 6.1 | Tech task | Extensão `.mcpb` do núcleo (instala com dois cliques, sem reiniciar) | instalação no Claude Desktop | 2.1 |
| 6.2 | Tech task | Plugin do Claude Code: painel, hooks e `/console`, num marketplace | instalação do painel e dos hooks | 4.4, 1.4 |
| 6.3 | Tech task | Releases no GitHub com os dois pacotes e guia de instalação | entrega ao time | 6.1, 6.2 |

## Épico 7 · Hub na nuvem, AWS serverless (M2)

Estratégia: **por camada**, reaproveitando o núcleo atrás das portas do Épico 1. O CCAM não tem nada disso: é território novo.

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 7.1 | Spike | Arquitetura e custo: API Gateway + Lambda, DynamoDB sob demanda, S3, EventBridge, Cognito ou login GitHub; estimativa mensal (timebox: 2 dias) | decisão e diagrama | — |
| 7.2 | Tech task | Adaptador DynamoDB da porta de armazenamento | o mesmo modelo na AWS | 7.1, 1.1 |
| 7.3 | Tech task | Infraestrutura como código (CDK) e deploy | ambiente na AWS | 7.1 |
| 7.4 | Tech task | Identidade, organizações e papéis (quem vê o quê) | multiusuário | 7.3 |
| 7.5 | Tech task | API de ingestão com token por máquina | máquinas enviando | 7.2, 7.4 |
| 7.6 | Tech task | Agente local envia ao hub, com controle do que sai e redação de segredos | dados do time | 7.5, 1.5 |
| 7.7 | User story, API | Hub como conector MCP remoto: as mesmas ferramentas do Épico 2, para o time | MCP do time | 7.5, 2.2 |
| 7.8 | User story, frontend | Visão do time no artefato: sessões e trabalho por pessoa, máquina e cliente | console do time | 7.7, 3.3 |
| 7.9 | Tech task | GitHub consultado pelo hub uma vez para o time, com cache | fim do problema de limite | 7.3, 5.2 |
| 7.10 | Tech task | Ingestão dos agentes headless por OpenTelemetry | headless no mesmo console | 7.5 |

## Épico 8 · Identidade visual (M1)

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 8.1 | Tech task | Fechar a paleta (cor de erro, tema claro, tipografia) e os 5 status com cor e motivo | tokens finais | — |
| 8.2 | Tech task | Tokens compartilhados entre painel e artefato | uma fonte de cores | 8.1 |

---

## Depois da entrega ao time

Registrados como próximos passos, sem issue agora:

- Feed de atividade com filtros, e timeline da sessão (CCAM P1)
- Analytics completa: heatmap de 52 semanas, mix de tokens, uso de ferramentas (CCAM P1)
- Alertas por regra e webhooks (Slack, Teams), no hub (CCAM P1)
- Paleta de comandos ⌘K no artefato (CCAM P1)
- Workflows dinâmicos e análise de orquestração (CCAM P1 e P2)
- Controle (0.0.2): responder, aprovar, run e resume pelo console (tela Run do CCAM)
- Editor de configuração (0.0.2): skills, subagentes, comandos, memória, hooks e MCP, com backup (tela Agent Config do CCAM)
- Relatórios como skills do plugin: standup, semanal, executivo (plugins do CCAM)
- Espelhar o GitHub Projects, carregando só o projeto aberto

## Premissas

- Tudo no repo `ahrenatechnology/ahrena-console`, com os tipos de issue da organização e sub-issues.
- O código de `spikes/` é referência; o definitivo nasce dentro destes itens, com testes.
- Ordem entre épicos registrada como `blocked by` no GitHub.
