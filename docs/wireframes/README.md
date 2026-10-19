# Wireframes

Wireframes de todas as telas da 0.0.1, para aprovação antes de construir:

- **Painel lateral** (mod do Claude Code, decisão [0004](../decisoes/0004-painel-da-sessao.md)): P0 a P8, em 38 e 121 colunas.
- **App de bandeja** (Tauri, decisão [0005](../decisoes/0005-app-desktop.md)): A1 a A5.
- **Console** (artefato, épico 3, que também é a janela do app): C1 a C12.

A referência é o Claude Code Agent Monitor. Cada tela diz o que veio dele e onde diverge.

É um artefato do claude.ai versionado aqui ([artifact.json](artifact.json)), no formato das skills `versioning-artifacts` e `publishing-artifacts`. O link oficial só é publicado depois do merge.

| Arquivo | O que é |
| --- | --- |
| [index.html](index.html) | A página. Segue o contrato do Artifact: sem `<html>` nem `<head>`, CSS embutido e só scripts de CDN permitida (ícones Lucide). |
| [montar.mjs](montar.mjs) | Copia `packages/marca/gerado/marca.css` para dentro da página. Com `--checar`, falha se a cópia estiver velha. Nenhuma cor é escrita à mão. |
| [capturar.mjs](capturar.mjs) | Gera um PNG por tela em [capturas/](capturas/), abrindo a página em `?captura=<id>` num Chromium headless já instalado. |

Para ver no navegador, sirva a página com o mesmo esqueleto que o Artifact põe na publicação (um `<!doctype html>` em volta) e abra em `http://127.0.0.1:<porta>/`. `?captura=<id>` mostra só uma tela e `?tema=light` força o tema claro.

```bash
node docs/wireframes/montar.mjs --checar
```

Os dados são sintéticos, com o vocabulário do simulador (`packages/nucleo/src/simulador`).
