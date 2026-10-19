# Proposta de arquitetura: Ahrena Console 0.0.1

Status: **proposta para discussão.** Nada aqui foi implementado.

Base: o benchmark interno. Cada decisão aponta de onde veio.

## Em uma frase

Um processo local em cada máquina coleta as sessões do Claude Code, guarda tudo em SQLite e expõe por um servidor MCP. Dentro do Claude Desktop, isso aparece em quatro lugares: um painel lateral na aba Code, um artefato fixado, ferramentas na conversa e, se a validação confirmar, uma UI inline.

## 1. Local ou nuvem

**Decisão: local-first. O hub na nuvem fica para depois, mas o desenho já nasce preparado para ele.**

Por que local na 0.0.1:

- **Os dados nascem na máquina.** Transcripts, hooks, status line e telemetria estão no Mac de cada pessoa (benchmark interno 02).
- **O artefato só fala com servidor MCP local** via `host:` (benchmark interno 05, seção 1.4.1).
- **Privacidade.** Transcript tem código, segredos e conversa. Mandar para a nuvem por padrão é uma decisão que o open source não deve tomar pelo usuário.
- **O Claude Code apaga transcripts com mais de 30 dias.** A cópia local é o que preserva o histórico (benchmark interno 02, ideia 1).
- **Instalar é mais fácil.** Sem conta, sem servidor, sem Docker (benchmark interno 01, anti-padrões).

Por que o hub vem depois:

- Ver o time, os clientes e os agentes headless de produção exige um ponto central (benchmark interno 04).
- Nenhuma referência resolve isso bem. O Agent Monitor junta máquinas por SSH, e o Podium tem um servidor de time sem visão por cliente.

Como o desenho já prepara o hub:

- Todo evento ganha `machine_id`, `org_id` e `origin` (interativo ou headless) desde a 0.0.1.
- O vocabulário segue o OpenTelemetry GenAI, então o hub pode receber tanto as máquinas quanto os agentes headless pelo mesmo protocolo (benchmark interno 04, seção c).
- A sincronização com o hub será opcional e explícita, com a máquina enviando e nunca o hub buscando.

## 2. Como as peças se encaixam

```
 Máquina (Mac)
 ┌──────────────────────────────────────────────────────────────┐
 │  Fontes                       Núcleo: ahrena-console          │
 │  ─────────                    ──────────────────────────      │
 │  ~/.claude/projects/*.jsonl ─▶ Coletor ─▶ SQLite ─▶ Servidor   │
 │  hooks do Claude Code ───────▶  (backfill,          MCP        │
 │  status line (limites) ──────▶   tail,              (HTTP em   │
 │  telemetria OTel (opcional) ─▶   normaliza)         localhost) │
 │                                                     │ │ │ │    │
 └─────────────────────────────────────────────────────┼─┼─┼─┼────┘
                                                       │ │ │ │
   Claude Desktop                                      │ │ │ │
   ├─ Painel lateral na aba Code (mod) ◀───────────────┘ │ │ │
   ├─ Artefato fixado (claude.ai, host:ahrena-console) ◀──┘ │ │
   ├─ Ferramentas MCP na conversa ◀─────────────────────────┘ │
   └─ UI inline (MCP App), se validar ◀──────────────────────┘
   Navegador: web standalone (o mesmo servidor serve a UI)
```

### O núcleo

Um único processo, `ahrena-console`, com três papéis:

1. **Coletor.** Quatro fontes, cada uma cobrindo o que a outra não cobre (benchmark interno 02, achados):
   - **transcripts `.jsonl`:** histórico, tokens, custo, subagentes e linhas alteradas. Faz o backfill no primeiro start e depois segue os arquivos de forma incremental, sem contar a mesma resposta duas vezes (chave `message.id` + `requestId`);
   - **hooks:** estado ao vivo (rodando, esperando aprovação, parada). Eles só avisam; o conteúdo pesado vem do transcript (benchmark interno 01, ideia 3);
   - **status line:** os limites oficiais de uso (5 h, 7 dias, gasto), que só ela traz;
   - **telemetria OTel:** opcional. O núcleo recebe em `127.0.0.1:4318`, sem precisar de Grafana.
2. **Armazenamento.** SQLite local, usando o `node:sqlite` embutido no Node. Assim a instalação não depende de módulo nativo, que foi o atrito do Agent Monitor (benchmark interno 00).
3. **Servidor MCP.** HTTP em localhost, stateless, compatível com as duas versões da spec em circulação (benchmark interno 05, resumo 4). O mesmo servidor serve a UI web.

### As superfícies no Claude Desktop

Ordem de prioridade, da mais certa para a menos certa:

| Superfície | Para quê | Por que entra | Limite |
| --- | --- | --- | --- |
| **Painel lateral na aba Code (mod)** | Inbox "quem precisa de você", contadores ao vivo, status line, comando `/console` | É o único jeito de ter UI persistente ao lado do trabalho, atualizando sozinha, sem passar pelo modelo (benchmark interno 05, arquitetura C) | Só aparece na aba Code. Usa elementos nativos, não HTML |
| **Artefato fixado** | O console completo: dashboard, kanban de status, detalhe da sessão, analytics | Fica na barra lateral, tem URL própria e lê o núcleo local via `host:` (benchmark interno 05, arquitetura B) | Atualiza a cada ~30 s no mínimo. Funciona só para o dono e só no app Desktop |
| **Ferramentas MCP na conversa** | "Quais sessões estão paradas?", "Quanto gastei esta semana por projeto?" | É o "MCP first" de fato. Nenhuma referência faz isso dentro do Desktop (benchmark interno 01, benchmark interno 02) | Poucas ferramentas e respostas paginadas, para não pesar no contexto |
| **UI inline (MCP App)** | Um gráfico ou uma lista dentro da resposta | É o padrão aberto, que roda também em ChatGPT, VS Code e Cursor (benchmark interno 05, arquitetura A) | Servidor local está quebrado no Desktop hoje ([issue #1069](https://github.com/anthropics/claude-ai-mcp/issues/1069)). Entra só se a validação passar |
| **Web standalone** | Fora do Claude, e para desenvolver | Sai de graça: o núcleo já serve a UI | Não é o centro |

A UI completa (artefato, MCP App e web) é **um único bundle** HTML/JS com a marca da Ahrena ([design.md](design.md)). O painel lateral é à parte, porque o mod desenha com elementos nativos.

## 3. Features da 0.0.1

O recorte da 0.0.1 é **ver**. Controlar vem na 0.0.2.

### Entra

1. **Histórico completo desde o primeiro start.** Backfill dos `.jsonl`, incluindo subagentes, preservado além dos 30 dias (benchmark interno 02, ideia 1).
2. **Inbox "quem precisa de você".** Estados por sessão: rodando, esperando aprovação, esperando resposta, parada, terminada (benchmark interno 01 e benchmark interno 03, ideia 1 das duas).
3. **Detalhe da sessão.** Conversa renderizada, árvore de subagentes com custo e contexto por nó, ferramentas usadas e plano (benchmark interno 00; benchmark interno 01, ideia 6).
4. **Custo e tokens honestos.** Por sessão, projeto, modelo, org e subagente, sempre marcado como estimativa, com tabela de preços editável (benchmark interno 01, ideia 8; benchmark interno 02, ideias 5 e 10).
5. **Contexto em destaque.** Ocupação da janela, estouros e compactações (benchmark interno 01, ideia 4).
6. **Limites de uso com procedência.** Cada número diz se é oficial ou estimado (benchmark interno 02, ideia 2).
7. **Separação por org.** Sessões de orgs diferentes não se misturam (benchmark interno 02, ideia 8).
8. **Busca nas sessões.**
9. **Ferramentas MCP**, no máximo 10, só de leitura e paginadas por tamanho (benchmark interno 04, ideia 5):
   - `fleet_overview`, `sessions_needing_attention`, `list_sessions`, `get_session`, `search_sessions`
   - `usage_report` (agrupado por dia, projeto, modelo, org)
   - `query_sql` (só SELECT) (benchmark interno 04, ideia 1)
   - `console_doctor` (a coleta está saudável?) (benchmark interno 01, ideia 9)
10. **Instalação em um passo.** Um plugin do marketplace que instala o núcleo, registra os hooks e o servidor MCP, e um `doctor` que diz o que falta.
11. **Segurança desde o início.** Só de leitura, bind só em localhost, redação de segredos, e transcript tratado como conteúdo não confiável quando vai para o modelo (benchmark interno 05, risco 11).

### Fica para depois

| Versão | O quê |
| --- | --- |
| 0.0.2 | **Controle:** responder perguntas, aprovar plano e permissão pelo painel. Desligado por padrão, com consentimento (benchmark interno 01, ideia 2). Previsão de esgotamento de limite (benchmark interno 02, ideia 4) |
| 0.1 | **Hub na nuvem** para time e clientes. Ingestão OTel dos agentes headless de produção, com sessão unificada entre interativo e headless (benchmark interno 04, ideia 2) |
| depois | Tarefas → sessão → PR com kanban de trabalho e painel de checks (benchmark interno 03, ideias 2 a 4); avaliações e scores; alertas em linguagem natural; replay em outro modelo ou provider |

## 4. Modelo de dados

Vocabulário alinhado ao OpenTelemetry GenAI, com um modelo próprio pequeno por cima (benchmark interno 04, seção c):

- **Machine** (de onde veio) e **Org** (a conta dona da sessão)
- **Project** (repositório e pasta)
- **Session** (`origin`: interativo ou headless; estado; custo agregado)
- **Agent** (principal ou subagente, com pai)
- **Event** (mensagem, chamada de ferramenta, compactação, falha)
- **Usage** (tokens por modelo e tipo, incluindo cache)
- **LimitSnapshot** (limites oficiais com procedência)
- **Plan** (passos e dono de cada passo)

## 5. Stack

- **TypeScript** no núcleo, no mod e na UI.
- **Node 24** com `node:sqlite`, sem módulo nativo.
- **SDK oficial do MCP** em TypeScript.
- **UI:** React, Vite e Tailwind, com os tokens de [brand/tokens.json](brand/tokens.json).
- **Testes desde o primeiro commit.**

## 6. Validações antes de escrever código

> **Feitas em 2026-10-18.** V1, V2 e V4 confirmadas; V3 pendente. Resultados e o que mudou na proposta em [validacoes-0.0.1.md](validacoes-0.0.1.md). Mudanças principais: o núcleo é instalado como extensão `.mcpb` do Claude Desktop (sem reiniciar) além do plugin do Claude Code; o artefato usa long polling (`wait_for_changes`) para ficar ao vivo; o painel abre só por `/console`.

Quatro pontos que o benchmark não conseguiu confirmar, testados com protótipos mínimos:

1. **O painel lateral (mod) lê o núcleo** por `$.http.fetch` em localhost e se atualiza por timer.
2. **O artefato fala com o núcleo** via `host:ahrena-console`: qual é o intervalo real de atualização, e se funciona fixado na barra lateral.
3. **A UI inline (MCP App) renderiza na aba Code** do Desktop a partir de um servidor em localhost, apesar da issue #1069.
4. **O núcleo não consegue usar as ferramentas internas do Desktop** (listar sessões, mandar mensagem). O benchmark indica que não (benchmark interno 05, risco 10). Se for isso mesmo, o controle da 0.0.2 vai por hooks.

## 7. Perguntas para você

1. **Recorte da 0.0.1:** fica bom "ver" agora e "controlar" na 0.0.2, ou o controle (responder e aprovar pelo painel) precisa entrar já?
2. **Superfície principal:** painel lateral na aba Code ou artefato fixado? A proposta faz os dois, mas um deles vai receber o cuidado visual primeiro.
3. **Codex e Cursor:** o Agent Monitor cobre os dois. Entram, ou a 0.0.1 é só Claude Code?
