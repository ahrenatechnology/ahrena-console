# Backlog: Ahrena Console 0.0.1

Status: **proposta para confirmação.** Nada foi criado no GitHub ainda.

Base: o estudo do Claude Code Agent Monitor (benchmark interno, seção 7, e o inventário das telas), o Podium (benchmark interno), as [validações](validacoes-0.0.1.md) e as decisões de 2026-10-18:

- **Claude-first.** O pacote nasce para o Claude e vive dentro dele: MCP primeiro, painel lateral, artefato e conversa no Claude Desktop.
- **Pacote completo.** Tudo o que o Claude Code Agent Monitor (CCAM) e o Podium entregam, com o mapa de cada recurso abaixo.
- **Referência de produto:** o Claude Code Agent Monitor. Mesmas telas centrais, mesma máquina de estados, mesmo cuidado com custo.
- **Local e nuvem, mesmo código.** Desenvolve local primeiro e sobe para a AWS logo em seguida.
- **Nuvem:** AWS, serverless, barata.
- **Prazo:** nas mãos do time no mês que vem.

## Marcos

| Marco | O quê | Quando |
| --- | --- | --- |
| **M1 · Local** | Uma pessoa usa o console completo no próprio Mac: painel lateral, artefato, MCP | primeiras 2 semanas |
| **M2 · Nuvem** | O time usa o mesmo console pelo hub na AWS, com o agente local enviando de cada máquina | 2 semanas seguintes |
| **M3 · Controle** | Responder, aprovar, lançar e configurar pelo console (Épico 9) | em seguida |
| **Depois** | Feed de atividade, analytics completa, alertas e webhooks | depois da entrega ao time |

## Iniciativa

**Ahrena Console 0.0.1:** console MCP-first, na linha do Claude Code Agent Monitor, para ver e acompanhar sessões, agentes e trabalho de dentro do Claude Desktop, local e na nuvem.

## Do Claude Code Agent Monitor para o backlog

Cada tela e recurso do Claude Code Agent Monitor (CCAM), e onde ele entra aqui. O detalhe de cada um está no estudo do benchmark interno.

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
| **Agent Config** (editor de configuração) | Explora e edita skills, subagentes, comandos, memória, hooks e MCP, com backup | **9.6** | Entra no épico de controle, porque escreve em `~/.claude` |
| **Run** | Lança e retoma sessões do Claude Code e do Codex pelo navegador | **9.5** | Entra no épico de controle |
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

## Do Podium para o backlog

Cada recurso do Podium e onde ele entra aqui.

| Recurso do Podium | O que faz lá | Onde entra | Como fica aqui |
| --- | --- | --- | --- |
| **Mural de sessões** (fleet wall) | Um card por sessão ao vivo, com status, modelo, esforço, plano, agentes, contexto e custo; números no topo | **3.9** | Uma tela "Mural" no artefato, ao lado do Dashboard |
| **Página do orquestrador** | Cabeçalho, fatos e faixa de status; árvore de agentes que lançam agentes; abas de atividade, arquivos e plano | **3.4** e **3.5** | Junta com o Detalhe da sessão do CCAM |
| **Plano da sessão** | Passos extraídos de TaskCreate, TodoWrite e update_plan, com o dono de cada passo e barra `feitos/total` | **1.9** | No detalhe da sessão, no mural e no painel |
| **Medidor de esforço** | Cinco barras, de `low` a `max`, onde aparece o modelo | **3.9** e **4.2** | Igual |
| **Estouros de contexto** (blowouts) | Conta quantas vezes a janela estourou; selo e alerta a partir de 2 | **1.7** | Junto do medidor de contexto |
| **Falhas explicadas** | Captura cada falha e, se ligado, um modelo pequeno explica em duas frases | **1.10** | Desligado por padrão |
| **Esperando processo em background** | Sessão que terminou o turno mas tem trabalho rodando por trás | **1.5** | Um motivo a mais na máquina de estados |
| **Delegando** | Agente parado esperando os agentes que lançou | **1.5** | Estado próprio, sem contar como "esperando você" |
| **Responder pelo console** | Responder perguntas, aprovar plano, permitir uma ferramenta, mandar mensagem, `/clear` e `/compact`, com dupla autorização (admin e dono) | **Épico 9** | Desligado por padrão, pelo plugin do Claude Code |
| **Visão por pessoa** | Agrupa o mural por pessoa quando o servidor é de time | **7.8** | No hub |
| **Pessoas, tokens e grupos** | Cada pessoa com o próprio token; grupos; administradores | **7.4** | No hub, com Cognito ou login GitHub |
| **Admin** | Preços por modelo, chaves de recursos (feature flags), avisos do mural, máquinas que reportam, log do admin | **7.11** | No hub |
| **Compatibilidade de versão** | Avisa quando o reporter e o servidor estão em versões que não combinam | **7.11** e **6.3** | Aviso no painel e no doctor |
| **Histórico** | Sessões encerradas por dia, com o detalhe de cada uma, e ligação entre sessões depois de `/clear` | **3.8** | Tela "Histórico" no artefato |
| **Feed de atividade do agente** | Últimas chamadas de ferramenta e textos de um agente, enviados só enquanto alguém olha | Depois da entrega | Privacidade igual à do Podium: nada é enviado sem alguém olhando |
| **Copiar comando de retomar** | Botão que copia o `claude --resume` da sessão | **3.4** | No detalhe da sessão |
| **Status line** | `podium v1.1.0 ● N live`, com avisos de versão | **4.5** | `ahrena-console ● N ao vivo` |
| **Sessões em segundo plano escondidas** | O mural esconde sessões sem terminal aberto, com um aviso | **3.9** | Igual |
| **Simulador** | Gera sessões falsas, com modo caos, para testar e demonstrar | **6.4** | Essencial para demonstrar sem expor dados reais |
| **Temas** | Vários temas de cor | **8.1** | Tema escuro e claro com a paleta do Ahrena |
| **`podiumctl` e contêiner** | Sobe o servidor num contêiner, com token e porta | **7.3** | Substituído pelo deploy serverless na AWS |
| **Segurança** | Token por pessoa, bloqueio depois de tentativas erradas, redação de segredos | **7.4** e **7.6** | No hub |

---

## Épico 1 · Núcleo e máquina de estados (M1)

Estratégia: **por camada**, de baixo para cima. Tudo atrás de portas (armazenamento, relógio, processo), para o mesmo código rodar com SQLite no Mac e com DynamoDB na AWS.

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 1.1 | Tech task | Modelo de dados e porta de armazenamento, com adaptador SQLite (`node:sqlite`) | sessão, agente, evento, uso de tokens, tabela de preços | — |
| 1.2 | Tech task | Importar o histórico de `~/.claude/projects`, incluindo subagentes, sem contar duas vezes | backfill | 1.1 |
| 1.3 | Tech task | Seguir os transcripts em tempo real | atualização incremental | 1.2 |
| 1.4 | Tech task | Receber os hooks do Claude Code (SessionStart/End, Pre/PostToolUse, Stop, SubagentStop, Notification, UserPromptSubmit) | eventos ao vivo | 1.1 |
| 1.5 | Tech task | Máquina de estados como a do CCAM: `active/waiting/completed/error/abandoned`, motivo do waiting (`notification`, `interrupted`, `stop`, `session_start`), watchdog de turno morto (120 s), sonda de processo vivo, `abandoned` após 180 min, cura de erro já superado | estados confiáveis para o inbox, incluindo "delegando" e "esperando processo em background" (Podium) | 1.4 |
| 1.6 | Tech task | Custo e tokens: tabela de preços editável, cache de 5 min e 1 h, piso depois da compactação, "sem preço" explícito, tudo marcado como estimativa | custo por sessão, agente, modelo, dia | 1.2 |
| 1.7 | Tech task | Medidor de contexto por sessão e agente, com contagem de estouros e alerta a partir de 2 (Podium) | "62.6k / 200k (31%)" e estouros | 1.3 |
| 1.8 | Tech task | Saúde da coleta e `doctor` | hooks falhando, última leitura, o que falta | 1.4 |
| 1.9 | Tech task | Plano da sessão a partir de TaskCreate, TodoWrite e update_plan, com dono de cada passo (Podium) | `feitos/total` por sessão | 1.4 |
| 1.10 | Tech task | Falhas: captura e explicação opcional por um modelo pequeno (Podium) | motivo de cada falha | 1.4 |

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
| 3.8 | User story, frontend | Histórico: sessões encerradas por dia, com detalhe e ligação depois de `/clear` (Podium) | tela de histórico | 3.3 |
| 3.9 | User story, frontend | Mural de sessões ao vivo: um card por sessão com status, modelo, esforço, plano, agentes, contexto e custo (Podium) | tela do mural | 3.1, 1.9, 1.7 |
| 3.10 | User story, frontend | Kanban do projeto no artefato: o GitHub Project por Status, e mover um card muda o Status no GitHub | o projeto inteiro numa tela | 3.1, 5.3 |

## Épico 4 · Painel lateral (M1)

Estratégia: **o painel olha a sessão em que está aberto.** O projeto, a frota e o time ficam no artefato ([decisão 0004](decisoes/0004-painel-da-sessao.md)).

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 4.1 | User story, frontend | Esta sessão: estado com motivo e tempo, modelo, contexto, custo e processos em background; e a linha "N precisam de você" | coração do painel | 2.1 |
| 4.2 | User story, frontend | Subagentes e plano desta sessão, e as sessões que ela abriu, com status colorido e link para o detalhe no artefato | o que roda dentro da sessão | 2.2, 1.7 |
| 4.3 | User story, frontend | Trabalho desta sessão: a issue e o PR que ela toca (pelo branch), com sub-issues, CI e review | o recorte do GitHub da sessão | 5.2 |
| 4.4 | Tech task | Layout responsivo validado em larguras de 36 a 160 colunas, e estado salvo compatível entre versões | painel sem estouro | 4.1, 4.2 |
| 4.5 | Tech task | Status line `ahrena-console ● N ao vivo`, com aviso de versão (Podium) | estado sempre visível | 4.1 |
| 4.6 | Tech task | Consumo baixo: o painel consulta só enquanto está aberto e só a própria sessão, com medição repetível | painel que não pesa no Mac | — |

## Épico 5 · Integração com o GitHub (M1)

Estratégia: **leve e sob demanda.** O spike estourou o limite do GitHub; esta versão consulta pouco e guarda em cache. Critério da 0.0.1: o próprio desenvolvimento do Ahrena Console é gerenciado pelo kanban do console (5.3).

Decisão do spike 5.1: [consulta rasa, filhas ao expandir, delta e cache](decisoes/0001-github-consulta-cache.md).

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 5.1 | Spike | Consulta enxuta, cache em disco e busca sob demanda ao expandir (timebox: 1 dia) | decisão | — |
| 5.2 | Tech task | Hierarquia iniciativa → épico → item → plano, com PR, CI e review por item | dados de trabalho | 5.1, 1.1 |
| 5.3 | User story, frontend | Gerenciar o projeto do Ahrena Console pelo kanban: ver as issues do GitHub Project por Status e mover um card muda o Status no GitHub | o console gerenciando o próprio desenvolvimento | 5.2 |

## Épico 6 · Distribuição (M1)

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 6.1 | Tech task | Extensão `.mcpb` do núcleo (instala com dois cliques, sem reiniciar) | instalação no Claude Desktop | 2.1 |
| 6.2 | Tech task | Plugin do Claude Code: painel, hooks e `/console`, num marketplace | instalação do painel e dos hooks | 4.4, 1.4 |
| 6.3 | Tech task | Releases no GitHub com os dois pacotes e guia de instalação | entrega ao time | 6.1, 6.2 |
| 6.4 | Tech task | Simulador de sessões, com modo caos, para testar e demonstrar sem dados reais (Podium) | demonstração | 1.1 |
| 6.5 | Spike | Plataforma desktop externa integrada ao Claude, reaproveitando o que já está instalado; referência no app Electron do CCAM, preferência por Tauri (timebox: 1 dia) | decisão | — |
| 6.6 | Tech task | Núcleo com dono único: arquivo de trava com pid e porta, adoção pela extensão, pelo app e pelo terminal, saída quando o pai some ([decisão 0005](decisoes/0005-app-desktop.md)) | um núcleo por máquina | 1.1 |
| 6.7 | User story, frontend | App desktop em Tauri, na bandeja: "N precisam de você" na barra de menus, sessões esperando no menu, janela com a interface do núcleo | atenção fora do Claude | 2.1, 2.4, 6.6 |
| 6.8 | User story, frontend | Notificações do sistema quando uma sessão passa a esperar, com o motivo | aviso sem olhar a tela | 6.7, 1.5 |
| 6.9 | Tech task | Abrir no login com SMAppService, começando só na bandeja | núcleo vivo desde o login | 6.7 |
| 6.10 | Tech task | Release do app assinado e notarizado, com updater e build no CI | instalar e atualizar sem atrito | 6.7, 6.3 |

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
| 7.11 | User story, frontend | Admin do hub: preços por modelo, chaves de recursos, avisos, máquinas que reportam, compatibilidade de versão, log (Podium) | administração do time | 7.4 |

## Épico 9 · Responder e controlar pelo console

Estratégia: **por ação**, cada uma desligada por padrão e liberada pelo admin e pelo dono da sessão, como no Podium.

| # | Tipo | Título | Produz | Depende de |
| --- | --- | --- | --- | --- |
| 9.1 | Spike | Como o plugin entrega respostas à sessão (perguntas, plano, permissão) com segurança (timebox: 1 dia) | decisão | — |
| 9.2 | User story, frontend | Responder perguntas e aprovar planos pelo console (Podium) | respostas sem terminal | 9.1, 4.1 |
| 9.3 | User story, frontend | Permitir ou negar uma ferramenta, uma vez (Podium) | aprovações sem terminal | 9.2 |
| 9.4 | User story, frontend | Mandar mensagem e `/clear`, `/compact` para uma sessão parada (Podium) | comandos sem terminal | 9.2 |
| 9.5 | User story, frontend | Lançar e retomar sessões pelo console (tela Run do CCAM) | run e resume | 9.1 |
| 9.6 | User story, frontend | Editor de configuração: skills, subagentes, comandos, memória, hooks e MCP, com backup (tela Agent Config do CCAM) | configuração sem terminal | 3.1 |

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
- Relatórios como skills do plugin: standup, semanal, executivo (plugins do CCAM)
- Espelhar o GitHub Projects, carregando só o projeto aberto

## Premissas

- Tudo no repo `ahrenatechnology/ahrena-console`, com os tipos de issue da organização e sub-issues.
- O código de `spikes/` é referência; o definitivo nasce dentro destes itens, com testes.
- Ordem entre épicos registrada como `blocked by` no GitHub.
