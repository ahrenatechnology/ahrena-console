# 0027 · O Workboard na nuvem: o hub espelha o GitHub e trava a issue de quem a puxou

- **Status:** proposta (rascunho de 2026-11-17; três perguntas em aberto no fim, que são do dono do produto)
- **Data:** 2026-11-17
- **Issue:** a abrir, depois das respostas
- **Estende:** [0002](0002-hub-aws.md) (o Workboard é a primeira feature do hub; vale o mesmo desenho serverless, o mesmo GitHub App e a regra "a máquina envia, o hub nunca busca")
- **Toca:** [0001](0001-github-consulta-cache.md) e [0015](0015-github-background-sync.md) (com o hub ligado, o núcleo deixa de ler o GitHub para o quadro), #477 (a fila de execução sai da instalação e vai para o time)

## Contexto

O Workboard (#465, #466, #477, #531, #609) roda inteiro no núcleo local, em `packages/nucleo/src/github/work-*.ts`:

| Peça | Onde está hoje | Escopo |
| --- | --- | --- |
| Issues, PRs, CI e reviews | Lidos dos Projects do GitHub com o token **da pessoa**, guardados no SQLite (0001, 0015) | Cada máquina lê a sua cópia |
| Fila de execução (`WorkQueueStore`) | SQLite, `work-queue-store.ts` | **Uma por instalação** |
| Planejamento e execução (`work-plan-runs`, `work-execution-runs`) | SQLite | Por instalação |
| Sessões ligadas ao cartão | Leitura ao vivo das sessões locais | Por máquina |

Isso basta para uma pessoa. Para um time não basta, porque **nada impede duas máquinas de puxar a mesma issue**: a fila de um AI Coordinator não enxerga a do outro, e o GitHub só fica sabendo quando um PR aparece. Além disso, cada pessoa gasta o próprio limite do GitHub para montar o mesmo quadro.

O objetivo é o modelo de um gerenciador de tarefas como o Linear: o backlog sincronizado com o GitHub, e uma issue puxada fica **travada para o time** enquanto o agente na máquina do AI Coordinator trabalha nela. O console continua existindo e funcionando local; o que vai para a nuvem é o back-end do Workboard, tudo o que fala direto com o GitHub.

## Decisão

**O Workboard ganha um back-end no hub da 0002: o hub espelha o GitHub por um GitHub App (webhooks e reconciliação), guarda a fila do time e é o único dono da trava de cada issue, uma trava com prazo que o núcleo do AI Coordinator renova enquanto a sessão vive. O núcleo local troca os adaptadores do quadro pelos do hub e continua dono das sessões e da execução. Sem hub configurado, o console funciona como hoje.**

### 1. O que vai para a nuvem e o que fica

| Hub (nuvem) | Núcleo (máquina) |
| --- | --- |
| Espelho das issues, PRs, checks e reviews dos Projects do time | Sessões do Claude Code e tudo o que está nelas |
| Fila do time e a ordem dela | O executor: abre a sessão local ou por SSH (#531) e o puller da fila (#477 L2) |
| **A trava** de cada issue: quem, de qual máquina, até quando | A renovação da trava, enquanto a sessão vive |
| A escrita de volta no GitHub (responsável e status no Project) | O cache do que o hub mandou, para ler sem rede |
| O cursor de mudanças (0002, "tempo real barato") | A tela do console, que passa a ler do hub pelo cache |

O núcleo já fala com o quadro por portas (`WorkProjectBoard`, `WorkQueueStore`, `WorkSessions`). A troca é de adaptador: `WorkProjectBoard` e `WorkQueueStore` ganham uma implementação que lê e escreve no hub; `WorkSessions` continua local. A regra do quadro (`columnOfIssue`, `buildWorkBoard`) não muda de lugar: é pura, e roda no núcleo sobre o que o hub mandou mais as sessões locais.

### 2. Sincronizar com o GitHub

- **GitHub App instalado na organização**, o mesmo da 0002. O hub lê com o token de instalação, uma vez para o time, e não com o token de cada pessoa. Permissões: `issues` (leitura e escrita), `pull_requests` e `checks` (leitura), `organization_projects` (leitura e escrita), `metadata`.
- **Webhooks** `issues`, `issue_comment` (só para o contador de rodadas de review, se for preciso), `pull_request`, `pull_request_review`, `check_suite`, `projects_v2_item`. Uma Lambda confere `X-Hub-Signature-256`, descarta repetidos por `X-GitHub-Delivery` e põe o evento numa fila SQS; outra Lambda aplica no DynamoDB e sobe o cursor. A SQS segura rajada e reentrega.
- **Reconciliação** por EventBridge Scheduler a cada 15 min: lê os itens do Project por `updatedAt` desde a última passada e corrige o que um webhook perdido deixou para trás. O webhook é o caminho rápido; a reconciliação é a garantia.
- **O que é guardado é só o que o quadro mostra**: número, título, estado, tipo, pai, campos do Project, PR ligado, estado do CI e da review. Corpo de issue e comentários não vão para o hub.

### 3. A trava

A trava é o centro desta decisão. Ela vive no hub, e só o hub escreve nela.

- **Pegar** (`POST /v1/work/items/{key}/claim`) é uma gravação condicional no DynamoDB: passa só se não há trava ou se a que existe venceu. Dois núcleos que pedem ao mesmo tempo recebem um sim e um `409 claimed`, com quem está travando.
- **A trava guarda** pessoa (do token), máquina (do token), a sessão quando ela aparecer, `claimedAt`, `expiresAt` e uma versão. Toda renovação e toda liberação mandam a versão; uma versão velha é recusada. Assim um núcleo que voltou de uma queda não derruba a trava que outro pegou depois.
- **Renovar.** O núcleo renova a cada 60 s enquanto a execução está iniciando (a janela de 10 min de `EXECUTION_SESSION_WINDOW_MS`) ou a sessão ligada está viva. A trava vence 5 min depois da última renovação. A renovação leva só o estado da sessão (`working`, `needs-you`, `idle`), para o time ver o cartão se mexer; nenhum texto da conversa.
- **Liberar.** A trava termina quando:
  - o PR ligado é mergeado ou a issue é fechada (webhook): fim normal, o cartão vai para Concluído;
  - a pessoa solta no console;
  - ela vence: a issue volta ao **topo** da fila, parada, com o motivo "trava vencida", como o `markFailed` da #477 faz hoje com uma execução que não subiu;
  - um `admin` do time força a liberação, e isso fica no log de admin da 0002.
- **No GitHub**, a trava aparece como **responsável** (a pessoa) e o status **Em execução** no Project, escritos pelo hub com o token de instalação. Ao liberar, o hub tira o responsável que ele mesmo pôs. Quem está fora do console vê que a issue está tomada.
- **Puxar da fila são duas raízes.** A fila do time e a issue são agregados diferentes; pegar é a operação que manda. O hub grava a trava e emite `WorkItemClaimed`; a saída da fila acontece em seguida, pelo evento, e não na mesma transação.

### 4. O núcleo local

- **Configuração.** O hub é opcional. Com `ahrena-console hub login` (0002) feito e o Workboard ligado no time, o núcleo usa os adaptadores do hub; sem isso, usa os de hoje, e o quadro funciona como funciona agora, sem trava de time.
- **Mudanças** chegam pelo cursor da 0002: o núcleo lê o cursor a cada 10 s e baixa o delta quando ele muda; a tela continua lendo do núcleo, com long polling.
- **Sem rede**, o quadro mostra a última cópia, marcada como velha (o `stale` da 0001), e pegar, soltar e reordenar ficam desligados. A trava que este núcleo segura não é renovada e vence no hub; ao voltar, se ela ainda é dele (mesma versão), ele renova; se não é, a tela avisa e a sessão continua, mas o cartão mostra que outra pessoa pegou a issue.
- **O núcleo para de ler os Projects do GitHub para o quadro** quando o hub está ligado. As outras leituras do GitHub (Decisões, PRs da sessão) continuam como estão.

### 5. Itens novos no DynamoDB

Na tabela única da 0002, sob `T#<team>`, que sai do token:

| Item | PK | SK | Atributos principais |
| --- | --- | --- | --- |
| Item de trabalho | `T#<team>#W#<owner/repo#n>` | `META` | campos do quadro, `updatedAt`, `version` |
| Trava | `T#<team>#W#<owner/repo#n>` | `CLAIM` | pessoa, máquina, sessão, `claimedAt`, `expiresAt`, `version`, estado da sessão |
| Entrada da fila | `T#<team>#Q#<projectId>` | `<posição>#<key>` | alvo da execução, `enqueuedAt`, `failedReason` |
| Entrega de webhook | `T#<team>#GH` | `D#<deliveryId>` | recebida em (TTL 3 dias, para descartar repetidas) |

GSI1 da 0002 ganha os itens de trabalho (`<updatedAt>#W#<key>`), para o delta por cursor. As travas vencidas são encontradas por um job de 1 min que lê só as travas ativas do time (poucas por definição) e libera as de `expiresAt` passado; o TTL do DynamoDB não serve aqui porque apaga com até 48 h de atraso.

### 6. Quem pode o quê

| Ação | Quem |
| --- | --- |
| Ver o quadro do time | Todo `member` |
| Pôr na fila, reordenar, tirar | `member` |
| Pegar uma issue | `member`, por uma máquina com token válido |
| Renovar e soltar | Só a máquina que segura a trava (máquina do token e versão) |
| Forçar a liberação | `admin` |

## Fases

1. **Spike:** GitHub App de teste numa org, webhook entrando, reconciliação de um Project, medida de custo.
2. **Quadro no hub, só leitura:** o espelho e o cursor; o núcleo lê o quadro do hub.
3. **A trava:** pegar, renovar, soltar, vencer, e a escrita de responsável e status no GitHub.
4. **A fila do time:** a fila da #477 migra para o hub; o puller local passa a puxar dela.

Cada fase vira uma issue e passa pela Athena.

## Alternativas consideradas

| Alternativa | Por que não |
| --- | --- |
| **Trava só no GitHub** (o responsável ou uma etiqueta como trava) | Não há gravação condicional: dois agentes que leem "sem responsável" ao mesmo tempo se atribuem os dois. Não há prazo, então uma máquina que caiu segura a issue para sempre |
| **Cada núcleo lendo o GitHub e combinando entre si** | Contraria "o hub nunca chama a máquina" e a máquina não fala com outra máquina. E multiplica o uso do limite do GitHub por pessoa |
| **Trava sem prazo, solta à mão** | O caso comum de falha (notebook fechado, túnel caído) deixaria issues presas até alguém lembrar |
| **Levar a execução para a nuvem também** | A execução depende do Claude Code e das credenciais da máquina do AI Coordinator. Fica fora desta decisão |

## Consequências

- O Workboard passa a ter dois modos, local e de time, com os mesmos testes de contrato das portas rodando nos dois adaptadores, como a 0002 pede para o armazenamento.
- O hub da 0002 sai do papel por esta feature, e não pela telemetria de sessões. O primeiro deploy precisa só da parte de auth, do cursor e do Workboard.
- O GitHub App vira requisito do modo time; instalar na org precisa de um `owner` da org.
- A escrita no Project muda o que as pessoas veem no GitHub: o hub passa a mexer em responsável e status.

## Perguntas em aberto

1. **Onde o hub mora?** A 0002 diz que cada time sobe o hub na própria conta AWS, porque o projeto é open source. Levar o Workboard para a nuvem pode querer dizer, em vez disso, um serviço da Ahrena com vários clientes. Isso muda o isolamento entre times (de "uma conta por time" para "um teste de contrato garante que nenhuma consulta cruza times"), a instalação do GitHub App (um App da Ahrena instalado em várias orgs) e a cobrança. **Esta decisão vale para os dois casos, mas a fase 1 depende da resposta.**
2. **Quem é a fonte da ordem e do status?** Recomendação: o Project do GitHub continua a fonte de status e campos, e o hub é dono só da fila e da trava. A alternativa é o hub virar o gerenciador de tarefas e o GitHub ficar como espelho, como o Linear faz; isso dá mais liberdade de tela e mais trabalho de sincronia nos dois sentidos.
3. **A trava é forte ou fraca?** Ninguém impede uma pessoa de mexer na issue direto no GitHub. Recomendação: forte para o console e para os agentes (o hub recusa), aviso visível para o resto do time (responsável e status no Project). Se alguém tirar o responsável no GitHub, a trava continua, e o hub o põe de volta na próxima reconciliação, ou respeita a mudança e solta a trava?
