# App desktop

A bandeja do Ahrena Console na barra de menus do macOS, em Tauri 2 ([decisão 0005](../../docs/decisoes/0005-app-desktop.md), issue [#87](https://github.com/ahrenatechnology/ahrena-console/issues/87)). Veio da prova em [spikes/app-desktop](../../spikes/app-desktop/). O app complementa o Claude sem duplicar nada: não grava hooks nem configuração do Claude, não embute Node e não tem telas próprias. A janela abre a `/ui` do núcleo.

## O que faz

- **Número ao lado do ícone** (`tray.set_title`): as sessões esperando você ou com erro, em todas as contas. Com zero ou com o núcleo parado, só o ícone template.
- **Ícone template** em 18 e 36 px (`icons/tray.png` e `tray@2x.png`, de `tray.svg`): o macOS escolhe o nítido para cada tela e o pinta conforme a barra.
- **Menu**, como os wireframes A1, A2 e A4 (`docs/wireframes/index.html`, ids `app-bandeja-0`, `app-bandeja-3` e `app-parado`): o estado do núcleo, "N precisam de você" com o motivo e o tempo de cada sessão (urgentes primeiro: permissão, pergunta, plano e decisão; depois erro; depois a sua vez), "N ativas", "Abrir o console ⌘O", Notificações, Abrir no login, a versão e Sair.
- **Clique numa sessão:** por enquanto abre a conversa no Claude Desktop (`POST /open/<local_…>` do núcleo). Com ⌥, cada item vira "Abrir no Claude Desktop" (item alternativo nativo do macOS). Quando a janela do app mostrar a sessão (A5), o clique sem ⌥ passa a abrir lá.
- **Abrir o console:** uma janela com `http://127.0.0.1:<porta>/ui`. Fechar a janela não fecha o app.
- **Notificações** (A3, issue #88): uma notificação do sistema quando uma sessão **passa** a precisar de você (entra na lista ou troca de motivo), nunca a cada leitura; ao abrir e ao reencontrar o núcleo, quem já esperava não avisa. Título com a sessão e o motivo ("motor-de-regras pede permissão"), corpo com o que ela pede, som só em Pede permissão, Interrompida e Com erro. O clique e "Abrir" levam a janela a `/ui/sessions/<id>`; "Abrir no Claude Desktop" faz o `POST /open/<local_…>`; "Silenciar" cala só aquela sessão. A marca "Notificações" do menu liga e desliga tudo. As duas coisas ficam no app, não no núcleo: `notifications.json` no diretório de dados do app (`~/Library/Application Support/dev.ahrena.console/`). O clique e as ações vêm do `UNUserNotificationCenter`, com a categoria do A3 e a apresentação também com o app em primeiro plano: o plugin de notificação do Tauri tem `on_action` no desktop, mas no macOS só reporta o clique pelo `NSUserNotification` (obsoleto), com as ações num menu "Opções". Fora de um bundle (`cargo run`), o `UNUserNotificationCenter` não pode ser usado e o aviso sai pelo plugin; o app não registra `on_action` nele, por isso fica sem clique nem ações.
- **Máquinas** (A6 e A7, issue #180, [decisão 0008](../../docs/decisoes/0008-machine-telemetry-and-dev-console.md) seção 5): um bloco entre quem precisa de você e o pé, lido de `GET /api/machines` e de `GET /api/telemetry?machine=<id>` a cada volta do laço. Uma linha por máquina ("Este Mac" e o rótulo de cada remota do `machines.json`) com a CPU (ou a carga contra os núcleos, quando passa deles) e o volume mais cheio, e um item por alerta aberto; o clique abre a janela em `/ui/machines/<id>`. Remota sem conexão: ponto cinza, "sem conexão há N min" (de `lastReadAt`) e uma linha com o que o núcleo viu, sem item para subir o túnel. As sessões remotas que esperam entram na lista de cima com o rótulo da máquina e sem o ⌥ "Abrir no Claude Desktop". O número da barra continua só de sessões. Um alerta novo, ou uma máquina que cai, notifica uma vez, na passagem e sem som, sob a mesma marca "Notificações". Sem `machines.json`, só "Este Mac"; com um núcleo sem telemetria (404 ou lista vazia), o bloco não aparece.
- **Abrir no login:** registra o app pelo `SMAppService.mainApp` (macOS 13+, sem LaunchAgent) e fica marcado só com o registro ligado; aberto pelo login, fica só na bandeja, e aberto à mão abre também o console.
- **Atualizar para a versão X:** com a chave do updater no app, ele procura versão nova ao abrir e a cada 6 h; se houver, o item aparece logo abaixo da versão e o clique baixa, confere a assinatura, instala e relança. Sem a chave (builds locais), o item nunca aparece.
- Sem ícone no Dock, instância única (abrir de novo abre o console).

## Instalar

1. Em [Releases](https://github.com/ahrenatechnology/ahrena-console/releases), abra a mais recente com tag `app-v…` e baixe o DMG do seu Mac: `aarch64` para Apple Silicon (M1 em diante), `x64` para Intel.
2. Abra o DMG e arraste o **Ahrena Console** para **Aplicativos**.
3. Abra o app. Como ele não tem assinatura da Apple (só ad hoc), o macOS o bloqueia na primeira vez: em **Ajustes do Sistema › Privacidade e Segurança**, role até o aviso sobre o Ahrena Console e clique em **Abrir Mesmo Assim** (pede a senha de administrador). Só na primeira vez.

Alternativa pelo terminal, no lugar do passo 3:

```bash
xattr -dr com.apple.quarantine "/Applications/Ahrena Console.app"
```

Depois disso, as versões novas chegam pelo item "Atualizar para a versão X" do menu.

## O núcleo

Um núcleo por instalação, em porta aleatória ([decisão 0010](../../docs/decisoes/0010-core-per-installation.md), issue [#221](https://github.com/ahrenatechnology/ahrena-console/issues/221)). O app **sempre** sobe e usa o próprio núcleo, que vai dentro dele como recurso (`Contents/Resources/packages/nucleo` e `packages/marca/gerado`), sem Node embutido. Ele nunca adota o núcleo de outra instalação: nem o de desenvolvimento (`~/.ahrena-console/`, que pode estar na 4720), nem o da extensão. Os dois rodam lado a lado, em portas e bancos diferentes.

1. Com um Node 24 no PATH do shell de login, o app roda o `start` do dono (`packages/nucleo/src/owner`):

   ```bash
   node --disable-warning=ExperimentalWarning <núcleo>/src/owner/cli.ts start --installation app \
     --data-dir "$HOME/Library/Application Support/dev.ahrena.console" --port 0 --parent <pid do app> --json
   ```

   A pasta de dados vem do Tauri (`app_data_dir`, a do identificador `dev.ahrena.console`). O dono **sobe** o núcleo em segundo plano numa porta que o sistema escolhe, ou **adota** o que já roda naquela pasta de dados (só a do app). O app lê da linha `--json` a `porta`, o `pid`, o `subiu`, e confere `installation` (`app`) e `dataDir` (a pasta do app): se vier outra, recusa e mostra o núcleo parado. O app tira do ambiente do núcleo `AHRENA_CONSOLE_DB`, `AHRENA_CONSOLE_DATA_DIR`, `AHRENA_CONSOLE_CORE_PORT` e `AHRENA_CONSOLE_PORT`, que um shell pode exportar para o núcleo de desenvolvimento.
2. **Pasta de dados:** `~/Library/Application Support/dev.ahrena.console/`, com o banco (`nucleo.sqlite`), o log (`nucleo.log`), os clientes (`clientes/`) e a trava (`nucleo.json`), além do `notifications.json` do app. O núcleo se registra em `~/.ahrena-console/instances/app-<pid>.json`, onde os hooks e o mod o acham.
3. **Primeira vez:** com o banco do app vazio, o núcleo importa o histórico dos transcripts (`~/.claude/projects`) ao subir, como sempre fez; não precisa de opção.
4. A bandeja, a janela (`/ui`) e todo pedido HTTP do app só falam com a porta do núcleo que ele subiu ou adotou, e cada conferência de que ele ainda responde olha também o `pid` do `/api/overview`. A porta muda a cada subida: se o núcleo cai e o app sobe outro, a janela aberta passa para a porta nova. Com o núcleo parado ou ainda subindo, "Abrir o console" não abre outro: procura o próprio de novo e abre a janela quando ele responder.
5. Sem Node (ou com um Node velho): o menu A4, com "Como instalar o Node 24" e "Procurar o núcleo de novo". O app **não** procura núcleo em porta nenhuma e tenta de novo a cada 30 s.
6. **Ao sair,** o app não sinaliza ninguém. O núcleo que ele subiu tem o app como `--parent` e sai sozinho em até 1 s, apagando a trava e a própria entrada do registro. Nenhum outro núcleo é tocado.

A bandeja lê `GET /api/attention` e espera mudanças em `GET /api/changes?since=<cursor>&wait=25` (long polling). Toda volta da espera relê a atenção, o que também atualiza os minutos. Se o núcleo para de responder, o app volta a procurá-lo (e sobe outro, se puder). Um núcleo de antes desta rota (404) fica adotado, com o aviso "Este núcleo não lista quem precisa de você: atualize-o".

| Arquivo | O quê |
| --- | --- |
| [src-tauri/src/main.rs](src-tauri/src/main.rs) | A bandeja, o laço do núcleo, os cliques e a janela |
| [src-tauri/src/menu.rs](src-tauri/src/menu.rs) | O menu como dados, montado do JSON de `/api/attention` (testado sem abrir o app) |
| [src-tauri/src/machines.rs](src-tauri/src/machines.rs) | As máquinas de `/api/machines` e `/api/telemetry`: a leitura do JSON e os textos curtos da linha, do alerta e do motivo sem conexão (testado sem abrir o app) |
| [src-tauri/src/core.rs](src-tauri/src/core.rs) | O plano (subir o próprio núcleo, o A4 ou a porta de demonstração), a linha de comando do `start` e a leitura do `start --json`, que recusa o núcleo de outra instalação |
| [src-tauri/src/notifications.rs](src-tauri/src/notifications.rs) | Quando avisar (a transição desde a leitura anterior), o título e o som de cada aviso, e o silêncio gravado em JSON (testado sem abrir o app) |
| [src-tauri/src/native_notice.rs](src-tauri/src/native_notice.rs) | A notificação pelo `UNUserNotificationCenter`: autorização, as ações do A3 e o delegate que responde ao clique |
| [src-tauri/src/login.rs](src-tauri/src/login.rs) | Abrir no login pelo `SMAppService` e a origem da partida (login ou à mão), testados com um registro falso |
| [src-tauri/src/native.rs](src-tauri/src/native.rs) | O que o Tauri não expõe: o item alternativo do ⌥, a dica (conta e motivo) e o recuo, direto no `NSMenu` |
| [src-tauri/src/http.rs](src-tauri/src/http.rs) | HTTP/1.0 cru com `127.0.0.1` |
| [src-tauri/src/updater.rs](src-tauri/src/updater.rs) | O updater: checa ao abrir e a cada 6 h, instala e relança; só liga com a chave pública no `tauri.conf.json` |
| [src-tauri/tests/configuration.rs](src-tauri/tests/configuration.rs) | A configuração da release: a mesma versão nos três arquivos e no núcleo, o endpoint do updater e o identificador |
| [src-tauri/src/shell_path.rs](src-tauri/src/shell_path.rs) | O PATH do shell de login, para achar o `node` aberto pelo Finder |

## Rodar

Precisa de Rust e das ferramentas de linha de comando do Xcode. Para não instalar nada no escopo do usuário, dá para usar um Rust dentro do checkout (`.toolchain/` está no `.gitignore`):

```bash
export RUSTUP_HOME=$PWD/.toolchain/rustup CARGO_HOME=$PWD/.toolchain/cargo PATH=$PWD/.toolchain/cargo/bin:$PATH
```

```bash
curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal
```

```bash
cd apps/desktop && npm install && npm run build
```

O `.app` e o `.dmg` saem em `src-tauri/target/release/bundle/`, assinados ad hoc (sem Developer ID). Os ícones já estão em `src-tauri/icons`; `npm run icons` os refaz do logo. Os da bandeja vêm de `tray.svg`: `npx tauri icon src-tauri/icons/tray.svg -p 18 -p 36`.

Testes, sem abrir o app:

```bash
cd apps/desktop/src-tauri && cargo test
```

No CI, o [app-ci.yml](../../.github/workflows/app-ci.yml) roda `cargo test`, `cargo clippy --all-targets -- -D warnings` e uma build de debug do `.app` em todo PR que mexe em `apps/desktop`.

### Variáveis para testar à mão

| Variável | Efeito |
| --- | --- |
| `AHRENA_CONSOLE_DEMO_PORT=<n>` | Não sobe núcleo: só mostra o desta porta (uma `npm run api -- --demo --port <n>`), para os prints |
| `AHRENA_CONSOLE_NODE=<caminho>` | Usa este `node`; vazio, finge que não há Node (para ver o A4) |
| `AHRENA_CONSOLE_CORE_DIR=<pasta>` | Usa este `packages/nucleo` em vez do que vai no app |
| `AHRENA_CONSOLE_OPEN_MENU_AFTER=<s>` | Abre o menu sozinho depois de tantos segundos (prints) |
| `AHRENA_CONSOLE_DATA_DIR=<pasta>` | Grava e lê o `notifications.json` nesta pasta em vez do diretório de dados do app; o núcleo do app continua na pasta do app |
| `AHRENA_CONSOLE_LAUNCH_ORIGIN=login\|manual` | Finge que o app abriu pelo login (só a bandeja) ou à mão (abre o console) |

Os nomes antigos, em português (`AHRENA_NUCLEO_PORTA`, `AHRENA_NODE`…), saíram na fase 6 da #173.

Pelo Finder, `open --env` passa as variáveis:

```bash
open --env AHRENA_CONSOLE_DEMO_PORT=4797 "src-tauri/target/release/bundle/macos/Ahrena Console.app"
```

## Release

Para mantenedores. A release sai do [app-release.yml](../../.github/workflows/app-release.yml), com o `tauri-action`, num DMG por arquitetura (`aarch64` e `x64`), assinado ad hoc.

1. Suba a versão nos quatro arquivos, iguais: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json` e o `packages/nucleo/package.json` do núcleo que vai dentro do app (o `cargo test` confere). O núcleo mostra essa versão no rodapé da /ui, no registro de instâncias e no MCP ([#261](https://github.com/ahrenatechnology/ahrena-console/issues/261)).
2. Depois do merge, crie e envie a tag `app-vX.Y.Z` com essa versão. O workflow falha se a tag não bater com o `tauri.conf.json`.
3. A release sai como **rascunho**, com os DMGs (e, com a chave do updater, os `.app.tar.gz`, `.sig` e o `latest.json`).
4. Antes de publicar o rascunho à mão, abra o `latest.json` dele e confira que tem as duas plataformas, `darwin-aarch64` e `darwin-x86_64`: os dois jobs da matriz o atualizam em paralelo, e um pode sobrescrever o outro.

Sem tag, "Run workflow" na aba Actions builda e deixa os DMGs como artefatos do workflow; com `criar_release` marcado, cria a release como no passo 3. Num PR, o workflow roda só a build, quando o PR mexe nele ou no `tauri.conf.json`: é assim que ele é provado antes de chegar ao main. "Run workflow" a partir de uma tag já publicada refaz os assets dela: use só para isso.

### A chave do updater

O app só se atualiza com uma chave própria, que assina cada versão. Uma vez:

1. Gere a chave na sua máquina, com senha: `npm run tauri signer generate -- -w ~/.tauri/ahrena-console.key`.
2. Guarde a privada (o conteúdo de `~/.tauri/ahrena-console.key`) como segredo do repositório `TAURI_SIGNING_PRIVATE_KEY`, e a senha em `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Cole a pública (`~/.tauri/ahrena-console.key.pub`) em `plugins.updater.pubkey` do `tauri.conf.json`, num PR.

Sem o segredo, a build sai sem updater e o workflow avisa; com o segredo e a pública vazia, falha. **Perder a chave privada impede atualizar quem já instalou:** cada um teria de baixar o DMG de novo. Guarde-a também fora do GitHub.

O app procura a versão nova em `releases/download/app-updates/latest.json`: a release fixa `app-updates`, que é só o canal de atualização. Quando um rascunho `app-v…` é publicado, o [app-updates.yml](../../.github/workflows/app-updates.yml) copia o `latest.json` dele para lá; rascunho nunca chega ao canal. Por isso não importa qual release é a **Latest** do repositório (a Latest é das releases do plugin). Para voltar o canal a uma versão anterior, rode o `app-updates` com a tag dela.

### Notarização

Desligada: precisa da conta Apple Developer. Para ligar, crie os segredos `APPLE_CERTIFICATE` (o `.p12` do Developer ID em base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (o nome do certificado Developer ID Application), `APPLE_ID`, `APPLE_PASSWORD` (senha de app) e `APPLE_TEAM_ID`, e troque, no passo do `tauri-action`, o `APPLE_SIGNING_IDENTITY: '-'` pelo bloco comentado no mesmo `env:`. Com isso some o "Abrir Mesmo Assim".

## O que falta

- Assinatura com Developer ID e notarização (ver [Notarização](#notarização)).
- A janela no detalhe da sessão (A5), quando a `/ui` (#26) tiver as telas.
