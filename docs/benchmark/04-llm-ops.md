# Benchmark 04: plataformas de observabilidade de LLM e agentes

> Frente: LLM-Ops / observabilidade de agentes, para embasar o design do **Ahrena Console**: MCP-first, roda dentro do Claude Desktop e cobre tanto as sessões interativas do Claude Code quanto agentes headless de produção (por exemplo LangGraph/TS, multi-cliente, multi-provider: Anthropic, Bedrock, Cloudflare).
>
> Data da coleta: 18/10/2026. Fontes: `gh api` (licenças lidas no arquivo LICENSE de cada repositório, não só no campo SPDX), READMEs, docs oficiais e o repositório `open-telemetry/semantic-conventions-genai`. Onde não deu para confirmar na fonte, o texto diz **(a confirmar)**.

---

## Resumo em 30 segundos

- **Licenças divergem do que o GitHub mostra.** Langfuse e Phoenix aparecem como `NOASSERTION`. Lendo o LICENSE: o Langfuse é **MIT, com as pastas `ee/` sob licença comercial** (e o copyright agora é da ClickHouse, Inc.). O Phoenix é **Elastic License 2.0**, que proíbe oferecê-lo como serviço gerenciado. A app do AgentOps (`app/`) também é **ELv2**, embora o SDK e a raiz do repositório sejam MIT.
- **De verdade Apache-2.0 e self-host completo**, só Opik, Laminar e Helicone. O Langfuse é quase isso (o núcleo é MIT; RBAC por projeto, audit log e retenção ficam no EE).
- **MCP virou requisito básico.** Langfuse (nativo em `/api/public/mcp`), Opik (nativo em `/api/v1/mcp`), Laminar (`/v1/mcp`, com SQL e agente), Phoenix (`@arizeai/phoenix-mcp`), LangSmith, Helicone, AgentOps, W&B e Braintrust têm servidor MCP. O que diferencia é **o que o MCP faz**. O Laminar expõe SQL somente-leitura e um `ask_agent`. O LangSmith pagina por caracteres, para caber no contexto. A maioria só lista e lê.
- **Claude Code já é um alvo de tracing.** Langfuse (hook `Stop` que lê o transcript) e Opik (plugin, ou o OTel nativo do Claude Code) têm integração. Ninguém junta, numa mesma tela, a sessão interativa do dev e o agente de produção. Essa é a brecha do Ahrena Console.
- **OTel GenAI amadureceu, mas segue com status "Development".** Já cobre `invoke_agent`, `execute_tool`, `invoke_workflow`, `plan`, memória, avaliação (`gen_ai.evaluation.result`), MCP (`mcp.session.id`), skills (`gen_ai.skill.*`) e cache de tokens. Mudou de repositório (`open-telemetry/semantic-conventions-genai`). **Não há `cloudflare` entre os valores de `gen_ai.provider.name`.**

---

## Fichas

### 1. Langfuse

- **O que é:** plataforma open source de tracing, evals e prompt management para apps LLM. É a referência OSS mais adotada (cerca de 36k estrelas).
- **Licença (confirmada no LICENSE):** MIT Expat para tudo fora de `ee/`, `web/src/ee/` e `worker/src/ee/`, que seguem `ee/LICENSE` (comercial). Copyright "2023-2026 ClickHouse, Inc." (a Langfuse foi adquirida pela ClickHouse). O GitHub mostra `NOASSERTION`.
- **Self-host:** sim (Docker Compose, Helm). Stack: Postgres, ClickHouse, Redis e S3. O EE vem "bundled com plano ClickHouse".
- **Modelo de dados:** `Trace` → `Observation` aninhada. Os tipos de observação são span, generation e event, mais os tipos de agente: agent, tool, chain, retriever, evaluator, embedding e guardrail (a confirmar a lista exata da v4). Ainda: `Session` (agrupa traces), `userId`, `Score` (numérico, categórico ou booleano, ligado a trace, observation, session ou dataset run), `Environment`, `Tags`, `Metadata`, `Release/Version`, `Dataset` → `DatasetItem` → `DatasetRun`, e `Prompt` (versões e labels). No armazenamento há uma única tabela de observations, com os atributos de trace desnormalizados em cada linha.
- **Features:** tracing; sessões; playground; prompt management (versionamento, labels, composição, cache); datasets e experimentos; LLM-as-judge (também online, sobre produção); annotation queues; custo por modelo (tabela de preços editável); dashboards e métricas; organizações e projetos; RBAC por organização (OSS) e por projeto (EE); SSO; audit log e retenção (EE); ingestão OTLP (`/api/public/otel`); integração com Claude Code e Codex via hooks.
- **MCP próprio:** sim, nativo, `streamableHttp` em `/api/public/mcp` (cloud ou self-host), com Basic Auth por chave de projeto e tools de leitura e escrita (`listPrompts`, `listObservations`, `getObservationFilterValues`...). Existe também o antigo `mcp-server-langfuse` (MIT, só prompts, parado desde 2025).
- **Diferencial:** o pacote mais completo de forma OSS; o modelo de dados virou padrão de fato (trace, observation, score, session); integração com Claude Code pronta.
- **O que aproveitar:** o **Score como entidade de primeira classe**, ligável a qualquer nível (observation, trace, session); **environments**; os **tipos de observação de agente**; o **MCP nativo no mesmo servidor** (sem processo à parte); o padrão do **hook `Stop` que lê o transcript** do Claude Code.
- **Fraquezas:** stack pesada (4 componentes); as features de governança que um multi-cliente precisa (RBAC por projeto, audit, retenção) estão no EE; o futuro do roadmap depende da ClickHouse; não tem controle (pausar, matar ou aprovar um agente).

### 2. Arize Phoenix

- **O que é:** ferramenta de tracing e avaliação da Arize, OTel-nativa via **OpenInference**. Roda local (`pip`) ou em container.
- **Licença (confirmada):** **Elastic License 2.0** no servidor (`NOASSERTION` no GitHub). Proíbe oferecer o software "como serviço hospedado ou gerenciado". OpenInference (instrumentação) e `phoenix-mcp` são Apache-2.0.
- **Self-host:** sim, num único container (SQLite ou Postgres). Leve.
- **Modelo de dados:** `Project` → `Trace` → `Span` (OTel puro, com `openinference.span.kind`: LLM, CHAIN, TOOL, AGENT, RETRIEVER, EMBEDDING, RERANKER, GUARDRAIL, EVALUATOR); `Session` (via `session.id`); `Annotation` (humana, LLM ou código, em span, trace ou session); `Dataset` → `Example`; `Experiment`; `Prompt` (versões e tags).
- **Features:** tracing; sessões; evals (biblioteca `phoenix-evals`, LLM-as-judge); anotações humanas; datasets e experimentos; playground (com replay de span); prompt management; custo por modelo (a confirmar a granularidade); projetos; auth com papéis admin, member e viewer (a confirmar); alertas e monitores **só no Arize AX** (pago).
- **MCP próprio:** sim, `@arizeai/phoenix-mcp` (Apache-2.0, stdio via npx), com projetos, traces, spans, annotations, sessões, prompts, datasets e experimentos.
- **Diferencial:** **OpenInference**, uma convenção semântica própria, anterior e paralela ao OTel GenAI, com instrumentações para dezenas de frameworks; e a melhor experiência "rode local em 1 comando".
- **O que aproveitar:** o **replay de um span no playground** (abrir uma chamada LLM real e reexecutar com outro prompt ou modelo); a anotação em nível de **session**; o footprint mínimo (um container) como meta para o modo local do Console.
- **Fraquezas:** a ELv2 impede a Ahrena de hospedar o Phoenix para clientes; sem alertas no OSS; OpenInference e OTel GenAI coexistem, o que exige mapeamento.

### 3. AgentOps

- **O que é:** SDK e dashboard de monitoramento de agentes, focado em frameworks (CrewAI, AutoGen, OpenAI Agents, LangChain...).
- **Licença (confirmada):** raiz do repositório e SDK **MIT**; a app (`app/`: API, dashboard, ClickHouse, Supabase) é **Elastic License 2.0**. O SPDX do GitHub mostra só MIT.
- **Self-host:** possível (`app/compose.yaml`, Supabase, ClickHouse e um collector OTel), mas é secundário; o foco é a nuvem.
- **Modelo de dados:** `Session` (cada execução do programa) = trace → spans (LLM, tool, action, agent, error) e eventos; tags.
- **Features:** tracing; sessões; **session waterfall e drilldown** (replay visual da execução); custo por LLM; overview agregado entre sessões; integração por decorators (`@trace`, `@agent`, `@tool`); evals e benchmarks (limitados, a confirmar).
- **MCP próprio:** sim, `AgentOps-AI/agentops-mcp-server` (Apache-2.0).
- **Diferencial:** UX centrada em **sessão de agente** (waterfall com erros, tool calls e o chat lado a lado) e onboarding de 2 linhas.
- **O que aproveitar:** a **sessão como unidade de navegação**, não o trace; o waterfall que mistura LLM, tool e erro numa linha do tempo; o "meta-overview" entre sessões.
- **Fraquezas:** atividade em queda (último push no repositório em 06/2026); ELv2 na app; pouco de evals e prompt management; Python primeiro (o TS é secundário).

### 4. Comet Opik

- **O que é:** plataforma de tracing, evals, otimização de prompts e agentes e guardrails, da Comet.
- **Licença (confirmada):** **Apache-2.0 para a plataforma inteira** (backend, UI, avaliação online, otimizador). O README faz disso o argumento central contra os concorrentes.
- **Self-host:** sim (`opik.sh` com perfis, Helm). Stack: Java backend, MySQL, ClickHouse, Redis e MinIO.
- **Modelo de dados:** `Workspace` → `Project` → `Trace` → `Span` (tipos general, llm, tool, guardrail); `Thread` (conversa multi-turno); `Feedback Score`; `Dataset` → `Item`; `Experiment`; `Prompt` (versões); `Guardrail`.
- **Features:** tracing; threads (sessões); evals com métricas prontas (hallucination, moderation, relevância...) e LLM-as-judge; **avaliação online por regras**; datasets e experimentos; prompt library e playground; **Agent Optimizer** (otimiza prompts e agentes automaticamente); **Guardrails** (PII, tópicos); custo por modelo; dashboards; anotação humana (annotation queues); integração com Claude Code (plugin ou OTel nativo, beta).
- **MCP próprio:** sim, nativo em `/opik/api/v1/mcp` (HTTP), mais o repositório `comet-ml/opik-mcp` (Apache-2.0), com leitura de traces, gravação de scores e gestão de prompts. `uvx opik mcp configure` configura Claude Code e Cursor.
- **Diferencial:** **Apache-2.0 sem pegadinhas**, mais otimizador e guardrails no mesmo produto.
- **O que aproveitar:** o **MCP que também escreve** (logar score a partir do Claude); o instalador `mcp configure` de um comando; guardrails como span (`type=guardrail`), visíveis no trace.
- **Fraquezas:** stack pesada (Java, MySQL e ClickHouse); no OSS self-host o modelo de usuários e workspaces é limitado, e o multi-tenant real fica na Comet (a confirmar); a UI fica atrás do Langfuse em sessões de agente longas.

### 5. Laminar (lmnr)

- **O que é:** observabilidade "feita para agentes", em Rust (YC S24), com foco em traces longos (browser agents, coding agents).
- **Licença (confirmada):** Apache-2.0 (`LICENSE.md`).
- **Self-host:** sim (`docker compose up`, com versão "full" para produção). Usa ClickHouse.
- **Modelo de dados:** `Project` → `Trace` → `Span` (OTel-nativo, ingestão gRPC); `Session`; `Event`; `Signal` (comportamento descrito em linguagem natural); `Dataset`; `Evaluation`; dashboards por SQL.
- **Features:** tracing OTel (Vercel AI SDK, LangChain, Anthropic, Browser Use...); **Signals** ("o agente está preso em loop", em português claro, avaliado em cada execução e notificado no Slack); evals (SDK e CLI, CI/CD); **dashboards com SQL custom**; anotação e datasets; **realtime** (ver o trace enquanto acontece); busca full-text em spans; compressão de traces de 20x; redator de PII (`pii-redactor`).
- **MCP próprio:** sim, `/v1/mcp` com Bearer por projeto. Três tools: **`query_laminar_sql`** (ClickHouse somente-leitura, com escopo de projeto), **`get_trace_context`** (resumo do trace otimizado para LLM: árvore, tempos, I/O, erros) e **`ask_agent`** (agente que responde perguntas sobre os traces, com `conversationId`).
- **Diferencial:** o MCP mais inteligente do benchmark, e **alertas semânticos (Signals)** em vez de thresholds numéricos.
- **O que aproveitar:** os três padrões do MCP (**SQL somente-leitura com escopo**, **resumo de trace otimizado para LLM**, **agente sobre os traces**); **Signals como alertas em linguagem natural**; trace ao vivo (essencial para "controle"); redação de PII no ingest.
- **Fraquezas:** comunidade menor (cerca de 3,4k estrelas); prompt management fraco; RBAC e multi-tenant pouco documentados (a confirmar).

### 6. Helicone

- **O que é:** **AI Gateway** (proxy OpenAI-compatível para mais de 100 modelos) com observabilidade embutida.
- **Licença (confirmada):** Apache-2.0.
- **Self-host:** sim (Docker Compose; Helm só no enterprise). Componentes: Web (Next), Worker (proxy em **Cloudflare Workers**), Jawn (Express), Supabase, ClickHouse e MinIO.
- **Modelo de dados:** `Request` (unidade básica: request e response do provider) com `Properties` custom (headers `Helicone-Property-*`), `Session` (via `Helicone-Session-Id`, `-Path`, `-Name`, formando árvore por path), `User`, `Feedback/Score`, `Prompt` (versões), `Dataset`.
- **Features:** gateway com roteamento, fallback, **cache**, **rate limit** por usuário ou propriedade, retries; logging por proxy (zero SDK) ou assíncrono (OpenLLMetry); sessões; custo e latência por modelo (tabela de preços OSS própria); **alertas** (custo, erro); playground; prompt management servido pelo gateway; datasets e fine-tuning (parceiros); export para PostHog.
- **MCP próprio:** sim, `@helicone/mcp` (stdio), que **consulta dados e também faz chamadas LLM pelo gateway** (`use_ai_gateway`, com `sessionId`, `userId` e propriedades).
- **Diferencial:** **observabilidade como efeito colateral do roteamento**; controle (cache, rate limit, fallback) no caminho do request.
- **O que aproveitar:** para um runtime **multi-provider** de agentes, um gateway é o ponto natural para custo, limites e fallback por cliente; **custom properties por header** (`cliente`, `agente`, `ambiente`) sem mudar o SDK; o worker em Cloudflare é sinergia direta com quem usa Cloudflare como provider.
- **Fraquezas:** a visão é por request, e o tracing de agente (tool spans, grafo) é secundário; proxy no caminho crítico (latência e disponibilidade); evals limitados.

### 7. LangSmith (fechado; referência)

- **O que é:** plataforma da LangChain para tracing, evals, monitoramento e deploy de agentes; integração mais profunda com LangGraph.
- **Licença:** proprietária. Os SDKs são MIT (o `langsmith-sdk` foi arquivado em 16/10/2026 e dividido em `langsmith-python` e `langsmith-javascript`). Self-host só no Enterprise (cloud, híbrido ou self-hosted).
- **Modelo de dados:** `Workspace` → `Project` (tracing project) → `Run` (árvore; `run_type`: llm, chain, tool, retriever, prompt, parser, embedding) agrupado em `Trace`; `Thread` (conversa); `Feedback` (score, comentário, correção); `Dataset` → `Example` (versionados, com `as_of`); `Experiment`; `Prompt` (Hub, commits); `Annotation Queue`; `Rule/Automation`.
- **Features:** tracing com views **Messages, Turns e Details** por thread; dashboards e **alertas**; **automations** (regras: amostrar, mandar para fila, webhook, avaliador online); annotation queues e anotação inline; datasets e experimentos (comparação lado a lado); Prompt Hub e playground; custo por modelo; **Engine** (detecta problemas recorrentes nos traces, diagnostica a causa e ajuda a resolver); RBAC e workspaces; ingestão OTel; deploy de agentes (Agent Server / LangGraph Platform).
- **MCP próprio:** sim, `langchain-ai/langsmith-mcp-server` (MIT, hospedado), com threads, runs (com **FQL**), projetos, prompts, datasets, experimentos e **billing**. **Paginação por caracteres** (`max_chars_per_page` padrão de 25k, `preview_chars` para truncar strings longas): cada página cabe no contexto do modelo.
- **Diferencial:** o ciclo fechado tracing → automations → fila de anotação → dataset → experimento, mais o nativo LangGraph.
- **O que aproveitar:** **paginação por orçamento de caracteres** no MCP; as **automations baseadas em regra** (filtro, amostra, ação); as **views por thread** (Messages, Turns); a tool de **billing via MCP**; para runtimes em LangGraph, o LangSmith é o benchmark direto de UX.
- **Fraquezas:** fechado; self-host só pago; lock-in no ecossistema LangChain; não cobre sessões do Claude Code de forma nativa.

### 8. Traceloop / OpenLLMetry, e as convenções OTel GenAI

- **O que é:** OpenLLMetry é um conjunto de instrumentações OTel para LLMs, vector DBs e frameworks (Python e TS); a Traceloop é a plataforma comercial em cima dele.
- **Licença (confirmada):** OpenLLMetry Apache-2.0. A plataforma Traceloop é proprietária.
- **Self-host:** o SDK exporta para **qualquer backend OTLP** (Datadog, Grafana/Tempo, Honeycomb, Langfuse, Laminar...). Plataforma Traceloop: cloud e enterprise.
- **Modelo de dados:** spans OTel com atributos `gen_ai.*` (o OpenLLMetry ajudou a originar a convenção) mais `traceloop.workflow.name`, `traceloop.entity.*` e `association_properties`.
- **Features:** auto-instrumentação ampla; decorators `@workflow`, `@task`, `@agent` e `@tool`; na plataforma: monitores de qualidade, evals, prompts.
- **MCP próprio:** sim, `traceloop/opentelemetry-mcp-server` (Apache-2.0): **MCP unificado para consultar traces em vários backends** (Jaeger, Tempo, Traceloop...).
- **Diferencial:** **neutralidade de backend**, porque instrumenta uma vez e manda para onde quiser.
- **O que aproveitar:** o MCP **agnóstico de backend** é exatamente o desenho que deixa o Console ler traces que o cliente já guarda no Datadog ou no Tempo.

#### Estado das convenções OTel GenAI (repositório `open-telemetry/semantic-conventions-genai`, Apache-2.0)

- **Status:** todo o conjunto está em **Development** (nada estável). Saiu do repositório principal de semconv para um repositório próprio, gerenciado com Weaver; o "Schema URL" ainda é TODO.
- **Sinais:** spans (inferência e agente), métricas, eventos, exceções e métricas de token.
- **`gen_ai.operation.name`:** `chat`, `text_completion`, `generate_content`, `embeddings`, `retrieval`, `execute_tool`, `create_agent`, `invoke_agent`, `invoke_workflow`, `plan`, `create_memory`, `search_memory`, `update_memory`, `upsert_memory`, `delete_memory`, `create_memory_store`, `delete_memory_store`, `fetch_response`.
- **Identidade:** `gen_ai.provider.name` (valores conhecidos: `anthropic`, `aws.bedrock`, `openai`, `azure.ai.openai`, `gcp.vertex_ai`, `gcp.gemini`, `mistral`, `groq`, `deepseek`, `x_ai`... **sem `cloudflare`**, então seria preciso um valor custom, por exemplo `cloudflare.workers_ai`); `gen_ai.request.model` / `gen_ai.response.model`; `gen_ai.agent.{id,name,version,description}`; `gen_ai.main_agent.*` (agente raiz em multiagente); `gen_ai.workflow.name`; **`gen_ai.conversation.id`** (sessão ou thread); `gen_ai.conversation.compacted`.
- **Uso e custo:** `gen_ai.usage.input_tokens`, `output_tokens`, `cache_read.input_tokens`, `cache_write.input_tokens`, `reasoning.output_tokens` e variantes por modalidade. **Não há atributo de custo em dinheiro**: o custo fica a cargo do backend.
- **Conteúdo (opt-in):** `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments` / `.result`, com schema JSON definido; capturado só por opt-in.
- **Ferramentas, skills, prompts:** `gen_ai.tool.{name,type,call.id,description}`; **`gen_ai.skill.{name,description,source.uri,resource.name}`**; `gen_ai.prompt.{name,version,variable.*}`.
- **Avaliação:** evento **`gen_ai.evaluation.result`** com `gen_ai.evaluation.{name,score.value,score.label,explanation}`.
- **MCP:** `mcp.method.name`, `mcp.session.id`, `mcp.protocol.version`, `mcp.resource.uri`.
- **Métricas:** `gen_ai.client.operation.duration`, `gen_ai.client.token.usage`, `gen_ai.server.time_to_first_token`, `gen_ai.invoke_agent.duration`, `gen_ai.invoke_agent.tool_calls`, `gen_ai.invoke_agent.inference_calls`, `gen_ai.execute_tool.duration`, `gen_ai.invoke_workflow.duration`.
- **Specs por provider:** Anthropic, AWS Bedrock, Azure AI Inference, OpenAI.
- **Fraquezas da convenção:** instável (atributos já foram renomeados, como `gen_ai.system` virando `gen_ai.provider.name`); não modela **usuário final, tenant/cliente, score humano, dataset, prompt management, custo em dinheiro** nem **controle**.

### 9. Braintrust e W&B Weave (complementares)

**Braintrust**
- **O que é:** plataforma de evals e observabilidade com forte foco em experimentos.
- **Licença:** plataforma proprietária; SDKs Apache-2.0. O self-host é um modelo híbrido (data plane no cliente), no enterprise (a confirmar os detalhes).
- **Modelo de dados:** `Project` → `Experiment` / `Logs` → spans; `Dataset`; `Prompt`; `Score`.
- **Features:** logs e traces; evals (o ponto mais forte do mercado); datasets a partir de anotação; playground; prompts; **Loop** (agente que analisa dados e cria evals); **Patterns** (acha problemas recorrentes nos traces e sugere correções); CLI `bt`; admin e acesso; banco próprio (Brainstore).
- **MCP:** sim (dados e ações), mais uma extensão do Cursor que **traça as sessões do próprio Cursor**.
- **O que aproveitar:** "eval-first"; **Patterns/Loop** (clusterização de falhas e um agente que gera evals); **tracing da ferramenta de dev** (Cursor), que é análogo ao Console traçar o Claude Code.

**W&B Weave**
- **O que é:** toolkit de tracing e evals da Weights & Biases (agora parte da CoreWeave).
- **Licença:** SDK Apache-2.0; o self-managed exige licença do W&B Server.
- **Modelo de dados:** `Op` (função versionada) → `Call` (árvore), `Object` versionado (datasets, modelos, prompts), `Feedback`, `Evaluation`.
- **Features:** tracing via `@weave.op`; **versionamento automático de código, prompts e objetos**; evals e leaderboards; playground; guardrails/scorers; custo.
- **MCP:** sim, `wandb/wandb-mcp-server` (MIT), cobrindo W&B Models e Weave.
- **O que aproveitar:** **versionamento automático do "agente"** (código, prompt e config com hash) ligado a cada call, o que é útil para comparar versões de agentes de produção entre deploys.

---

## (a) Matriz de features

Legenda: ✓ tem (no produto, na edição indicada) · ◐ parcial, só pago ou EE, ou beta · – não tem ou não encontrado.
Colunas: LF = Langfuse, PX = Phoenix, AO = AgentOps, OP = Opik, LM = Laminar, HC = Helicone, LS = LangSmith, TL = Traceloop/OpenLLMetry, BT = Braintrust, WV = Weave.

| Feature | LF | PX | AO | OP | LM | HC | LS | TL | BT | WV |
|---|---|---|---|---|---|---|---|---|---|---|
| Licença OSI do servidor | ◐ MIT+EE | – ELv2 | – ELv2 | ✓ Apache | ✓ Apache | ✓ Apache | – | ◐ só SDK | – | – |
| Self-host gratuito | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | – | ◐ SDK | – | – |
| Tracing aninhado (agente/tool) | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ |
| Ingestão OTLP / OTel-nativo | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ | ✓ | ◐ |
| Sessões / threads | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ | ◐ | ◐ |
| Replay visual (waterfall/timeline) | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ | ✓ | ◐ | ✓ | ✓ |
| Trace ao vivo (realtime) | ◐ | – | ◐ | – | ✓ | ◐ | ◐ | – | ◐ | – |
| Replay de span no playground | ✓ | ✓ | – | ✓ | ◐ | ✓ | ✓ | – | ✓ | ✓ |
| Evals offline (datasets + experimentos) | ✓ | ✓ | ◐ | ✓ | ✓ | ◐ | ✓ | ◐ | ✓ | ✓ |
| LLM-as-judge online (produção) | ✓ | ◐ | – | ✓ | ✓ | ◐ | ✓ | ◐ | ✓ | ✓ |
| Anotação humana / filas | ✓ | ✓ | – | ✓ | ✓ | ◐ | ✓ | – | ✓ | ✓ |
| Prompt management (versões/labels) | ✓ | ✓ | – | ✓ | ◐ | ✓ | ✓ | ◐ | ✓ | ✓ |
| Playground | ✓ | ✓ | – | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| Custo por modelo | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ |
| Alertas | ◐ | ◐ AX | – | ◐ | ✓ Signals | ✓ | ✓ | ◐ | ✓ | ◐ |
| Detecção automática de padrões de falha | – | – | – | ◐ | ✓ | – | ✓ Engine | – | ✓ Patterns | – |
| Dashboards custom (SQL) | ◐ | – | – | ◐ | ✓ | ◐ | ✓ | – | ✓ | ◐ |
| Gateway / controle no caminho (cache, rate limit, fallback) | – | – | – | – | – | ✓ | – | – | ◐ | – |
| Guardrails | ◐ | ◐ | – | ✓ | – | – | – | – | ◐ | ✓ |
| Multi-projeto / multi-tenant | ✓ | ✓ | ◐ | ◐ | ✓ | ✓ | ✓ | ◐ | ✓ | ✓ |
| RBAC | ◐ org OSS, projeto EE | ◐ | – | ◐ | ◐ | ✓ | ✓ | ◐ | ✓ | ✓ |
| Audit log / retenção | ◐ EE | – | – | – | – | ◐ | ✓ | – | ✓ | ✓ |
| Redação de PII | ◐ | – | – | ✓ | ✓ | ◐ | ◐ | ◐ | ◐ | ◐ |
| Servidor MCP próprio | ✓ nativo | ✓ npm | ✓ | ✓ nativo | ✓ nativo | ✓ npm | ✓ | ✓ multi-backend | ✓ | ✓ |
| MCP grava (scores, prompts) | ✓ | ✓ | – | ✓ | – | ✓ | ◐ | – | ✓ | ◐ |
| MCP com SQL / agente sobre traces | – | – | – | – | ✓ | – | ◐ FQL | – | ◐ Loop | – |
| Integração com Claude Code | ✓ hooks | – | – | ◐ beta | ◐ | – | ◐ | ◐ via OTel | – | – |
| Controle do agente (pausar, aprovar, matar) | – | – | – | – | – | ◐ gateway | ◐ deploy | – | – | – |

> Os ◐ e – em linhas como "Trace ao vivo", "RBAC" e "Claude Code" refletem o que foi encontrado nas fontes desta coleta; vale confirmar antes de uma decisão contratual.

**Leitura da matriz:** nenhuma ferramenta tem a última linha (controle). O mercado inteiro é "observar e avaliar"; **controle** e **unificação dev + produção** ficam livres para o Ahrena Console.

---

## (b) Top 10 ideias para roubar (ordenadas por valor para o Ahrena Console)

1. **MCP com SQL somente-leitura mais "resumo de trace otimizado para LLM" (Laminar).** Tools `query_sql` (SELECT com escopo de tenant e projeto), `get_trace_context` (árvore, tempos, I/O e erros condensados) e `ask` (agente sobre os traces). É o que torna o Console MCP-first de verdade dentro do Claude Desktop, em vez de um CRUD exposto por MCP.
2. **Sessão unificada dev ↔ produção sobre `gen_ai.conversation.id` (lacuna de mercado; inspirada no hook do Langfuse e no plugin do Opik).** Ingerir o Claude Code (OTel nativo, mais o hook `Stop`/transcript para o conteúdo) e os agentes headless no mesmo modelo, com sessão, agente e tool, e filtros por "origem: interativo | headless".
3. **Score como entidade de primeira classe em qualquer nível (Langfuse, emitida como `gen_ai.evaluation.result`).** Humano, LLM-judge, regra ou usuário final, ligado a span, trace ou sessão; base para evals, alertas e datasets.
4. **Alertas semânticos em linguagem natural (Laminar Signals) mais detecção de padrões (LangSmith Engine, Braintrust Patterns).** "Avise quando o agente do cliente X entrar em loop de tool" avaliado continuamente, com notificação; muito mais útil para agentes do que thresholds de latência.
5. **Paginação por orçamento de caracteres e truncamento com `preview_chars` (LangSmith MCP).** Toda tool do Console que devolve traces ou threads respeita um teto de caracteres e indica `total_pages`, para nunca estourar o contexto do Claude.
6. **Automations por regra (LangSmith): filtro → amostra → ação** (mandar para fila de anotação, rodar judge, webhook, adicionar ao dataset). O ciclo produção → dataset → eval fica fechado sem código.
7. **Atributos de tenant e propriedades por header, sem mudar o código (Helicone).** `ahrena.client.id`, `ahrena.agent.id`, `deployment.environment` e custom properties obrigatórios na ingestão; custo, limite e alerta por cliente desde o dia 1 (o produto é multi-cliente).
8. **Replay de span no playground (Phoenix, Langfuse, LangSmith).** A partir de qualquer chamada LLM de produção: reexecutar com outro modelo ou provider (Anthropic ↔ Bedrock ↔ Cloudflare) ou outro prompt, comparando custo e qualidade. Encaixa direto na estratégia multi-provider.
9. **Versionamento automático do agente (Weave) mais prompt labels (Langfuse).** Hash de código, prompt, modelo e provider atrelado a cada `invoke_agent` (`gen_ai.agent.version`, `gen_ai.prompt.version`), para comparar versões entre deploys e fazer rollback por label.
10. **Trace ao vivo mais redação de PII no ingest (Laminar).** Ver a execução enquanto acontece é pré-requisito para o lado de controle (pausar ou aprovar); redigir PII na entrada é pré-requisito para clientes regulados.

Menções honrosas: instalador `mcp configure` de um comando (Opik); MCP multi-backend para ler traces que o cliente já guarda no Datadog ou no Tempo (Traceloop); MCP de billing (LangSmith); guardrail como tipo de span (Opik).

---

## (c) Recomendação: adotar OTel GenAI como modelo de dados base?

**Sim, como base de ingestão e de vocabulário, mas não como o modelo de dados inteiro.** O desenho recomendado é "**OTel GenAI na borda, modelo próprio fino por cima**".

**Por que sim:**

1. **Cobre as duas fontes do Console sem adaptador próprio.** O Claude Code já exporta OTel nativamente; o LangGraph/TS instrumenta via OpenLLMetry ou OpenInference em OTLP; Bedrock e Anthropic têm spec própria na convenção. Um único endpoint OTLP recebe tudo.
2. **Já modela agentes, não só chamadas LLM.** `invoke_agent`, `execute_tool`, `invoke_workflow`, `plan`, memória, `gen_ai.main_agent.*`, `gen_ai.conversation.id`, `gen_ai.skill.*`, MCP (`mcp.session.id`) e avaliação (`gen_ai.evaluation.result`) batem quase um a um com os conceitos do Console.
3. **Portabilidade e saída para o cliente.** Os clientes da Ahrena podem querer os mesmos dados no Datadog, Grafana ou Langfuse. Com OTel, o Console vira mais um backend (e pode reexportar), não um silo. Todas as plataformas analisadas já ingerem OTLP, o que reduz lock-in nos dois sentidos.
4. **O mercado convergiu.** Langfuse, Phoenix, Opik, Laminar, LangSmith e Braintrust aceitam OTLP; brigar com isso é custo sem diferencial.

**Por que não sozinho (o que o modelo próprio precisa acrescentar):**

- **Status "Development":** nomes já mudaram (`gen_ai.system` → `gen_ai.provider.name`). É preciso uma **camada de normalização versionada** (mapear OpenInference, `traceloop.*` e versões antigas de `gen_ai.*` para um esquema interno estável).
- **Lacunas que o Console precisa e a convenção não tem:** tenant/cliente (`ahrena.client.id`), usuário final, **custo em dinheiro** (calculado com uma tabela de preços por provider, incluindo Cloudflare, que não tem `provider.name` padrão: usar `cloudflare.workers_ai` ou similar e propor upstream), scores humanos, datasets, prompts versionados, anotações e, principalmente, **entidades de controle** (estado do agente, aprovação pendente, comando de pausa ou kill, política).
- **Sessão é atributo, não entidade:** a convenção dá o `gen_ai.conversation.id`, mas a navegação por sessão (como no AgentOps e no Langfuse) exige materializar `Session` como entidade com agregados (custo, duração, status, origem).

**Desenho sugerido:**

```
Ingestão: OTLP (traces + logs/eventos + métricas), atributos gen_ai.* / mcp.* / ahrena.*
   ↓ normalizador versionado (OpenInference, traceloop.*, gen_ai antigo → esquema interno)
Armazenamento: spans brutos (colunar, ex.: ClickHouse) + entidades materializadas:
   Tenant · Project/Environment · Agent(versão) · Session(origem: claude-code | headless)
   · Trace · Span · Score · Dataset · Prompt · Alert/Signal · ControlAction
   ↓
Superfícies: MCP (SQL somente-leitura com escopo, get_trace_context, ask, write_score, control_*)
             + UI dentro do Claude Desktop
Saída: reexport OTLP para o backend do cliente
```

Em uma frase: **usar OTel GenAI como "língua franca" de entrada e saída, e manter um modelo próprio pequeno para o que gera valor e a convenção ignora: tenant, custo, score, sessão materializada e controle.**

---

### Fontes principais

- LICENSEs via `gh api`: `langfuse/langfuse`, `Arize-ai/phoenix`, `AgentOps-AI/agentops` (`app/LICENSE`), `comet-ml/opik`, `lmnr-ai/lmnr`, `Helicone/helicone`, `traceloop/openllmetry`, `wandb/weave`
- READMEs: `lmnr-ai/lmnr`, `comet-ml/opik`, `Helicone/helicone` (incl. `helicone-mcp`), `Arize-ai/phoenix` (`js/packages/phoenix-mcp`), `langchain-ai/langsmith-mcp-server`
- Docs: langfuse.com (data model, MCP server, pricing-self-host, integração Claude Code); laminar.sh/docs/platform/mcp; docs.langchain.com/langsmith; docs.agentops.ai; braintrust.dev/docs; comet.com/docs/opik (integração Claude Code)
- `open-telemetry/semantic-conventions-genai`: `docs/gen-ai/*.md` e `docs/registry/attributes/{gen-ai,mcp}.md`
