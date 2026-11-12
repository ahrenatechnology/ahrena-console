# 0021 · Núcleo remoto: o Mac mostra a versão de lá e avisa quando está defasada; o comando versionado atualiza com backup, trava antes de parar e supervisor do systemd

- **Status:** aceita (o Fernando aceitou, PR #457)
- **Data:** 2026-11-12
- **Issue:** [#449](https://github.com/ahrenatechnology/ahrena-console/issues/449)
- **Depende de:** [0020](0020-remote-owner-credential-over-ssh.md) / [#388](https://github.com/ahrenatechnology/ahrena-console/issues/388) (a `main` só roda na remota com a prova do dono)
- **Estende:** [0012](0012-remote-reconnect.md) e [0013](0013-cloud-connectors-and-machine-connection.md) §4 (o Mac só roda comando que o usuário escreveu, em lista, sem shell; o núcleo nunca abre SSH) e [0020](0020-remote-owner-credential-over-ssh.md) §5 (a lista fechada de rotas assinadas)
- **Toca:** [0009](0009-english-internals.md) (nomes em inglês, texto da tela em pt-BR)

## Contexto

O app desktop atualiza só o núcleo embutido no Mac. O da Workstation é um checkout iniciado à mão (`setsid nohup … cli.ts &`), sem instalador, sem atualizador, sem supervisor. Em 11/11 ele rodava o `81251bd` (22/10, 201 commits atrás) como processo órfão, e as correções da #431 e da #446 não chegaram lá. Fatos do código que a proposta usa:

- **`GET /api/overview` já diz a versão e o commit, e é anônima.** `api/server.ts` responde `{ ok, name, version: API_VERSION, pid, commit }`, e `ownerProofRequired` a deixa de fora da prova (`api/owner-auth.ts`). `commit` vem de `checkoutCommit()` na subida (`api/cli.ts`): é o commit do **código que roda**, `null` fora de um checkout. `API_VERSION` é o `version` de `packages/nucleo/package.json`, que acompanha o app (`apps/desktop/package.json`, `tauri.conf.json` e `Cargo.toml` estão na 0.0.16; a #261 manda o release subir os dois).
- **O `81251bd` também responde isso.** `git show 81251bd:packages/nucleo/src/api/server.ts` tem a mesma linha, com `version: "0.0.7"` (o `package.json` de lá só sobe em release). Ou seja, a Workstation não "não reporta nada": reporta 0.0.7 e o commit. Um corpo sem `version` válida é o único "desconhecido".
- **A telemetria só carrega o protocolo.** `GET /api/telemetry` devolve `version: TELEMETRY_VERSION` (inteiro, hoje `1`, `telemetry/model.ts`); `telemetry/remote.ts` compara com `===` e marca `incompatible-version`. Ela é privada: com `owner-auth-required` ela nem responde, que é justo o estado que esta issue quer avisar.
- **O Mac já lê o `/api/overview` da remota** (`overviewPidVia`, `telemetry/remote-proof.ts`, 0020 §2) por `loopbackGet`, sem prova.
- **Não existe nada de atualização no repositório para a remota:** `scripts/` tem só medições e o guard do client id; a `plugins/ahrena-console` é de hooks do Claude. O núcleo gera `nucleo.sqlite` (+ `-wal`/`-shm`), `nucleo.log`, `nucleo.json` (trava) e `core.starting` na `--data-dir` (`owner/README.md`). Os pacotes `.ts` rodam direto no Node 24, sem `npm install` (o `package.json` do núcleo só tem uma devDependency).

## Decisão

**O Mac passa a ler a versão e o commit de cada máquina remota no `/api/overview` e avisa, na tela, quando a versão é menor que a do app, mostrando o comando exato para rodar na máquina. A atualização é um script versionado, rodado pela pessoa lá, que recusa antes de parar o processo quando o alvo deixaria a máquina sem conexão. O núcleo remoto passa a rodar sob uma unidade de usuário do systemd. Nada atualiza sem a pessoa pedir.**

### 1. Como o Mac sabe a versão (AC1)

**Rota: nenhuma nova. O `/api/overview` anônimo, que já existe em todo núcleo.** Não entra nada na lista fechada do 0020 §5 (anônima não leva assinatura) e ela responde também com `owner-auth-required`, `owner-auth-failed` e `owner-auth-mismatch`. A leitura é um `loopbackGet` a mais por ciclo de 30 s depois da telemetria, em `telemetry/remote.ts`, que reaproveita o parser do pid.

Campos novos em `MachineSummary` (`telemetry/model.ts`), em um objeto só porque `version` já é o protocolo da telemetria:

```ts
core: {
  version: string | null;   // /^\d+\.\d+\.\d+$/ ou null
  commit: string | null;    // /^[0-9a-f]{4,40}$/ ou null
  expectedVersion: string;  // API_VERSION do núcleo do Mac
  mac: { telemetryVersion: number; credentialCommand: boolean; checkout: string | null }; // o que o Mac declara à trava (§4)
  status: 'current' | 'outdated' | 'ahead' | 'unknown';
  readAt: string | null;    // ISO da última leitura boa
} | null                    // null enquanto nunca leu (e para a máquina local)
```

- **Comparação:** semver numérico `major.minor.patch` (prerelease ignorado). `outdated` se a remota é menor que a do app; `current` se igual; `ahead` se maior (sem aviso: a pessoa pode estar numa `main` mais nova); `unknown` se o corpo não tem `version` ou `commit` válidos, ou o `/api/overview` falhou. O texto cru da remota nunca vai para a tela (só os dois padrões acima, com teto de 64 caracteres).
- **O commit informa, não decide.** `package.json` só sobe em release, então duas versões iguais podem ser códigos diferentes. A tela mostra o commit ao lado da versão. Só quando o núcleo do Mac roda de um checkout (`codeCommit()` não é `null`) e as versões são iguais, `isOlderCommit(core.commit)` (`owner/commit.ts`) promove `current` a `outdated`. O app empacotado, sem git, fica só no semver.
- **O que isso não é:** a leitura é anônima, então um impostor na porta responde o que quiser. Serve para avisar, nunca para decidir uma atualização; quem decide é o script, lendo o git de lá (§3).

**Alternativas rejeitadas:** (a) pôr a versão na telemetria: é privada, fica vazia justo em `owner-auth-required`, e inflaria um protocolo que só compara um inteiro; (b) uma rota nova (`/api/version`): cresceria a superfície anônima ou a lista fechada para dar um dado que o `/api/overview` já dá; (c) o Mac rodar `ssh … git rev-parse` pela conexão: o núcleo não abre SSH (0012, 0013 §4, 0020).

### 2. Como a atualização é disparada

**Recomendado: a tela só avisa e mostra o comando para copiar. O Mac não executa nada.** Sem processo filho, sem job; o único campo novo no `machines.json` é o `connection.checkout` abaixo, que só alimenta o texto da tela. O aviso diz o que fazer ("o núcleo de lá está na 0.0.7 e o app na 0.0.16; rode isto na Workstation"), e o bloco traz o comando do §3 com o `--ref app-v<versão do app>` e as duas flags de trava já preenchidas (§4). A pessoa cola no terminal da máquina (por SSH, VS Code, o que usar).

**O caminho do checkout: `connection.checkout`.** Campo opcional, por máquina, no `machines.json` do Mac (ao lado de `start`, `stop` e `credential`), validado como caminho absoluto de texto (começa com `/`, sem `..`, sem NUL, sem expansão de shell nem de `~`, até 512 caracteres). Um `checkout` inválido derruba só esse campo, com uma linha de log, como o `credential`. Nunca é executado: só entra no texto do comando. O núcleo o expõe como `core.mac.checkout` (e nenhum outro dado do `machines.json`). Presente, a tela preenche o comando com ele; ausente, usa o literal `<checkout>`. A decisão de que `--ref` é sempre explícito, `app-v<versão do app>`, nunca "o mais novo", fica como está.

**Quando a tela mostra o comando de atualização:** só para um alvo cujo release carrega **os dois**, `scripts/remote-core/update-remote-core.mjs` e `packages/nucleo/remote-contract.json`. Para tags anteriores (a 0.0.16 e as de antes, sem script nem manifesto) o `--ref app-v<versão>` não funcionaria, então o Mac mostra, no lugar, as **instruções de bootstrap**: pegar o script da `main` (ou da primeira tag que o traz), rodar com `--check` e então com `--allow-disconnect` se a pessoa decidir. O núcleo conhece a primeira versão que carrega os dois (uma constante, `FIRST_UPDATER_VERSION`) e escolhe o texto.

**Alternativa rejeitada (por ora): `connection.update` no `machines.json`**, um comando em lista que o Mac roda como `start` e `stop` (0013 §4). Ele reaproveitaria o runner, mas: para e troca um processo que funciona por um clique, o que o 0020 evita desde o início (o Mac só entra pelo SSH para ler e para uma credencial curta); exigiria job, progresso, cancelamento e log com a saída do script, e o rollback precisa de um humano olhando; e o escopo da issue é caminho "documentado e repetível", com atualização automática fora. Fica aberto como decisão própria depois que o script provar o rollback na Workstation. A trava do §4 já é feita para esse dia: o código de saída é legível por máquina.

**Fora do escopo, de novo:** qualquer atualização sem a pessoa pedir (agendada, ao detectar `outdated`, no `Reconectar`).

### 3. O comando de atualização (AC2, AC3)

**`scripts/remote-core/update-remote-core.mjs`**, ESM de um arquivo só, só `node:` embutido, Node 24 (o mesmo que o núcleo exige). Pasta do runbook: `scripts/remote-core/README.md`.

**Como roda, inclusive a primeira vez** (a Workstation de hoje não tem o script): o comando mostrado pela tela traz o script do alvo, de fora do checkout:

```
git -C <checkout> fetch origin --tags \
  && git -C <checkout> show app-v0.0.16:scripts/remote-core/update-remote-core.mjs > ~/.ahrena-console/update-remote-core.mjs \
  && node ~/.ahrena-console/update-remote-core.mjs --checkout <checkout> --ref app-v0.0.16 \
       --mac-telemetry-version 1 --mac-credential-command yes
```

Depois que o checkout o tem, `node scripts/remote-core/update-remote-core.mjs …` basta. `--ref` é obrigatório: tag `app-vX.Y.Z` (o padrão do release), `origin/main` ou um sha. O script nunca escolhe "o mais novo" sozinho.

**Passos, em ordem (nada para o processo antes do passo 4):**

1. **Preflight.** Checkout acessível; árvore sem mudança rastreada (`git status --porcelain --untracked-files=no`, senão sai `30`, sem `--force`: commits locais como o `local/workstation-link-cap` não somem, o script grava o HEAD velho e avisa que sairá de um ramo); `git rev-parse --verify <ref>^{commit}` resolve o sha. O `fetch` pode ser pulado com `--no-fetch` (testes).
2. **Trava (§4)**, lendo o alvo com `git show <sha>:…`. Recusa aqui, ainda sem tocar em nada.
3. **Backup com o núcleo ainda no ar.** Descobre o núcleo pela porta (`GET /api/overview`: `pid`, `version`, `commit`) e faz a cópia consistente de `<data-dir>/nucleo.sqlite` com `backup()` do `node:sqlite` para `<data-dir>/backups/update-<UTC>-<commit velho>/nucleo.sqlite` (o WAL é incorporado; copiar `nucleo.sqlite*` solto com o processo escrevendo não seria consistente). Mantém os 5 últimos. Falhou: sai `31` e o processo segue de pé.
4. **Parar.** Se a unidade está ativa, `systemctl --user stop ahrena-console-core.service`. Senão (processo órfão), o `pid` do `/api/overview` é só uma dica: ele é anônimo e forjável (um impostor na porta responde o pid que quiser, 0020 §2), então **nenhum sinal sai antes de o script verificar o processo**: `/proc/<pid>/cmdline` tem o `src/api/cli.ts` do checkout e o `--port` pedido, e o uid dono do processo (`/proc/<pid>/status`) é o do próprio script (`process.getuid()`). Qualquer divergência sai `32` e nada é parado. Verificado, manda `SIGTERM`, espera até 15 s e só então `SIGKILL`, e confere que a porta liberou. Esse mesmo `cmdline` fornece os argumentos reais para subir "com as mesmas opções" (`--port`, `--installation`, `--data-dir`, `--no-github`, `--accept-remote-actions`…), lidos **antes** de parar. **Sem `/proc`** (ou sem permissão de ler o `cmdline`), o script não chuta opções: recusa antes de parar (`32`), a menos que a pessoa passe as opções explicitamente (`--core-options "--port 4720 --installation dev --data-dir …"`), e só então verifica o dono pela porta (`ss -ltnp`) e segue.
5. **Trocar o código:** `git checkout --detach <sha>`. Sem `npm install`: se `git diff --name-only <velho> <novo> -- package-lock.json packages/nucleo/package.json` listar dependências de produção novas, o script para antes do passo 4 e avisa (hoje não há). Registra velho→novo em `update.log`.
6. **Subir.** Sob a unidade: `systemctl --user start …`. Sem a unidade, o comando de referência, dentro de `packages/nucleo`:

   ```
   setsid nohup /usr/bin/node --disable-warning=ExperimentalWarning <checkout>/packages/nucleo/src/api/cli.ts \
     --port 4720 --installation dev --data-dir $HOME/.ahrena-console --no-github \
     >> ~/.ahrena-console/core-stdout.log 2>&1 < /dev/null &
   ```

   e avisa em uma linha que ele é órfão e que `install-unit` resolve.
7. **Conferir que respondeu.** Até 30 s: `GET /api/overview` 200 com o `commit` igual ao alvo e a `version` do `package.json` do alvo. Se o manifesto do alvo diz `ownerProofRequired: true`, roda também `node <checkout>/packages/nucleo/src/owner/cli.ts remote-credential --port <porta>` com um pedido válido no stdin e exige saída `0`: é a prova de que o Mac conseguirá entrar (a credencial emitida vale 10 min e some).
8. **Rollback se o 7 falhar** (ou o 6 não subir): para o processo novo, `git checkout --detach <commit velho>`, **restaura o `nucleo.sqlite` do backup** (apaga `-wal` e `-shm` antes; as migrações só andam para frente, então um banco já migrado não serve ao código velho) e sobe como no 6. Saída `40` se voltou e respondeu; `41` se o rollback também falhou (mensagem com os caminhos do backup e do commit velho; nada é apagado).

**Códigos de saída:** `0` atualizou e conferiu; `2` uso; `20` trava: protocolo da telemetria incompatível; `21` trava: o alvo exige prova do dono e o Mac não tem o comando de credencial; `22` trava: o alvo não traz o manifesto; `23` trava: faltam as flags do Mac; `30` árvore suja ou ref inexistente; `31` backup falhou; `32` o processo não confere (cmdline, porta ou uid) ou não há como ler as opções; `40` falhou e voltou; `41` falhou e o rollback falhou. `--check` roda só os passos 1 e 2 e sai com `0` ou o código da trava, sem tocar em nada: é o que a tela pode sugerir e o que os testes usam.

**A unidade do systemd** (`install-unit`, subcomando do mesmo script, a pessoa roda uma vez):

- Arquivo: `~/.config/systemd/user/ahrena-console-core.service`, gerado com caminhos absolutos (`process.execPath`, o checkout, a `--data-dir`), a partir de um texto embutido no script e repetido no README:

  ```
  [Unit]
  Description=Ahrena Console core
  After=network.target

  [Service]
  Type=simple
  WorkingDirectory=<checkout>/packages/nucleo
  ExecStart=<node> --disable-warning=ExperimentalWarning <checkout>/packages/nucleo/src/api/cli.ts --port 4720 --installation dev --data-dir %h/.ahrena-console --no-github
  Restart=on-failure
  RestartSec=5
  TimeoutStopSec=20
  StandardOutput=append:%h/.ahrena-console/core-stdout.log
  StandardError=inherit

  [Install]
  WantedBy=default.target
  ```

  O `ExecStart` é o do órfão (o núcleo já roda em primeiro plano; o `setsid nohup … &` é só de quem não tem supervisor). As opções vêm do `/proc/<pid>/cmdline` do núcleo vivo, já verificado como no passo 4, ou de `--core-options`; sem nenhum dos dois, `install-unit` recusa em vez de chutar.
- `install-unit` para o órfão (como no passo 4), grava a unidade, `systemctl --user daemon-reload && systemctl --user enable --now ahrena-console-core.service`, e confere o `/api/overview`. Em sessão SSH sem login completo ele define `XDG_RUNTIME_DIR=/run/user/$(id -u)` se estiver vazio, senão o `systemctl --user` não acha o barramento.
- **Linger.** Unidade de usuário só sobe no boot, sem login, com `loginctl enable-linger "$(id -un)"`. O script confere (`loginctl show-user "$(id -un)" -p Linger`) e, se for `no`, **imprime** o comando e sai `0` com o aviso; ele não chama `sudo`. O critério 3 só se prova depois dessa linha e de um reboot (§Testes).
- `Restart=on-failure` volta sozinho se o processo morrer; `systemctl --user stop` (parada limpa do §3) não é reiniciada.

### 4. A trava: recusar antes de parar (AC4)

**Um manifesto de contrato, versionado dentro do próprio checkout, que o script lê do alvo com `git show <sha>:packages/nucleo/remote-contract.json` antes de parar qualquer coisa.**

```json
{ "manifest": 1,
  "telemetryVersion": 1,
  "ownerProofRequired": true,
  "remoteCredentialCommand": "remote-credential" }
```

- `telemetryVersion`: o `TELEMETRY_VERSION` que o alvo responde. `ownerProofRequired`: o alvo recusa rota privada sem prova (a #391 em diante). `remoteCredentialCommand`: o subcomando de `owner/cli.ts` que o Mac precisa estar configurado para rodar em `connection.credential` (ou `null` se o alvo não tem emissão).
- **Fonte única, verificada:** o arquivo é escrito à mão (o contrato é a fonte, `contract-first`) e um teste do núcleo falha se `telemetryVersion !== TELEMETRY_VERSION`, se `ownerProofRequired` difere de `ownerProofRequired('GET', '/api/telemetry')`, ou se o subcomando não existe no `owner/cli.ts`. Quem muda um sem o outro não passa no CI.
- **O que o Mac declara**, por flags do comando que a tela mostra: `--mac-telemetry-version <n>` (o `TELEMETRY_VERSION` do núcleo do Mac) e `--mac-credential-command yes|no` (se **esta máquina** tem `connection.credential` válido em `machines.json` **e** o núcleo do Mac sabe usá-lo). A tela calcula os dois; o script não adivinha nada do Mac. São o `core.mac` do §1 (`telemetryVersion` e `credentialCommand`), então a tela só os imprime.
- **Regra, em ordem, antes do passo 3 do §3:**
  1. faltam as flags (e não há `--allow-disconnect`): sai `23` (falha fechada: sem o que o Mac declara, o script não sabe);
  2. o alvo não tem o manifesto (um `main` anterior a esta proposta, a 0.0.15, o `81251bd`): sai `22` (contrato desconhecido, não aprovado por omissão);
  3. `manifest.telemetryVersion !== --mac-telemetry-version`: sai `20` ("a telemetria de lá fala outra versão; o Mac a mostraria como `incompatible-version`");
  4. `manifest.ownerProofRequired` e `--mac-credential-command no`: sai `21` ("o Mac ficaria em `owner-auth-required`: configure `connection.credential` (0020 §1) antes").
- **`--allow-disconnect`** pula só as recusas `20`, `21`, `22` e `23`, imprime em letras claras que a máquina pode ficar sem conexão e que o passo 8 (rollback) continua valendo. Não pula preflight, backup nem a conferência. Existe porque o primeiro salto do `81251bd` para um alvo sem manifesto precisa de uma saída consciente; sem o flag, a trava seria um beco.
- **Limite honesto:** a trava confia no que a pessoa cola. Protege de acidente, não de uma flag errada de propósito, e o passo 7 (que roda a emissão da credencial lá) é a rede de baixo para o caso `21`.

**Alternativas rejeitadas:** (a) o script inferir o contrato lendo o código-fonte do alvo: frágil e acoplado a nomes; (b) o script perguntar ao Mac: não há caminho da remota para o Mac (só o inverso, o túnel); (c) o Mac gravar um arquivo de capacidades lá por um `ssh` próprio: o núcleo não monta SSH e seria um segundo comando por máquina; (d) variável de ambiente em vez de flag: invisível no que a tela mostra e mais fácil de ficar velha.

## Plano de camadas

Roteamento pela tabela: backend para o núcleo e o script, frontend para o texto. Sem camada de dados. Cada camada passa pelo ciclo desenvolver → Argos (no máximo três rodadas) antes de abrir, e as camadas entram em pilha.

1. **iris · wireframe**, aprovado pelo Fernando antes do código: o cartão da máquina e a barra lateral com `outdated`/`unknown`/`ahead`, o bloco do comando com "Copiar", e o aviso da trava (`20`/`21`).
2. **apollo · versão da remota no Mac.** `remote-contract.json` e o teste de coerência com as constantes; a leitura do `/api/overview` em `telemetry/remote.ts`, a comparação pura (arquivo próprio em `telemetry/`), `MachineSummary.core`, o que a API devolve, a leitura e a validação de `connection.checkout` em `machines-config.ts` e a `FIRST_UPDATER_VERSION`. AC1 (lado do núcleo).
3. **apollo · script, unidade e trava.** `scripts/remote-core/update-remote-core.mjs` (`--check`, atualização, rollback, `install-unit`), o README/runbook e a unidade. AC2, AC3 (unidade gerada e comandos do systemd) e AC4.
4. **iris · o que a tela diz.** Textos pt-BR de cada estado e da recusa, o comando com as flags da §4 e o `core.mac.checkout` (ou `<checkout>`). O aviso fica na seta amarela da barra lateral; sem alerta na lista de atenção nem linha na faixa P14 por ora. AC1 (tela).

A Workstation só é atualizada por um passo do Fernando fora desta pilha, depois da #388 no ar lá.

## Plano de testes

Sem SSH, sem a Workstation, sem a suíte inteira (só o arquivo tocado, `--test-concurrency=1`). O script é testado contra **repositórios git temporários** (dois commits, com e sem o manifesto) e um **núcleo falso**: um servidor HTTP mínimo que responde `/api/overview` com pid, versão e commit e some quando o processo é morto, com `systemctl` e `loginctl` falsos no `PATH`. Cada arquivo nomeia o critério (`AC1` a `AC4`).

1. **AC1 · a tela mostra a versão (ou o commit) de cada máquina remota e avisa quando é mais antiga, com texto do que fazer.**
   - Núcleo falso com `version` 0.0.7 e commit `81251bd` → `core.status = outdated`, `version` e `commit` no `GET /api/machines`; igual → `current`; maior → `ahead`; corpo sem `version` ou lixo → `unknown`; porta fechada → `core` `null` ou `unknown`.
   - Lido também com a máquina em `owner-auth-required` (a leitura é anônima).
   - Versões iguais com commit mais antigo, só quando o Mac tem checkout → `outdated`; sem checkout, `current`.
   - **`FIRST_UPDATER_VERSION` e `connection.checkout` (camada 2):** o comando de atualização só aparece para um app com versão `>= FIRST_UPDATER_VERSION`; abaixo dela a tela traz as instruções de bootstrap. `checkout` absoluto válido chega em `core.mac.checkout`; relativo, com `..`, `~`, NUL ou longo demais é descartado com uma linha de log, sem derrubar o resto da máquina, e `null` aparece na resposta.
   - Texto cru da remota (versão longa, HTML) nunca chega ao JSON. Texto da tela em pt-BR, com o comando e as flags corretas, na camada 3.
2. **AC2 · caminho documentado e repetível: backup, troca, sobe, confere.**
   - Repetível: rodar duas vezes o mesmo `--ref` na segunda é no-op (`0`, nada parado).
   - Atualiza o checkout temporário velho→novo com o núcleo falso: backup do `nucleo.sqlite` em `backups/update-*` (idêntico ao original), HEAD no alvo, núcleo com o mesmo argv, `/api/overview` confere.
   - Falha ao subir → exit `40`, HEAD e banco de volta, núcleo velho de pé. Rollback que também falha → `41` sem apagar o backup.
   - Árvore suja → `30`; backup impossível → `31` e o processo segue vivo.
3. **AC3 · supervisor, volta sozinho depois de reboot.**
   - `install-unit` gera exatamente a unidade do §3, com caminhos absolutos; chama `daemon-reload`, `enable --now` e confere o `overview`; órfão é parado antes; `Linger=no` imprime o `loginctl enable-linger` e não chama `sudo`.
   - Com a unidade ativa, a atualização usa `systemctl --user stop/start`, não `kill`.
   - **O reboot não se testa aqui:** a prova é do Fernando na Workstation (reiniciar e ver o núcleo voltar), registrada no PR da camada 2.
4. **AC4 · recusa antes de parar o processo que funciona.**
   - **Pid forjado:** um servidor falso responde o `/api/overview` com o pid de outro processo do mesmo usuário, e outro com um pid de outro uid (ou `cmdline` sem `cli.ts`/`--port`) → `32`, nenhum sinal enviado a ninguém. Sem `/proc` e sem `--core-options` → `32` antes de parar; com `--core-options` o fluxo segue.
   - O núcleo falso é o processo de verdade e o teste checa que o pid **não** mudou e nenhum `SIGTERM` chegou, em cada recusa.
   - Alvo com `ownerProofRequired: true` + `--mac-credential-command no` → `21`; `telemetryVersion` diferente → `20`; alvo sem manifesto → `22`; sem flags do Mac → `23`.
   - `--allow-disconnect` passa as quatro, e o rollback do AC2 segue valendo.
   - `--check` não toca em nada em nenhum caso.
   - Teste do núcleo: o manifesto do `main` bate com `TELEMETRY_VERSION`, `ownerProofRequired` e o subcomando de `owner/cli.ts`.

## Fora do escopo

- A prova do dono remota (#388, 0020) e o pareamento/autenticação do que a remota responde (#315).
- Atualização sem a pessoa pedir; um `connection.update` no `machines.json` (§2, decisão futura).
- Mudar o `connect.sh` do plugin `ahrena-workstation`, o release do app, ou rodar qualquer coisa na Workstation real.
- Supervisor em macOS (`launchd`): o núcleo do Mac é o do app.

## Consequências

- Uma leitura anônima a mais por máquina a cada 30 s, em loopback.
- Mais um arquivo à mão para manter (`remote-contract.json`), preso por teste às constantes que ele espelha.
- Passar a versão de lá para a tela depende de a remota responder o `/api/overview`; um impostor na porta pode mentir o aviso, nunca a trava (que lê o git do alvo).
- A atualização continua um passo humano por máquina. É o preço de manter o núcleo sem SSH e sem botão que para um processo que funciona.
