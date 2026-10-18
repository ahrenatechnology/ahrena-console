# Benchmark 01: dashboards de observabilidade de sessões do Claude Code

Insumo para o design do **Ahrena Console** (MCP-first, roda dentro do Claude Desktop como servidor MCP local + artefato/painel, sem depender de terminal/TUI).

- Data da coleta: 2026-10-18. Stars e datas de push vêm da API do GitHub nesse dia.
- Fontes: README de cada repo (via `gh api`), mais o clone local do Podium (README, `docs/USER_GUIDE.md`, `docs/SPEC.md` §1 e §8.1) e uma checagem pontual do `mcp_server.mjs` do agents-observe.
- Nada foi instalado nem executado. As features listadas são as que a documentação declara, não foram testadas.
- Fora de escopo: hoangsonww/Claude-Code-Agent-Monitor (outro agente cobre).

## Visão geral rápida

| Ferramenta | Licença | Stars | Último push | Coleta | Forma |
|---|---|---|---|---|---|
| agents-observe (simple10) | MIT | ~700 | set/2026 | hooks (plugin) + leitura pontual do transcript | plugin CC + container Docker + web |
| Multi-Agent Observability (disler) | sem licença declarada | ~1,5k | fev/2026 | hooks (scripts Python via `uv`) | web (Bun + Vue) |
| CAST Dashboard (ek33450505) | badge diz MIT, sem arquivo de licença | 3 | set/2026 | `cast.db` (escrito por hooks do CAST) + JSONL | web (Express + React) |
| ObservAgent (darshannere) | Apache-2.0 | 14 | abr/2026 | hooks (relay Python) + watcher de JSONL | CLI npm + web |
| Podium (eengelking) | MIT | ~66 | out/2026 (ativo) | mod do Claude Code (`podium-reporter`); fallback por settings hooks | servidor + web; multiusuário |
| Sniffly (chiphuyen) | MIT | ~1,3k | ago/2025 (parado) | só transcripts JSONL | CLI Python + web |
| Claude Code Viewer (d-kimuson) | MIT | ~1,3k | ago/2026 | JSONL + Agent SDK (opcional, para enviar mensagens) | web / PWA, cliente completo |
| claude-devtools (matt1398) | MIT | ~4k | set/2026 | só transcripts JSONL (local ou por SSH) | app Electron + Docker/web |

---

## 1. agents-observe (simple10/agents-observe)

**O que é:** dashboard em tempo real de sessões e multiagentes do Claude Code, distribuído como plugin do Claude Code.

- **Licença:** MIT.
- **Stars/atividade:** ~700 stars, versão 0.9.x, commits frequentes (último push em set/2026).
- **Como coleta:** hooks do plugin chamam um script bash fire-and-forget, que repassa ao `observe_cli.mjs` (Node), que faz POST no servidor. Quando o servidor precisa de mais dados (por exemplo o slug legível da sessão), ele **responde pedindo**, e o hook lê o transcript local e reenvia. Armazena em SQLite e transmite por WebSocket.
- **Features:**
  - stream ao vivo de tool calls, com PreToolUse e PostToolUse mesclados numa linha só;
  - hierarquia de agentes (qual subagente nasceu de qual pai);
  - filtro por agente e por ferramenta, busca em todos os eventos;
  - payload completo expansível (comando e resultado);
  - timeline clicável que salta para o evento;
  - histórico de sessões com nomes legíveis ("twinkly-hugging-dragon");
  - tokens e custo por sessão (desde a 0.9.7);
  - sino de notificação configurável por tipo de evento;
  - skills `/observe` (status, debug, logs, restart, `view` abre a sessão atual no dashboard, `stats`);
  - mapeamento de ícones e geração de resumo editáveis em arquivos de config;
  - porta livre automática se a 4981 estiver ocupada; migração automática do DB entre versões.
- **Diferencial:** instalação em dois comandos via marketplace de plugins. O detalhe mais relevante para nós: o plugin declara **um servidor MCP sem nenhuma tool** (`tools/list` retorna vazio). Ele serve só para que o Claude Code suba o container Docker no início da sessão, ou seja, o MCP é usado como gancho de ciclo de vida.
- **O que aproveitar no Ahrena Console:**
  - o protocolo de "servidor pede, hook completa" para buscar dados caros no transcript sob demanda;
  - o merge Pre/Post em uma linha com duração;
  - a skill `/observe view`, que abre a sessão atual no painel (vira uma tool MCP `open_session` no nosso caso);
  - envelope de evento por classe de agente (Claude, Codex), com o servidor neutro.
- **Fraquezas:** exige Docker, Node e bash no host; o servidor não rastreia status de agente (tudo é derivado no cliente); o MCP não expõe nada consultável; o README anuncia suporte a Codex mas o roadmap ainda o lista como pendente.

## 2. Multi-Agent Observability (disler/claude-code-hooks-multi-agent-observability)

**O que é:** sistema de referência, muito citado, que captura os 12 tipos de hook do Claude Code e mostra numa timeline web ao vivo.

- **Licença:** nenhuma declarada (juridicamente, todos os direitos reservados).
- **Stars/atividade:** ~1,5k stars; último push em fev/2026; 31 issues abertas. Tem cara de projeto de demonstração ligado a vídeos do autor.
- **Como coleta:** hooks em Python (`uv run`) copiados para `.claude/` de cada projeto; `send_event.py` faz POST num servidor Bun, que grava em SQLite (WAL) e transmite por WebSocket para um cliente Vue.
- **Features:**
  - cobre os 12 eventos: PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, Stop, SubagentStart, SubagentStop, PreCompact, UserPromptSubmit, SessionStart, SessionEnd;
  - filtros por app, sessão e tipo de evento;
  - cor dupla por app e por sessão; emoji por evento e por ferramenta (MCP com prefixo 🔌);
  - "live pulse chart" em canvas com janelas de 1, 3 e 5 minutos;
  - visualizador do transcript do chat (`--add-chat`);
  - resumo de eventos por IA (`--summarize`);
  - detecção de tool MCP (`mcp_server`, `mcp_tool_name`);
  - hooks que também **bloqueiam** comandos perigosos e validam arquivos no Stop;
  - TTS para notificações (ElevenLabs/OpenAI);
  - endpoint `GET /events/filter-options` que devolve os valores possíveis dos filtros.
- **Diferencial:** é o mapa mais didático do modelo de eventos de hooks e mistura observar com agir (validadores e bloqueios no próprio hook).
- **O que aproveitar:**
  - a tabela evento → significado → apresentação como contrato da nossa ingestão;
  - a separação visual por sessão (cor estável por sessão);
  - o endpoint de opções de filtro (bom candidato a tool MCP `list_filter_values`);
  - o resumo de cada evento em uma linha, gerado por IA de forma opcional.
- **Fraquezas:** sem licença; instalação por cópia de pasta em cada projeto; exige `ANTHROPIC_API_KEY` para o resumo; sem custo, sem contexto, sem árvore de agentes de verdade; o broadcast vai para todos os clientes; manutenção irregular.

## 3. CAST Dashboard (ek33450505/claude-code-dashboard)

**O que é:** camada de observabilidade do CAST (um "sistema operacional de agentes" local), com 18 páginas sobre `~/.claude/` e `cast.db`.

- **Licença:** o badge diz MIT, mas o repo não tem arquivo de licença (a API retorna 404).
- **Stars/atividade:** 3 stars, porém muito ativo (versão 3.0.0, CI, push em set/2026). É um projeto de um autor só.
- **Como coleta:** leitura direta de `~/.claude/projects/*` (JSONL), `~/.claude/agents/`, `settings.json` e do SQLite `cast.db` (escrito pelos hooks do CAST: cost-tracker, agent-stop, memory-router). chokidar faz o watch, um poll do `cast.db` roda a cada 3 s e o push vai por SSE.
- **Features:**
  - Home ao vivo (agentes ativos, custo do dia, saúde);
  - Sessions com drill-down no JSONL;
  - Analytics de 30 dias (consumo de tokens, faixa de modelo, "economia por delegação", frequência de ferramentas, scorecard por agente);
  - registro de agentes com status e histórico de execuções;
  - página Executive com KPIs;
  - Evals (pass@k por agente e por modelo);
  - Agent Reliability com 7 abas (alucinações, completude, checagem de referências de código, truncamentos, violações de protocolo, anomalias de worktree);
  - Hooks (definições e saúde) e Hook Failures;
  - Memory (busca e edição dos arquivos de memória);
  - Plans, DB browser read-only, Work Log, Routines, Incidents, Injection Log;
  - busca global `Cmd+K`;
  - 103 endpoints REST.
- **Diferencial:** postura de segurança explícita. Escuta só em loopback, é **read-only por padrão**, e as 12 rotas de escrita (inclusive `dispatch` de agentes) retornam 404 sem `CAST_DASHBOARD_CONTROL=1` e exigem token (fail-closed: 503 sem configuração, 403 com token errado, comparação em tempo constante). Tem schema-drift guard e nunca escreve no DB ao iniciar. O custo é mostrado como **limite inferior**, com `runs_missing_cost`.
- **O que aproveitar:**
  - o modelo read-only por padrão com controle fail-closed (no nosso caso, tools MCP de leitura sempre presentes e tools de controle atrás de flag e confirmação);
  - mostrar a incompletude do dado em vez de esconder;
  - a página de saúde dos hooks e das falhas de hook (essencial quando a coleta depende de hooks);
  - o scorecard por agente e a página de confiabilidade;
  - memória como cidadã de primeira classe.
- **Fraquezas:** acoplado ao CAST (sem ele, metade das páginas degrada); 18 páginas é superfície demais; sem backfill automático de custo; usuário único; adoção quase nula.

## 4. ObservAgent (darshannere/observagent)

**O que é:** observabilidade local e "zero-config" para sessões do Claude Code, focada em custo, ferramentas e latência.

- **Licença:** Apache-2.0.
- **Stars/atividade:** 14 stars, beta publicado no npm, último push em abr/2026.
- **Como coleta:** um `relay.py` instalado por `observagent init` registra hooks (Pre/PostToolUse, SubagentStart/Stop) em `~/.claude/settings.json` e faz POST fire-and-forget em `/ingest`. Em paralelo, um `jsonlWatcher` lê `~/.claude/projects` para extrair o uso e calcular o custo. O servidor é Fastify + SQLite, com SSE.
- **Features:**
  - stream ao vivo de tool calls;
  - custo por modelo considerando tokens de cache;
  - latência por ferramenta;
  - falhas de ferramenta e saúde da sessão;
  - filtro por sessão e por subagente;
  - History agrupado por repositório, com custo, modelo, último evento, marcador ativo/erro;
  - replay de sessão para o modo live;
  - exportação em JSONL e CSV;
  - configuração de orçamento e limiares (`/api/config`);
  - `observagent doctor`.
- **Diferencial:** coleta **híbrida**. Os hooks dão a latência e o tempo real; o JSONL dá a verdade de tokens e custo. Instalação em 3 comandos, que editam o `settings.json` sozinhos.
- **O que aproveitar:**
  - a coleta híbrida hooks + JSONL (é o desenho certo para não depender de um único canal);
  - o comando `init`/`doctor`, que instala e verifica os hooks;
  - o agrupamento do histórico por repositório;
  - orçamento e limiares de alerta;
  - exportação.
- **Fraquezas:** pouco maduro e com pouca adoção; hooks limitados a 4 eventos (não vê Notification, Stop ou permissões, logo não sabe se a sessão "espera você"); sem visão de contexto; depende de Python.

## 5. Podium (eengelking/podium)

**O que é:** console de frota ao vivo para Claude Code. Cada sessão, agente, plano, custo e janela de contexto numa aba do navegador, para uma pessoa ou para um time.

- **Licença:** MIT.
- **Stars/atividade:** ~66 stars, mas é o mais ativo e o mais especificado do grupo (push no próprio dia 18/10/2026; SPEC de 1.370 linhas, DECISIONS, GOTCHAS e mockups HTML que valem como especificação).
- **Como coleta:** um **mod do Claude Code** (`podium-reporter`, instalado pelo marketplace de plugins) que roda dentro da sessão e envia "Reports" agregados (estado, não eventos crus) a cada 1 s quando há mudança, com heartbeat de 5 s, para um servidor Node com SQLite e SSE. Git é consultado a cada 10 s no `cwd`. Para sessões iniciadas sem o mod, há uma visão reduzida via settings hooks. Por desenho, **não lê transcripts**: manda só trechos curtos, com segredos redigidos.
- **Features (SPEC §1 e §8.1, USER_GUIDE):**
  - "wall" de cards por sessão, que aparece em ~2 s e sai sozinho;
  - 6 KPIs: orquestradores ao vivo, subagentes rodando, blowouts de contexto, passos de plano concluídos, custo estimado do dia e tokens no último minuto, com sparklines;
  - por sessão: modelo, effort (medidor de 5 barras), branch e worktree com ahead/behind/modificados, contexto, custo, tokens, tempo, **comando de resume copiável**;
  - **plano** extraído de TaskCreate/TaskUpdate/TodoWrite, com o dono de cada passo;
  - árvore de agentes aninhada em qualquer profundidade (subagentes e forks) com status, contexto, custo, skills carregadas, última ferramenta;
  - **blowouts de contexto** contados por loop, com alerta vermelho a partir de 2;
  - falha explorável: chamada, saída, evidência de causa; explicação opcional por Haiku (`explainFailures`);
  - estados derivados ricos: running, **waiting** (precisa da sua aprovação ou do seu input), **delegating**, **stale** (com contagem até sair e botão Remove), "esperando processo em background";
  - painel de atividade paginado de 12 em 12, com links para o item;
  - gráficos de 60 s por sessão; History por dia;
  - **Respond from Podium**: responder AskUserQuestion, aprovar ou rejeitar plano, permitir ou negar uma tool uma vez, mandar mensagem, `/clear` e `/compact`. Precisa de dupla autorização (Admin liga a flag, dono da sessão liga `respond` no mod), e quem responder primeiro (terminal ou console) vence;
  - activity feed opt-in, transmitido **só enquanto alguém olha** o painel daquele agente e mantido só em memória;
  - multiusuário: token por pessoa amarrado ao nome, hash no servidor, grupos, visão por pessoa, página Reporters (reportando, ocioso, silencioso);
  - Admin: preços de modelo editáveis, feature flags, wall notices, log de admin;
  - status line no Claude Code (`podium vX ● N live` / `○ offline`) e comando `/podium`;
  - checagem de versão entre mod e servidor;
  - temas, wall mode (`w`), atalhos para recolher os painéis, controle de taxa de refresh para economizar GPU;
  - simulador com `--chaos`;
  - proteção contra DNS rebinding (allowlist de Host).
- **Diferencial:** a única ferramenta pensada como **console de operação** ("qual sessão precisa de mim agora?") e não como visualizador de logs. Tem um modelo de privacidade explícito ("o que sai da sessão") e um controle mínimo, muito bem delimitado, que só responde ao que a sessão já pergunta e nunca digita no terminal.
- **O que aproveitar:** praticamente o modelo conceitual inteiro:
  - estados derivados (waiting, delegating, stale, background wait);
  - blowouts como sinal de primeira classe;
  - plano a partir das tools de tarefa;
  - "Respond" com dupla autorização e "primeiro a responder vence";
  - feed só sob observação;
  - custo sempre rotulado como estimativa, com tabela de preços editável;
  - comando de resume copiável;
  - Report agregado em vez de evento cru.
- **Fraquezas:**
  - depende de navegador e servidor próprios (é o oposto de rodar dentro do Desktop);
  - exige instalar o mod em cada máquina;
  - leitura sem autenticação para quem alcança a porta;
  - HTTP puro;
  - não fecha nem inicia sessões (manda o usuário para `claude stop` e `claude rm`);
  - sem histórico profundo nem busca em conversas (de propósito);
  - UI densa e com custo de GPU perceptível.

## 6. Sniffly (chiphuyen/sniffly)

**O que é:** dashboard analítico dos logs do Claude Code, voltado a "usar melhor o Claude Code".

- **Licença:** MIT.
- **Stars/atividade:** ~1,3k stars; parado desde ago/2025.
- **Como coleta:** só lê os JSONL de `~/.claude/projects` (sem hooks, sem tempo real), com cache em memória por projeto.
- **Features:**
  - estatísticas de uso por projeto;
  - **breakdown de erros por tipo** ("onde o Claude erra");
  - histórico de instruções do usuário navegável (walkthrough de comandos);
  - **link compartilhável** do dashboard (privado ou público em galeria, com ou sem o texto dos comandos);
  - recorte por intervalo de datas.
- **Diferencial:** foco em aprendizado e retrospectiva (erros e padrões de instrução) e em compartilhar com colegas.
- **O que aproveitar:**
  - a taxonomia de erros como relatório periódico;
  - o "walkthrough" das instruções do usuário como revisão de prompts;
  - o compartilhamento com controle de privacidade (no Desktop, isso vira publicar um artefato privado que pode ser compartilhado).
- **Fraquezas:** sem tempo real, sem multiagente, sem custo detalhado por agente, projeto abandonado, Python.

## 7. Claude Code Viewer (d-kimuson/claude-code-viewer)

**O que é:** cliente web completo do Claude Code centrado em logs de sessão: ver, buscar, retomar e controlar sessões pelo navegador ou pelo celular (PWA).

- **Licença:** MIT.
- **Stars/atividade:** ~1,3k stars; ativo (push em ago/2026), com CI, releases e i18n.
- **Como coleta:** lê os JSONL (validação estrita de schema, "zero perda de dados") e acompanha sessões ao vivo por SSE. Para **enviar** mensagens, retomar sessões e aprovar permissões, usa o Agent SDK. Desde abr/2026 isso é opt-in por causa dos Termos (proibido com conta de assinatura). No modo assinatura, o formulário gera o comando `claude` equivalente para copiar.
- **Features:**
  - iniciar e retomar conversas, monitorar tarefas em execução;
  - busca full-text com `⌘K` (fuzzy, por projeto ou global);
  - renderização visual de tools (diffs, saídas estruturadas) com toggle Raw;
  - Todo viewer (TodoWrite);
  - **aprovações inline** e AskUserQuestion via uma tool MCP própria (`CCVAskUserQuestion`);
  - **Git**: diff com comentários inline, commit, push, troca de branch;
  - preview de navegador embutido; terminal embutido;
  - **agendador de mensagens com cron** (controle de concorrência);
  - auto-continue em rate limit;
  - visualizador de servidores MCP configurados;
  - notificações sonoras e push (PWA);
  - modo `--api-only`; senha; base path para proxy reverso; Tailscale.
- **Diferencial:** é o mais completo como **cliente**: vai além de observar e opera a sessão (mensagem, aprovação, git, cron). Também é o único que documenta de frente o limite dos Termos de uso e degrada com elegância para "copiar comando".
- **O que aproveitar:**
  - `--api-only` como prova de que a mesma API serve UI e integrações (no nosso caso, MCP);
  - agendador com cron;
  - auto-continue em rate limit;
  - visão de MCPs configurados;
  - modo "copiar comando" quando a ação não é permitida;
  - aprovação inline via tool MCP.
- **Fraquezas:** depende do Agent SDK para controle (fricção de Termos com assinatura); sem visão de frota nem KPIs de multiagente; sem Windows; o terminal embutido aumenta a superfície de risco.

## 8. claude-devtools (matt1398/claude-devtools)

**O que é:** "DevTools do Claude Code". Reconstrói, a partir dos JSONL, tudo o que o terminal esconde (tool calls, thinking, contexto, subagentes).

- **Licença:** MIT.
- **Stars/atividade:** ~4k stars (o mais popular do grupo depois do ccusage); ativo (push em set/2026); app Electron para macOS, Linux e Windows, Homebrew, Docker.
- **Como coleta:** só lê transcripts JSONL em `~/.claude/` (local ou **remoto via SSH**, com base em `~/.ssh/config`). Zero configuração; o servidor standalone faz zero chamadas de rede de saída e roda com `--network none` e volume read-only.
- **Features:**
  - **reconstrução de contexto por turno** em 7 categorias (CLAUDE.md global/projeto/diretório, skills, arquivos @-mencionados, I/O de tools, thinking, overhead de time, texto do usuário);
  - **visualização de compactação** (enche, comprime, reenche; "por que o Claude esqueceu");
  - inspetor de tool calls com viewers especializados (Read com syntax highlight, diffs de Edit, saída de Bash);
  - árvores de subagentes e times, recursivas, com tokens, duração e custo;
  - thinking visível;
  - memória do projeto (`MEMORY.md` e camadas) renderizada;
  - copiar e colar limpo, exportação da sessão;
  - **gatilhos de notificação** (acesso a `.env`, erros de tool, uso alto de tokens, regex customizada em qualquer campo);
  - `Cmd+K` entre sessões; múltiplos painéis lado a lado.
- **Diferencial:** profundidade de debugging. É o único que explica **o que ocupa a janela de contexto** e o que se perdeu na compactação, e funciona retroativamente em qualquer sessão já rodada.
- **O que aproveitar:**
  - atribuição de contexto por categoria (resposta direta para "por que essa sessão está pesada?");
  - linha do tempo de compactação;
  - gatilhos de notificação por regex como regras configuráveis;
  - leitura remota por SSH (casa com o caso de máquinas remotas);
  - postura de rede zero e volume read-only.
- **Fraquezas:** não é tempo real de frota (é por sessão, com foco retrospectivo); não controla nada; app Electron separado; depende do formato do JSONL, que não é contrato público.

> Menção honrosa, não detalhada: **ccusage** (~19k stars), CLI de relatório de uso e custo a partir dos JSONL. É a referência de fato de "custo a partir do transcript" e vale como biblioteca ou fonte de verdade de preços, mas não é um dashboard de sessões.

---

## (a) Matriz de features

Legenda: ✓ = tem (segundo a documentação) · ~ = parcial ou opcional · – = não tem.
Colunas: **AO** agents-observe · **DIS** disler · **CAST** · **OA** ObservAgent · **POD** Podium · **SNF** Sniffly · **CCV** Claude Code Viewer · **DEV** claude-devtools.

| Feature | AO | DIS | CAST | OA | POD | SNF | CCV | DEV |
|---|---|---|---|---|---|---|---|---|
| Coleta por hooks | ✓ | ✓ | ~ (via CAST) | ✓ | ~ (fallback) | – | – | – |
| Coleta por mod/plugin dentro da sessão | ✓ | – | – | – | ✓ | – | – | – |
| Coleta por transcript JSONL | ~ | – | ✓ | ✓ | – | ✓ | ✓ | ✓ |
| OpenTelemetry | – | – | – | – | – | – | – | – |
| Sem servidor extra (zero setup) | – | – | – | – | – | ~ | ~ | ✓ |
| Distribuído como plugin do Claude Code | ✓ | – | – | – | ✓ | – | – | – |
| Usa MCP de alguma forma | ~ (só ciclo de vida) | ~ (detecta tools MCP) | – | – | – | – | ✓ (tool de pergunta + viewer) | – |
| Tempo real (WS/SSE) | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ | ~ |
| Visão de frota multissessão ao vivo | ✓ | ✓ | ✓ | ✓ | ✓ | – | ~ | – |
| Árvore de subagentes aninhada | ✓ | ~ | ✓ | ~ | ✓ | – | ~ | ✓ |
| Timeline de eventos e tool calls | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| Payload completo da tool call | ✓ | ✓ | ✓ | ~ | ~ (trechos, opt-in) | – | ✓ | ✓ |
| Estado "esperando você" (permissão ou pergunta) | ~ (sino) | ~ | – | – | ✓ | – | ✓ | – |
| Detecção de sessão parada (stale) | – | – | – | – | ✓ | – | – | – |
| Custo e tokens por sessão | ✓ | – | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| Custo por agente | – | – | ✓ | – | ✓ | – | – | ✓ |
| Tabela de preços editável, custo rotulado como estimativa | – | – | ~ | – | ✓ | – | – | – |
| Ocupação da janela de contexto | – | – | – | – | ✓ | – | – | ✓ |
| Blowouts e compactação visualizados | – | ~ (evento) | – | – | ✓ | – | – | ✓ |
| Atribuição do contexto por categoria | – | – | – | – | – | – | – | ✓ |
| Latência por ferramenta | ~ | – | – | ✓ | – | – | – | ✓ |
| Erros e falhas explicados | – | ~ | ✓ | ✓ | ✓ (+IA) | ✓ | – | ✓ |
| Plano e todos da sessão | – | – | ✓ | – | ✓ | – | ✓ | – |
| Git (branch, worktree, ahead/behind) | – | – | ~ | – | ✓ | – | ✓ (+commit) | – |
| Comando de resume copiável | – | – | – | – | ✓ | – | ✓ | – |
| Busca global (`Cmd+K` ou full-text) | ✓ | – | ✓ | – | ~ (filtro) | – | ✓ | ✓ |
| Histórico persistente | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Exportação (JSONL/CSV) ou compartilhamento | – | – | – | ✓ | – | ✓ | – | ✓ |
| Analytics de longo prazo e KPIs | ~ | – | ✓ | ~ | ~ | ✓ | – | – |
| Notificações e alertas por regra | ~ | ~ (TTS) | – | ~ (limiares) | – | – | ✓ | ✓ |
| Responder ou aprovar a sessão remotamente | – | – | – | – | ✓ | – | ✓ | – |
| Enviar mensagem, `/clear`, `/compact` | – | – | – | – | ✓ | – | ✓ | – |
| Iniciar, despachar ou agendar sessões | – | – | ✓ (gated) | – | – | – | ✓ (cron) | – |
| Bloqueio e validação via hooks | – | ✓ | – | – | – | – | – | – |
| Read-only por padrão, controle fail-closed | – | – | ✓ | – | ✓ (dupla flag) | – | ~ | ✓ |
| Redação de segredos e minimização de dados | – | – | – | – | ✓ | – | – | – |
| Multiusuário e times | – | ~ (source-app) | – | – | ✓ | – | – | – |
| Sessões remotas por SSH | – | – | – | – | ~ (bind de rede) | – | ~ (Tailscale) | ✓ |
| Saúde da coleta (doctor, hook failures, versão) | ✓ | ~ | ✓ | ✓ | ✓ | – | ✓ | – |
| Memória e config do projeto (CLAUDE.md, MEMORY, MCPs) | – | – | ✓ | – | – | – | ~ (MCPs) | ✓ |
| Simulador ou dados de demonstração | – | ~ (test-event) | ~ (seed) | – | ✓ | – | – | – |
| Funciona dentro do Claude Desktop (sem navegador próprio) | – | – | – | – | – | – | – | – |

**Leitura da matriz:** nenhuma ferramenta roda dentro do Claude Desktop, nenhuma expõe a observabilidade como **tools MCP consultáveis pelo próprio Claude** e nenhuma usa OpenTelemetry. Todas precisam de um servidor web próprio e de um navegador. Esse é o espaço vazio que o Ahrena Console ocupa.

---

## (b) Top 10 ideias para roubar, por valor

1. **Estados derivados de "quem precisa de mim" (Podium).** Waiting (aprovação ou input), delegating, stale com expiração, "esperando processo em background". É a pergunta número 1 de quem roda várias sessões. No Console, vira a tool MCP `sessions_needing_attention` e o topo do painel.
2. **Responder sem terminal, com dupla autorização e "primeiro a responder vence" (Podium; CCV com aprovação inline).** Responder AskUserQuestion, aprovar plano, permitir uma tool uma vez, mandar mensagem, `/compact`, sempre pelo canal da própria sessão e nunca digitando num TTY. Desligado por padrão, com consentimento do dono. Encaixa direto no Desktop.
3. **Coleta híbrida: hooks ou plugin para tempo real, JSONL para a verdade (ObservAgent, agents-observe).** Hooks dão latência e estado ao vivo; o transcript dá tokens, custo e histórico retroativo. Somar o "servidor pede, hook completa sob demanda" do agents-observe evita mandar payload pesado o tempo todo.
4. **Contexto como sinal de primeira classe (Podium + claude-devtools).** Ocupação por sessão e por agente, contagem de blowouts com alerta a partir de 2, linha do tempo de compactação e **atribuição por categoria** (CLAUDE.md, skills, tool I/O, thinking). Responde "por que travou ou esqueceu".
5. **Read-only por padrão, controle fail-closed e minimização de dados (CAST + Podium).** As tools MCP de leitura ficam sempre disponíveis; as de controle ficam atrás de flag, token e confirmação. Redação de segredos, trechos com limite de tamanho, feed de atividade só enquanto alguém observa e mantido só em memória. O documento "o que sai da sessão" vira parte do produto.
6. **Plano e árvore de agentes ligados (Podium, CCV, devtools).** Extrair o plano de TaskCreate/TaskUpdate/TodoWrite, mostrar o dono de cada passo e aninhar subagentes e forks em qualquer profundidade, com custo, contexto e última ferramenta por nó.
7. **Falha explorável com explicação opcional por modelo pequeno (Podium + Sniffly).** Chamada, saída, evidência de causa, resumo de 2 frases (Haiku, opt-in) e, no agregado, a taxonomia de erros do Sniffly como relatório semanal.
8. **Custo honesto (Podium + CAST).** Sempre rotulado como estimativa, tabela de preços editável, cobertura do dado exposta (`runs_missing_cost`), por sessão, por agente e por repositório, com orçamento e limiares (ObservAgent).
9. **Instalação e auto-diagnóstico em um passo (agents-observe, ObservAgent, Podium).** Plugin do marketplace, `init` que registra os hooks sozinho, `doctor`, página de saúde da coleta (hooks falhando, versão do reporter versus servidor) e status line `● N live / ○ offline`. Para nós: uma tool MCP `console_doctor`.
10. **Ações de conveniência que fecham o ciclo (Podium, CCV, devtools).** Comando de resume copiável, abrir a sessão atual no painel (`/observe view`), regras de notificação por regex (acesso a `.env`, erro, tokens altos), agendamento por cron, auto-continue em rate limit e leitura de sessões remotas por SSH (o caso de máquinas remotas).

**Anti-padrões a evitar:**
- exigir Docker (agents-observe);
- copiar uma pasta `.claude/` para cada projeto (disler);
- 18 páginas (CAST);
- terminal embutido (CCV);
- depender do Agent SDK para controle com conta de assinatura (CCV, por causa dos Termos);
- leitura sem autenticação em bind de rede (Podium).
