# Núcleo

Modelo de dados do Ahrena Console, a porta de armazenamento e o adaptador SQLite. Item 1.1 do [backlog](../../docs/backlog-0.0.1.md).

TypeScript rodado direto pelo Node 24 (type stripping), sem build e sem dependências. O SQLite é o `node:sqlite` embutido.

## Peças

| Arquivo | O quê |
| --- | --- |
| [src/model.ts](src/model.ts) | Sessão, agente, evento, uso de tokens e preço, com os validadores |
| [src/storage-port.ts](src/storage-port.ts) | A porta: a única coisa de que o resto do núcleo depende |
| [src/pricing.ts](src/pricing.ts) | Preço pelo padrão mais longo e custo estimado, com "sem preço" explícito |
| [src/adapters/sqlite/](src/adapters/sqlite/) | Adaptador SQLite e as migrações do esquema |
| [test/storage-contract.ts](test/storage-contract.ts) | Contrato da porta. Todo adaptador roda a mesma bateria |
| [src/github/](src/github/) | Trabalho do GitHub: hierarquia, PR, CI e review por item (seção abaixo) |

## Estados

A sessão persiste `active`, `completed`, `error` ou `abandoned`. `waiting` não é gravado: é uma camada sobre `awaitingInputSince`, com o motivo em `awaitingReason` (`notification`, `interrupted`, `stop`, `session_start`). `displayStatus()` devolve o que a interface mostra. As transições ficam para a máquina de estados (item 1.5).

## Migrações

Cada mudança de esquema é uma migração nova no fim de `MIGRATIONS`. A versão aplicada fica em `PRAGMA user_version`; cada migração roda na própria transação e, se falhar, o banco fica na versão anterior.

## Trabalho do GitHub

Item 5.2: a árvore iniciativa → épico → item → plano, com o tipo de issue, o progresso das sub-issues e, por card aberto, os PRs vinculados com CI e review. Segue a [decisão 0001](../../docs/decisoes/0001-github-consulta-cache.md): nada de consulta aninhada.

```ts
import { createGithubWork, SqliteCacheStore } from '@ahrena-console/nucleo';

const work = createGithubWork({
  filter: 'repo:dono/repo is:issue is:open',
  store: new SqliteCacheStore(storage.db), // sem isto, cache em memória
});
const tree = await work.tree();        // leitura rasa + delta a cada 60 s
const card = await work.expand(key);   // filhas, PR, CI e review deste card
await work.tree({ force: true });      // botão de atualizar (mínimo de 30 s)
await work.patchNode(key, (n) => ({ ...n, title })); // escrita do console, sem reler
```

| Arquivo | O quê |
| --- | --- |
| [work.ts](src/github/work.ts) | Nó, detalhe (PR, CI, review), nível pelo tipo de issue e etapa do item |
| [tree.ts](src/github/tree.ts) | Montagem da árvore a partir da chave do pai, mescla pelo `updatedAt` e filtro do delta |
| [source.ts](src/github/source.ts) | Porta da fonte: `listShallow`, `nodes`, `children`, `detail` |
| [github-source.ts](src/github/github-source.ts) | Adaptador GraphQL, com o token do `gh` |
| [cache.ts](src/github/cache.ts) | Cache com TTL, leitura velha até 24 h, uma chamada por chave, pausa no limite e `patch` |
| [sqlite-cache.ts](src/github/sqlite-cache.ts) | Cache na tabela `github_cache` do banco do núcleo |
| [work-service.ts](src/github/work-service.ts) | `GithubWork`: o que o painel e o MCP usam |

Custo medido no repositório do console: leitura inicial 1 ponto (mais 1 se faltarem pais), filhas de um card 2, detalhe 1. As consultas são sempre em série. TTLs: lista 5 min com delta a cada 60 s, filhas 10 min, PR e CI do card aberto 60 s.

Nível: `Initiative` → iniciativa, `Epic` → épico, `User Story`, `Tech Task`, `Spike`, `Bug` → item, `Plan` → plano. Sem tipo, fica um nível abaixo do pai. Etapa do item: `a fazer`, `em andamento` (PR rascunho), `ci rodando`, `ci falhou`, `ajustes pedidos`, `em revisão`, `mergeado`, `concluída`.

Os testes usam respostas reais gravadas em `test/github/fixtures/respostas.json`. Para regravar (cerca de 4 chamadas, com pausa):

```bash
node test/github/gravar-fixtures.ts > test/github/fixtures/respostas.json
```

## Testes

```bash
npm test
```
