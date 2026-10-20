# Decisões da sessão

O núcleo registra o que foi decidido em cada sessão: o que se decidiu, o que foi descartado, quem decidiu, de onde veio e o link para a mensagem. Assim nem o agente nem a pessoa perdem o fio depois de um `/clear`, de uma compactação ou numa sessão filha. Issue #99; as telas são P9, P10, C20 e C21 dos [wireframes](../../../../docs/wireframes/).

| Arquivo | O quê |
| --- | --- |
| [model.ts](model.ts) | `Decision` e `SessionLink`, os estados, origens e escopos, e os validadores |
| [port.ts](port.ts) | `DecisionPort`: grava e consulta por sessão, família e branch |
| [migration.ts](migration.ts) | O esquema SQLite, a migração 4 da lista do adaptador |
| [sqlite.ts](sqlite.ts) | `SqliteDecisionStore`, sobre o mesmo banco do `SqliteStorage` |
| [registry.ts](registry.ts) | Registrar sem duplicar, cadeia de substituição, confirmar, descartar, reverter, ligar sessões e consultar |
| [capture-hooks.ts](capture-hooks.ts) | `HookDecisionCapture`, pendurada no `onEvent` do receptor de hooks |
| [capture-transcript.ts](capture-transcript.ts) | `extractTranscriptDecisions` (função pura) e `captureTranscriptFile` |
| [inference.ts](inference.ts) | A interface do inferidor por modelo pequeno, sem implementação |
| [hub.ts](hub.ts) | O que sai para o hub: só metadados, salvo texto liberado |

```ts
import { SqliteDecisionStore, HookDecisionCapture, captureTranscriptFile } from '@ahrena-console/nucleo';

const decisions = new SqliteDecisionStore(storage.db);
const capture = new HookDecisionCapture({ decisions });
await startHookReceiver({ storage, onEvent: (r) => capture.onEvent(r.event) });
await captureTranscriptFile(decisions, transcriptPath, new Date().toISOString());
```

## Modelo

- **Origem:** `pergunta`, `plano`, `permissao`, `correcao` ("correção sua") e `sugerida`.
- **Estado:** `vigente`, `substituida` (com `supersededBy`), `revertida`, `a_confirmar` e `descartada` (o "Descartar" de uma sugerida, que fica no histórico em vez de sumir).
- **Escopo:** `sessao`, `familia` (o padrão) ou `branch`. Uma decisão de escopo `sessao` não atravessa o `/clear`.
- **Número:** `seq` conta na família; `decisionLabel(d)` dá o "D4".
- **Link:** `message` guarda o `uuid` da linha, o `tool_use_id` e o caminho do transcript, nunca o texto da mensagem.
- **Outros:** `inferred` marca o que a captura deduziu; `textReleased` libera o texto para o hub; `promotedTo` é o registro em `docs/decisoes/` (#103).

## Cadeia de substituição

Cada decisão tem um assunto (`topic`). Na mesma família, as decisões vigentes e substituídas de um assunto formam uma fila por `decidedAt`: cada uma é substituída pela seguinte, e só a última vale. A fila é refeita a cada mudança, então a cadeia fica certa mesmo quando a captura chega fora de ordem (o hook agora, o transcript depois). `decisionChain(port, id)` devolve a cadeia inteira, da mais antiga à mais nova, a partir de qualquer elo.

- Uma decisão `a_confirmar` não substitui nada. Ao confirmar (`confirmDecision`), entra na fila.
- Reverter (`revertDecision`) tira a decisão da fila, e a anterior volta a valer.
- Os assuntos: `pergunta:<pergunta normalizada>`, `plano`, `permissao:<ferramenta e comando>`. A correção herda o assunto da proposta que contraria quando dá para saber qual é.

## Família

`linkSession(port, { sessionId, parentSessionId, reason })` liga uma sessão à anterior. Os motivos são `clear`, `compact`, `resume` e `filha`. A sessão entra na família da mãe, e o que ela já tinha decidido vai junto, com número novo. Quem descobre a mãe é a ligação de sessões do histórico (#33). A compactação mantém o `session_id`, então nada muda nela.

`currentDecisionsFor(port, { sessionId, branch, repo }, level)` devolve as vigentes que valem para a sessão. É o que a injeção (#100) e a ferramenta MCP (#101) consultam.

## Captura

Na API (`npm run api`), a captura do transcript roda na importação e no seguidor, para cada sessão que ganhou um prompt, uma resposta de pergunta ou de plano, ou uma recusa; e uma vez para o histórico já importado (src/api/reprocessamento.ts).

Determinística, nos dois caminhos. A chave de origem é a mesma (`tool:<tool_use_id>`), então hook e transcript não duplicam. O segundo a chegar só completa branch e link.

| O quê | Hooks | Transcript |
| --- | --- | --- |
| Pergunta (`AskUserQuestion`) | `PostToolUse`: perguntas e `answers` | `tool_result` com `toolUseResult.answers`, ou o texto "…answered: "P"="R"" |
| Plano (`ExitPlanMode`) | `PostToolUse` (aprovado) | `tool_result` aprovado; os recusados antes viram alternativas |
| Permitir | `PreToolUse` → notificação `permission_prompt` → `PostToolUse` da mesma chamada | não aparece: o transcript não diz se houve pedido |
| Negar | o pedido sem `PostToolUse` até o próximo `Stop` ou prompt, ou `PostToolUseFailure` de recusa | `tool_result` com erro "The user doesn't want to proceed…" |
| Correção sua | — | recusa de plano com o que a pessoa escreveu (determinística, vigente); resposta curta (até 160 caracteres, sem pergunta nem dúvida, com pelo menos três palavras depois da negação) que começa contrariando uma pergunta que o agente acabou de fazer (inferida, a confirmar). O título é a primeira frase; o texto inteiro fica em `metadata.texto` |
| Pergunta fechada sem resposta | — | não é decisão: `[User dismissed…]` não é registrado |

A correção inferida é conservadora. Só conta uma mensagem que começa com "não", "na verdade", "em vez de", "actually", "instead"… logo depois de uma fala do agente. Ela entra na cadeia de um assunto só quando o turno teve uma decisão só.

**Inferência por modelo pequeno:** `DecisionInferrer` é só a interface, e nada aqui chama API de modelo. O que o inferidor devolve entra como `sugerida`, do agente, `a_confirmar`.

## Conteúdo não confiável

O transcript e o payload do hook são dados, nunca instrução. A extração só faz `JSON.parse` e lê campos. Não executa, não avalia e não abre caminho nenhum que venha do conteúdo. Todo texto passa por `cleanText`: vira uma linha só, perde controles, ANSI e caracteres invisíveis ou de direção, e é cortado em 280 caracteres, com no máximo 12 itens por lista.

## No painel

A API local (`src/api/decisoes.ts`, #102) lista as decisões por escopo para o painel e faz o Confirmar e o Descartar de uma sugerida, gravando em `metadata.painel` quem decidiu e quando. A captura pelos hooks está pendurada no receptor da API (`src/api/cli.ts`); a do transcript ainda não é chamada pelo seguidor.

**Para o hub:** `decisionForHub(d)` leva só metadados: ids, família, número, branch, origem, estado, escopo, quem decidiu, cadeia, ids da mensagem, datas e quantas alternativas. Assunto, contexto, escolha, alternativas e caminhos locais ficam de fora. O texto só vai quando a pessoa libera aquela decisão (`releaseDecisionText`).
