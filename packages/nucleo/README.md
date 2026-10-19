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
| [src/simulador/](src/simulador/) | Simulador de sessões, com modo caos (ver abaixo) |

## Estados

A sessão persiste `active`, `completed`, `error` ou `abandoned`. `waiting` não é gravado: é uma camada sobre `awaitingInputSince`, com o motivo em `awaitingReason` (`notification`, `interrupted`, `stop`, `session_start`). `displayStatus()` devolve o que a interface mostra. As transições ficam para a máquina de estados (item 1.5).

## Migrações

Cada mudança de esquema é uma migração nova no fim de `MIGRATIONS`. A versão aplicada fica em `PRAGMA user_version`; cada migração roda na própria transação e, se falhar, o banco fica na versão anterior.

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
