# Servidor MCP

O servidor MCP de produção do Ahrena Console (épico 2, a partir da 2.1). Responde **no mesmo processo da API local**, em `POST http://127.0.0.1:4720/mcp`, e também por stdio. Só de leitura, sem sessão (stateless), com no máximo 10 ferramentas e respostas paginadas por tamanho ([proposta 0.0.1](../../../../docs/proposta-0.0.1.md), feature 9).

| Ferramenta | Pergunta | Item |
| --- | --- | --- |
| `sessions_needing_attention` | Quem precisa de mim? | 2.1 |
| `fleet_overview` | Como está tudo? | 2.1 |
| `wait_for_changes` | O que mudou? (long polling, [src/changes](../changes/mcp.ts)) | 2.4 |

## Como registrar

Suba o núcleo (`npm run api` em `packages/nucleo`, ou `npm run api -- --demo` para dados sintéticos) e registre o servidor.

**Claude Code**, por HTTP:

```bash
claude mcp add --transport http ahrena-console http://127.0.0.1:4720/mcp
```

**Claude Desktop**, por stdio, no `claude_desktop_config.json` (Configurações › Desenvolvedor › Editar configuração). O `command` é o caminho absoluto do Node 24 ou mais novo, porque o Desktop não herda o `PATH` do shell:

```json
{
  "mcpServers": {
    "ahrena-console": {
      "command": "/opt/homebrew/bin/node",
      "args": ["--disable-warning=ExperimentalWarning", "/caminho/do/ahrena-console/packages/nucleo/src/mcp/cli.ts"]
    }
  }
}
```

O stdio é uma ponte para o `/mcp` do núcleo que já roda: o mesmo servidor, e um só processo lendo o banco. Com o núcleo fora do ar, a ponte responde sozinha `initialize`, `ping` e `tools/list` (as mesmas ferramentas e esquemas), e cada `tools/call` volta com `isError` dizendo como subir o núcleo; o pedido seguinte já tenta o núcleo de novo. Uma ferramenta registrada só no núcleo (como a da 2.4) aparece na lista quando o cliente reconecta com o núcleo no ar. Sem `--porta`, a ponte usa o dono único ([src/owner](../owner/README.md)): adota o núcleo da trava `~/.ahrena-console/nucleo.json` ou, se não há, sobe um em segundo plano na `AHRENA_CONSOLE_PORT` (ou 4720) com `--pai` nela, e se registra como cliente quando adota. O núcleo sai quando a ponte e todos os clientes registrados saem. `--sem-subir` só adota. `--porta` fala só com aquela porta, sem adotar nem subir.

## Protocolo

| | |
| --- | --- |
| Versões | `2025-03-26` e `2025-06-18` (as duas em circulação), `2025-11-25` e `2024-11-05`. A versão pedida no `initialize` volta igual; uma desconhecida recebe a mais nova |
| HTTP | `POST /mcp` com JSON-RPC (mensagem ou lote) → `application/json`. Só notificações → 202. `GET` e `DELETE` → 405: não há stream nem `Mcp-Session-Id`. `MCP-Protocol-Version` desconhecida → 400 |
| Segurança | Bind só em `127.0.0.1`. Pedido com `Origin`, ou com `Host` que não seja `127.0.0.1:<porta>` ou `localhost:<porta>`, dá 403 ([decisão 0003](../../../../docs/decisoes/0003-responder-sessao.md)) |
| Métodos | `initialize`, `ping`, `tools/list`, `tools/call`. Os outros dão -32601 |
| Resultado | `content` com um texto curto em pt-BR e `structuredContent` com o mesmo dado em JSON, descrito no `outputSchema`. O esquema declara todos os campos (`objeto()` em [output.ts](output.ts): obrigatórios e nada a mais), porque o cliente oficial valida e recusa a chamada com campo sobrando |

**Sem o SDK oficial no servidor.** Servir ferramentas de leitura sem sessão é `initialize`, `ping`, `tools/list` e `tools/call` sobre JSON-RPC; o [protocol.ts](protocol.ts) faz isso em menos de 200 linhas. O SDK traria o `zod` e um transporte com sessão que, no modo stateless, é criado e descartado a cada pedido (era assim no spike `nucleo-teste`), e o núcleo segue sem dependência de execução. O SDK entra só como devDependency, na versão que o Claude Code usa, para o teste de contrato.

## O que as ferramentas devolvem

Comum às duas:

- **`account`** (decisão 0006): o rótulo da conta (sem diferença de caixa) ou o id `<accountUuid>/<organizationUuid>`, um ou vários; `none` pede as sessões "Sem conta". Sem ele, todas. A conta de cada sessão é a mesma do painel (a mesma instância de `Contas`). Na saída, a conta é o rótulo, a cor e a fonte, nunca o id.
- **Paginação por tamanho:** `limit` (padrão 10, máximo 50) e `cursor`. A página para no `limit` ou quando o JSON dos itens passa de 12 kB, o que vier primeiro, e devolve `nextCursor`.
- **Transcript não confiável:** nenhuma ferramenta devolve texto de conversa: prompts, respostas, perguntas, planos, comandos ou mensagens de erro. Sai o título da sessão (limpo de caracteres de controle, até 60 caracteres), nomes de ferramenta que passam por um padrão estrito, a quantidade de opções de uma pergunta e o código de um erro da API (`529 overloaded_error`). O texto lembra o modelo de que títulos são dados, não instruções.

### `sessions_needing_attention`

As sessões que esperam por você, em dois grupos, como o dono pediu. A divisão é a do "precisam de você" do painel: `atencaoDe` em [src/api/atencao.ts](../api/atencao.ts) (#140), usada pelas duas superfícies, para que contem igual.

| `group` | `reason` | Quando |
| --- | --- | --- |
| `blocking` (trava a sessão até você agir) | `permission` | Uma ferramenta pediu permissão (`tool` diz qual) |
| | `question` | `AskUserQuestion` sem resposta, ou diálogo de input (`questionOptions`) |
| | `plan` | `ExitPlanMode` sem resposta: o plano espera aprovação |
| | `decision` | O fechamento do turno no Desktop (`wrap_up`) pediu uma decisão (`ask`) ou disse que trava (`blocked`) |
| | `error` | A sessão parou num erro (`errorCode`) |
| `your_turn` (sua vez no bate-bola) | `turn_ended` | O turno acabou e a vez é sua |
| | `interrupted` | Esc no meio do turno, ou o vigia viu o turno morrer |
| | `first_prompt` | A sessão abriu e espera o primeiro prompt |

Delegando (esperando subagentes) e em background (processo rodando depois do turno) não entram: a vez não é sua de verdade (1.5). Cada item traz `waitingSince` e `waitingMinutes`, a conta, o modelo e `open`: `claude --resume <id>`, a pasta e, quando o Desktop conhece a sessão, o `local_…` dela e `desktopLink` (`claude://claude.ai/epitaxy/<local_…>`), que abre a conversa no Claude Desktop. Travadas primeiro; em cada grupo, quem espera há mais tempo primeiro. Os totais (`total`, `blocking`, `yourTurn`, `byAccount`) contam todos os grupos; `group` filtra só os itens.

### `fleet_overview`

`totals` e `byAccount` com as sessões vivas por estado (`active`, `waiting`, `delegating`, `background`, `error`), as `completed` e `abandoned` de hoje, quantas precisam de você (com a divisão `blocking`/`yourTurn`) e o custo estimado de hoje (1.6), no fuso da máquina. Custo e contagens somam entre contas; limites de uso nunca entram. `activeSessions` lista as vivas, mais recentes primeiro, paginadas. O filtro `account` vale para os totais e para a lista.

## Acrescentar uma ferramenta

O ponto de registro é `ServidorMcp.registrar(ferramenta)`. É por ele que a 2.4 (`wait_for_changes`) entra.

1. Crie `src/mcp/tools/<nome>.ts` com uma função que recebe o que a ferramenta lê e devolve uma `Ferramenta` ([protocol.ts](protocol.ts)): `nome` em `snake_case`, `titulo`, `descricao`, `entrada` e `saida` (JSON Schema, com `esquema()` de [output.ts](output.ts)) e `executar(args, ctx)`, que devolve `{ texto, dados }`.
2. Leia os argumentos com `lerComuns(args, permitidos)` e lance `ErroDeArgumento` para argumento errado: volta como `isError`, para o modelo corrigir.
3. Registre em [src/api/cli.ts](../api/cli.ts), logo depois de `criarServidorMcp`, com `mcp.servidor.registrar(...)`; ou, se ela for padrão em todo núcleo, em `criarServidorMcp` ([index.ts](index.ts)). `criarServidorMcp({ extras })` também aceita uma lista.
4. Declare em `saida` todos os campos que `dados` traz, com `objeto()`, e acrescente as chamadas da ferramenta em `CHAMADAS` de [test/mcp/sdk-contract.test.ts](../../test/mcp/sdk-contract.test.ts): o cliente oficial recusa campo fora do esquema.
5. Ferramenta longa (long polling) ouve `ctx.sinal`: ele aborta quando o cliente fecha a conexão HTTP. A resposta sai no próprio `POST`, sem SSE.

O servidor recusa nome repetido, nome fora do padrão e a 11ª ferramenta. Toda ferramenta sai com `readOnlyHint: true`: ferramenta de escrita fica fora da 0.0.1 (2.5).

## Arquivos

| Arquivo | O quê |
| --- | --- |
| [protocol.ts](protocol.ts) | `ServidorMcp`: JSON-RPC, negociação de versão, registro e chamada de ferramentas |
| [http.ts](http.ts) | A rota `/mcp` que o servidor da API monta |
| [stdio.ts](stdio.ts) | Uma mensagem por linha, e a ponte para o HTTP |
| [cli.ts](cli.ts) | `npm run mcp`: o stdio para o Claude Desktop |
| [fleet.ts](fleet.ts) | O que as ferramentas leem: vivas com estado e conta, encerradas hoje, custo de hoje, e o motivo de cada espera |
| [output.ts](output.ts) | Argumentos comuns, paginação por tamanho e limpeza do texto |
| [tools/](tools/) | Uma ferramenta por arquivo |

Testes em [test/mcp](../../test/mcp/), com fixtures e o cenário do simulador. O [sdk-contract.test.ts](../../test/mcp/sdk-contract.test.ts) liga o cliente oficial (`@modelcontextprotocol/sdk` 1.20.2) por HTTP e por stdio e valida cada saída contra o `outputSchema`; ele pede `npm install` em `packages/nucleo` antes do `npm test`.
