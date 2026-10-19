# 0006 · Várias contas do Claude ao mesmo tempo, sem trocar de conta

- **Status:** aceita
- **Data:** 2026-10-19
- **Issue:** [#106](https://github.com/ahrenatechnology/ahrena-console/issues/106) (spike 1.11 do [backlog](../backlog-0.0.1.md), épico [#2](https://github.com/ahrenatechnology/ahrena-console/issues/2))
- **Mexe em:** [0002](0002-hub-aws.md) (hub), [0004](0004-painel-da-sessao.md) (painel), [0005](0005-app-desktop.md) (app de bandeja)
- **Prova:** [spikes/multiplas-contas](../../spikes/multiplas-contas/)

> Medido num Mac com duas contas do Claude (macOS 26.7, Claude Code 2.1.302, Claude Desktop com as versões 2.1.295 e 2.1.299 do CLI embutido). Li só a **estrutura** dos arquivos: nomes de campos e de pastas, e contagens. Nenhum UUID, e-mail ou nome real entrou aqui; os exemplos usam UUIDs sintéticos. Não fiz login, logout nem troca de org, e não reiniciei o Claude Desktop. A prova rodou numa pasta temporária, com `HOME` falso e uma API falsa em `127.0.0.1`.

## Contexto

O dono usa o Claude como Forward Deployed Engineer em vários clientes, cada um com a sua conta do Claude, e o time inteiro também tem mais de uma (a da empresa, a de cada cliente, Team e Max). **Decisão do dono, premissa deste registro:** a 0.0.1 (M1) suporta várias contas do Claude **ao mesmo tempo, sem trocar de conta**, e nenhuma parte do console depende de uma conta só: núcleo, plugin, extensão, app de bandeja e hub.

Neste registro, **conta** é o par `(conta, org)` do claude.ai: o `accountUuid` do login (uma pessoa, um e-mail) e o `organizationUuid` em que ele está (Team, Enterprise, Max, Pro). Uma mesma conta pode estar em várias orgs; o que separa limites, cobrança, artefatos e dados de cliente é a org. A interface chama o par de "conta" e mostra o rótulo que a pessoa deu a ele.

## O que foi medido

### Onde a conta aparece no disco

| Fonte | O que tem | Medido nesta máquina |
| --- | --- | --- |
| Índice do Claude Desktop: `~/Library/Application Support/Claude/claude-code-sessions/<conta>/<org>/local_*.json` | **A conta e a org só pelo caminho**: o JSON não tem campo de conta nem de org. Tem `cliSessionId` (o id do transcript), `priorCliSessionIds`, `cwd`, `model`, `sshConfig.sshHost` e `sshRemoteTranscriptPath` | 2 contas, 3 pastas conta/org, 1.643 arquivos (583, 579 e 481 por pasta), 1.034 por SSH |
| A mesma sessão em várias pastas | Copiar um `local_*.json` para outra pasta faz a sessão aparecer na outra org (é o que a sincronização de sessões entre orgs faz) | **580 dos 597** `cliSessionId` distintos estão em mais de uma pasta conta/org. A pasta **não** diz, sozinha, de qual conta a sessão é |
| Ambiente do CLI lançado pelo Desktop | `CLAUDE_CODE_ACCOUNT_UUID`, `CLAUDE_CODE_ORGANIZATION_UUID`, `CLAUDE_CODE_USER_EMAIL`, `CLAUDE_CODE_SESSION_ID` e `CLAUDE_CODE_HOST_SESSION_ID` (`local_…`) | Os dois UUIDs batem com a pasta `<conta>/<org>` do `local_*.json` da sessão, e o `CLAUDE_CODE_SESSION_ID` com o `cliSessionId`. O CLI usa essas variáveis para preencher o `oauthAccount` |
| Hooks | O payload **não** tem conta. O hook herda o ambiente do CLI e recebe `transcript_path`, que fica dentro da pasta de configuração | Na prova, o hook viu `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_ACCOUNT_UUID` e `CLAUDE_CODE_ORGANIZATION_UUID` de cada pasta, sem mistura |
| Transcripts em `~/.claude/projects` | Um diretório só para todas as contas do Desktop. Linhas `bridge-session` trazem `ownerAccountUuid` e `ownerOrganizationUuid`; linhas `artifact-autoreact-ledger` trazem `accountUuid` | 1.678 transcripts, 531 com `bridge-session`. Dos 598 ligados a uma sessão do Desktop, 425 têm o dono, e **em todos** ele está entre as pastas do Desktop daquela sessão. Os outros 173 não têm a linha |
| `~/.claude.json` (ou `$CLAUDE_CONFIG_DIR/.claude.json`) | `oauthAccount` com a conta e a org **logadas agora** na pasta de configuração | Não li o arquivo real nesta máquina. Na prova, a pasta nova ganhou o próprio `.claude.json` |
| `~/.claude/sessions/<pid>.json` | Sessões vivas: `sessionId`, `hostSessionId`, `entrypoint`, `cwd`, `status`. Sem conta | 6 arquivos |
| OpenTelemetry do Claude Code | Atributos `user.account_uuid`, `organization.id` e `user.email` em métricas e eventos | Visto nas strings do binário do CLI; não liguei a telemetria |

### O que separa uma pasta de configuração da outra

- **Login:** é o caminho documentado para várias contas: cada pasta tem "as próprias configurações, histórico de sessões e login do claude.ai ou API key" ([Authentication › Log in with multiple accounts](https://code.claude.com/docs/en/authentication)), com um alias por conta (`alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'`). No macOS, o item do Keychain fica ligado à pasta: o CLI 2.1.302 soma ao nome `Claude Code-credentials` os 8 primeiros caracteres do SHA-256 da pasta (`Claude Code-credentials-1a2b3c4d`). Logar numa pasta não desloga a outra. Visto na documentação e no código do CLI; não criei credencial na prova.
- **O que não fica separado:** o login do Claude Console **sem** API key (o perfil da Anthropic, a partir da v2.1.242) fica fora da pasta de configuração, em `~/.config/anthropic`, e a documentação diz que pastas diferentes não o isolam. Credenciais no ambiente (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `apiKeyHelper`) passam na frente do login de qualquer pasta, então não podem ficar exportadas no shell de todas as contas.
- **Tudo o mais:** `.claude.json`, `settings.json`, plugins, hooks, `projects/` e `sessions/` ficam dentro da pasta. Na prova, duas sessões em `a` e `b` rodaram juntas e nada foi parar no `HOME`.
- **O Claude Desktop** usa a pasta padrão (`~/.claude`) para todas as orgs e diz ao CLI qual conta usar pelo ambiente. Por isso os transcripts de todas as orgs do Desktop ficam juntos. A documentação diz que o Desktop entra por OAuth, não lê as variáveis de credencial, compartilha `~/.claude.json` e `~/.claude/settings.json` com o CLI e roda uma cópia própria do Claude Code. Ela **não** diz se o Desktop respeita `CLAUDE_CONFIG_DIR`, nem se ele pode ficar logado numa conta e o CLI do terminal, na mesma `~/.claude`, em outra. Não medi nenhum dos dois: trocar o login para medir mexeria na configuração real.
- **Do terminal para o Desktop:** `/desktop` no CLI, `claude --desktop --resume <id>` (v2.1.285 em diante; o CLI 2.1.302 tem a opção) ou `/resume` no Desktop levam uma sessão local para o Desktop. É a mesma sessão, não uma cópia, e só vale com login de assinatura. O Desktop e o CLI têm listas de sessões separadas: a barra lateral não mostra as sessões do CLI até alguém trazê-las. Como o Desktop lê `~/.claude`, uma sessão de outra pasta de configuração provavelmente não tem como ser trazida (inferência, não medido).

## Decisão

**Um núcleo por máquina para todas as contas.** A conta é um atributo da sessão, gravado quando ela é vista pela primeira vez, com a procedência. As superfícies mostram tudo junto e filtram, agrupam e somam por conta. Nenhuma peça depende da conta logada no Claude Desktop. Para rodar contas em simultâneo, o caminho padrão é **o Claude Code no terminal, com uma pasta de configuração por conta e Remote Control**, todas alimentando o mesmo núcleo. O Claude Desktop entra como mais uma superfície, numa conta.

### 1. Conta de cada sessão

O núcleo resolve a conta pela primeira fonte que responder, nesta ordem, e grava a procedência em `accountSource`:

| Ordem | Fonte | Quando vale | `accountSource` |
| --- | --- | --- | --- |
| 1 | Ambiente do hook: `CLAUDE_CODE_ACCOUNT_UUID` e `CLAUDE_CODE_ORGANIZATION_UUID` | Sessão lançada pelo Claude Desktop, ao vivo | `env` |
| 2 | Pasta de configuração do hook (`CLAUDE_CONFIG_DIR`, ou a raiz do `transcript_path`) → `oauthAccount` do `.claude.json` dela, lido no `SessionStart` | Sessão só de CLI (terminal, VS Code, script), ao vivo | `config` |
| 3 | Linha `bridge-session` do transcript (`ownerAccountUuid`, `ownerOrganizationUuid`) | Importação do histórico e seguidor | `transcript` |
| 4 | Índice do Desktop, pelo `cliSessionId`, quando a sessão está em **uma** pasta conta/org só | Importação do histórico | `desktop` |
| 5 | A conta atual da pasta de configuração onde o transcript está | Importação, sem nada melhor; marcada como inferida | `profile` |
| — | Nenhuma | A sessão fica em "Sem conta". Nunca é atribuída a outra conta por palpite | `null` |

- A conta de uma sessão não muda depois de gravada, a não ser que chegue uma fonte de ordem menor (por exemplo, o hook ao vivo corrige a inferência da importação).
- Da `.claude.json` o núcleo lê só `accountUuid`, `organizationUuid`, `organizationName` e o tipo da org. Nunca lê tokens. O e-mail fica só na máquina e só para sugerir o rótulo.
- **Sessão por SSH:** quem roda é o CLI remoto, com o login da máquina remota. A conta da sessão é a do CLI remoto: pelo hook remoto (ordens 1 e 2, no núcleo da máquina remota) ou pela `bridge-session` do transcript remoto. O par `<conta>/<org>` do Desktop entra em `metadata.desktopScope`. Quando os dois diferem, o console mostra o aviso "Desktop numa org, CLI remoto em outra", que é a falha que hoje se descobre tarde. Não medi o ambiente que o Desktop passa ao CLI remoto: fica para a 1.13 conferir.
- **Chave de API** (sem OAuth): a sessão vai para uma conta "Chave de API" da pasta de configuração, sem guardar a chave.

### 2. Modelo de dados do núcleo (aditivo)

| Peça | Muda | Não muda |
| --- | --- | --- |
| `model.ts` | Entidade nova `ClaudeAccount`: `id` (`<accountUuid>/<organizationUuid>`), `accountUuid`, `organizationUuid`, `organizationName`, `organizationType`, `label`, `color`, `configDirs`, `firstSeenAt`, `lastSeenAt`, `metadata`. Em `Session`: `accountId: string \| null` e `accountSource` | Os ids de sessão, agente e evento (o `sessionId` do transcript é um UUID global; as convenções da #12 continuam) |
| `storage-port.ts` | `putAccount`, `getAccount`, `listAccounts`; `ListSessionsQuery.accountIds?: readonly (string \| null)[]` (o `null` pede as "Sem conta") | Paginação por cursor, `put` do registro inteiro |
| SQLite | Migração nova: tabela `accounts`, colunas `account_id` e `account_source` em `sessions`, índice `(account_id, updated_at DESC, id DESC)` | As tabelas e migrações que existem |
| Importador e seguidor (#12, #13) | `root` vira uma lista de pastas de configuração (perfis); cada transcript leva a conta pela ordem 3 a 5 | O cursor em `metadata.importacao` e a deduplicação |
| Hooks (#14) | `forward.mjs` manda junto as três variáveis do ambiente (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_ACCOUNT_UUID`, `CLAUDE_CODE_ORGANIZATION_UUID`) num campo próprio do corpo; o receptor resolve a conta no `SessionStart` | O payload do Claude Code, o timeout e a tolerância a falha |
| Custo e uso (1.6) | As agregações ganham a dimensão conta | O cálculo do custo |
| Limites (status line, 1.6 e 1.7) | O `LimitSnapshot` passa a ser por conta | — |

**Perfis.** O núcleo guarda a lista de pastas de configuração que conhece: `~/.claude`, as `~/.claude-*` que existirem, as que a pessoa configurar e as que os hooks revelarem. Para cada uma, a conta atual (lida do `.claude.json`), se o plugin está instalado e onde ficam os transcripts.

### 3. Superfícies

Regra comum: **mostrar junto, filtrar e agrupar por conta, somar só o que soma.** Custo e contagens somam, sempre com a divisão por conta ao lado. **Limites de uso nunca somam**, porque cada conta tem o seu. Toda sessão mostra o rótulo e a cor da conta.

| Superfície | Como fica |
| --- | --- |
| **Núcleo e MCP** | Toda ferramenta aceita `account` (rótulo ou id; vários; `none` para "Sem conta"), com todas por padrão. Cada sessão na resposta traz a conta. `fleet_overview` e `sessions_needing_attention` devolvem o total e a divisão por conta. O MCP responde igual em qualquer org do Desktop, porque o núcleo é da máquina |
| **Artefato** | A moldura (3.1) ganha o seletor de conta (Todas, uma, várias), lembrado por pessoa. Coluna Conta em Sessões, cards por conta no Dashboard, Custo por conta, mural e kanban agrupáveis por conta |
| **Painel lateral** | Mostra a conta desta sessão (do ambiente, ordem 1). A linha "N precisam de você" conta todas as contas e abre a divisão ao passar o mouse |
| **App de bandeja** | Total de todas as contas na barra de menus, menu agrupado por conta, rótulo da conta na notificação |

**O artefato e a ponte `host:` também são por conta do claude.ai.** Já medido na sincronização de sessões: um artefato publicado é da pessoa e abre pelo link em qualquer org, mas só uma sessão da org em que ele foi publicado consegue atualizá-lo. Como o artefato lê o núcleo da máquina pela extensão, ele mostra todas as contas seja qual for a org em que foi publicado. O que **não** foi medido: se a ponte `host:` funciona quando o Desktop está noutra org que não a da publicação. Até a validação (3.12), a recomendação é publicar o artefato do console uma vez em cada org em que a pessoa trabalha, a partir da mesma pasta versionada.

### 4. Hub (decisão 0002)

A conta do Claude é uma **dimensão** dentro do time, não um tenant. O tenant continua sendo o time do hub, que sai do token.

| Quem | No hub | De onde vem |
| --- | --- | --- |
| Pessoa | `U#<githubId>`, como na 0002 | Login GitHub |
| Máquina | `M#<machineId>`, da pessoa | Token de máquina |
| Conta do Claude | `A#<accountKey>`: rótulo, tipo da org, pessoa | O lote de ingestão |
| Cliente | `C#<cliente>`, como na 0002; a pessoa liga cada conta a um cliente | Configuração da máquina |

- **O UUID real não sai da máquina.** O hub recebe `accountKey = sha256(sal do time ‖ accountUuid/organizationUuid)` e o rótulo. O e-mail da conta do Claude nunca sai. Assim, o hub do time da empresa não guarda identificadores da org de um cliente.
- **Política por conta, decidida na máquina** (somando à 7.6): para cada conta, o que sai (`nada`, `metadados`, `conteúdo`) e para qual hub. **Conta nova começa em `nada`** até a pessoa decidir, para não vazar sessão de cliente para o hub errado. Uma conta de cliente pode mandar para o hub do próprio cliente, ou para nenhum.
- O índice GSI2 da 0002 ganha a chave sobrecarregada `T#<team>#A#<accountKey>`, e o agregado diário ganha a conta na chave de ordenação.
- O contrato do lote (conta em cada sessão, `accountKey`, política) entra no M1 (7.12), para o núcleo local nascer com ele. A ingestão no hub continua na 7.5 e na 7.6, no M2.

### 5. Instalação

- **O plugin é por pasta de configuração**, porque plugins, `settings.json` e hooks ficam dentro dela. Uma instalação em `~/.claude` cobre todas as orgs do Claude Desktop. Cada `CLAUDE_CONFIG_DIR` a mais precisa da sua: `CLAUDE_CONFIG_DIR=~/.claude-cliente claude plugin install …`.
- `ahrena-console perfis` lista as pastas de configuração, a conta atual de cada uma e se o plugin está instalado, e instala onde falta, com confirmação. O `doctor` (1.8) confere cada perfil.
- **A extensão `.mcpb` é do Claude Desktop**, não da conta: fica em `Claude Extensions`, fora das pastas por conta, e sobe ou adota o mesmo núcleo (6.6) qualquer que seja a org.
- **A bandeja** é da máquina. Não pede login do Claude.

### 6. Contas em simultâneo

| Caminho | O que funciona | Login | Custo | O que se perde |
| --- | --- | --- | --- | --- |
| **Claude Desktop trocando de org** | Tudo do Desktop, numa org por vez | Um login, troca pelo menu | Nenhum | **Não é simultâneo.** A barra lateral só lista as sessões da org logada; o resto some até trocar de volta |
| **Uma pasta de configuração por conta** (`CLAUDE_CONFIG_DIR`), no terminal ou no editor | **Simultâneo**: provado com duas pastas ao mesmo tempo, com hooks e transcripts separados. Cada uma alimenta o mesmo núcleo | `CLAUDE_CONFIG_DIR=~/.claude-cliente claude auth login`, uma vez por pasta; o Keychain separa as credenciais | Zero; um alias de shell por conta e o plugin instalado em cada pasta | A barra lateral, o navegador, o diff e os outros painéis do Desktop. O painel do console (mod) continua: ele também desenha no terminal (testes do [painel-teste](../../spikes/painel-teste/)). Configuração duplicada (plugins, MCP, `settings.json`) |
| **Terminal com uma pasta por conta, Remote Control e o console juntando tudo** (indicado pelo dono) | **Simultâneo e com mais paralelismo**: `claude remote-control` fica em modo servidor e abre sessões sob demanda (`--spawn same-dir`, `worktree` ou `session`), até `--capacity` sessões por processo (padrão 32), um processo por conta. `--rc` ou `/rc` liga o Remote Control numa sessão já aberta. Cada sessão aparece no claude.ai/code e no app do celular **da conta dela**. O console junta todas: painel em cada sessão, MCP, bandeja e artefato | Um `claude auth login` por pasta, como acima. Remote Control exige plano Pro, Max, Team ou Enterprise e não aceita API key nem `CLAUDE_CODE_OAUTH_TOKEN`; em Team e Enterprise, um Owner da org precisa ligar a opção, ou seja, **em cada org de cliente** | Zero de infraestrutura; um terminal (ou um serviço) por conta com `remote-control` rodando | A barra lateral e os painéis do Desktop. No claude.ai/code e no celular, cada conta vê só as próprias sessões: quem junta as contas é o console. O artefato do console continua precisando do Desktop com a extensão (ponte `host:`). Sem o Owner ligar o Remote Control, a conta de um cliente fica só no terminal |
| **Claude Code num container por conta** | Simultâneo e isolado de verdade: disco, rede e credenciais do cliente ficam no container | Login dentro do container; sem Keychain, a credencial fica num arquivo do volume | Docker ou Colima ligados (centenas de MB de RAM por container) e um volume por conta | O painel, os arquivos do Mac fora dos volumes montados e o núcleo em `127.0.0.1`: o hook precisa de um endereço do host. **Não provado** no timebox |
| **Workstation por SSH** | Sessões da aba Code rodando lá, com o painel no Desktop | O login do CLI na máquina remota, que precisa estar na mesma org do Desktop (hoje um login por usuário remoto) | A máquina remota | Só uma conta por usuário remoto, salvo pasta de configuração por conta lá também. O núcleo remoto precisa juntar-se ao do Mac (pelo túnel ou pelo hub) |
| **Hub juntando tudo** | A visão única de todas as máquinas e contas da pessoa e do time | GitHub, independente do Claude | O da 0002 | Não faz as contas rodarem juntas, só junta o que cada máquina manda. M2 |

**Recomendação:** o terminal com uma pasta de configuração por conta, cada uma com `claude remote-control` para abrir e acompanhar sessões de qualquer lugar. Esse é o único caminho medido que roda todas as contas ao mesmo tempo, com o paralelismo do modo servidor. O painel do console fica em cada sessão, e o núcleo, a bandeja e o MCP somam todas as contas. O Claude Desktop continua para a conta em que a pessoa quer o navegador, o diff e o artefato. Na pasta padrão, ele não deve disputar a conta com o terminal até a dúvida acima ser medida (6.11). O hub junta máquinas. Container fica para o cliente que exige isolamento, e a workstation para o trabalho remoto que já existe.

Pela linha `bridge-session` que o Remote Control grava, as sessões abertas assim tendem a trazer o dono no próprio transcript (ordem 3). É uma inferência a conferir na 1.14.

## Prova

[spikes/multiplas-contas](../../spikes/multiplas-contas/):

- `prova.sh`: duas pastas de configuração, contas sintéticas, `HOME` falso e uma API falsa; as duas sessões rodam juntas e os hooks recebem a conta de cada uma pelo ambiente.
- `medir.py`: os números da seção "O que foi medido", só contagens.

O que a prova **não** cobre: login OAuth de verdade em duas pastas (não criei credencial no Keychain), Remote Control (exige login de assinatura), container, sessões por SSH, a ponte `host:` com o Desktop em outra org, o Desktop e o terminal logados em contas diferentes na mesma `~/.claude`, e uma segunda instância do Claude Desktop.

## O que entra no backlog

Todos no **M1**:

| # | Tipo | Item | Depende de |
| --- | --- | --- | --- |
| 1.12 | Tech task | Conta no modelo e na porta: `ClaudeAccount`, `Session.accountId` e `accountSource`, filtro por conta em `listSessions`, migração aditiva no SQLite, testes de contrato e o simulador (6.4) com duas contas sintéticas | 1.1 |
| 1.13 | Tech task | Conta pelos hooks: o encaminhador manda `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_ACCOUNT_UUID` e `CLAUDE_CODE_ORGANIZATION_UUID`; o receptor resolve pelas ordens 1 e 2 no `SessionStart`. Conferir o que chega numa sessão por SSH | 1.4, 1.12 |
| 1.14 | Tech task | Importador e seguidor com várias pastas de configuração, e conta pelas ordens 3 a 5 (`bridge-session`, índice do Desktop, perfil), com procedência | 1.2, 1.3, 1.12, 1.15 |
| 1.15 | Tech task | Perfis: descobrir as pastas de configuração, ler só a conta e a org de cada `.claude.json`, rótulo e cor editáveis por conta | 1.12 |
| 1.16 | Tech task | Custo, uso e limites por conta: agregações com a dimensão conta; limites por conta, nunca somados | 1.6, 1.12 |
| 2.6 | User story, API | MCP por conta: parâmetro `account` em todas as ferramentas, conta em cada sessão, divisão por conta no `fleet_overview` e no `sessions_needing_attention` | 2.1, 2.2, 1.12 |
| 3.11 | User story, frontend | Artefato por conta: seletor na moldura, coluna Conta, Dashboard, Custo, mural e kanban por conta | 3.1, 2.6 |
| 3.12 | Tech task | Validar o artefato e a ponte `host:` com o Desktop em cada org, e decidir entre um link por org ou um só | 3.1 |
| 4.7 | User story, frontend | Painel com a conta desta sessão e "N precisam de você" de todas as contas, com a divisão | 4.1, 1.13 |
| 6.11 | Tech task | Instalação com várias pastas de configuração: `ahrena-console perfis`, plugin em cada perfil, `doctor` por perfil (inclusive credencial no ambiente) e guia de contas simultâneas com alias e `remote-control` por conta. Medir se o Desktop e o terminal podem ficar em contas diferentes na mesma `~/.claude` | 6.2, 1.15 |
| 6.12 | User story, frontend | Bandeja e notificações por conta: menu agrupado e rótulo da conta na notificação | 6.7, 6.8, 1.12 |
| 7.12 | Tech task | Contrato do hub com conta: `accountKey` com sal do time, conta em cada sessão do lote, política de envio e destino por conta na máquina, conta nova em `nada` | 1.12 |

## Alternativas consideradas

- **Um núcleo por conta.** Isolaria tudo, mas cada superfície teria que falar com vários núcleos e a soma "N precisam de você" teria que ser feita fora. Bate de frente com o núcleo de dono único (6.6). Perdeu.
- **A conta pela pasta do Desktop, só.** É a fonte mais óbvia, mas 580 de 597 sessões estão em mais de uma pasta, e sessões só de CLI não aparecem lá. Fica como ordem 4.
- **A conta pelo `.claude.json` atual, só.** Diz quem está logado agora, não quem rodou a sessão: depois de um `claude auth login` em outra org, o histórico todo mudaria de dono. Fica como ordem 2 (no `SessionStart`) e 5 (inferida).
- **Pedir a conta à pessoa em cada sessão.** Atrito sem ganho, já que o ambiente e o transcript dizem.
- **OpenTelemetry como fonte da conta.** Traz `user.account_uuid` e `organization.id`, mas exige ligar a telemetria em cada pasta e não cobre o histórico. Fica para os headless (7.10).
- **Mandar o UUID real ao hub.** Mais simples, mas leva o identificador da org de um cliente para o hub de outro time. Perdeu para o `accountKey`.

## Consequências

- O modelo e a porta ganham conta antes das telas: 1.12 vem logo depois da 1.1 e antes das superfícies do M1.
- Toda tela e toda ferramenta passa a ter a dimensão conta, e os testes de contrato da porta passam a cobrir o filtro por conta, inclusive "Sem conta".
- O plugin precisa estar em cada pasta de configuração. O `doctor` passa a ser por perfil.
- O hub (0002) ganha a dimensão conta e a política por conta. O UUID real da conta não sai da máquina.
- O painel (0004) continua olhando a sessão em que está aberto; só ganha a conta dela e a soma de todas.
- A recomendação de uso muda: o terminal com uma pasta de configuração e um `remote-control` por conta, o Desktop como mais uma superfície, e o mesmo núcleo para todas.

## Riscos

| Risco | Efeito | Mitigação |
| --- | --- | --- |
| As variáveis `CLAUDE_CODE_ACCOUNT_UUID` e `CLAUDE_CODE_ORGANIZATION_UUID` não são documentadas e podem mudar | Sessões do Desktop caem para as ordens seguintes | As ordens 2 a 5 continuam valendo; o `doctor` avisa quando a ordem 1 some |
| A linha `bridge-session` é interna e falta em 173 dos 598 transcripts | Histórico sem conta | Índice do Desktop e perfil como reserva; "Sem conta" visível, nunca palpite |
| Sessões copiadas entre orgs pela sincronização | A pasta do Desktop aponta para mais de uma conta | Só usar o índice quando há uma pasta só |
| Sessão de cliente enviada ao hub errado | Vazamento entre clientes | Conta nova em `nada`, destino por conta, `accountKey` em vez do UUID |
| Esquecer o plugin numa pasta de configuração | Sessões dessa conta sem hooks, só pelo seguidor | `ahrena-console perfis` e o `doctor` por perfil |
| Remote Control desligado na org de um cliente (Team ou Enterprise) | Sem acompanhar pelo celular ou pelo claude.ai/code nessa conta | O console mostra a conta do mesmo jeito, pelos hooks; o guia (6.11) explica o pedido ao Owner |
| Credencial exportada no shell (`ANTHROPIC_API_KEY` e afins) | Passa na frente do login de todas as pastas e mistura as contas | O `doctor` avisa quando há credencial no ambiente |
