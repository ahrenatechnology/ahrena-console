# Design

## Direção da interface

A referência de interface é o **Claude Code Agent Monitor** (ficha no benchmark interno), não o Podium. O que vem dele:

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
| Institucional, réguas, seleção | rosa | `#df285d` | Rosa da marca; substitui o roxo `#552973` desde 2026-10-18 |
| Sucesso (CI e sessão concluída) | verde | `#1baf7a` | Cor do CI |
| Pendente (CI e sessão esperando) | amarelo | `#ffc30a` | Cor do CI |
| Erro, falha (CI e sessão com erro) | vermelho | `#e34948` | Cor do CI, reaproveitada (ver abaixo) |
| Fundo (tema escuro) | cinza 900 | `#17171b` | The Forward Deployed Engineer |
| Superfícies | cinza 800 / 700 | `#1e1e24` / `#28282f` | The Forward Deployed Engineer |
| Texto principal | cinza 100 | `#d7d7d9` | The Forward Deployed Engineer |

Os valores ficam em [brand/tokens.json](brand/tokens.json), e a amostra com os dois temas e os status está em [brand/amostra.html](brand/amostra.html) (captura em [brand/amostra.png](brand/amostra.png)). O teste [test/tokens.test.mjs](../test/tokens.test.mjs) confere as cores obrigatórias e o contraste AA:

```bash
node --test test/
```

O painel e o artefato não copiam esses valores: leem o que [packages/marca](../packages/marca/) gera do `tokens.json` (um módulo TS com as cores em hex para o painel e as variáveis CSS para o artefato). Para mudar uma cor, edite o `tokens.json` e rode `node packages/marca/src/gerar.ts`.

### Cor de erro

O erro usa o **mesmo vermelho do CI, `#e34948`**. Uma sessão com erro e um CI que falhou dizem a mesma coisa para quem olha: algo falhou e precisa de você. Dois vermelhos para a mesma ideia só confundiriam.

O `#db6286` provisório saiu porque era um rosa mais claro: no matiz (LCh), ficava a 10° do rosa da marca. O `#e34948` fica a 16° do rosa e a 26° do laranja, no vermelho entre os dois. Além disso:

- o rosa nunca é cor de status nem de erro, só institucional;
- o erro sempre vem com o glifo `✕` e o rótulo, nunca só a cor.

No tema escuro, o texto de erro usa `#f06463`, um degrau mais claro, porque o `#e34948` não chega a 4,5:1 sobre o cartão realçado. O ponto e as barras continuam `#e34948`.

### Temas

O escuro é o padrão. O claro é o equivalente, com os mesmos papéis em três degraus de superfície:

| Papel | Escuro | Claro |
| --- | --- | --- |
| Fundo (`bg`) | `#17171b` | `#f4f4f5` |
| Cartão (`surface`) | `#1e1e24` | `#fdfdfd` |
| Realce, hover (`raised`) | `#28282f` | `#efeff1` |
| Borda | `#3a3a44` | `#d7d7d9` |
| Texto | `#d7d7d9` | `#17171b` |
| Texto secundário | `#a6a6aa` | `#5a5a63` |
| Destaque (preenchimento) | `#f47720` com texto `#17171b` | `#f47720` com texto `#17171b` |
| Destaque como texto | `#f47720` | `#ab5316` (laranja 700) |

O laranja não muda no tema claro. Ele continua sendo o preenchimento de botões, barras e do logo, sempre com texto escuro por cima. Como texto sobre fundo claro, o `#f47720` fica em 2,6:1, então ali entra o laranja 700, que já estava na escala.

Todo texto passa AA (4,5:1) sobre fundo, cartão e realce nos dois temas. Pontos e ícones de status passam 3:1.

### Status de sessão

Os cinco status do Claude Code Agent Monitor (detalhe no benchmark interno, seção 3). Cada um tem cor, glifo e rótulo, para que o status nunca dependa só da cor, inclusive no painel nativo, que só tem texto.

| Status | Rótulo | Glifo | Cor | Por que existe |
| --- | --- | --- | --- | --- |
| `active` | Ativa | `●` | laranja `#f47720` | O Claude está no meio de um turno. Não pede nada, só dá para acompanhar. Laranja porque é onde a ação está, como nas barras de progresso |
| `waiting` | Esperando você | `◐` | amarelo `#ffc30a` | O turno parou e a vez é sua. É o estado que alimenta o inbox "quem precisa de você". Amarelo como o pendente do CI: algo aguarda alguém |
| `completed` | Concluída | `✓` | verde `#1baf7a` | Terminou sem erro. Verde como o sucesso do CI |
| `error` | Com erro | `✕` | vermelho `#e34948` | Parou num erro e não se recuperou. Vermelho como a falha do CI |
| `abandoned` | Abandonada | `○` | cinza `#a6a6aa` | Ficou ativa sem sinal por 180 min. Não pede ação e não é erro, então sai do caminho em cinza |

O motivo do "Esperando você" aparece num chip ao lado do status: **Pede permissão** (`notification`) e **Interrompida** (`interrupted`) são urgentes; **Sua vez** (`stop`) e **No prompt** (`session_start`) não são.

No tema claro, ponto e rótulo usam um tom mais escuro da mesma cor (laranja 700, amarelo 900, verde 700, vermelho 700 e cinza 300), para passar o contraste. A pílula é a cor canônica a 12% sobre o cartão.

### Tipografia

As mesmas fontes do site do The Forward Deployed Engineer, ambas livres (SIL Open Font License):

- **Poppins** para títulos, rótulos e texto corrido no artefato: `"Poppins", "Roboto", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
- **JetBrains Mono** para ids, caminhos, números de tabela, custo e tokens: `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`.

No artefato HTML, as duas vêm do Google Fonts, com a pilha do sistema como reserva. No painel nativo do Claude Desktop não dá para escolher fonte: ele usa a monoespaçada do app. Ali a hierarquia vem de peso (negrito nos títulos), caixa alta nos cabeçalhos de seção, cor (texto principal e secundário) e dos glifos de status.

Escala do artefato: 12, 13, 14, 16, 20 e 28 px; pesos 400, 500 e 600.

## Logo

| Fundo laranja | Fundo preto |
| --- | --- |
| ![Logo com fundo laranja](brand/logo-laranja.svg) | ![Logo com fundo preto](brand/logo-preto.svg) |
| [brand/logo-laranja.svg](brand/logo-laranja.svg) | [brand/logo-preto.svg](brand/logo-preto.svg) |

O logo é um **"A" com um triângulo apontando para baixo no centro**, num quadrado de cantos arredondados. Existem duas versões, uma o negativo da outra:

- **fundo laranja, "A" preto:** para telas escuras, onde o quadrado laranja se destaca. É a versão padrão ([brand/logo.svg](brand/logo.svg));
- **fundo preto, "A" laranja:** para telas claras.

O triângulo é sempre rosa (`#df285d`). O logo nasceu no painel de teste do mod em 2026-10-18.
