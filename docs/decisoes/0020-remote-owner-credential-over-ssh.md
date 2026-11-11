# 0020 · Prova do dono na máquina remota: o Mac pede, pelo SSH que já entrou lá, uma credencial curta que o núcleo de lá emite, e assina cada pedido com ela

- **Status:** proposta (aguarda o aceite do Fernando; nenhum código antes dele)
- **Data:** 2026-11-11
- **Issue:** [#388](https://github.com/ahrenatechnology/ahrena-console/issues/388)
- **Estende:** [0003](0003-responder-sessao.md) §"Owner proof on local HTTP" (o token daqui nunca vai para lá; a remota fecha até existir uma credencial remota revisada), [0012](0012-remote-reconnect.md) e [0013](0013-cloud-connectors-and-machine-connection.md) §4 (o Mac roda um comando que o usuário escreveu, em lista, sem shell; o núcleo nunca abre SSH por conta própria) e [0018](0018-stuck-terminal-sessions.md) §4 (agir lá continua desligado por padrão, `--accept-remote-actions`)
- **Toca:** [0009](0009-english-internals.md) (nomes em inglês, texto da tela em pt-BR), [0016](0016-release-listening-port.md) e [0017](0017-docker-actions-closed-catalog.md) (as ações remotas que já existem)

## Contexto

Desde a [#391](https://github.com/ahrenatechnology/ahrena-console/pull/391) (issue [#302](https://github.com/ahrenatechnology/ahrena-console/issues/302)), todo núcleo exige `Authorization: Bearer <token do dono>` em toda leitura privada e toda escrita (`packages/nucleo/src/api/owner-auth.ts`). O token é o da trava `nucleo.json` (0600, pasta 0700), muda a cada reinício e só o dono do processo o lê.

O Mac lê a máquina remota pela porta local que o túnel do usuário encaminha (`~/.ahrena-console/machines.json`: Workstation em `14720`, encaminhada pelo `LocalForward 14720 127.0.0.1:4720` do host `ahrena-tunnel`). Os pedidos saem de `loopbackGet` (`telemetry/adapters/loopback-http.ts`) e `loopbackWrite` (`clouds/remote-connectors.ts`) com `Host: 127.0.0.1:4720`, sem `Origin` e sem prova nenhuma. Quem os usa hoje:

| Chamada | Onde | Tipo |
| --- | --- | --- |
| `GET /api/telemetry`, `GET /api/attention` | `telemetry/remote.ts` | leitura privada, a cada 30 s |
| rotas de tela da remota (sessões, painel) | `api/machine-reader.ts` | leitura privada |
| `GET /api/connectors`; `POST`/`DELETE …/aws/sessions/<nome>/login` | `api/clouds.ts` | leitura e escrita (login AWS) |
| `GET`/`POST /api/ports/release` | `api/ports.ts` | ação remota (0016) |
| ações do Docker | `api/docker.ts` | ação remota (0017) |
| sinais aos terminais | `telemetry/terminal-actions.ts` | ação remota (0018) |

Nenhuma delas leva prova, então um núcleo da `main` do lado de lá responde 403 e o Mac mostra a máquina sem conexão (`owner-auth-required`). Em 11/11 a Workstation teve de voltar ao commit `81251bd`, de antes da #391: nada novo chega lá até isto se resolver.

O que já existe e qualquer solução tem de respeitar:

- **Qualquer usuário do Mac alcança `127.0.0.1:14720`.** A porta encaminhada é TCP de loopback, sem dono. E, com o túnel caído, outro usuário pode ocupar `14720` e receber o que o núcleo do Mac mandar para lá. Origem e "veio pelo túnel" não são identidade (0003, #302).
- **O token do Mac nunca vai para a remota** (0003). E o token da remota prova o dono de lá com poder total, inclusive para as rotas que nunca deveriam ser chamadas de fora.
- **O túnel já é uma sessão SSH autenticada como o dono de lá.** O host `ahrena-tunnel` tem `ControlMaster auto` e `ControlPath ~/.ssh/cm-%n`, então um segundo `ssh ahrena-tunnel <comando>` passa pela mesma conexão, sem abrir outra sessão do SSM. O mesmo host tem `SessionType none`, que um comando precisa desfazer com `-o SessionType=default`. O arquivo é gerado pelo `connect.sh` do plugin `ahrena-workstation`, não por este repositório.
- **O que o Mac roda para a remota é sempre um comando que o usuário escreveu** em `machines.json`, em lista, sem shell (0012, 0013 §4). O núcleo nunca monta um comando SSH. A saída do runner de reconexão vai inteira para `reconnect.log` (`telemetry/reconnect.ts`): lugar errado para qualquer segredo.
- **O que a remota responde não é autenticado.** Um impostor na porta pode mandar dados falsos. Isso é do pareamento ([#315](https://github.com/ahrenatechnology/ahrena-console/issues/315)); aqui o problema é o inverso, o Mac provar o dono à remota.

## Decisão

**O Mac roda um comando fixo pelo SSH que já entrou na remota. Do lado de lá, a CLI do núcleo lê a trava do próprio usuário e pede ao núcleo uma credencial curta, presa a esse núcleo, a esse processo e a esse usuário. A credencial volta pelo stdout do `ssh`, fica só na memória do núcleo do Mac, e cada pedido pelo túnel leva uma assinatura de uso único feita com ela, nunca a credencial. A remota aceita a assinatura só nas rotas de uma lista fechada; as ações continuam pedindo `--accept-remote-actions` além dela.**

### 1. A entrega: o comando de credencial

- **`machines.json` ganha `connection.credential`**: `{ "command": [...], "timeoutSeconds": 20 }` (5 a 60 s), com as regras de `start` e `stop` (lista, sem shell, sem expansão). Um `credential` inválido derruba só esse campo, com uma linha de log. Sem ele, a máquina fica como hoje: sem prova, e `owner-auth-required` se a remota exigir. Para a Workstation, o recomendado:

  ```json
  "credential": { "command": ["/usr/bin/ssh", "-T", "-o", "BatchMode=yes", "-o", "SessionType=default",
      "-o", "ControlMaster=no", "-o", "ClearAllForwardings=yes", "ahrena-tunnel",
      "node", "<checkout>/packages/nucleo/src/owner/cli.ts", "remote-credential", "--port", "4720"],
    "timeoutSeconds": 20 }
  ```

  `ControlMaster=no` usa a conexão mestra do túnel quando ela existe e nunca vira mestra; `ClearAllForwardings=yes` impede que, sem mestra, este `ssh` tome as portas do túnel. O comando e seus argumentos são constantes: nenhum segredo passa por argv, nem do lado de cá nem do de lá.

- **O pedido vai pelo stdin.** O núcleo do Mac escreve uma linha JSON, `{"version":1,"nonce":"<32 hex>"}`, e fecha o stdin. O nonce é novo a cada pedido, para que uma resposta velha (gravada, repetida por um wrapper) não sirva.
- **A resposta vem pelo stdout**, uma linha JSON de até 4 KiB:

  ```
  { version: 1, nonce, credentialId, key, machineIdentity, uid, corePid, corePort, generation, issuedAt, expiresAt }
  ```

  `key` são 32 bytes aleatórios (base64url); `credentialId` e `generation` são 16 bytes em hex; os tempos são em ms, no relógio da remota.
- **Um runner próprio, não o de reconexão.** O processo filho sobe sem shell; o stdout vai por pipe para a memória, com teto de 4 KiB (passou, mata o grupo e falha); o stderr é descartado (`ignore`); o timeout mata o grupo do processo. Nada da saída vai para `reconnect.log`, `nucleo.log` ou resposta HTTP. O log diz só `credential (<id>): ok`, ou `failed (exit <n> | timeout | invalid-output | nonce-mismatch)`.
- **Do lado de lá, `core remote-credential --port <n>`** (subcomando de `packages/nucleo/src/owner/cli.ts`):
  1. lê o stdin (até 1 KiB) e valida o pedido;
  2. acha, no registro de instâncias, o núcleo deste usuário que ouve na porta pedida, confere com `verifyInstance` e lê o token da trava com `readOwnerToken` (dono do arquivo é o uid do processo, modo 0600, sem symlink);
  3. faz `POST /api/owner/remote-credentials` em `127.0.0.1:<porta>` com `Authorization: Bearer <token de lá>` e o nonce no corpo;
  4. escreve a resposta no stdout, e mais nada.

  Saídas: `0` emitida; `2` nenhum núcleo deste usuário nessa porta; `3` o núcleo não tem a rota (é anterior a esta decisão); `1` qualquer outra falha. O stderr traz só mensagens fixas em inglês, sem token nem chave.
- **A rota de emissão, `POST /api/owner/remote-credentials`**, só no núcleo de lá: pede o bearer do dono **local** (o da trava), `Host` de loopback, **nenhum** `Origin` (com `Origin` é 403: não é rota da `/ui`), `application/json`, corpo de até 1 KiB. Nunca aceita uma credencial remota: uma credencial não emite outra.

### 2. A amarração da credencial

O núcleo de lá guarda cada credencial **só na memória**, num registro `{ credentialId, key, uid, corePid, corePort, generation, machineIdentity, issuedAt, expiresAt, seenNonces }`:

- **Geração:** `generation` são 16 bytes aleatórios sorteados quando o processo sobe. Reiniciar o núcleo apaga a tabela e muda a geração: toda credencial anterior deixa de existir.
- **Processo e porta:** `corePid` e `corePort` são os do núcleo que emitiu. A CLI só pede a quem ouve na porta pedida e confirma o pid pelo `/api/overview`.
- **Dono do SO:** só quem lê a trava 0600 emite, ou seja, o uid dono do núcleo. O `uid` vai na credencial; o verificador confere que é o seu.
- **Identidade da máquina:** `machineIdentity` é o SHA-256 de `ahrena-console-machine-v1\n` mais o `/etc/machine-id` (no macOS, o `IOPlatformUUID`). Não é segredo; é estável. O Mac fixa `{ machineIdentity, uid }` de cada máquina na primeira emissão boa e guarda na memória pela vida do processo, como já faz com `SessionPortals`. Se uma emissão posterior trouxer outro valor, recusa e marca `owner-auth-mismatch`. Fixar em disco e parear de verdade é da #315.
- **Antes de assinar o primeiro pedido**, o Mac lê o `GET /api/overview` anônimo pela porta do túnel e confere que o `pid` é o `corePid` da credencial. Se não for, a porta leva a outro núcleo: não assina nada, descarta a credencial e marca `owner-auth-failed`.
- **Nunca o token do Mac.** O pedido pelo stdin leva só versão e nonce. A credencial é emitida lá, com material de lá.

### 3. O uso: uma assinatura por pedido, nunca a chave

Cada pedido pelo túnel leva:

```
Authorization: AhrenaRemote id=<credentialId>, ts=<ms>, nonce=<32 hex>, sig=<64 hex>
sig = HMAC-SHA256(key, "ahrena-remote-v1\n" + method + "\n" + rawPath + "\n" + host + "\n"
                       + generation + "\n" + ts + "\n" + nonce + "\n" + hex(SHA-256(body)))
```

- `ts` é o relógio da remota estimado pelo Mac (`issuedAt` menos a hora do Mac quando a resposta chegou, somado à hora atual). Assim a diferença de relógio entre as máquinas não importa.
- **A remota aceita** só se: `id` existe, não expirou e não foi despejada; `generation` e `uid` são os seus; `|ts - agora| ≤ 30 s`; o nonce não foi visto nessa credencial (a memória de nonces cobre a janela, e com mais de 10 000 o pedido é recusado); `sig` confere em `timingSafeEqual`; e método mais caminho cru estão na lista fechada (§5).
- **A chave nunca sai do processo do Mac.** O que passa pela porta é uma assinatura presa a método, caminho, corpo, hora e nonce. Quem ocupar `14720` com o túnel caído, ou ler um pedido, leva uma assinatura que não vale para outra rota, outro corpo, de novo, ou daqui a 30 s.
- **O cabeçalho nunca vai para log.** Os erros dizem só o motivo.

### 4. Vida, renovação, reconexão e revogação

- **Validade de 10 minutos.** O Mac renova quando faltam 2 min, ou quando recebe `401` (`credential-unknown`, `credential-expired`, `credential-clock`), e repete o pedido uma vez. Uma renovação por máquina por vez; quem chega no meio espera a que está em curso. Se a renovação falha, o Mac espera 30 s, 60 s, e depois até 5 min entre tentativas, para que um `ssh` quebrado não vire um `ssh` por pedido.
- **No máximo 3 credenciais vivas por núcleo.** Emitir a quarta despeja a mais antiga.
- **O Mac joga fora a credencial** quando a conexão da máquina reinicia ou para (start, stop, reconnect), quando a porta fecha (`port-closed`), quando a remota responde `credential-unknown` e quando a identidade muda.
- **Reiniciar o núcleo de lá é a revogação.** A tabela some e a geração muda; o próximo pedido do Mac recebe `401 credential-unknown`, ele renova pelo SSH e segue. Nenhum estado sobrevive em disco.
- **Streams e long polls fecham sem o último pedaço.** A guarda é a mesma da `authorizeOwner`: um timer de 100 ms e uma checagem a cada `writeHead`, `write`, `end`, `flushHeaders` e `addTrailers`. Quando a credencial que abriu a resposta expira, é despejada ou a geração muda, a resposta é destruída (`res.destroy()`), sem um evento final. O Mac reabre com uma assinatura nova. Hoje nenhuma chamada do Mac abre stream na remota; a regra vale para a primeira que abrir.

### 5. Quais chamadas levam a assinatura

O verificador aceita a credencial remota **só** nesta lista, por método e caminho cru exato. Qualquer outra rota com `AhrenaRemote` recebe 403 `credential-route`, mesmo que o token do dono de lá a aceitaria:

| Rotas | Além da credencial |
| --- | --- |
| `GET /api/telemetry`, `GET /api/attention`, as rotas de tela lidas por `machine-reader.ts`, `GET /api/connectors` | nada |
| `POST`/`DELETE /api/connectors/aws/sessions/<nome>/login` (corpo fixo `{"mode":"device-code"}`) | nada: é a escrita que já existe e que a 0013 §2a liberou para o Mac |
| `POST /api/ports/release`, as ações do Docker, os sinais aos terminais | **`--accept-remote-actions`** (ou `AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1`) do lado de lá, como na 0016, na 0017 e na 0018 §4. A credencial não substitui a opção; sem ela, continua 403 |
| `POST /api/owner/remote-credentials` e qualquer outra rota | nunca |

A lista mora num lugar só, no núcleo de lá, ao lado da `ownerProofRequired`. Cada rota nova que o Mac passar a chamar entra nela num PR revisado.

O lado do Mac injeta a assinatura em `loopbackGet` e `loopbackWrite` (um assinador por porta de máquina). Assim todas as chamadas da tabela do Contexto levam a assinatura sem mudar cada rota.

### 6. Sem prova, fechado

- **`owner-auth-required` continua sendo o estado sem prova**: sem `connection.credential`, a CLI de lá respondeu `2` ou `3`, ou a remota respondeu 403 a um pedido sem assinatura.
- **Dois motivos novos**, para a tela dizer o que fazer: `owner-auth-failed` (o comando falhou, estourou o tempo, respondeu fora do formato ou com o nonce errado, o pid não confere, ou a remota recusou de novo depois de renovar) e `owner-auth-mismatch` (a identidade ou o uid mudaram desde a primeira emissão).
- **Compatível com o núcleo antigo.** Um núcleo de antes da #391 (o `81251bd` da Workstation) não exige prova: o comando de credencial sai com `3`, o Mac pede sem assinatura e recebe 200. A Workstation volta para a `main` só depois que o lado de lá desta decisão estiver lá.
- **Nada de Origin nem de "veio pelo túnel".** Nenhuma opção aceita pedido do túnel sem assinatura, e nenhum `Origin` substitui a prova. Um pedido com `AhrenaRemote` e qualquer `Origin` é recusado (403), porque o Mac nunca manda `Origin`.

### 7. O que não vaza

| Lugar | Por quê |
| --- | --- |
| argv (Mac e remota) | o comando é constante; pedido e resposta vão por stdin e stdout |
| URL, query | a assinatura vai no cabeçalho; nenhuma rota lê credencial da URL |
| logs (`nucleo.log`, `reconnect.log`, `hooks.log`) | runner próprio sem log de saída; o log tem só o resultado; o cabeçalho nunca é logado |
| HTML, `/ui`, `GET /api/machines`, registro de instâncias, `status` | a chave fica num `Map` privado do núcleo do Mac, fora de toda projeção; a tela recebe só o motivo |
| texto de erro (Mac e remota) | erros com motivo fixo, nunca com cabeçalho, chave, id de credencial ou saída do comando |
| stderr do `ssh` | descartado |

## Alternativas rejeitadas

- **Mandar o token do Mac para a remota.** Proibido pela 0003: entrega o dono do Mac a outra máquina.
- **Aceitar o túnel ou um `Origin` como prova** (uma opção `--trust-tunnel`). É o que a #302 fechou: qualquer usuário do Mac alcança `14720`.
- **Copiar o token da trava de lá pelo SSH** (`ssh ahrena-tunnel cat …/nucleo.json`). É a menor mudança e funciona, mas põe no Mac um bearer com poder total sobre o núcleo de lá, inclusive sobre rotas que nunca deveriam ser chamadas de fora e sobre a própria emissão. Esse bearer vale até o próximo reinício, não tem escopo e, se vazar uma vez, pode ser repetido.
- **Uma credencial curta, mas como bearer simples.** Seria mais simples do que assinar cada pedido. Só que o bearer viaja em todo pedido pela porta que qualquer usuário do Mac alcança: quem tomar `14720` com o túnel caído junta um bearer válido por 10 min e o usa quando o túnel voltar. A assinatura por pedido reduz esse vazamento a um pedido só, já gasto. O custo é um HMAC por pedido e uma memória de nonces, tudo com `node:crypto` e sem dependência.
- **Um socket Unix encaminhado pelo SSH** (`LocalForward <sock> <sock remoto>`, a "Unix socket" da 0003). A fronteira do SO é forte, mas: o `~/.ssh/ahrena-workstation.conf` é gerado pelo `connect.sh` de outro plugin, que teria de mudar; toda conexão no socket seria o dono com poder total, sem escopo nem validade, e sem separar leitura de ação; o Node não expõe a credencial do par (`SO_PEERCRED`); e todo o transporte do Mac (`loopbackGet`, `loopbackWrite`, `machines.json` por porta) mudaria. Fica como caminho se um dia o núcleo gerenciar o túnel.
- **Cada pedido como um comando SSH** (`ssh ahrena-tunnel curl …`). Um processo por pedido; sem a mestra, uma sessão do SSM por pedido; e não serve para stream.
- **TLS mútuo no núcleo.** Exige certificados, emissão e rotação, e nada disso existe no repositório.
- **Assinar com a chave SSH do usuário (ssh-agent).** O núcleo do Mac teria de falar com o agente, e o de lá de ler `authorized_keys`. Muito mais superfície que um HMAC com uma chave que o próprio núcleo emite.

## Plano de testes

Tudo com SSH falso e núcleo falso, sem rede e sem a Workstation. O **SSH falso** é um executável de teste que grava o próprio argv, lê o stdin e responde por script: emitir pelo núcleo falso, falhar, demorar, responder lixo, devolver outro nonce, outra identidade ou outro uid. O **núcleo falso** é o servidor real do núcleo, numa porta de teste, com relógio, geração e uid injetáveis. Os critérios da #388, numerados:

1. **Outro usuário, local ou remoto, sem prova não lê dados privados nem dispara ações, nem com `Origin` forjado.**
   - Rotas da lista sem `Authorization` → 403 `owner-auth-required`.
   - `AhrenaRemote` válido com `Origin: http://127.0.0.1:4720` → 403.
   - Assinatura de um `GET /api/telemetry` reapresentada num `POST …/login` → 403.
   - Rota fora da lista com assinatura válida → 403 `credential-route`.
   - Ação remota com assinatura válida e sem `--accept-remote-actions` → 403.
   - Emissão sem o bearer de lá, ou com `Origin` → 403.
   - O verificador recusa uma credencial emitida para outro uid (**wrong owner**).
2. **As vistas configuradas voltam depois de reinício e reconexão; a prova velha é recusada; streams revogados fecham sem o último pedaço.**
   - Reiniciar o núcleo falso (geração nova) → a credencial velha leva 401 `credential-unknown` → o Mac renova pelo SSH falso → `connected` no ciclo seguinte.
   - Um `start` da conexão descarta a credencial e emite outra (**reconnect**).
   - Um SSE aberto com uma credencial que expira, é despejada ou muda de geração é destruído: o cliente de teste não recebe nenhum byte depois do instante da revogação (**expiry**).
   - Relógio além de `expiresAt` → 401 `credential-expired`, renovação e um único novo pedido.
3. **Nenhum token aparece em GET/HTML, logs, argv, saída do registro ou texto de erro.**
   - Com chave e token sentinela, a varredura cobre:
     - os logs capturados e o `reconnect.log`;
     - o argv gravado pelo SSH falso;
     - o stdin que ele recebeu, onde só pode haver versão e nonce, e nunca o token do Mac;
     - `GET /api/machines`, `GET /api/machines/<id>/connectors` e a `/ui`;
     - os registros de instância e todo corpo de erro, do Mac e da remota.
   - O sentinela não pode aparecer em hex, base64 nem base64url (**no-token-leak**).
4. **Os testes com SSH falso e núcleo falso cobrem máquina errada, dono errado, replay, expiração e reconexão.**
   - **Wrong machine:**
     - uma emissão com outra `machineIdentity` depois da primeira → `owner-auth-mismatch`, e nada é assinado;
     - a porta do túnel apontando para outro núcleo falso → o `pid` do `/api/overview` não confere → `owner-auth-failed`, e nada é assinado;
     - o outro núcleo recusa a credencial que não emitiu.
   - **Wrong owner:** o uid muda entre duas emissões → `owner-auth-mismatch`; o verificador recusa um uid diferente do seu.
   - **Replay:**
     - o mesmo nonce duas vezes → 403 `credential-replayed`;
     - `ts` fora da janela de 30 s → 401 `credential-clock`;
     - uma resposta do comando com outro nonce → `owner-auth-failed`.
   - **Expiry** e **reconnect**, como no critério 2.
   - **Sem inferência real:** nada nesta decisão chama um modelo, e os gates da #377 e da #382 ficam como estão.

Cada arquivo de teste nomeia o critério que cobre (`AC1` a `AC4`), para a rastreabilidade de `writing-acceptance-criteria`.

## Pilha planejada

Concern roteado pela tabela: backend para o núcleo, frontend para o texto da tela. Não há camada de dados, porque nada vai para o SQLite. Cada camada passa pelo ciclo desenvolver → Argos (no máximo três rodadas) antes de abrir, e as camadas entram em pilha, nesta ordem:

1. **apollo · emissão e verificação na remota.** Geração por processo, identidade da máquina, `POST /api/owner/remote-credentials`, a tabela em memória (validade, despejo, nonces), o verificador `AhrenaRemote` na `authorizeOwner` com a lista fechada e `--accept-remote-actions` nas ações, a guarda de streams e `core remote-credential`. Testes AC1, AC2 (lado de lá) e AC4 (replay, dono errado).
2. **apollo · o Mac obtém e usa a credencial.** `connection.credential` em `machines.json`, o runner próprio (stdout em memória, stderr descartado, sem log), a prova por máquina (renovação, recuo, fixação, diferença de relógio, conferência do pid), a assinatura injetada em `loopbackGet` e `loopbackWrite`, e os motivos `owner-auth-failed` e `owner-auth-mismatch` em `MachineStatus`. Também o exemplo no README e uma linha de emenda na 0003 e na 0018 §4 apontando para cá. Testes AC2, AC3 e AC4 de ponta a ponta.
3. **iris · o que a tela diz.** Primeiro o wireframe dos três motivos (cartão da máquina, barra lateral e a faixa P14 do mod), aprovado pelo Fernando; depois os textos em pt-BR. Cada um diz o que fazer: configurar o comando de credencial, atualizar o núcleo de lá, ou conferir se o túnel leva à máquina certa.

A Workstation sai do `81251bd` só depois que a camada 1 chegar lá, por um passo do Fernando fora desta pilha.

## Fora do escopo

- Inferência real, e a execução gerenciada da [#376](https://github.com/ahrenatechnology/ahrena-console/issues/376), [#377](https://github.com/ahrenatechnology/ahrena-console/issues/377) e [#382](https://github.com/ahrenatechnology/ahrena-console/issues/382).
- O aviso de versão e a atualização do núcleo remoto ([#449](https://github.com/ahrenatechnology/ahrena-console/issues/449)).
- Autenticar o que a remota responde ao Mac e fixar a identidade em disco: pareamento, [#315](https://github.com/ahrenatechnology/ahrena-console/issues/315).
- O Mac com mais de um usuário humano no mesmo usuário do SO: fora, como na 0013.
- Qualquer release do app ou do núcleo, e qualquer mudança no `connect.sh` do plugin `ahrena-workstation`.

## Consequências

- **Configuração por máquina.** Cada máquina remota precisa de um `connection.credential`. Sem ele, fica em `owner-auth-required`, com a tela dizendo o que configurar.
- **Cada renovação roda um `ssh`.** É uma a cada ~8 min por máquina, pela conexão mestra quando ela existe. Sem a mestra, vira uma sessão nova do SSM (mais lenta), mas só quando o túnel caiu, e aí a leitura já falharia de qualquer jeito.
- **Um esquema de autenticação a mais no núcleo.** São dois caminhos de prova (bearer local e `AhrenaRemote`) para manter, e a lista fechada (§5) cresce, num PR revisado, a cada rota nova que o Mac chamar na remota.
- **Um stream remoto fecha a cada 10 min**, no máximo, e o Mac o reabre.
- **A prova é do dono, não do agente.** Não substitui as checagens de identidade e de cobrança da #377 e da #382.
