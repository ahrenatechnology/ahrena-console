# Analytics

A tela Analytics do console ([#95](https://github.com/ahrenatechnology/ahrena-console/issues/95) e [#32](https://github.com/ahrenatechnology/ahrena-console/issues/32), wireframes C12 e C13) mostra uso, custo e produtividade das sessões do Claude Code desta máquina, em todas as contas.

## Onde fica

Na barra lateral do console, item **Analytics**. Duas abas, que trocam sem sair da tela:

| Aba | Endereço | O que lê |
| --- | --- | --- |
| Visão geral | `/ui/analytics` | `GET /api/analytics?fuso=<fuso>` |
| Custo | `/ui/analytics/custo` | `GET /api/analytics/custo?dias=7\|30\|90&fuso=<fuso>` |

Os dias são contados no fuso do navegador. A tela acompanha o "Ao vivo": quando chega uma novidade, relê depois de alguns segundos (uma releitura por rajada); se o núcleo reiniciar, relê na hora. Se uma releitura falhar, os números da leitura anterior ficam e uma faixa avisa.

**Exportar** baixa, em JSON, exatamente o que a aba está mostrando (a resposta já lida, sem ir ao núcleo de novo). Na Visão geral, o relógio ao lado é a hora em que o núcleo calculou os números.

## Visão geral

| Peça | O que mostra |
| --- | --- |
| Sessões | Sessões com atividade nos últimos 30 dias; embaixo, quantas estão ativas agora |
| Agentes | Agentes (principal e subagentes) dessas sessões; embaixo, quantos estão trabalhando |
| Tokens | Tokens dos últimos 30 dias; embaixo, a parte da entrada que veio do cache |
| Custo | Custo estimado dos últimos 30 dias (veja abaixo) |
| Eventos | Eventos dos últimos 30 dias; embaixo, a média por sessão |
| Atividade · 52 semanas | Um quadrado por dia, de segunda a domingo, mais escuro quanto mais eventos. Passe o mouse para ver o número |
| Últimos 30 dias | Sessões por dia, com o pico e o total do período |
| Tokens por modelo | Tokens de cada modelo nos 30 dias, em milhões |
| Ferramentas | As cinco ferramentas mais chamadas nos 30 dias |
| Por dia da semana | Sessões dos 30 dias somadas por dia da semana |

## Custo

O seletor no alto escolhe o período: 7, 30 ou 90 dias.

| Peça | O que mostra |
| --- | --- |
| Hoje | Custo de hoje e quantas sessões tiveram uso hoje |
| N dias | Custo do período e a média por dia |
| Cache | A parte dos tokens de entrada que veio do cache |
| Sem preço | Quantos modelos usados no período não estão na tabela de preços (passe o mouse para ver quais) |
| Custo por dia | A linha do custo de cada dia, com o pico e o total |
| Por modelo | A divisão do custo entre os modelos, com o total no meio |
| Por projeto | O custo de cada projeto (a pasta em que a sessão rodou) |

## O custo é uma estimativa

O console não lê fatura. O custo é calculado a partir dos tokens registrados no transcript de cada sessão, multiplicados pelo preço de cada modelo na tabela de preços do núcleo (o padrão do código, com as sobrescritas que você gravar por cima). Por isso todo valor aparece com `~`: é uma estimativa, que pode diferir do que a conta cobra (descontos, planos por assinatura, mudanças de preço).

**Sem preço** quer dizer que o modelo não está na tabela. Esse uso não entra na soma, e a tela escreve "sem preço" em vez de inventar um valor: nunca aparece US$ 0 para algo que só não tem preço. Um dia sem preço interrompe a linha do custo por dia.

## Várias contas

Com sessões de mais de uma conta do Claude no período, a tela soma o que soma (custo e contagens, como diz a [decisão 0006](decisoes/0006-multiplas-contas.md)) e mostra a divisão por conta ao lado: no número **Custo** da Visão geral e no número do período da aba Custo, uma linha por conta com o rótulo e o valor. Quando a cor da conta é uma das cores da marca, ela aparece como um ponto ao lado do rótulo. Com uma conta só, nada muda.
