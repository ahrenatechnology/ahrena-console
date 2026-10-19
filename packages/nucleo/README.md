# Núcleo

Modelo de dados do Ahrena Console, a porta de armazenamento e o adaptador SQLite. Item 1.1 do [backlog](../../docs/backlog-0.0.1.md).

TypeScript rodado direto pelo Node 24 (type stripping), sem build e sem dependências. O SQLite é o `node:sqlite` embutido.

## Peças

| Arquivo | O quê |
| --- | --- |
| [src/model.ts](src/model.ts) | Sessão, agente, evento, uso de tokens e preço, com os validadores |
| [src/storage-port.ts](src/storage-port.ts) | A porta: a única coisa de que o resto do núcleo depende |
| [src/pricing.ts](src/pricing.ts) | Preço pelo padrão mais longo e custo estimado, com modificadores e "sem preço" explícito |
| [src/custo/](src/custo/) | Tabela de preços editável, piso da compactação e agregações de custo (item 1.6, seção abaixo) |
| [src/adapters/sqlite/](src/adapters/sqlite/) | Adaptador SQLite e as migrações do esquema |
| [src/ingest/hooks/](src/ingest/hooks/) | Receptor dos hooks do Claude Code e a configuração de hooks do plugin (item 1.4) |
| [test/storage-contract.ts](test/storage-contract.ts) | Contrato da porta. Todo adaptador roda a mesma bateria |
| [src/ingest/historico/](src/ingest/historico/) | Importação do histórico de `~/.claude/projects` (item 1.2) e o seguidor em tempo real (item 1.3) |
| [src/github/](src/github/) | Trabalho do GitHub: hierarquia, PR, CI e review por item, e o kanban de um Project (seção abaixo) |
| [src/simulador/](src/simulador/) | Simulador de sessões, com modo caos (ver abaixo) |
| [src/estados/](src/estados/) | Máquina de estados: transições, vigia, sonda de processo e leitura do inbox (item 1.5) |

## Importação do histórico

`importHistory({ storage })` lê os transcripts JSONL de `~/.claude/projects` e grava sessões, agentes, eventos e uso de tokens pela porta. Entram o arquivo principal (`<sessão>.jsonl`) e os subagentes nos dois layouts: `<sessão>/subagents/agent-<id>.jsonl` (com o `.meta.json`, que dá tipo, descrição e quem lançou) e o antigo `agent-<id>.jsonl` na pasta do projeto. `<sessão>.superseded-<n>.jsonl` é cópia antiga do principal e fica de fora.

- **Ids estáveis:** sessão é o `sessionId`; agente principal `<sessão>:main`; subagente `<sessão>:<agentId>`; evento `jsonl:<uuid da linha>`.
- **Sem contar duas vezes:** o streaming grava a mesma mensagem em várias linhas, com uso parcial e final. O uso é recalculado a partir dos eventos da sessão, deduplicado por `message.id`, ficando a entrada final. Mensagens `<synthetic>` não têm custo. Escrita de cache vai para 5 min ou 1 h pelo `cache_creation`; sem ele, conta como 5 min.
- **Retoma de onde parou:** o cursor de cada arquivo (bytes lidos, tamanho, mtime e os 64 bytes antes do cursor) fica em `metadata.importacao` da sessão ou do subagente e é gravado por último. Arquivo sem mudança não é relido; linha pela metade espera a próxima rodada; arquivo reescrito, menor ou maior, é relido do início (`filesRewound`), e os ids absorvem a repetição.
- **Não decide estado:** sessão nova nasce `completed` com `source: 'import'`. Sessão que já existe (dos hooks) mantém status, espera e `metadata`. A máquina de estados é o item 1.5; o custo, o 1.6.

`importHistory({ storage, files })` importa só os arquivos dados, sem varrer a raiz.

## Seguir em tempo real

`followTranscripts({ storage })` observa `~/.claude/projects` e importa só o que mudou, pelo mesmo importador.

```ts
import { followTranscripts } from '@ahrena-console/nucleo';

const follower = followTranscripts({ storage, onError: console.error });
await follower.start();  // importação completa e, daí em diante, só o que mudar
await follower.sync();   // varre agora, sem esperar o intervalo
await follower.stop();   // espera a rodada em andamento; pode chamar start() de novo
```

- **Dois avisos:** `fs.watch` recursivo dá o arquivo que mudou em poucas centenas de ms (`debounceMs`, padrão 150). A varredura a cada `scanIntervalMs` (padrão 5 s) é a reserva, porque o watch perde avisos no macOS e não existe enquanto a raiz não existe; ela também religa o watch.
- **Custo baixo:** o seguidor guarda tamanho e mtime de cada arquivo em memória e só entrega ao importador o que mudou. Rodada sem mudança faz só `stat`, sem ler arquivo nem consultar o banco: com 300 sessões, poucos ms.
- **Pastas novas:** aviso de uma pasta que ainda não tem transcript conhecido (projeto, sessão, `subagents`) pede uma varredura, para achar o subagente novo mesmo que o arquivo dele não avise.
- **Sem sobreposição:** as rodadas são em fila. Se uma falhar, `onError` recebe o erro e os arquivos dela voltam a ser tentados na próxima.

## Custo e tokens

Item 1.6. Tudo é **estimativa**: não há leitura de fatura, e todo resultado leva `estimate: true` / `estimativa: true`.

- **Tabela de preços:** o padrão fica versionado em [precos-padrao.ts](src/custo/precos-padrao.ts), com a fonte (a página pública de preços da Anthropic) e a data da consulta. O usuário sobrescreve pela porta: `definirPreco(porta, preco)` grava, `restaurarPadrao(porta, pattern?)` apaga a sobrescrita. `tabelaDePrecos(porta)` devolve as linhas com a origem (`padrao` ou `usuario`) e o preço padrão que foi trocado; `precosVigentes(porta)` só os preços. Cada modelo casa pelo id e pelo id com data, sem padrão aberto, para um modelo novo não herdar o preço de outro.
- **Cache:** escrita de 5 min e de 1 h e leitura com preço próprio por modelo; sem preço informado, valem os multiplicadores 1,25x, 2x e 0,1x do input.
- **Modificadores** (em [pricing.ts](src/pricing.ts)): batch 0,5x, `inference_geo = us` 1,1x, fast pelo multiplicador do modelo (Opus 5.5, 5 e 4.8: 2x) e contexto longo do Haiku 5.5 (prompt acima de 100 mil tokens, 5x), todos acumulando. Busca na web a US$ 10 por mil. Web fetch não tem cobrança além dos tokens; execução de código é cobrada por hora de contêiner e fica de fora.
- **Sem preço:** modelo fora da tabela, ou em modo fast sem multiplicador conhecido, aparece como "sem preço" (`costUsd: null`, com o motivo), nunca como zero.
- **Piso depois da compactação:** `aplicarPiso(anterior, vivo)` move para o `baseline` o que a contagem viva perdeu, então `tokens + baseline` nunca diminui. A importação do histórico já grava o uso por ele.
- **Agregações:** `agregarCusto(porta, { desde, ate, fusoHorario, sessionIds })` devolve o total e as linhas por sessão, agente, modelo e dia; `custoDaSessao(porta, id)` é o atalho para uma sessão. A parte de cada agente e dia vem das mensagens do assistente gravadas como eventos, deduplicadas por `message.id`. O que o bucket tem além disso (o piso, uso gravado sem evento) entra sem agente, no dia da última atualização do bucket, para todos os agrupamentos somarem o mesmo total. Linha com parte sem preço soma só o que tem preço e lista em `semPreco` os modelos e tokens que ficaram de fora.

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
| [project.ts](src/github/project.ts) | `GithubProject`: kanban de um GitHub Project por Status e mover um card |

Custo medido no repositório do console: leitura inicial 1 ponto (mais 1 se faltarem pais), filhas de um card 2, detalhe 1. As consultas são sempre em série. TTLs: lista 5 min com delta a cada 60 s, filhas 10 min, PR e CI do card aberto 60 s.

Nível: `Initiative` → iniciativa, `Epic` → épico, `User Story`, `Tech Task`, `Spike`, `Bug` → item, `Plan` → plano. Sem tipo, fica um nível abaixo do pai. Etapa do item: `a fazer`, `em andamento` (PR rascunho), `ci rodando`, `ci falhou`, `ajustes pedidos`, `em revisão`, `mergeado`, `concluída`.

Os testes usam respostas reais gravadas em `test/github/fixtures/respostas.json`. Para regravar (cerca de 4 chamadas, com pausa):

```bash
node test/github/gravar-fixtures.ts > test/github/fixtures/respostas.json
```

### Kanban de um Project

Item 5.3: os itens de um GitHub Project v2 em raias pelo campo Status, na ordem das opções do Project, e mover um card muda o Status no GitHub. O Project é configurável (dono e número, como na URL `.../orgs/dono/projects/3`); o deste repositório é o Project 3 da organização `ahrenatechnology`.

```ts
import { createGithubProject, GithubCache, SqliteCacheStore } from '@ahrena-console/nucleo';

const kanban = createGithubProject({
  project: { owner: 'ahrenatechnology', number: 3 }, // `field: 'Status'` é o padrão
  cache: new GithubCache({ store: new SqliteCacheStore(storage.db) }),
});
const board = await kanban.board();           // raias com os cards; TTL de 2 min
await kanban.board({ force: true });          // botão de atualizar (mínimo de 30 s)
await kanban.move(card.itemId, lane.id);      // mutação; devolve o quadro já atualizado
```

Pela decisão 0001: a leitura usa `fieldValueByName(name: "Status")`, 100 itens por página, e custa 1 ponto; mover é uma mutação (`updateProjectV2ItemFieldValue`) que devolve o item, e o cache é atualizado com ela, sem reler o Project. Itens sem Status ficam numa raia "Sem status", a primeira, como no GitHub; itens arquivados ficam de fora.

Ler e mover pedem o escopo `project` no token do `gh`. Sem ele, `move` e `board` lançam `ProjectPermissionError`, com a instrução `gh auth refresh -s project`. Quando o GitHub limita, a mutação pausa as chamadas como as leituras, e o quadro continua saindo do cache.

Os testes usam a leitura real do Project 3 gravada em `test/github/fixtures/project.json` (uma chamada, sem mutação). Para regravar:

```bash
node test/github/gravar-project.ts > test/github/fixtures/project.json
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
