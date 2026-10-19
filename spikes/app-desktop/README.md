# App desktop (spike #82)

Prova mínima da [decisão 0005](../../docs/decisoes/0005-app-desktop.md): um app Tauri 2 que vive só na barra de menus do macOS, adota o núcleo que já roda em `127.0.0.1:4720` ou sobe um como processo filho, e mostra o estado das sessões. Código descartável; nenhum binário é publicado.

## O que faz

- **Bandeja:** `● N` na barra de menus (sessões ativas) e um menu com o estado, de onde veio o núcleo, o que está instalado do lado do Claude, "Abrir o console", "Abrir no login" e "Sair". Sem ícone no Dock (`ActivationPolicy::Accessory`).
- **Núcleo:** se `GET /api/overview` responde, o app **adota** e nunca o encerra. Se não, roda `node spikes/nucleo-teste/server.mjs` (ou `AHRENA_NUCLEO_ENTRY`) e o encerra ao sair (SIGTERM, depois SIGKILL).
- **PATH:** roda o shell de login uma vez e junta o PATH dele, como o `shell-path.ts` do Claude Code Agent Monitor. Sem isso, aberto pelo Finder, o app não acha `claude` (`~/.local/bin`) nem `node`.
- **Integração, só leitura:** mostra a versão do CLI `claude`, os plugins `ahrena-console` habilitados em `~/.claude/settings.json` e a extensão `.mcpb` instalada no Claude Desktop. Não instala hooks e não edita nada.
- **Notificação do sistema** quando o número de sessões ativas cai ("1 sessão parou"). No produto, vira "precisa de você" (item 2.1).
- **Janela:** "Abrir o console" abre `http://127.0.0.1:4720/ui` numa janela própria (WKWebView). A janela não tem acesso a nenhum comando do app (`capabilities/default.json` vazio).

## Rodar

Precisa de Rust e das ferramentas de linha de comando do Xcode. Para não instalar nada no escopo do usuário, a prova usou um Rust dentro do worktree:

```bash
export RUSTUP_HOME=$PWD/.toolchain/rustup CARGO_HOME=$PWD/.toolchain/cargo
```

```bash
curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal
```

```bash
cd spikes/nucleo-teste && npm ci
```

```bash
cd spikes/app-desktop && npm install && npx tauri icon ../../docs/brand/logo-laranja.svg -o src-tauri/icons
```

```bash
cd spikes/app-desktop && PATH=$CARGO_HOME/bin:$PATH npx tauri build --bundles app,dmg
```

O `.app` sai em `src-tauri/target/release/bundle/macos/`, assinado ad hoc (sem Developer ID).

## Medições

Ver a seção "Medições da prova" da [decisão 0005](../../docs/decisoes/0005-app-desktop.md).
