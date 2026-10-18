# Benchmark 03: orquestradores de agentes em paralelo

> Frente: ferramentas que pegam uma tarefa, dão a ela um agente e um worktree e levam até o PR (tarefas, worktrees, kanban).
> Objetivo: embasar o **Ahrena Console**, um console de observabilidade e controle de sessões e agentes do Claude Code que é MCP-first e roda **dentro do Claude Desktop** (servidor MCP local + artefato/painel). Sem TUI.
> Coleta: 18/10/2026. Fontes: README via `gh api`, metadados do GitHub (stars, licença, último push), docs oficiais via WebFetch. Nada foi instalado nem executado.

## Panorama em uma tabela

| Ferramenta | Interface | Licença | Stars | Último push | Situação |
|---|---|---|---|---|---|
| Vibe Kanban | Web local (`npx`) + MCP | Apache-2.0 | 28,4k | set/2026 | Empresa (Bloop) fechou em abr/2026; segue como projeto da comunidade, só local |
| Conductor | Desktop nativo macOS | Proprietária (free + Pro US$50/mês) | n/d (fechado) | v0.91 | Ativo; tem Conductor Cloud |
| Claude Squad | TUI (tmux) | AGPL-3.0 | 8,6k | ago/2026 | Ativo |
| Crystal → Nimbalyst | Desktop Electron + app iOS | MIT | 3,1k → 1,9k | fev/2026 → out/2026 | Crystal descontinuado; Nimbalyst ativo |
| parallel-code | Desktop Electron + web no celular | MIT | 1,1k | out/2026 | Muito ativo |
| opcode (ex-claudia) | Desktop Tauri | AGPL-3.0 | 22,4k | set/2026 | Ativo, mas sem binários publicados |
| Sculptor (Imbue) | Desktop | MIT | 240 | out/2026 | Research preview |
| dmux | TUI (tmux) | MIT | 1,8k | ago/2026 | Ativo |
| ccmanager | TUI (sem tmux) | MIT | 1,3k | out/2026 | Muito ativo |
| Terragon | Web (nuvem) + CLI + MCP | Apache-2.0 (snapshot) | 261 | fev/2026 | Encerrado em jan/2026 |
| Claude Code desktop | Desktop nativo (app Claude) | Proprietária (Anthropic) | — | — | Referência da plataforma onde o Console vai rodar |

---

## Fichas

### 1. Vibe Kanban (BloopAI/vibe-kanban)

- **O que é:** um kanban de issues em que cada card vira um "workspace" (branch, terminal e dev server) com um agente rodando dentro.
- **Licença:** Apache-2.0.
- **Stars e atividade:** 28,4k stars, último push em set/2026. A Bloop anunciou o encerramento em 10/04/2026. O código continua aberto, mantido pela comunidade e só local; os recursos de nuvem e time ficaram no código, para quem quiser hospedar por conta própria.
- **Interface:** app web local, iniciado com `npx vibe-kanban` (backend em Rust, frontend em React). Tem também uma extensão de VS Code.
- **Agentes:** mais de 10: Claude Code, Codex, Gemini CLI, Copilot, Amp, Cursor, OpenCode, Droid, CCR e Qwen.
- **Features:**
  - fluxo completo de issue → workspace (worktree + branch) → agente → diff → PR com descrição gerada por IA → merge;
  - kanban e lista com filtros, prioridade, responsáveis e relações entre issues (bloqueia, relacionada, duplicada);
  - revisão de diff com comentários inline que voltam para o agente;
  - navegador embutido com devtools, modo inspecionar e emulação de dispositivo;
  - scripts de setup, cleanup e dev server por repositório;
  - "Tags", trechos de prompt reutilizáveis chamados com @;
  - perfis de agente (modelo, modo de planejamento e permissões);
  - multi-repo e várias sessões por workspace;
  - notificações configuráveis;
  - **servidor MCP próprio** (`vibe-kanban --mcp`) com ferramentas de issues, tags, relações, repositórios, workspaces e sessões: `start_workspace`, `create_session`, `run_session_prompt`, `get_execution`, `get_context`.
- **Diferencial:** é o único do grupo em que o **MCP é um canal de controle completo**. Um cliente MCP (Claude Desktop, por exemplo) planeja, cria issues e dispara workspaces e prompts. Os próprios agentes também usam o MCP para alimentar o board.
- **O que vale aproveitar no Console:**
  - o desenho das ferramentas MCP, que é a referência mais próxima do que o Console precisa (issue/tarefa → workspace → sessão → execução);
  - `get_context`, para o agente saber em qual tarefa está;
  - relações entre tarefas;
  - perfis de agente;
  - scripts de setup e cleanup.
- **Fraquezas:**
  - o projeto ficou sem dono comercial: risco de manutenção e sinal de que monetizar esse tipo de ferramenta é difícil;
  - a UI é uma web app separada, fora do Claude Desktop;
  - precisa de terminal para subir (`npx`);
  - a base de usuários era quase toda gratuita.

### 2. Conductor (conductor.build)

- **O que é:** app nativo de Mac para rodar vários Claude Code, Codex, Cursor e OpenCode em paralelo, cada um num workspace isolado.
- **Licença:** proprietária e de código fechado. Planos: Free US$0, Pro US$50/mês, Teams US$60 por usuário/mês, Enterprise sob consulta.
- **Stars e atividade:** código fechado; versão 0.91 com changelog frequente. Tem SOC 2 Type II.
- **Interface:** desktop nativo (macOS), com app mobile no plano Pro.
- **Agentes:** Claude Code, Codex, Cursor e OpenCode. O usuário traz a própria assinatura ou chave de API.
- **Features:**
  - workspace = branch + worktree + ambiente de execução + pasta `.context` compartilhada;
  - workspace criado a partir de uma branch, de um PR, de uma issue do GitHub ou de uma **issue do Linear**;
  - script de setup, scripts de execução com botão Run e `CONDUCTOR_PORT`, que dá a cada workspace sua faixa de portas;
  - "Files to copy" para `.env` e configuração em camadas (`.conductor/settings.toml` do projeto, `.local` pessoal e nível de usuário);
  - Diff Viewer;
  - aba **Checks** que junta status do git, CI, deploys, comentários e todos;
  - PR, merge e arquivamento do workspace;
  - modos de agente e terminal integrado;
  - Slack via MCP;
  - Conductor API;
  - Conductor Cloud (sandboxes na Vercel, o agente segue rodando com o app fechado) e multiplayer.
- **Diferencial:** o polimento do fluxo inteiro e a aba Checks como painel único do que falta para dar merge. A porta por workspace resolve o conflito de dev servers rodando ao mesmo tempo.
- **O que vale aproveitar no Console:**
  - a aba "Checks" (git, CI, review e todos num lugar só);
  - porta por workspace;
  - criar uma tarefa a partir de uma issue do Linear ou do GitHub;
  - configuração em camadas versionada no repositório;
  - a pasta `.context` para passar contexto que não vai para o commit.
- **Fraquezas:** fechado e pago, só Mac, mais um app separado fora do Claude Desktop, mensagens da nuvem armazenadas no servidor deles.

### 3. Claude Squad (smtg-ai/claude-squad)

- **O que é:** app de terminal que gerencia várias instâncias de Claude Code, Codex, Gemini e Aider, cada uma num worktree, usando o tmux.
- **Licença:** AGPL-3.0.
- **Stars e atividade:** 8,6k stars, último push em ago/2026.
- **Interface:** TUI que depende de tmux e gh.
- **Agentes:** qualquer CLI, via "profiles" (`program`).
- **Features:**
  - nova sessão, com ou sem prompt inicial;
  - abas de preview e de diff;
  - commit e push (`s`);
  - checkout que pausa a sessão (`c`) e retomada (`r`);
  - modo yolo/autoyes em segundo plano;
  - perfis de agente.
- **Diferencial:** o primeiro e mais simples da categoria, com o conceito de **pausar e retomar** uma sessão liberando o worktree.
- **O que vale aproveitar no Console:** o ciclo de vida pausar → retomar e o conceito de perfil (nome + comando).
- **Fraquezas:**
  - 100% terminal: tmux obrigatório, atalhos de teclado e nenhuma GUI;
  - não mostra o estado de cada sessão (ocupada ou aguardando);
  - o autoyes passa por cima das confirmações de segurança;
  - a licença AGPL limita reaproveitar o código.

### 4. Crystal → Nimbalyst (stravu/crystal → Nimbalyst/nimbalyst)

- **O que é:** o Crystal rodava várias sessões de Claude Code e Codex em worktrees, num app desktop. Foi descontinuado em fev/2026 e substituído pelo Nimbalyst, um "workspace visual" que junta sessões, worktrees, tarefas, documentos, diagramas e código.
- **Licença:** MIT nos dois. O servidor de sync do Nimbalyst é um projeto à parte.
- **Stars e atividade:** Crystal com 3,1k (parado); Nimbalyst com 1,9k e push em 17/10/2026.
- **Interface:** desktop Electron (Mac, Windows e Linux) e app iOS nativo.
- **Agentes:** Claude Code e Codex; OpenCode e Copilot em alpha; provider Gemini.
- **Features:**
  - **kanban de sessões** (buscar, retomar, ligar sessão aos arquivos que ela tocou);
  - rastreador de tarefas que o agente lê e atualiza;
  - diff vermelho/verde aceito ou rejeitado trecho a trecho **no documento renderizado**;
  - editores WYSIWYG (markdown, Mermaid, Excalidraw, CSV, mockups, modelos de dados, Monaco);
  - git embutido com commit gerado por IA e terminal Ghostty;
  - **cliente MCP que renderiza o resultado das ferramentas como widget visual** em vez de JSON;
  - SDK de extensões;
  - tudo guardado em arquivos simples no repositório;
  - app iOS com painel "quem precisa de mim", resposta por voz, diffs por swipe, fila de próximas tarefas e push quando o agente espera.
- **Diferencial:** trata a sessão como objeto de primeira classe, ligada a arquivos e tarefas, e tem a melhor experiência mobile de "agente esperando por você".
- **O que vale aproveitar no Console:**
  - o kanban **de sessões**, não só de tarefas;
  - o vínculo entre sessões e arquivos;
  - resultado de MCP renderizado como widget, que é exatamente o modelo de artefato;
  - fila de próximas tarefas para o agente não ficar parado;
  - a visão "quem precisa de mim".
- **Fraquezas:** é uma IDE paralela pesada, que compete com o editor e com o próprio Claude Desktop; escopo muito largo; telemetria ligada por padrão (dá para desligar).

### 5. parallel-code (johannesjo/parallel-code)

- **O que é:** app desktop para disparar Claude Code, Codex, Gemini e Copilot lado a lado, cada um num worktree, com revisão, merge e descarte.
- **Licença:** MIT.
- **Stars e atividade:** 1,1k stars, push em 16/10/2026 (ritmo alto de features).
- **Interface:** desktop Electron (macOS e Linux), UI web no celular via QR code e app Android.
- **Agentes:** Claude Code, Codex, Gemini, Copilot e Antigravity.
- **Features:**
  - a tarefa cria branch e worktree, faz symlink de `node_modules` e outras pastas ignoradas pelo git, e sobe o agente;
  - painéis lado a lado e modo foco;
  - diff com comentários inline e navegação por commit;
  - **AI Arena**, que põe agentes para competir na mesma tarefa;
  - **"tour guiado das mudanças"**, cards gerados por IA que explicam o diff;
  - **task brief** reescrito a cada turno (o que o diff não mostra, o que está em aberto, decisões que o agente tomou sozinho);
  - **nota de confiança** que o agente publica via ferramenta MCP `confidence_publish`;
  - kanban em `KANBAN.md` compatível com Obsidian, em que o card acompanha a tarefa por Em andamento, Review e Done e mostra "precisa de input";
  - notas e canvas por tarefa;
  - preview de navegador com seleção de elemento;
  - **notificação quando o CI do PR termina**;
  - push no celular quando a tarefa entra em "Needs input";
  - sandbox Docker por projeto;
  - badges de cobertura de testes;
  - importação de worktrees existentes.
- **Diferencial:** foca em **entender e confiar no que o agente fez** (brief, tour, confiança), não só em rodar agentes.
- **O que vale aproveitar no Console:**
  - task brief automático por sessão;
  - nota de confiança publicada pelo agente via MCP;
  - tour de mudanças;
  - kanban guardado como Markdown no repositório;
  - notificação de CI e de "needs input";
  - AI Arena para comparar dois agentes na mesma tarefa.
- **Fraquezas:** mais um app Electron separado; o celular depende de Wi-Fi ou Tailscale e de HTTPS para push; muitas features e pouca coesão; sem Windows.

### 6. opcode, ex-claudia (winfunc/opcode)

- **O que é:** GUI desktop "centro de comando" do Claude Code: navegador de projetos e sessões de `~/.claude/projects`, agentes customizados, custos, MCP e checkpoints.
- **Licença:** AGPL-3.0.
- **Stars e atividade:** 22,4k stars, push em set/2026. O README ainda diz que os binários "serão publicados em breve", então é preciso compilar (Rust + Bun).
- **Interface:** desktop Tauri 2.
- **Agentes:** só Claude Code.
- **Features:**
  - navegador visual de projetos e sessões (primeira mensagem, timestamps, retomar);
  - "CC Agents" (prompt de sistema, modelo e permissões de arquivo e rede) executados em segundo plano, com histórico de execuções;
  - **dashboard de uso e custo** por modelo, projeto e período, com exportação;
  - gerenciador de servidores MCP com teste de conexão e **importação da configuração do Claude Desktop**;
  - **timeline de checkpoints** com fork e diff entre checkpoints;
  - editor de CLAUDE.md com scanner de projetos.
- **Diferencial:** o único focado em **observabilidade de sessões e custo** lendo os arquivos locais do Claude Code. É o mais parecido com a parte de "console" do Ahrena Console.
- **O que vale aproveitar no Console:**
  - indexar `~/.claude/projects` (JSONL) para listar e pesquisar sessões;
  - dashboard de custo e tokens por projeto e modelo;
  - timeline de checkpoints com fork;
  - inventário e saúde dos servidores MCP;
  - auditoria de CLAUDE.md.
- **Fraquezas:** só Claude Code; não faz worktree nem PR; AGPL; sem binário oficial; é uma GUI paralela que duplica o que o Claude Desktop já faz.

### 7. Sculptor (imbue-ai/sculptor)

- **O que é:** app desktop da Imbue para rodar agentes em paralelo em workspaces isolados, com skills de fluxo de trabalho prontas.
- **Licença:** MIT.
- **Stars e atividade:** 240 stars, push em out/2026; declarado como "research preview".
- **Interface:** desktop (Mac e Linux).
- **Agentes:** Claude Code e Pi integrados, mais qualquer agente de terminal.
- **Features:**
  - workspaces em worktree;
  - vários agentes no mesmo workspace;
  - revisão de mudanças e commit;
  - PR com acompanhamento de status;
  - **skills embutidas** (`spec`, `mocks`, `/sculptor-workflow:fix-bug`, que entrevista para reproduzir o bug, escreve testes que falham e depois os faz passar);
  - paleta de comandos Cmd+K;
  - backend de containers (Docker ou remoto) experimental.
- **Diferencial:** vem com **skills de método**, não só com infraestrutura de paralelismo.
- **O que vale aproveitar no Console:** um catálogo de "receitas" de fluxo (fix-bug, spec) que o Console dispara numa sessão nova, o que conversa com um framework de skills.
- **Fraquezas:** imaturo, comunidade pequena, app separado.

### 8. dmux (standardagents/dmux)

- **O que é:** multiplexador de agentes sobre tmux + worktrees, com um painel por tarefa.
- **Licença:** MIT.
- **Stars e atividade:** 1,8k stars, push em ago/2026.
- **Interface:** TUI (tmux 3+).
- **Agentes:** 11 ou mais CLIs (Claude Code, Codex, OpenCode, Cline, Gemini, Qwen, Amp, pi, Cursor, Copilot, Crush).
- **Features:**
  - **lançar vários agentes de uma vez** com o mesmo prompt;
  - "goal mode";
  - nome de branch, commit e painel gerado por IA;
  - terminais duráveis que retomam a conversa do agente;
  - merge inteligente (commit, merge e limpeza);
  - criar PR no GitHub;
  - **notificações nativas do macOS** quando um painel precisa de atenção;
  - navegador de arquivos e diffs;
  - multi-projeto;
  - **hooks de ciclo de vida** (worktree criado, antes e depois do merge).
- **Diferencial:** hooks de ciclo de vida e lançamento multi-agente.
- **O que vale aproveitar no Console:** hooks por evento do ciclo de vida da tarefa, nomes gerados por IA e "fan-out" de um prompt para N agentes.
- **Fraquezas:** terminal e tmux, atalhos de teclado, nenhuma GUI.

### 9. ccmanager (kbwo/ccmanager)

- **O que é:** gerenciador de sessões de agentes de código em worktrees e projetos, sem tmux.
- **Licença:** MIT.
- **Stars e atividade:** 1,3k stars, push em 17/10/2026.
- **Interface:** TUI (Ink/Node).
- **Agentes:** Claude Code, Gemini, Codex, Cursor Agent, Copilot, Cline, OpenCode, Kimi, MCode e Grok.
- **Features:**
  - **indicador de estado por sessão (ocupada, aguardando, ociosa)** com estratégia de detecção própria para cada CLI;
  - criar, fazer merge e apagar worktrees;
  - **restaurar sessões depois de reiniciar ou de um crash**;
  - copiar os dados de sessão do Claude Code entre worktrees;
  - suporte a `.worktreeinclude`;
  - presets de comando com fallback;
  - **hooks de mudança de estado** para notificação e automação;
  - devcontainer;
  - **aprovação automática verificada por IA** (experimental);
  - plugin/skill que configura o próprio ccmanager.
- **Diferencial:** a **máquina de estados da sessão** (busy, waiting, idle) é o núcleo da UX.
- **O que vale aproveitar no Console:**
  - o modelo de estados como primitivo do produto;
  - hooks de mudança de estado;
  - restaurar sessões após crash;
  - aprovação automática com verificação por IA (com cuidado);
  - distribuir a própria configuração como skill.
- **Fraquezas:** terminal puro; a detecção de estado é por heurística sobre a saída do terminal, frágil.

### 10. Terragon (terragon-labs/terragon-oss)

- **O que é:** orquestrador de agentes em background na nuvem (sandbox por tarefa). Encerrado em jan/2026; o código ficou como snapshot.
- **Licença:** Apache-2.0.
- **Stars e atividade:** 261 stars; parado desde fev/2026.
- **Interface:** dashboard web, CLI `terry` e servidor MCP.
- **Agentes:** Claude Code, Codex, Amp e Gemini.
- **Features:**
  - sandbox por tarefa;
  - branch única, checkpoints com push, commits e PRs gerados por IA;
  - **assumir a tarefa localmente** (`terry`);
  - **servidor MCP para criar e gerenciar tarefas a partir de clientes MCP**;
  - uso da própria assinatura ou chave;
  - **automações** recorrentes ou disparadas por evento (nova issue, novo PR);
  - acionamento por @-menção no Slack ou no GitHub;
  - streaming em tempo real e notificações no navegador.
- **Diferencial:** automações por evento e passagem do trabalho da nuvem para a máquina local.
- **O que vale aproveitar no Console:** automações (cron e evento), passagem da nuvem para o local e vice-versa, e acionar tarefas por @-menção.
- **Fraquezas:** morreu, o que mostra o custo de operar sandboxes; infraestrutura pesada (Postgres, Redis, Stripe, túnel).

### 11. Claude Code desktop (Anthropic), a plataforma-alvo

- **O que é:** a aba Code do app Claude, com sessões paralelas locais, por SSH, WSL ou nuvem.
- **Licença:** proprietária, incluída nos planos do Claude.
- **Interface:** desktop nativo (é exatamente onde o Ahrena Console vai viver).
- **Agentes:** Claude Code.
- **Features (doc pública em code.claude.com/docs/en/desktop):**
  - várias sessões em paralelo (Cmd+N, Ctrl+Tab, **split com Cmd+clique**);
  - checkbox de **worktree** por sessão (`.claude/worktrees/`, `.worktreeinclude`);
  - diff com comentários por linha enviados em lote;
  - `/code-review`;
  - **barra de status de CI do PR** via `gh`, com **auto-fix de CI e de comentários**, **auto-merge** e **auto-archive** quando o PR é mergeado;
  - sessões na nuvem (continuam com o app fechado, multi-repo, acompanháveis em claude.ai/code e no mobile);
  - SSH e WSL;
  - sidebar com filtro por status, projeto e ambiente e agrupamento;
  - notificação do sistema quando a sessão termina;
  - painel de navegador com `.claude/launch.json` e verificação automática;
  - **trabalho entre sessões** (Claude lista, lê, envia mensagem, renomeia e arquiva outras sessões);
  - anel de uso de contexto e de plano;
  - connectors e MCP;
  - modos de permissão (Manual, Accept edits, Plan, Auto, Bypass);
  - Dispatch, que cria sessões a partir do celular.
- **Observação relevante (vista nesta própria sessão):** o host expõe ao Claude ferramentas MCP internas de gestão. Exemplos:
  - `ccd_session_mgmt__list_sessions`, `send_message`, `get_usage`, `search_session_transcripts`, `set_session_model`;
  - `ccd_sidebar__create_group` e `move_sessions`;
  - `ccd_pr__get_status` e `set_auto_merge`;
  - `ccd_session__start_session` e `move_to_cloud`.
  Ou seja: parte do "controle" que o Ahrena Console quer **já existe como primitivo dentro do Claude Desktop**. O Console pode compor sobre isso em vez de reimplementar.
- **Diferencial:** nativo, sem instalação extra, com PR, CI, auto-merge e nuvem integrados.
- **O que falta (a oportunidade para o Console):**
  - visão agregada de todas as sessões num painel (board, tabela, custo por sessão e projeto);
  - kanban de tarefas ligado às sessões;
  - histórico e busca analítica;
  - visão de várias máquinas (local + máquina remota por SSH + nuvem) num lugar só;
  - automações e regras;
  - "quem precisa de mim" consolidado;
  - não enxerga sessões de CLI nem da nuvem pelas ferramentas entre sessões.
- **Fraquezas:** só Claude; as ferramentas entre sessões não veem CLI nem nuvem; não tem kanban nem métricas agregadas.

### Similares só citados

- **Superset:** concorrente direto do Conductor (a própria conductor.build tem uma página de comparação).
- **Cursor background agents** e **Codex cloud:** orquestração em nuvem presa ao fornecedor.

Ficaram fora das fichas por sobreposição ou por estarem fora do ecossistema Claude Code.

---

## (a) Matriz de features

Legenda: ✓ tem · ◐ parcial ou experimental · – não tem ou não documentado.
VK = Vibe Kanban · Cond = Conductor · CSq = Claude Squad · Nimb = Nimbalyst (sucessor do Crystal) · PC = parallel-code · opc = opcode · Scul = Sculptor · dmux · ccm = ccmanager · Terr = Terragon · CCD = Claude Code desktop

| Feature | VK | Cond | CSq | Nimb | PC | opc | Scul | dmux | ccm | Terr | CCD |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Interface gráfica (não TUI) | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓ | – | – | ✓ | ✓ |
| Dispensa terminal para usar | ◐ | ✓ | – | ✓ | ✓ | ◐ | ✓ | – | – | ✓ | ✓ |
| Worktree automático por tarefa | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓¹ | ✓ |
| Tarefa → agente → PR de ponta a ponta | ✓ | ✓ | ◐ | ◐ | ✓ | – | ✓ | ✓ | – | ✓ | ✓ |
| Kanban de tarefas | ✓ | – | – | ✓ | ✓ | – | – | – | – | – | – |
| Kanban/board de sessões | ◐ | ◐ | – | ✓ | ✓ | – | – | – | – | ✓ | ◐ |
| Estado da sessão (ocupada, aguardando, ociosa) | ✓ | ✓ | – | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓ | ✓ |
| Revisão de diff com comentário inline para o agente | ✓ | ✓ | ◐ | ✓ | ✓ | ◐ | ✓ | ◐ | – | – | ✓ |
| Merge pelo app | ✓ | ✓ | ◐ | ✓ | ✓ | – | ✓ | ✓ | ✓ | – | ✓ |
| Status de CI/PR e auto-fix/auto-merge | ◐ | ✓ | – | – | ◐ | – | ◐ | – | – | ◐ | ✓ |
| Notificações (desktop ou push) | ✓ | ◐ | – | ✓ | ✓ | – | – | ✓ | ◐ | ✓ | ✓ |
| Celular | – | ✓ | – | ✓ | ✓ | – | – | – | – | ✓ | ✓ |
| Custo e tokens | – | – | – | – | – | ✓ | – | – | – | – | ◐ |
| Checkpoints e timeline | – | – | ◐ | – | – | ✓ | – | – | – | ✓ | – |
| Templates, perfis e receitas de prompt | ✓ | ◐ | ✓ | ◐ | ◐ | ✓ | ✓ | – | ✓ | – | – |
| Scripts de setup/run e porta por workspace | ✓ | ✓ | – | – | ◐ | – | ✓ | ✓ | ◐ | – | ✓ |
| Hooks e automações por evento | – | – | – | – | – | – | – | ✓ | ✓ | ✓ | ◐ |
| Origem em issue (GitHub/Linear) | ◐ | ✓ | – | – | ◐ | – | – | – | – | ✓ | – |
| Vários agentes (não só Claude) | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓ | – |
| Comparar agentes na mesma tarefa | ◐ | ◐ | – | – | ✓ | – | ◐ | ✓ | – | – | – |
| Sandbox/container | – | ✓ | – | – | ✓ | ◐ | ◐ | – | ✓ | ✓ | ✓ |
| Execução na nuvem/background | ◐ | ✓ | ◐ | – | – | ◐ | ◐ | – | – | ✓ | ✓ |
| **Expõe servidor MCP para controle** | ✓ | ◐² | – | – | ◐³ | – | – | – | – | ✓ | ✓⁴ |
| Consome MCP (cliente) | ✓ | ✓ | – | ✓ | – | ✓ | – | – | – | – | ✓ |
| Resumo, brief ou confiança gerados por IA | ◐ | – | – | – | ✓ | – | – | ◐ | – | ◐ | ◐ |
| Estado em arquivos simples no repositório | – | ✓ | – | ✓ | ✓ | – | – | – | ✓ | – | ✓ |
| Código aberto | ✓ | – | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| Roda dentro do Claude Desktop | ◐⁵ | – | – | – | – | – | – | – | – | ◐⁵ | ✓ |

Notas:
1. No Terragon o isolamento é por sandbox na nuvem, não por worktree local.
2. O Conductor tem a "Conductor API", não um servidor MCP documentado.
3. O parallel-code expõe ferramenta MCP só para o agente publicar a nota de confiança.
4. Ferramentas internas `ccd_*`, disponíveis apenas para o Claude dentro do app, não como API pública.
5. Vibe Kanban e Terragon podem ser plugados como MCP no Claude Desktop, mas a UI continua fora dele.

**Leitura da matriz:**
- Ninguém junta **GUI dentro do Claude Desktop + MCP de controle + custo + kanban de tarefas e sessões**. Esse é o espaço vazio do Ahrena Console.
- Os itens comuns (worktree, diff, merge) **já estão no Claude Code desktop**, então o Console não deve competir aí.

---

## (b) Top 10 ideias para roubar (ordenadas por valor)

1. **Inbox "quem precisa de mim" baseada numa máquina de estados por sessão** (ocupada, aguardando input, aguardando aprovação, ociosa, CI falhou, pronta para merge), com notificação. Fontes: ccmanager, Nimbalyst, parallel-code, dmux. É a dor número 1 de quem roda mais de três agentes.
2. **API MCP de controle completa, com tarefa → workspace → sessão → execução**, no desenho do MCP do Vibe Kanban (`create_issue`, `start_workspace`, `run_session_prompt`, `get_execution`, `get_context`), para que o próprio Claude orquestre por conversa.
3. **Board unificado de tarefas e sessões**: o card acompanha a sessão por Backlog, Rodando, Precisa de input, Review, Done e mostra o estado ao vivo. Persistência em Markdown ou JSON no repositório (`KANBAN.md` como no parallel-code, arquivos simples como no Nimbalyst). Fontes: Vibe Kanban, Nimbalyst, parallel-code.
4. **Painel "Checks" por tarefa**: git status, CI, comentários de review, todos e pronto-para-merge num lugar só, ligado ao auto-fix e auto-merge que o Claude Desktop já oferece. Fontes: Conductor e CCD.
5. **Custo, tokens e contexto por sessão, projeto, modelo e máquina**, lendo os JSONL de `~/.claude/projects` e o `get_usage`. Fonte: opcode.
6. **Task brief e nota de confiança gerados a cada turno** (o que mudou, o que o diff não mostra, decisões que o agente tomou sozinho, o que está em aberto), publicados pelo agente via ferramenta MCP. Fonte: parallel-code.
7. **Criar tarefa a partir de uma issue do Linear ou do GitHub (e de um PR)**, já com branch, worktree e prompt montados. Fontes: Conductor e Terragon.
8. **Receitas e perfis de agente**: modelo, modo de permissão, skill de método (fix-bug, spec) e prompt-base reutilizáveis, mais "Tags" de trechos de prompt. Fontes: Sculptor, Vibe Kanban, Claude Squad, opcode.
9. **Hooks e automações de ciclo de vida**: ao criar worktree, ao mudar de estado, antes ou depois do merge, cron, nova issue. Também o setup por workspace, com porta própria (`CONDUCTOR_PORT`) e cópia de `.env`. Fontes: dmux, ccmanager, Terragon, Conductor.
10. **Fan-out e comparação (AI Arena)**: o mesmo prompt para N agentes ou modelos, com diffs e brief lado a lado para escolher o vencedor. Fontes: parallel-code, dmux.

Menções honrosas:
- timeline de checkpoints com fork (opcode);
- restaurar sessões depois de crash (ccmanager);
- fila de próximas tarefas para o agente não ficar parado (Nimbalyst);
- tour guiado do diff (parallel-code);
- passagem do trabalho entre nuvem e local (Terragon, CCD `move_to_cloud`).

---

## (c) O que cabe num produto MCP + artefato dentro do Claude Desktop

Premissas do formato:
- **O servidor MCP local** lê o estado (JSONL das sessões, git, `gh`, arquivos de tarefa) e expõe ferramentas.
- **O artefato/painel** renderiza board, inbox e gráficos, e dispara ações pedindo ao Claude ou chamando o MCP.
- **O Claude Desktop já dá** worktree, diff, PR/CI/auto-merge, nuvem, notificação de "sessão terminou" e ferramentas internas `ccd_*` (listar, enviar mensagem, criar sessão, uso, grupos da sidebar).
- O Console deve **compor sobre isso**, não duplicar.

| # | Ideia | Encaixe | Como fica no formato MCP + artefato |
|---|---|---|---|
| 1 | Inbox "quem precisa de mim" | **Alto** | O MCP deriva o estado dos JSONL e eventos de cada sessão (inclusive de máquinas remotas via SSH) e o artefato mostra a inbox. Clicar abre a sessão, via `ccd_window__open_session_in` quando estiver disponível. A notificação nativa já existe; o Console agrega. |
| 2 | API MCP de controle | **Alto (é o núcleo)** | Ferramentas `create_task`, `start_task_session`, `send_to_session`, `get_task_context`, `list_sessions`. Para sessões do Desktop, delega aos primitivos `ccd_*` quando o Claude estiver no app; para sessões headless e de outra máquina, usa o próprio runtime de agentes. |
| 3 | Board tarefas × sessões | **Alto** | Artefato com `db`/estado compartilhado ou arquivo no repositório; o MCP sincroniza o estado das sessões nos cards. Arrastar um card para "Rodando" pede ao Claude para abrir a sessão. |
| 4 | Painel Checks | **Alto** | O MCP agrega `gh pr checks` e comentários; o artefato mostra. Auto-fix e auto-merge ficam com o recurso nativo do Desktop (`ccd_pr__*`), e o Console só exibe e liga. |
| 5 | Custo, tokens e contexto | **Alto** | Puro observabilidade: o MCP lê JSONL e `get_usage`, o artefato desenha os gráficos. Nenhuma ferramenta concorrente faz isso dentro do Desktop. |
| 6 | Brief e confiança por turno | **Médio-alto** | Ferramenta MCP `publish_brief`/`publish_confidence` que o agente chama (por instrução em skill ou hook Stop); o artefato mostra no card. |
| 7 | Tarefa a partir de issue Linear/GitHub | **Alto** | O Claude Desktop já tem os connectors do Linear e do GitHub. O Console só precisa da ferramenta `create_task_from_issue` e de um botão no artefato. |
| 8 | Receitas e perfis | **Alto** | Perfis = modelo + modo de permissão + skill + prompt. Ficam como arquivos versionados; aplicados via `set_session_model`/`set_session_permission_mode`. |
| 9 | Hooks e automações | **Médio** | Os hooks do Claude Code (settings.json) já cobrem eventos de sessão e o MCP de scheduled tasks cobre cron. O Console configura e mostra; não precisa de engine própria. Porta por worktree pode ser um padrão de `.claude/launch.json` (`autoPort`). |
| 10 | Fan-out / Arena | **Médio** | Viável (N sessões com worktree via `start_session` e um artefato comparativo), mas custa caro em tokens e é nicho. Deixar para depois do MVP. |

**Fora do formato (não vale perseguir):**
- editores WYSIWYG e IDE própria (Nimbalyst);
- terminal embutido;
- sandbox e container próprio;
- app mobile próprio (o claude.ai mobile e o Dispatch já cobrem);
- infraestrutura de nuvem própria (o caso Terragon mostra o custo).

**Recomendação de MVP:** ideias 1, 2, 3, 5 e 4, nessa ordem. Inbox de estados + API MCP de controle + board tarefas × sessões + custo, com o painel Checks reaproveitando o PR/CI nativo do Claude Desktop. Tudo sem terminal, numa única superfície dentro do app.

---

## Fontes

- READMEs e metadados via `gh api repos/<owner>/<repo>`: BloopAI/vibe-kanban, smtg-ai/claude-squad, stravu/crystal, Nimbalyst/nimbalyst, johannesjo/parallel-code, winfunc/opcode, imbue-ai/sculptor, standardagents/dmux, kbwo/ccmanager, terragon-labs/terragon-oss.
- [Vibe Kanban: docs](https://vibekanban.com/docs/llms.txt), [MCP Server](https://vibekanban.com/docs/integrations/vibe-kanban-mcp-server), [anúncio de encerramento](https://vibekanban.com/blog/shutdown)
- [Conductor](https://www.conductor.build/), [Conductor docs](https://www.conductor.build/docs/), [llms-full.txt](https://www.conductor.build/llms-full.txt)
- [Claude Code desktop docs](https://code.claude.com/docs/en/desktop)
