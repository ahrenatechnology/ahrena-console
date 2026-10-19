# Chat e delegação de prompts (spike #120)

Prova mínima da [decisão 0007](../../docs/decisoes/0007-chat-e-delegacao.md): o console conversa em streaming com sessões **reais** do Claude Code CLI 2.1.302, novas ou retomadas pelo id, em pastas de configuração temporárias (uma por conta sintética), e entrega um prompt a uma sessão já aberta por outro processo. Código descartável.

O modelo é uma API falsa em `127.0.0.1` que responde com eco. Nada aqui usa login, Keychain, `~/.claude` ou plano de ninguém: o `HOME` é falso, a chave é falsa, as pastas são temporárias.

## O que tem aqui

| Arquivo | O quê |
| --- | --- |
| [sessao.mjs](sessao.mjs) | Abre uma sessão do CLI em `stream-json` (entrada e saída), com `CLAUDE_CONFIG_DIR`, `cwd`, `--resume`, `--session-id`, `--fork-session` e `--permission-prompt-tool stdio`. Envia mensagens com `priority`, interrompe por `control_request` e repassa os pedidos de permissão (`can_use_tool`). É o mesmo protocolo que o Agent SDK usa por baixo, sem dependência |
| [chat.mjs](chat.mjs) | Chat de terminal falso: o que a janela de chat do app faria. `/parar` interrompe, `/sair` encerra, e a permissão é perguntada "uma vez" |
| [caixa-de-entrada.mjs](caixa-de-entrada.mjs) | Descobre as sessões vivas de uma pasta de configuração (`sessions/<pid>.json`: `status`, `messagingSocketPath`) e entrega um prompt pela caixa de entrada da mensageria entre sessões |
| [prova.mjs](prova.mjs) | Os nove cenários abaixo, com o CLI |
| [sdk.mjs](sdk.mjs) | O mesmo com o Claude Agent SDK 0.3.302 (`query` em streaming, `resume`, `canUseTool`, `interrupt`, `listSessions`), rodando o CLI instalado |
| [api-falsa.mjs](api-falsa.mjs) | `/v1/messages` em streaming: "eco #n: texto", em que n é quantas mensagens da pessoa a conversa tem. "devagar" demora 4 s; "rode <comando>" pede a ferramenta Bash |

## Rodar

```bash
node spikes/chat-delegacao/prova.mjs
```

```bash
cd spikes/chat-delegacao && npm ci --omit=optional && node sdk.mjs
```

```bash
node spikes/chat-delegacao/api-falsa.mjs 4891 &
node spikes/chat-delegacao/chat.mjs --conta "$(mktemp -d)" --pasta "$(mktemp -d)" --api-falsa 4891
```

`PORTA` troca a porta da API falsa (padrão 4891) e `CLAUDE_BIN` o executável do CLI. O `--omit=optional` deixa de fora o binário do CLI que o SDK traz (268 MB descompactado, no pacote `-darwin-arm64` 0.3.302): a prova usa o instalado.

## O que ela mostra

`prova.mjs` (Claude Code 2.1.302, macOS 26.7), sem os caminhos:

```
== 1. sessão nova na conta A, id escolhido pelo console, dois turnos
resposta: eco #1: primeira mensagem | session_id igual ao escolhido: true
resposta: eco #2: segunda mensagem
== 2. retomar pelo id num processo novo
resposta: eco #3: terceira, depois de retomar | mesmo id: true
== 3. mensagem no meio de um turno
  assistant: eco #4: devagar, por favor
  result(success, 1 turnos)
  assistant: eco #5: chegou no meio (sem prioridade)
  result(success, 1 turnos)
  assistant: eco #6: chegou no meio (later)
  result(success, 1 turnos)
== 4. interromper
resposta do interrupt: {"still_queued":[]} | result: error_during_execution (erro)
== 5. permissão respondida pelo console
pediu: Bash "touch negado.txt"
depois de negar: ferramenta devolveu: Negado pela prova
pediu: Bash "touch permitido.txt"
depois de permitir: ferramenta devolveu: (Bash completed with no output)
== 6. dois processos na mesma sessão
processo 1: eco #10: do processo 1 | id igual
processo 2: eco #10: do processo 2 | id igual
retomada depois dos dois: eco #11: quem ficou no histórico?
== 7. --fork-session
resposta: eco #12: num fork | id novo: true
== 8. contas A e B ao mesmo tempo
A: eco #12: na conta A | B: eco #1: na conta B
transcripts em A: 2 | em B: 1 | B tem o id de A: false
HOME falso vazio: true
== 9. entregar a uma sessão aberta por outro processo
sessão viva: {"status":"busy","kind":"interactive","mesmoId":true,"socket":true,"token":true}
a sessão recebeu: "eco #14: Another Claude session sent a message: / delegado pelo console"
```

- **3:** sem ferramenta rodando, a mensagem enviada no meio vira o turno seguinte, na ordem. Com ferramenta rodando, `priority` decide (veja a decisão).
- **6:** os dois processos gravaram no mesmo arquivo, como **irmãos** do mesmo pai (`parentUuid`). A retomada seguinte segue só o ramo mais novo: "do processo 1" sumiu do contexto, sem erro nenhum. Por isso, um escritor por sessão.
- **8:** cada conta escreve só na sua pasta, ao mesmo tempo.
- **9:** a sessão viva se anuncia em `sessions/<pid>.json` da pasta de configuração, com `status` e `messagingSocketPath`, e o token num `<pid>.<hash>.key` ao lado. Uma linha de usuário em stream-json nesse socket virou um turno novo, **marcado como mensagem de outra sessão**, não como a pessoa. O `status` lido logo depois do fim do turno ainda dizia `busy`: ele atrasa e serve de dica, não de trava.

`sdk.mjs`:

```
== 1. sessão nova, dois turnos em streaming
   eco #1: olá pelo SDK
  canUseTool: Bash "touch pelo-sdk.txt"
   ferramenta devolveu: Negado pelo console (SDK)
== 2. retomar pelo id (options.resume) e interromper
  interrupt(): {"still_queued":[]}
   eco #3: deva
  result: error_during_execution | mesmo id: true
== 3. listSessions e getSessionMessages na pasta da conta
  sessões: 1 | primeira mensagem: "olá pelo SDK"
  mensagens da sessão: 9
```

Medido à parte, com scripts de uma vez só (no PR):

- **`claude agents --json`** na pasta de configuração lista a sessão `-p` viva como `interactive`, com `status` `busy` durante o turno e `idle` depois. A entrega pela caixa de entrada funcionou também sem a linha de `auth` (no macOS ela é opcional).
- **Sessão em background** (`claude --bg`): `claude -p --resume <id>` é recusado enquanto ela roda ("That session is running in the background… Add --fork-session"). `claude logs` devolve a tela do terminal com códigos ANSI, não mensagens.
- **`-p -w <nome>`** cria o worktree em `.claude/worktrees/<nome>` e roda a sessão lá.

## O que a prova não cobre

Login de assinatura de verdade (a API é falsa), Remote Control (exige assinatura), uma sessão interativa num terminal de verdade recebendo pela caixa de entrada (a prova usou um processo `-p`), a janela de chat no app Tauri e a interface do núcleo.
