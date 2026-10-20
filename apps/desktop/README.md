# App desktop

A bandeja do Ahrena Console na barra de menus do macOS, em Tauri 2 ([decisão 0005](../../docs/decisoes/0005-app-desktop.md), issue [#87](https://github.com/ahrenatechnology/ahrena-console/issues/87)). Veio da prova em [spikes/app-desktop](../../spikes/app-desktop/). O app complementa o Claude sem duplicar nada: não grava hooks nem configuração do Claude, não embute Node e não tem telas próprias. A janela abre a `/ui` do núcleo.

## O que faz

- **Número ao lado do ícone** (`tray.set_title`): as sessões esperando você ou com erro, em todas as contas. Com zero ou com o núcleo parado, só o ícone template.
- **Menu**, como os wireframes A1, A2 e A4 (`docs/wireframes/index.html`, ids `app-bandeja-0`, `app-bandeja-3` e `app-parado`): o estado do núcleo, "N precisam de você" com o motivo e o tempo de cada sessão (as que travam primeiro), "N ativas", "Abrir o console ⌘O", Notificações, Abrir no login, a versão e Sair.
- **Clique numa sessão:** por enquanto abre a conversa no Claude Desktop (`POST /abrir/<local_…>` do núcleo). Com ⌥, cada item vira "Abrir no Claude Desktop" (item alternativo nativo do macOS). Quando a janela do app mostrar a sessão (A5), o clique sem ⌥ passa a abrir lá.
- **Abrir o console:** uma janela com `http://127.0.0.1:<porta>/ui`. Fechar a janela não fecha o app.
- **Notificações e Abrir no login** só marcam, sem efeito: o efeito é das issues #88 e #89.
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

O núcleo vai dentro do app como recurso (`Contents/Resources/packages/nucleo` e `packages/marca/gerado`), sem Node embutido.

1. Com um Node 24 no PATH do shell de login, o app roda `node <núcleo>/src/dono/cli.ts subir --pai <pid do app> --json`, o dono único da #86: ele **adota** o núcleo de pé (e registra o app como cliente) ou **sobe** um em segundo plano.
2. Sem Node, o app só procura um núcleo em `127.0.0.1:4720` e o adota se responder.
3. Sem Node e sem núcleo: o menu A4, com "Como instalar o Node 24" e "Procurar o núcleo de novo". O app tenta de novo a cada 30 s.
4. **Ao sair,** o app não sinaliza ninguém. O núcleo que ele subiu tem o app como `--pai` e sai sozinho em até 1 s, a menos que outro cliente (a extensão, por exemplo) o tenha adotado. O que ele adotou continua.

A bandeja lê `GET /api/atencao` e espera mudanças em `GET /api/mudancas?desde=<cursor>&espera=25` (long polling). Toda volta da espera relê a atenção, o que também atualiza os minutos. Se o núcleo para de responder, o app volta a procurá-lo (e sobe outro, se puder). Um núcleo de antes desta rota (404) fica adotado, com o aviso "Este núcleo não lista quem precisa de você: atualize-o".

| Arquivo | O quê |
| --- | --- |
| [src-tauri/src/main.rs](src-tauri/src/main.rs) | A bandeja, o laço do núcleo, os cliques e a janela |
| [src-tauri/src/menu.rs](src-tauri/src/menu.rs) | O menu como dados, montado do JSON de `/api/atencao` (testado sem abrir o app) |
| [src-tauri/src/nucleo.rs](src-tauri/src/nucleo.rs) | A escolha entre adotar, subir e o A4, e a leitura do `subir --json` |
| [src-tauri/src/nativo.rs](src-tauri/src/nativo.rs) | O que o Tauri não expõe: o item alternativo do ⌥, a dica (conta e motivo) e o recuo, direto no `NSMenu` |
| [src-tauri/src/http.rs](src-tauri/src/http.rs) | HTTP/1.0 cru com `127.0.0.1` |
| [src-tauri/src/atualizacao.rs](src-tauri/src/atualizacao.rs) | O updater: checa ao abrir e a cada 6 h, instala e relança; só liga com a chave pública no `tauri.conf.json` |
| [src-tauri/tests/configuracao.rs](src-tauri/tests/configuracao.rs) | A configuração da release: a mesma versão nos três arquivos, o endpoint do updater e o identificador |
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

O `.app` e o `.dmg` saem em `src-tauri/target/release/bundle/`, assinados ad hoc (sem Developer ID). Os ícones já estão em `src-tauri/icons`; `npm run icones` os refaz do logo, e o da bandeja (`bandeja.png`, template) vem de `bandeja.svg`.

Testes, sem abrir o app:

```bash
cd apps/desktop/src-tauri && cargo test
```

No CI, o [app-ci.yml](../../.github/workflows/app-ci.yml) roda `cargo test`, `cargo clippy --all-targets -- -D warnings` e uma build de debug do `.app` em todo PR que mexe em `apps/desktop`.

### Variáveis para testar à mão

| Variável | Efeito |
| --- | --- |
| `AHRENA_NUCLEO_PORTA=<n>` | Procura o núcleo nesta porta em vez da 4720 (uma `npm run api -- --demo --porta <n>`) |
| `AHRENA_NODE=<caminho>` | Usa este `node`; vazio, finge que não há Node (para ver o A4) |
| `AHRENA_NUCLEO_DIR=<pasta>` | Usa este `packages/nucleo` em vez do que vai no app |
| `AHRENA_ABRIR_MENU=<s>` | Abre o menu sozinho depois de tantos segundos (prints) |

Pelo Finder, `open --env` passa as variáveis:

```bash
open --env AHRENA_NODE= --env AHRENA_NUCLEO_PORTA=4797 "src-tauri/target/release/bundle/macos/Ahrena Console.app"
```

## Release

Para mantenedores. A release sai do [app-release.yml](../../.github/workflows/app-release.yml), com o `tauri-action`, num DMG por arquitetura (`aarch64` e `x64`), assinado ad hoc.

1. Suba a versão nos três arquivos, iguais: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` e `package.json` (o `cargo test` confere).
2. Depois do merge, crie e envie a tag `app-vX.Y.Z` com essa versão. O workflow falha se a tag não bater com o `tauri.conf.json`.
3. A release sai como **rascunho**, com os DMGs (e, com a chave do updater, os `.app.tar.gz`, `.sig` e o `latest.json`).
4. Antes de publicar o rascunho à mão, abra o `latest.json` dele e confira que tem as duas plataformas, `darwin-aarch64` e `darwin-x86_64`: os dois jobs da matriz o atualizam em paralelo, e um pode sobrescrever o outro.

Sem tag, "Run workflow" na aba Actions builda e deixa os DMGs como artefatos do workflow; com `criar_release` marcado, cria a release como no passo 3. Num PR, o workflow roda só a build, quando o PR mexe nele ou no `tauri.conf.json`: é assim que ele é provado antes de chegar ao main.

### A chave do updater

O app só se atualiza com uma chave própria, que assina cada versão. Uma vez:

1. Gere a chave na sua máquina, com senha: `npm run tauri signer generate -- -w ~/.tauri/ahrena-console.key`.
2. Guarde a privada (o conteúdo de `~/.tauri/ahrena-console.key`) como segredo do repositório `TAURI_SIGNING_PRIVATE_KEY`, e a senha em `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Cole a pública (`~/.tauri/ahrena-console.key.pub`) em `plugins.updater.pubkey` do `tauri.conf.json`, num PR.

Sem o segredo, a build sai sem updater e o workflow avisa; com o segredo e a pública vazia, falha. **Perder a chave privada impede atualizar quem já instalou:** cada um teria de baixar o DMG de novo. Guarde-a também fora do GitHub.

O app procura a versão nova em `releases/latest/download/latest.json`, isto é, na release marcada como **Latest** do repositório. A release do app tem de ser a Latest; qualquer outra release deste repositório deve sair sem marcar Latest, senão o app deixa de achar as atualizações.

### Notarização

Desligada: precisa da conta Apple Developer. Para ligar, crie os segredos `APPLE_CERTIFICATE` (o `.p12` do Developer ID em base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (o nome do certificado Developer ID Application), `APPLE_ID`, `APPLE_PASSWORD` (senha de app) e `APPLE_TEAM_ID`, e troque, no passo do `tauri-action`, o `APPLE_SIGNING_IDENTITY: '-'` pelo bloco comentado no mesmo `env:`. Com isso some o "Abrir Mesmo Assim".

## O que falta

- Notificações (#88), abrir no login (#89).
- Assinatura com Developer ID e notarização (ver [Notarização](#notarização)).
- A janela no detalhe da sessão (A5), quando a `/ui` (#26) tiver as telas.
