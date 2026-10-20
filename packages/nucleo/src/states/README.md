# Máquina de estados

Decide o estado de cada sessão e dos agentes dela a partir dos eventos de hook e do transcript, e cobre os hooks que se perdem com um vigia. Item 1.5 do [backlog](../../../../docs/backlog-0.0.1.md). As regras vêm do Claude Code Agent Monitor (benchmark interno, seção 3); copiamos as regras, não o código. "Delegando" e "esperando processo em background" vêm do Podium.

| Arquivo | O quê |
| --- | --- |
| [rules.ts](rules.ts) | `transition(state, event)`: função pura, uma regra por tipo de evento |
| [watcher.ts](watcher.ts) | `watch(state, now, liveDirs)`: turno morto, sonda e abandono, também puro |
| [probe.ts](probe.ts) | Sonda de processo vivo (`systemProcessProbe`): `ps` + `lsof` no macOS, `/proc` no Linux, desligada no resto. Reconhece o `claude` do Claude Desktop, cujo caminho tem espaço (`Application Support`) |
| [inbox.ts](inbox.ts) | `readInbox(session, agents)`: o que o inbox mostra, com delegando e background |
| [machine.ts](machine.ts) | `SessionStateMachine`: lê e grava pela porta, em série |

## Uso

```ts
import { SessionStateMachine, startHookReceiver, readInbox } from '@ahrena-console/nucleo';

const machine = new SessionStateMachine({ storage, onChange: (change) => notify(change) });
await startHookReceiver({ storage, onEvent: machine.onHook });
const stop = machine.start(); // vigia a cada 15 s

await machine.sync(sessionId); // depois de importar histórico, se quiser na hora
const { state, needsYou, urgent } = readInbox(session, agents);
```

Relógio (`now`) e sonda (`probe`) são injetáveis. Na nuvem, `probe: null`: o processo não está na mesma máquina.

## Estados

A sessão grava `active`, `completed`, `error` ou `abandoned`. `waiting` é a camada sobre `awaitingInputSince`, com o motivo em `awaitingReason`. `readInbox()` acrescenta:

| Estado do inbox | Quando | Precisa de você |
| --- | --- | --- |
| `waiting` | Espera em aberto | sim (urgente se `notification` ou `interrupted`) |
| `error` | Erro não superado | sim |
| `delegating` | O principal está parado esperando subagentes: chamada de `Agent`/`Task` em andamento, ou subagente rodando com o turno encerrado | não |
| `background` | O turno acabou (`stop`), mas há `Bash` em background rodando | não |
| `active`, `completed`, `abandoned` | O status gravado | não |

## Transições

| Evento | Efeito |
| --- | --- |
| `SessionStart` | Reabre se estava encerrada, limpa erro, principal `waiting`, motivo `session_start`. Com `source: compact`, nada muda |
| `UserPromptSubmit` | Principal `working`, limpa a espera |
| `PreToolUse` | O agente que age fica `working` com `currentTool`. `Agent`/`Task` registra a delegação |
| `PostToolUse`, `PostToolUseFailure` | Limpa `currentTool` e a espera (a permissão foi respondida), encerra a delegação, registra `Bash` em background e tira o processo com `KillShell` ou `BashOutput` terminado. Falha de ferramenta não é erro da sessão |
| `Notification` | Bloqueante (`permission_prompt`, `elicitation_dialog`, `agent_needs_input`...; sem tipo, pelo texto) vira waiting `notification`. As outras não mudam nada |
| `Stop` | Principal `waiting`, motivo `stop`, a sessão continua `active`. Com `stop_reason: error`, vai para `error` |
| `StopFailure`, `APIError` | `error` |
| `SubagentStop` | O subagente do `agent_id` (ou o trabalhando mais antigo) fica `completed` |
| `SessionEnd` | `completed` (ou continua `error`, se o erro não foi superado), agentes encerrados |
| `Interrupted` (vigia), Esc no transcript | waiting `interrupted` |
| Transcript: `UserPrompt`, `ToolUse`, `ToolResult` | Como os hooks equivalentes |
| Transcript: `AssistantMessage` | Desfaz um `interrupted` ou `session_start`: o turno estava vivo |
| Transcript: `TurnDuration` | Fecha o turno (`stop`), se o `Stop` se perdeu |

- **Regra de ator:** hook de subagente (com `agent_id`) não limpa a espera do principal, só um `interrupted`. O subagente é criado no primeiro hook dele, com id `<sessão>:<agent_id>`, o mesmo do importador.
- **Cura de erro:** progresso (prompt, ferramenta, mensagem do assistente) depois do erro devolve a sessão a `active`. `Stop` não é progresso.
- **Reabrir:** hook numa sessão encerrada a reabre (resume, ou a sonda errou). Evento do transcript nunca reabre: é passado.
- **Ordem:** evento anterior ao último aplicado chegou atrasado e não muda o estado; o mesmo evento duas vezes não muda nada.

## Vigia

A cada 15 s, em cada sessão `active` ou `error`:

1. **Sincroniza:** se a sessão teve atividade que a máquina não viu (`updatedAt` depois do último evento aplicado, como quando o importador grava o transcript), aplica esses eventos. É assim que o transcript cura um erro.
2. **Sonda:** sem processo `claude` vivo no `cwd`, parada há 30 s ou mais → `SessionEnd` sintético. Sonda desligada ou com falha (`null`) não encerra nada.
3. **Abandono:** `active` parada há 180 min → `abandoned`.
4. **Turno morto:** principal `working`, sem ferramenta, sem delegação nem subagente, 120 s sem sinal → `Interrupted`.

As regras do vigia gravam um evento sintético (`id` começando por `estado:`, `data.sintetico = true`), que aparece no histórico da sessão. Evento sintético não conta como atividade: não mexe em `updatedAt`.

## O que fica em `metadata.estados`

`ultimoEvento` e `idsNoUltimoInstante` (ordem e duplicatas), `erroEm` (para a cura), `delegacoes` (por `tool_use_id`) e `background` (por id do processo). Quem grava a sessão deve preservar essa chave, como já faz com `importacao`. Ao gravar, a máquina relê a sessão e só troca os campos dela (status, `endedAt`, espera, `metadata.estados`).
