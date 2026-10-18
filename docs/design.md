# Design

## Direção da interface

A referência de interface é o **Claude Code Agent Monitor** ([ficha](benchmark/00-agent-monitor.md)), não o Podium. O que vem dele:

- dashboard com as sessões e os agentes ao vivo;
- kanban de status das sessões;
- detalhe da sessão com a conversa renderizada e a árvore de subagentes;
- feed de atividade;
- analytics de custo, tokens e modelos;
- visão de workflows (delegação e concorrência entre agentes).

Do Podium entram ideias pontuais, não o visual: o estado "quem precisa de você" em destaque e responder a sessão pelo painel.

## Marca

A marca é a da Ahrena, a mesma do **The Forward Deployed Engineer** ([theforwarddeployedengineer.io](https://theforwarddeployedengineer.io)).

Tokens em [brand/tokens.json](brand/tokens.json):

| Papel | Token | Hex |
| --- | --- | --- |
| Destaque, ações, barras | `orange.500` | `#f47720` |
| Institucional, réguas, seleção | `purple.500` | `#552973` |
| Alerta | `yellow.500` | `#ffc30a` |
| Erro, falha | `pink.500` | `#db6286` |
| Fundo (tema escuro) | `gray.900` | `#17171b` |
| Superfícies | `gray.800` / `gray.700` | `#1e1e24` / `#28282f` |
| Texto principal | `gray.100` | `#d7d7d9` |

Em aberto:

- a tipografia (Poppins, a confirmar com o site);
- o logo: usar o do The Forward Deployed Engineer ou um próprio do Ahrena Console;
- o tema claro.
