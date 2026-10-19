# Wireframes

Wireframes do painel lateral (mod do Claude Code, decisão [0004](../decisoes/0004-painel-da-sessao.md)) e do app desktop em Tauri (decisão [0005](../decisoes/0005-app-desktop.md)), para aprovação antes de construir. A referência é o Claude Code Agent Monitor; cada tela diz o que veio dele e onde diverge.

- [index.html](index.html): a página navegável. Lê as cores de `packages/marca/gerado/marca.css`, então abra pelo repositório servido por HTTP:

  ```bash
  python3 -m http.server 8765 --bind 127.0.0.1
  ```

  e vá a `http://127.0.0.1:8765/docs/wireframes/index.html`. Cada painel tem um verificador que conta colunas e linhas e acusa estouro.
- [capturas/](capturas/): um PNG por tela, gerado pela própria página em `?captura=<id>`.
- [capturar.mjs](capturar.mjs): regera as capturas com um Chromium headless já instalado (sem dependências):

  ```bash
  node docs/wireframes/capturar.mjs <caminho do chrome-headless-shell> http://127.0.0.1:8765/docs/wireframes/index.html docs/wireframes/capturas painel-estados painel-ativa painel-esperando painel-delegando painel-erro painel-precisam app-bandeja-0 app-bandeja-3 app-notificacao app-janela
  ```

Os dados são sintéticos, com o vocabulário do simulador (`packages/nucleo/src/simulador`).
