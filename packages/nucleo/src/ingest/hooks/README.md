# Hooks do Claude Code

Recebe os hooks do Claude Code e grava cada um como evento pela porta de armazenamento. Item 1.4 do [backlog](../../../../../docs/backlog-0.0.1.md).

Eventos: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop` e `Notification`. Um evento que o Claude Code venha a criar também é gravado, marcado com `known: false`.

## Caminho

```
Claude Code ──stdin──▶ plugin/hooks/forward.mjs ──POST /api/hooks──▶ receiver.ts ──▶ normalize.ts ──▶ ingest.ts ──▶ StoragePort
```

| Arquivo | O quê |
| --- | --- |
| [normalize.ts](normalize.ts) | Payload cru → `SessionEvent`: tipo, ferramenta, resumo de uma linha, `agent_id` do subagente, id estável, `data` com strings longas cortadas |
| [ingest.ts](ingest.ts) | Grava o evento e garante o registro mínimo da sessão (`cwd`, `model`, `source`, `updatedAt` que não anda para trás) |
| [receiver.ts](receiver.ts) | Servidor HTTP em `127.0.0.1:4720`, `POST /api/hooks` e `GET /api/hooks/health` |
| [plugin/hooks/hooks.json](plugin/hooks/hooks.json) | A configuração que o plugin do Claude Code (item 6.2) vai levar |
| [plugin/hooks/forward.mjs](plugin/hooks/forward.mjs) | O encaminhador que o hook executa |

O receptor não muda status, espera nem agentes. Isso é da máquina de estados (item 1.5), que entra pelo `onEvent` do receptor.

## Por que um encaminhador e um endpoint HTTP

O hook não grava no SQLite. Ele só manda o payload para o núcleo, que é o único processo que escreve no banco.

- **Um escritor só.** Os hooks chegam em rajada (Pre/PostToolUse a cada ferramenta, de várias sessões ao mesmo tempo). Com um processo por hook abrindo o banco, cada um aplicaria as migrações e disputaria o lock; o receptor serializa as gravações numa fila.
- **O mesmo contrato local e na nuvem.** `POST /api/hooks` com o payload do Claude Code é o que o hub (épico 7) recebe atrás do API Gateway. Para mandar a outro núcleo, basta trocar `AHRENA_CONSOLE_URL`.
- **O estado vive num processo.** A máquina de estados (1.5) e o watchdog precisam de memória entre eventos, o que um script de vida curta não tem.
- **O script fica pequeno.** JavaScript puro, sem dependências e sem importar o núcleo, roda em qualquer Node ≥ 18 com o plugin instalado sozinho.

Um hook HTTP direto do Claude Code dispensaria o processo, mas não deixaria rastro quando falha. Ficamos com `command` porque ele registra a falha num arquivo, que o `doctor` (1.8) vai ler, e controla o próprio timeout. O receptor aceita o payload sem os cabeçalhos do encaminhador, então a troca continua possível.

## Tolerância a falha

O encaminhador nunca atrapalha a sessão:

- não escreve nada no stdout (no `SessionStart` e no `UserPromptSubmit`, o stdout vira contexto do modelo);
- sai sempre com código 0;
- desiste depois de `AHRENA_CONSOLE_HOOK_TIMEOUT_MS` (padrão 800 ms), somando a leitura do stdin e todos os envios; com um núcleo desligado, a conexão é recusada na hora;
- sem núcleo vivo, desiste calado: nenhum pedido e nenhuma linha no log (com nada rodando, cada hook de cada sessão escreveria uma);
- o `timeout` do `hooks.json` (3 s) é só o teto do Claude Code, caso o Node trave;
- cada falha vira uma linha, com o endereço do núcleo, em `<home>/hooks.log` (ou `AHRENA_CONSOLE_HOOK_LOG`), cortado ao passar de 256 KiB.

No receptor, requisição com `Origin` ou com `Host` diferente de `127.0.0.1:<porta>`/`localhost:<porta>` dá 403, como manda a [decisão 0003](../../../../../docs/decisoes/0003-responder-sessao.md); payload inválido dá 400, sem `application/json` dá 415, acima de 1 MiB dá 413. Erro no `onEvent` é registrado e não desfaz a gravação.

## Para quais núcleos

Decisão [0010](../../../../../docs/decisoes/0010-core-per-installation.md), item 4: cada instalação roda o próprio núcleo, em porta aleatória, e o encaminhador manda cada evento a todos eles.

- `AHRENA_CONSOLE_URL` ou `AHRENA_CONSOLE_PORT` definidos: só aquele núcleo, como antes.
- Senão, o registro de instâncias, `<home>/instances/<instalação>-<pid>.json` (`<home>` é `AHRENA_CONSOLE_HOME` ou `~/.ahrena-console`, o mesmo de [owner/registry.ts](../../owner/registry.ts)): toda entrada com nome válido, porta válida e pid vivo (`EPERM` conta como vivo) recebe o evento em `127.0.0.1:<porta>`, todas ao mesmo tempo, dentro do mesmo prazo.
- Todos recebem o mesmo corpo e o mesmo `x-ahrena-delivery-id`: é uma entrega só, e cada núcleo guarda o retrato inteiro.
- O encaminhador só lê o registro. Entrada de pid morto ou ilegível é pulada, nunca apagada: quem limpa é o núcleo, ao listar.
- A porta fixa 4720 deixou de ser o padrão. Na transição (item 7), quem sobe o núcleo de desenvolvimento com `--port 4720` também entra no registro e recebe os hooks por ele.

## Duplicatas

O id do evento é estável. No Pre/PostToolUse, vem do `tool_use_id`, então o mesmo hook chegando por dois plugins vira um evento só. Nos outros, vem do `x-ahrena-delivery-id` que o encaminhador gera. Sem nenhum dos dois, o id é aleatório.

## Variáveis

| Variável | Padrão | Quem lê |
| --- | --- | --- |
| `AHRENA_CONSOLE_URL` | nenhum (os núcleos do registro) | encaminhador |
| `AHRENA_CONSOLE_PORT` | nenhum (os núcleos do registro); com ela, `http://127.0.0.1:<porta>` | encaminhador |
| `AHRENA_CONSOLE_HOME` | `~/.ahrena-console` (onde fica `instances/`) | encaminhador e núcleo |
| `AHRENA_CONSOLE_HOOK_TIMEOUT_MS` | `800` | encaminhador |
| `AHRENA_CONSOLE_HOOK_LOG` | `<home>/hooks.log` | encaminhador |

## Testar sem instalar nada

```bash
npm test
```

Os testes rodam o comando do `hooks.json` como o Claude Code rodaria (shell, payload no stdin, `CLAUDE_PLUGIN_ROOT`), com os payloads sintéticos de [test/ingest/hook-payloads.ts](../../../test/ingest/hook-payloads.ts), contra o núcleo no ar, desligado, travado e recusando.

Para ver com o Claude Code de verdade, sem mexer no escopo do usuário: copie `plugin/` para uma pasta com um `.claude-plugin/plugin.json` mínimo e rode `claude --plugin-dir <pasta>`. O plugin vale só para aquela execução.
