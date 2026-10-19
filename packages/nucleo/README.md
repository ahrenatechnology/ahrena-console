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
| [src/ingest/historico/](src/ingest/historico/) | Importação do histórico de `~/.claude/projects` (item 1.2) |

## Importação do histórico

`importHistory({ storage })` lê os transcripts JSONL de `~/.claude/projects` e grava sessões, agentes, eventos e uso de tokens pela porta. Entram o arquivo principal (`<sessão>.jsonl`) e os subagentes nos dois layouts: `<sessão>/subagents/agent-<id>.jsonl` (com o `.meta.json`, que dá tipo, descrição e quem lançou) e o antigo `agent-<id>.jsonl` na pasta do projeto. `<sessão>.superseded-<n>.jsonl` é cópia antiga do principal e fica de fora.

- **Ids estáveis:** sessão é o `sessionId`; agente principal `<sessão>:main`; subagente `<sessão>:<agentId>`; evento `jsonl:<uuid da linha>`.
- **Sem contar duas vezes:** o streaming grava a mesma mensagem em várias linhas, com uso parcial e final. O uso é recalculado a partir dos eventos da sessão, deduplicado por `message.id`, ficando a entrada final. Mensagens `<synthetic>` não têm custo. Escrita de cache vai para 5 min ou 1 h pelo `cache_creation`; sem ele, conta como 5 min.
- **Retoma de onde parou:** o cursor de cada arquivo (bytes lidos, tamanho, mtime) fica em `metadata.importacao` da sessão ou do subagente e é gravado por último. Arquivo sem mudança não é relido; linha pela metade espera a próxima rodada; arquivo reescrito menor é relido do início, e os ids absorvem a repetição.
- **Não decide estado:** sessão nova nasce `completed` com `source: 'import'`. Sessão que já existe (dos hooks) mantém status, espera e `metadata`. Seguir em tempo real é o item 1.3; a máquina de estados, o 1.5; o custo, o 1.6.

## Estados

A sessão persiste `active`, `completed`, `error` ou `abandoned`. `waiting` não é gravado: é uma camada sobre `awaitingInputSince`, com o motivo em `awaitingReason` (`notification`, `interrupted`, `stop`, `session_start`). `displayStatus()` devolve o que a interface mostra. As transições ficam para a máquina de estados (item 1.5).

## Migrações

Cada mudança de esquema é uma migração nova no fim de `MIGRATIONS`. A versão aplicada fica em `PRAGMA user_version`; cada migração roda na própria transação e, se falhar, o banco fica na versão anterior.

## Testes

```bash
npm test
```
