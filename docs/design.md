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

A paleta parte da do The Forward Deployed Engineer ([brand/tokens.json](brand/tokens.json)) e vai se afastando dela aos poucos. **Só o laranja fica.** As outras cores são trocadas uma de cada vez, testando na tela.

| Papel | Cor | Hex | Origem |
| --- | --- | --- | --- |
| Destaque, ações, barras | laranja | `#f47720` | The Forward Deployed Engineer (fica) |
| Institucional, réguas, seleção | rosa | `#df285d` | Barte (`--bg-brand` do `barte-design-system`); substitui o roxo `#552973` desde 2026-10-18 |
| Alerta | amarelo | `#ffc30a` | The Forward Deployed Engineer (a revisar) |
| Erro, falha | a definir | `#db6286` por enquanto | Fica parecido demais com o rosa novo; precisa de outra cor |
| Fundo (tema escuro) | `gray.900` | `#17171b` |
| Superfícies | `gray.800` / `gray.700` | `#1e1e24` / `#28282f` |
| Texto principal | `gray.100` | `#d7d7d9` |

## Logo

![Ahrena Console](brand/logo.svg)

O logo é um **"A" com um ponto** ([brand/logo.svg](brand/logo.svg)): o A em traço escuro sobre um quadrado laranja de cantos arredondados, com o ponto em rosa no lugar da barra do A. Nasceu no painel de teste do mod em 2026-10-18 e foi escolhido como o logo do Ahrena Console.

Em aberto:

- a tipografia (Poppins, a confirmar com o site);
- a cor de erro;
- o tema claro.
