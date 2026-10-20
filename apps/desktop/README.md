# App desktop

A bandeja do Ahrena Console na barra de menus do macOS, em Tauri 2 ([decisão 0005](../../docs/decisoes/0005-app-desktop.md), issue [#87](https://github.com/ahrenatechnology/ahrena-console/issues/87)). Veio da prova em [spikes/app-desktop](../../spikes/app-desktop/). O app complementa o Claude sem duplicar nada: não grava hooks nem configuração do Claude, não embute Node e não tem telas próprias. A janela abre a `/ui` do núcleo.

## O que faz

- **Número ao lado do ícone** (`tray.set_title`): as sessões esperando você ou com erro, em todas as contas. Com zero ou com o núcleo parado, só o ícone template.
- **Menu**, como os wireframes A1, A2 e A4 (`docs/wireframes/index.html`, ids `app-bandeja-0`, `app-bandeja-3` e `app-parado`): o estado do núcleo, "N precisam de você" com o motivo e o tempo de cada sessão (as que travam primeiro), "N ativas", "Abrir o console ⌘O", Notificações, Abrir no login, a versão e Sair.
- **Clique numa sessão:** por enquanto abre a conversa no Claude Desktop (`POST /abrir/<local_…>` do núcleo). Com ⌥, cada item vira "Abrir no Claude Desktop" (item alternativo nativo do macOS). Quando a janela do app mostrar a sessão (A5), o clique sem ⌥ passa a abrir lá.
- **Abrir o console:** uma janela com `http://127.0.0.1:<porta>/ui`. Fechar a janela não fecha o app.
- **Notificações** só marca, sem efeito: o efeito é da issue #88.
- **Abrir no login:** registra o app pelo `SMAppService.mainApp` (macOS 13+, sem LaunchAgent) e fica marcado só com o registro ligado; aberto pelo login, fica só na bandeja, e aberto à mão abre também o console.
- Sem ícone no Dock, instância única (abrir de novo abre o console).

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
| [src-tauri/src/login.rs](src-tauri/src/login.rs) | Abrir no login pelo `SMAppService` e a origem da partida (login ou à mão), testados com um registro falso |
| [src-tauri/src/nativo.rs](src-tauri/src/nativo.rs) | O que o Tauri não expõe: o item alternativo do ⌥, a dica (conta e motivo) e o recuo, direto no `NSMenu` |
| [src-tauri/src/http.rs](src-tauri/src/http.rs) | HTTP/1.0 cru com `127.0.0.1` |
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

### Variáveis para testar à mão

| Variável | Efeito |
| --- | --- |
| `AHRENA_NUCLEO_PORTA=<n>` | Procura o núcleo nesta porta em vez da 4720 (uma `npm run api -- --demo --porta <n>`) |
| `AHRENA_NODE=<caminho>` | Usa este `node`; vazio, finge que não há Node (para ver o A4) |
| `AHRENA_NUCLEO_DIR=<pasta>` | Usa este `packages/nucleo` em vez do que vai no app |
| `AHRENA_ABRIR_MENU=<s>` | Abre o menu sozinho depois de tantos segundos (prints) |
| `AHRENA_ORIGEM=login\|manual` | Finge que o app abriu pelo login (só a bandeja) ou à mão (abre o console) |

Pelo Finder, `open --env` passa as variáveis:

```bash
open --env AHRENA_NODE= --env AHRENA_NUCLEO_PORTA=4797 "src-tauri/target/release/bundle/macos/Ahrena Console.app"
```

## O que falta

- Notificações (#88), build no CI e release (#90).
- A janela no detalhe da sessão (A5), quando a `/ui` (#26) tiver as telas.
