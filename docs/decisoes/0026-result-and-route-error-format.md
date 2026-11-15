# 0026 · `Result` para falha esperada e formato de erro das rotas

- **Status:** aceita (as escolhas de princípio foram do dono do produto; o formato concreto foi derivado do código em 2026-11-14 e fica **a confirmar na revisão** desta issue)
- **Data:** 2026-11-14
- **Issue:** [#657](https://github.com/ahrenatechnology/ahrena-console/issues/657), tarefa técnica do [#656](https://github.com/ahrenatechnology/ahrena-console/issues/656)
- **Condições do framework:** ERR-1, ERR-3 (primeiro comentário de [ahrena-framework#323](https://github.com/ahrenatechnology/ahrena-framework/issues/323)); STR-4, CON-1 e PER-1 nos registros ao lado
- **Toca:** [0009](0009-english-internals.md) (chaves e códigos em inglês; texto de tela em pt-BR)
- **Registros que nascem junto:** [docs/architecture/](../architecture/README.md): mapa de camadas, registro de estratégias e registro de modos das tabelas

## Contexto

O núcleo mistura exceção e valor de retorno para dizer que algo deu errado, e as rotas respondem erro de mais de um jeito. Não existe um tipo `Result` compartilhado. Medido em 2026-11-14 com `grep` sobre `packages/*/src` (sem testes):

**Falha esperada no código (o que vira `Result`)**

| Medida | Valor |
| --- | --- |
| Arquivos com uniões `ok: true` / `ok: false` / `ok: boolean` | 22 |
| Desses, arquivos com um literal `{ ok: false … }` | 10 |
| Discriminante usado nesses 10 arquivos | `ok`, em todos |
| Campos que acompanham `ok: false` (ocorrências em literais; arquivos) | `param` 21 (2), `error` 7 (2), `reason` 7 (2), `why` 6 (2), `message` 5 (1), `line` 5 (1), `retryAfterMs` 2 (1), sem campo 4 (1) |
| Outro formato de recusa: campo `refusal` com código | 5 arquivos (`messaging/orders.ts`, `messaging/service.ts`, `framework-install/plan.ts`, `ports/release.ts`, `api/work-issue-write.ts`) |
| `throw new` em `packages/nucleo/src` | 377, em 93 arquivos (421 em 99 com `vendor/`, o parser de terceiros) |
| Classes `extends Error` | 49 |

A contagem é por expressão regular (`grep -rE 'throw new'` e `grep -rE 'extends Error'` sobre os `.ts` de `packages/nucleo/src`; não há teste em `src/`; `vendor/` entra só na segunda cifra do `throw new`) e serve de ordem de grandeza: o "cerca de 35 arquivos" do pedido não se confirmou, são 22 (10 com a falha escrita como literal). Os mais densos são `api/work-issue-steps.ts`, `api/work-issue-write.ts`, `messaging/model.ts`, `history/model.ts` e `diagnosis/`.

**Corpo de erro das rotas**

| Medida | Valor |
| --- | --- |
| `send(res, status, { error … })` | 417 corpos, em 47 arquivos |
| Desses, com `reason` além de `error` | 64 |
| Só com `reason` | 5 |
| `error` com texto pt-BR para a pessoa | maioria (ex.: `messaging.ts`) |
| `error` com código em inglês (`'not-found'`, `'conflict'`) | pelo menos 56 dos 335 literais simples (ex.: `work-issue-write.ts`) |
| Corpo com `stack` | 0 |
| Corpo com `err.message` / `e.message` / `error.message` | 11 corpos literais `{ error: <x>.message … }`, todos de classes de erro do próprio projeto (texto fixo nosso, não de fornecedor), mais 2 montados no mapa de `api/project.ts` (linhas 177 e 178). Uma exceção à regra: `api/analytics-route.ts:562` põe a mensagem de qualquer erro capturado de `sources.projects()` em `projectsError`, e isso pode ser texto de upstream; fica para a issue de migração (ERR-3) |
| Falha inesperada | `api/server.ts` responde 500 com `{ error: 'erro interno' }` e registra só uma frase fixa, sem URL, cabeçalho nem texto da exceção |

## Decisão

Princípios, do dono do produto:

1. **`Result` no lugar de exceção para falha esperada** (entrada inválida, recusa de regra, recurso ausente, limite). **`throw` só para invariante quebrada** (erro de programador): algo que o código chamador não pode tratar (ERR-1).
2. **Rota nunca devolve stack nem erro cru de fornecedor ou de upstream à pessoa.** O detalhe vai para o log do núcleo; a resposta leva uma mensagem nossa e, quando útil, um código estável (ERR-3).
3. **Uma estratégia por problema, mantida depois de escolhida.** O registro [strategies.json](../architecture/strategies.json) tem uma linha por problema; trocar uma estratégia exige um registro de decisão novo (CON-1).
4. **Persistência append-only de preferência; quando não der, upsert com o histórico guardado perto da entidade** (PER-1). O modo de cada tabela está em [table-modes.json](../architecture/table-modes.json).
5. **Toda escrita roda em transação, com commit ou rollback.** Hoje isso é `immediateTransaction` (`adapters/sqlite/immediate-transaction.ts`).

Formato, derivado do que o código já faz:

- **`Result`:** união discriminada por `ok`.

  ```ts
  type Result<T, D extends { reason: string } = { reason: string }> =
    | ({ ok: true } & T)
    | ({ ok: false } & D);
  ```

  Na prática, cada função escreve a sua união, como hoje: `{ ok: true, ...valor } | { ok: false, reason: '<english_code>', ...detalhe }`. `reason` é um código estável em inglês, `snake_case` ou `kebab-case` como o código vizinho já usa, nunca texto para a tela. O detalhe extra é permitido quando a falha precisa dele (`param` na validação de entrada, `retryAfterMs` no limite de taxa).
- **Erro de rota:** `send(res, status, { error, reason?, ...detalhe })`. `error` é o texto que a pessoa lê (pt-BR, é tela) ou, onde a rota já responde por código, um código estável; `reason` é o código em inglês quando a tela precisa ramificar. Nunca `stack`, nunca o texto ou o corpo de uma resposta de fornecedor, nunca um objeto de erro inteiro. O status HTTP diz a classe da falha.
- **Implementação de referência:** `Result` em `packages/nucleo/src/messaging/ports.ts` (`DeliveryResult = { ok: true } | { ok: false; reason: DeliveryFailure }`), produzido por `packages/nucleo/src/messaging/adapters/socket-inbox.ts`. Exemplos legados, que não têm o formato decidido: `api/work-issue-steps.ts` (`{ ok: false; param }`) e `messaging/model.ts` (`{ ok: false }` sem campo, `retryAfterMs`). Erro de rota em `packages/nucleo/src/api/messaging.ts` (mapa `ERRORS` mais `reason`) e o 500 genérico de `api/server.ts`.
- **Tipo compartilhado:** não se cria agora. O formato cabe numa linha, são 10 arquivos e cada um já declara o seu; um módulo `Result` sem segundo consumidor real seria abstração antecipada (`rules/yagni.md`). A issue de migração decide se ele nasce quando houver consumidores.

### Por que `reason` e `ok`

`ok` é o discriminante de todos os 10 arquivos com literal. Para o campo da falha o código está dividido (`param`, `error`, `reason`, `why` empatam em arquivos); escolhi `reason` porque é o nome que as rotas já levam ao cliente (64 corpos com `error` + `reason`) e porque `error` já é, no corpo da rota, o texto da pessoa. `param` fica como detalhe da validação, não como código da falha.

## Alternativas rejeitadas

- **Lançar erros de domínio** (`throw new WorkIssueNotFoundError`) como forma geral: já existe (377 `throw new` em 93 arquivos, 49 classes) e é o que o ERR-1 quer tirar do caminho de falha esperada; obriga o chamador a conhecer a classe e a lembrar do `try/catch`. Fica para a invariante quebrada.
- **Uma biblioteca de `Result`** (neverthrow, ts-results, Effect): os pacotes não têm dependência de execução hoje, só o SDK do MCP em desenvolvimento; a união de uma linha já resolve e não acrescenta um segundo jeito de escrever.
- **Os nomes minoritários** `why`, `error` ou `message` no lugar de `reason`: `why` aparece em 2 arquivos (`diagnosis/adapters/system.ts` e `common.ts`), `error` colide com o texto da pessoa no corpo da rota, `message` convida a pôr texto de exceção no valor.
- **`Result` com `kind` ou `status` no lugar de `ok`:** nenhum arquivo usa; o discriminante `ok` já é unânime.
- **Corpo de erro no formato RFC 9457** (`type`, `title`, `detail`): mudaria 417 corpos e o `/ui` que os lê, sem um problema que o formato atual não resolva.

## Catraca

Vale para **código novo**. O legado não bloqueia: os formatos `param`, `error`, `why`, `refusal` e as exceções de falha esperada que existem hoje continuam como estão, e os 11 corpos que enviam `err.message`, `e.message` ou `error.message` de erro do próprio projeto também (o texto é nosso e fixo). **Migrar o código antigo para o `Result` é uma issue à parte**, depois do check, como diz o #657. As tabelas `upsert` sem histórico estão marcadas `legacy: true` no registro de modos pelo mesmo motivo.

## Consequências

- Quem escreve uma função com falha esperada devolve a união acima; quem escreve uma rota responde `{ error, reason? }` e põe o detalhe no log.
- O mapa de camadas, o registro de estratégias e o registro de modos têm teste na raiz (`test/architecture-layers.test.mjs`, `test/architecture-registers.test.mjs`): pasta nova sem entrada no mapa, `CREATE TABLE` novo sem modo, ou entrada velha que aponta para o que sumiu, quebram o `node --test 'test/*.test.mjs'`.
- A regra "um teste por rota que força falha inesperada e confere o corpo sem stack" (ERR-3) e a de "0 `throw` em linha nova fora do helper de invariante" (ERR-1) ainda não têm verificação automática; entram quando a issue de migração e a de checagem chegarem.
