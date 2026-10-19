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
| [src/ingest/hooks/](src/ingest/hooks/) | Receptor dos hooks do Claude Code e a configuração de hooks do plugin (item 1.4) |
| [test/storage-contract.ts](test/storage-contract.ts) | Contrato da porta. Todo adaptador roda a mesma bateria |
| [src/ingest/historico/](src/ingest/historico/) | Importação do histórico de `~/.claude/projects` (item 1.2) |
| [src/github/](src/github/) | Trabalho do GitHub: hierarquia, PR, CI e review por item (seção abaixo) |
| [src/simulador/](src/simulador/) | Simulador de sessões, com modo caos (ver abaixo) |
| [src/estados/](src/estados/) | Máquina de estados: transições, vigia, sonda de processo e leitura do inbox (item 1.5) |

## Importação do histórico

`importHistory({ storage })` lê os transcripts JSONL de `~/.claude/projects` e grava sessões, agentes, eventos e uso de tokens pela porta. Entram o arquivo principal (`<sessão>.jsonl`) e os subagentes nos dois layouts: `<sessão>/subagents/agent-<id>.jsonl` (com o `.meta.json`, que dá tipo, descrição e quem lançou) e o antigo `agent-<id>.jsonl` na pasta do projeto. `<sessão>.superseded-<n>.jsonl` é cópia antiga do principal e fica de fora.

- **Ids estáveis:** sessão é o `sessionId`; agente principal `<sessão>:main`; subagente `<sessão>:<agentId>`; evento `jsonl:<uuid da linha>`.
- **Sem contar duas vezes:** o streaming grava a mesma mensagem em várias linhas, com uso parcial e final. O uso é recalculado a partir dos eventos da sessão, deduplicado por `message.id`, ficando a entrada final. Mensagens `<synthetic>` não têm custo. Escrita de cache vai para 5 min ou 1 h pelo `cache_creation`; sem ele, conta como 5 min.
- **Retoma de onde parou:** o cursor de cada arquivo (bytes lidos, tamanho, mtime) fica em `metadata.importacao` da sessão ou do subagente e é gravado por último. Arquivo sem mudança não é relido; linha pela metade espera a próxima rodada; arquivo reescrito menor é relido do início, e os ids absorvem a repetição.
- **Não decide estado:** sessão nova nasce `completed` com `source: 'import'`. Sessão que já existe (dos hooks) mantém status, espera e `metadata`. Seguir em tempo real é o item 1.3; a máquina de estados, o 1.5; o custo, o 1.6.

## Estados

A sessão persiste `active`, `completed`, `error` ou `abandoned`. `waiting` não é gravado: é uma camada sobre `awaitingInputSince`, com o motivo em `awaitingReason` (`notification`, `interrupted`, `stop`, `session_start`). `displayStatus()` devolve o que a interface mostra. As transições são da máquina de estados, em [src/estados/](src/estados/README.md), que também dá ao inbox os estados "delegando" e "esperando processo em background".

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

## Simulador

Gera sessões, agentes e subagentes, eventos e uso de tokens plausíveis e grava pela porta, para testar e demonstrar o painel e o artefato sem dados reais. Item 6.4 do backlog.

```bash
npm run simular                            # 12 sessões das últimas 6 h, de uma vez, em simulacao.sqlite
npm run simular -- --caos --seed 42        # com falhas, reproduzível
npm run simular -- --caos --tempo-real --velocidade 60 --precos
npm run simular -- --help
```

| Opção | O quê |
| --- | --- |
| `--banco <arquivo>` | Banco SQLite de destino. Padrão `simulacao.sqlite` (ignorado pelo git) |
| `--seed <semente>` | A mesma semente com as mesmas opções grava os mesmos dados. Sem ela, uma é sorteada e exibida |
| `--sessoes <n>` | Número de sessões. Padrão 12 |
| `--duracao <min>` | Janela simulada. Padrão 360; o abandono precisa de pelo menos ~240 |
| `--caos` | Liga o modo caos |
| `--intensidade <0..1>` | Fração extra de sessões com caos, além de uma de cada tipo. Padrão 0.4 |
| `--tempo-real` | Grava cada operação na hora dela, em vez de tudo de uma vez. Ctrl+C para; o que foi gravado fica |
| `--velocidade <x>` | Em tempo real, minutos simulados por minuto de relógio. Padrão 30 |
| `--precos` | Grava preços **ilustrativos** para os modelos simulados que ainda não têm preço, para o custo aparecer |

**Lote** grava a janela inteira terminando agora: as sessões já aconteceram e as que começaram tarde ficam em andamento. **Tempo real** começa agora e corre `velocidade` vezes mais rápido; as datas gravadas acompanham o relógio.

O **modo caos** garante pelo menos uma sessão de cada falha:

| Roteiro | O que fica gravado |
| --- | --- |
| `travada` | `active` esperando input (`notification` com pedido de permissão, ou `interrupted`), e nada mais acontece |
| `erro` | `PostToolUseFailure` e a sessão em `error` |
| `abandono` | Para no meio de um comando e, 180 min depois, a sessão é gravada como `abandoned` |
| `estouro` | Dois picos de tokens que estouram o contexto de 200k; cada um gera `PreCompact` e move o uso para o piso (`baseline`) |
| `enxame` | De 8 a 14 subagentes em paralelo no mesmo turno |

Os estados são gravados como dados; as transições continuam sendo da máquina de estados (item 1.5).

Tudo é sintético: projetos inventados sob `/simulacao/`, nenhum nome de pessoa nem caminho real. Todo registro leva `metadata.simulado = true`, a sessão leva o `roteiro` e o medidor de contexto (`metadata.contexto`), e os ids começam por `sim-<hash da semente>`, então rodar a mesma semente de novo no mesmo banco sobrescreve em vez de duplicar.

Pelo código:

```ts
import { simular } from '@ahrena-console/nucleo/simulador';

const resumo = await simular(porta, { semente: 42, caos: true, modo: 'lote' });
```

`gerarCenario()` devolve só o roteiro, sem gravar; `agora` e `esperar` são injetáveis para testes.

## Testes

```bash
npm test
```
