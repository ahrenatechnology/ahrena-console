# 0027 · O Workboard na nuvem: um backlog multi-tenant que sincroniza com o GitHub nos dois sentidos e trava a issue de quem a puxou

- **Status:** aceita nas três escolhas de princípio, respondidas pelo dono do produto em 17/11 (hub multi-tenant e serverless na AWS; backlog na nuvem com sincronia nos dois sentidos; trava no hub). As recomendações marcadas **a confirmar** ficam para a revisão da issue da fase 1.
- **Data:** 2026-11-17
- **Issue:** a abrir, uma por fase
- **Revê:** em [0002](0002-hub-aws.md), "Open source: cada time sobe o hub na própria conta AWS" e "Um deploy normalmente serve um time". O hub passa a ser um serviço da Ahrena, multi-tenant. O resto da 0002 vale: serverless, DynamoDB em tabela única com o tenant na chave vindo do token, GitHub App, cursor de mudanças e "a máquina envia, o hub nunca busca".
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

O objetivo é o modelo de um gerenciador de tarefas como o Linear: um backlog na nuvem, sincronizado com o GitHub, e uma issue puxada fica **travada para o time** enquanto o agente na máquina do AI Coordinator trabalha nela. O console continua existindo e funcionando local; o que vai para a nuvem é o back-end do Workboard, tudo o que fala direto com o GitHub. É a primeira feature do console na nuvem.

## Decisão

**O Workboard ganha um back-end próprio: um serviço multi-tenant da Ahrena na AWS, o mais serverless possível. Ele guarda o backlog do tenant no mesmo modelo de trabalho usado hoje (iniciativa, épico, história, tarefa, spike, bug, com milestones) e o sincroniza com o GitHub nos dois sentidos, por um GitHub App da Ahrena. Ele é dono da fila do time e da trava de cada item, uma trava com prazo que o núcleo do AI Coordinator renova enquanto a sessão vive. O núcleo local troca os adaptadores do quadro pelos do hub e continua dono das sessões e da execução. Sem hub configurado, o console funciona como hoje.**

### 1. O que vai para a nuvem e o que fica

| Hub (nuvem) | Núcleo (máquina) |
| --- | --- |
| O backlog do tenant: itens, hierarquia, milestones, campos | Sessões do Claude Code e tudo o que está nelas |
| A sincronia com o GitHub, nos dois sentidos | O executor: abre a sessão local ou por SSH (#531) e o puller da fila (#477 L2) |
| Fila do time e a ordem dela | A renovação da trava, enquanto a sessão vive |
| **A trava** de cada item: quem, de qual máquina, até quando | O cache do que o hub mandou, para ler sem rede |
| O cursor de mudanças (0002, "tempo real barato") | A tela do console, que passa a ler do hub pelo cache |

O núcleo já fala com o quadro por portas (`WorkProjectBoard`, `WorkQueueStore`, `WorkSessions`). A troca é de adaptador: `WorkProjectBoard` e `WorkQueueStore` ganham uma implementação que lê e escreve no hub; `WorkSessions` continua local. A regra do quadro (`columnOfIssue`, `buildWorkBoard`) não muda de lugar: é pura, e roda no núcleo sobre o que o hub mandou mais as sessões locais.

### 2. Multi-tenant e serverless

- **Tenant** é o cliente da Ahrena: uma ou mais organizações do GitHub e as pessoas delas. Toda chave do DynamoDB começa por `T#<tenant>`, e o tenant sai **do token** (pessoa ou máquina) ou **da instalação do GitHub App** (webhook), nunca de um parâmetro do pedido. Um teste de contrato garante que nenhuma consulta cruza tenants, como a 0002 já pedia.
- **Um GitHub App da Ahrena**, instalado em cada organização cliente. A instalação (`installation_id`) mapeia para um tenant; uma instalação sem tenant é ignorada e registrada.
- **Nada ligado parado.** API Gateway HTTP API, Lambda (Node, arm64), DynamoDB sob demanda, SQS, DynamoDB Streams e EventBridge Scheduler. O custo acompanha o uso por tenant.
- **Limites por tenant**: taxa de pedidos no API Gateway por token e o limite do GitHub, que é por instalação, então um tenant não gasta o do outro.

### 3. O backlog na nuvem e a sincronia nos dois sentidos

**O modelo é o mesmo de hoje.** Os tipos são os de `WORK_TYPE_SLUGS` (iniciativa, épico, história, tarefa, spike, bug, plano), a hierarquia é a de sub-issues, e o milestone casa pelo título, como a escrita local já faz (`github-source.ts`). O GitHub Project continua sendo o backlog para quem trabalha no GitHub; para o Workboard, a origem passa a ser o backlog na nuvem.

**Dois caminhos, os dois válidos:**

| Onde nasce | O que acontece |
| --- | --- |
| **Na nuvem** (console ou API do hub) | O hub grava o item e a mudança entra numa fila de saída; uma Lambda cria a issue no repositório escolhido, põe no Project, liga o pai e o milestone, e grava no item o vínculo com o GitHub (repositório, número, `node_id`) |
| **No GitHub** | O webhook chega, o hub cria o item com o vínculo e o tipo, pai e milestone que a issue já tem |

**O que sincroniza:** título, corpo, estado, tipo, pai, milestone, etiquetas, responsáveis e os campos do Project (status, prioridade, iteração). Comentários ficam fora da fase 1: a conversa continua no GitHub.

**Como**, sem servidor ligado:

- **Entrada:** webhooks `issues`, `sub_issues`, `milestone`, `pull_request`, `pull_request_review`, `check_suite`, `projects_v2_item`. Uma Lambda confere `X-Hub-Signature-256`, descarta repetidos por `X-GitHub-Delivery` e põe o evento na SQS; outra aplica no DynamoDB e sobe o cursor.
- **Saída:** cada mudança feita no hub grava um registro de saída; o DynamoDB Stream dispara a Lambda que escreve no GitHub com o token de instalação. Falha vai para nova tentativa e, esgotada, para uma fila de mortos com alerta; o item mostra "não sincronizado".
- **Eco:** toda escrita do hub guarda o que mandou. O webhook que volta com o bot do App como autor e os mesmos valores é reconhecido e descartado, para a mudança não dar a volta.
- **Conflito:** por campo, vence a mudança mais recente pela hora em que aconteceu (o `updated_at` do evento do GitHub contra o `changedAt` do hub). As duas versões ficam no histórico do item. Campo de texto longo (corpo) não é mesclado: vence a última e a anterior fica no histórico.
- **Reconciliação** por EventBridge Scheduler a cada 15 min por instalação: lê os itens do Project e as issues por `updatedAt` desde a última passada e corrige o que um webhook perdido deixou. O webhook é o caminho rápido; a reconciliação é a garantia.

**A confirmar:**
- Um item criado na nuvem precisa de repositório para virar issue. Recomendação: história, tarefa, spike e bug pedem o repositório na criação; iniciativa e épico, que atravessam repositórios, moram num **repositório de planejamento** que o tenant escolhe uma vez.
- Milestone é por repositório no GitHub. Recomendação: o milestone do hub é do tenant e vira, em cada repositório que tem itens nele, um milestone de mesmo título, criado quando o primeiro item chega lá.

### 4. A trava

A trava é do hub, e só o hub escreve nela. Ela é um conceito do backlog na nuvem, não um campo do GitHub.

- **Pegar** (`POST /v1/work/items/{id}/claim`) é uma gravação condicional no DynamoDB: passa só se não há trava ou se a que existe venceu. Dois núcleos que pedem ao mesmo tempo recebem um sim e um `409 claimed`, com quem está travando.
- **A trava guarda** pessoa (do token), máquina (do token), a sessão quando ela aparecer, `claimedAt`, `expiresAt` e uma versão. Toda renovação e toda liberação mandam a versão; uma versão velha é recusada. Assim um núcleo que voltou de uma queda não derruba a trava que outro pegou depois.
- **Renovar.** O núcleo renova a cada 60 s enquanto a execução está iniciando (a janela de 10 min de `EXECUTION_SESSION_WINDOW_MS`) ou a sessão ligada está viva. A trava vence 5 min depois da última renovação. A renovação leva só o estado da sessão (`working`, `needs-you`, `idle`), para o time ver o cartão se mexer; nenhum texto da conversa.
- **Liberar.** A trava termina quando:
  - o PR ligado é mergeado ou a issue é fechada, na nuvem ou no GitHub: fim normal, o cartão vai para Concluído;
  - a pessoa solta no console;
  - ela vence: o item volta ao **topo** da fila, parado, com o motivo "trava vencida", como o `markFailed` da #477 faz hoje com uma execução que não subiu;
  - um `admin` do tenant força a liberação, e isso fica no log de admin da 0002.
- **No GitHub** a trava aparece como **responsável** (a pessoa) e o status **Em execução** no Project, escritos pela saída da seção 3.
- **Puxar da fila são duas raízes.** A fila do time e o item são agregados diferentes; pegar é a operação que manda. O hub grava a trava e emite `WorkItemClaimed`; a saída da fila acontece em seguida, pelo evento, e não na mesma transação.

**Forte no hub, aviso no GitHub (recomendação).** O GitHub não tem como travar uma issue: qualquer pessoa com acesso muda responsável e status. Então:

| Quem tenta | O que acontece |
| --- | --- |
| Outro núcleo, agente ou pessoa pelo console ou pela API do hub | **Recusado** (`409 claimed`). Aqui a trava é forte |
| Alguém no GitHub tira o responsável ou muda o status | A mudança sincroniza como qualquer outra (seção 3), e o hub **não desfaz**: brigar com o GitHub geraria uma guerra de edições. A trava continua, e o cartão mostra "responsável mudou no GitHub" para quem segura a trava decidir |
| Alguém no GitHub se põe como responsável de um item travado | Sincroniza, a trava continua com quem a pegou, e o cartão mostra o conflito com os dois nomes |
| Alguém fecha a issue no GitHub | A trava termina, como no fim normal |

A trava protege o que passa pelo hub, que é por onde os agentes pegam trabalho. Para quem está fora, ela é um aviso visível. Um agente que pega issues direto no GitHub, sem o console, fica fora da trava; isso fica registrado como limite, não como falha.

### 5. O núcleo local

- **Configuração.** O hub é opcional. Com `ahrena-console hub login` (0002) feito e o Workboard ligado no tenant, o núcleo usa os adaptadores do hub; sem isso, usa os de hoje, e o quadro funciona como funciona agora, sem trava de time.
- **Mudanças** chegam pelo cursor da 0002: o núcleo lê o cursor a cada 10 s e baixa o delta quando ele muda; a tela continua lendo do núcleo, com long polling.
- **Sem rede**, o quadro mostra a última cópia, marcada como velha (o `stale` da 0001), e criar, pegar, soltar e reordenar ficam desligados. A trava que este núcleo segura não é renovada e vence no hub; ao voltar, se ela ainda é dele (mesma versão), ele renova; se não é, a tela avisa e a sessão continua, mas o cartão mostra que outra pessoa pegou o item.
- **O núcleo para de ler os Projects do GitHub para o quadro** quando o hub está ligado. As outras leituras do GitHub (Decisões, PRs da sessão) continuam como estão.

### 6. Itens no DynamoDB

Na tabela única da 0002, sob `T#<tenant>`:

| Item | PK | SK | Atributos principais |
| --- | --- | --- | --- |
| Item de trabalho | `T#<tenant>#W#<itemId>` | `META` | tipo, título, corpo, estado, pai, milestone, campos, vínculo com o GitHub (repositório, número, `node_id`), `updatedAt`, `version` |
| Histórico do item | `T#<tenant>#W#<itemId>` | `H#<changedAt>#<campo>` | valor antes e depois, origem (`hub` ou `github`), quem |
| Trava | `T#<tenant>#W#<itemId>` | `CLAIM` | pessoa, máquina, sessão, `claimedAt`, `expiresAt`, `version`, estado da sessão |
| Saída para o GitHub | `T#<tenant>#OUT` | `<changedAt>#<itemId>` | mudança, tentativas, último erro |
| Vínculo do GitHub | `GH#<node_id>` | `LINK` | tenant e `itemId`, para o webhook achar o item |
| Instalação | `GHI#<installationId>` | `INST` | tenant, organização |
| Milestone | `T#<tenant>` | `MS#<título>` | datas, estado, repositórios onde existe |
| Entrada da fila | `T#<tenant>#Q#<filaId>` | `<posição>#<itemId>` | alvo da execução, `enqueuedAt`, `failedReason` |
| Entrega de webhook | `GHD#<deliveryId>` | `D` | recebida em (TTL 3 dias, para descartar repetidas) |

O `itemId` é do hub (ULID), e não o número da issue, porque o item pode nascer na nuvem antes de existir no GitHub. GSI1 da 0002 ganha os itens de trabalho (`<updatedAt>#W#<itemId>`), para o delta por cursor. As travas vencidas são achadas por um job de 1 min que lê só as travas ativas (poucas por definição); o TTL do DynamoDB não serve aqui porque apaga com até 48 h de atraso.

### 7. Quem pode o quê

| Ação | Quem |
| --- | --- |
| Ver o backlog e o quadro do tenant | Todo `member` |
| Criar e editar itens, pôr na fila, reordenar | `member` |
| Pegar um item | `member`, por uma máquina com token válido |
| Renovar e soltar | Só a máquina que segura a trava (máquina do token e versão) |
| Forçar a liberação, ligar organizações e repositórios | `admin` |
| Instalar o GitHub App na organização | Um `owner` da organização no GitHub |

## Fases

1. **Spike:** GitHub App da Ahrena numa org de teste, webhook entrando, reconciliação de um Project, eco descartado, medida de custo por tenant.
2. **Backlog no hub, GitHub para a nuvem:** o espelho, o cursor e o núcleo lendo o quadro do hub.
3. **A trava:** pegar, renovar, soltar, vencer, e responsável e status escritos no GitHub.
4. **Nuvem para o GitHub:** criar e editar itens no console, com a saída, o conflito por campo e o histórico.
5. **A fila do time:** a fila da #477 migra para o hub; o puller local passa a puxar dela.

Cada fase vira uma issue e passa pela Athena.

## Alternativas consideradas

| Alternativa | Por que não |
| --- | --- |
| **Um hub por time, na conta AWS de cada um** (a 0002 original) | O Workboard é produto da Ahrena para vários clientes; um deploy por cliente multiplica operação, atualização e GitHub Apps |
| **GitHub como única fonte, hub só espelho** | Não permite criar e planejar na nuvem, que é o que a feature quer, e prende o modelo ao que o Project expõe |
| **Hub como única fonte, GitHub só espelho** | O time continua trabalhando no GitHub; uma edição feita lá precisa voltar |
| **Trava só no GitHub** (o responsável ou uma etiqueta como trava) | Não há gravação condicional: dois agentes que leem "sem responsável" ao mesmo tempo se atribuem os dois. Não há prazo, então uma máquina que caiu segura a issue para sempre |
| **O hub desfazer no GitHub o que contraria a trava** | Guerra de edições com pessoas e outras automações, num sistema que é dos dois sentidos |
| **Trava sem prazo, solta à mão** | O caso comum de falha (notebook fechado, túnel caído) deixaria itens presos até alguém lembrar |
| **Levar a execução para a nuvem também** | A execução depende do Claude Code e das credenciais da máquina do AI Coordinator. Fica fora desta decisão |

## Consequências

- O Workboard passa a ter dois modos, local e de time, com os mesmos testes de contrato das portas rodando nos dois adaptadores, como a 0002 pede para o armazenamento.
- O hub da 0002 sai do papel por esta feature, e como serviço multi-tenant da Ahrena. O primeiro deploy precisa só de auth, tenant, cursor e Workboard.
- O GitHub App da Ahrena vira requisito do modo time, e cada cliente instala na própria organização.
- O hub passa a guardar corpo de issue, então guarda conteúdo do cliente: cifra em repouso (padrão do DynamoDB), e a política de retenção e de saída de um tenant precisa existir antes do primeiro cliente externo.
- A escrita no GitHub muda o que as pessoas veem lá: o hub cria issues e mexe em responsável, status, pai e milestone.
