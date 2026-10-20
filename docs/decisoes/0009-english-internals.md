# 0009 · Bastidores em inglês, pt-BR só na tela

- **Status:** aceita para o código; a parte de comentários, docs, README, commits e PRs está **a confirmar pelo Fernando**
- **Data:** 2026-10-20
- **Issue:** [#173](https://github.com/ahrenatechnology/ahrena-console/issues/173)
- **Regra para os agentes:** [AGENTS.md](../../AGENTS.md) na raiz; o `CLAUDE.md` só importa ele (`@AGENTS.md`)
- **Guarda:** [test/english-internals.test.mjs](../../test/english-internals.test.mjs), com o legado em [test/english-internals.legacy.json](../../test/english-internals.legacy.json)

## Contexto

O código nasceu com os bastidores em pt-BR: rotas (`/api/atencao`, `/api/painel`, `/abrir/<id>`), URLs da /ui (`/ui/sessoes`), pastas (`ui/telas/`, `src/dono/`), identificadores, classes CSS e chaves de JSON. O repositório é público e open source, e quem chega para ler ou contribuir lê inglês; quem usa o console lê português. Em 20/10 o Fernando decidiu: **tudo o que é bastidor é em inglês; só a tela fica em pt-BR**.

## Decisão

### Em inglês

| O quê | Exemplo de hoje | Como fica |
| --- | --- | --- |
| Rotas da API, parâmetros de query e valores fixos que trafegam | `/api/atencao`, `?antes=`, `escopo=familia` | `/api/attention`, `?before=`, `scope=family` |
| URLs da /ui e ids de tela | `/ui/sessoes/:id`, `id: 'detalhe'` | `/ui/sessions/:id`, `id: 'session-detail'` |
| Nomes de arquivo e de pasta | `ui/telas/`, `src/dono/`, `rota-atencao.ts` | `ui/screens/`, `src/owner/`, `attention-route.ts` |
| Identificadores (variáveis, funções, tipos, constantes, módulos Rust) | `montarAtencao`, `ROTA_DA_ATENCAO` | `buildAttention`, `ATTENTION_ROUTE` |
| Classes CSS e atributos `data-*` | `.kb-coluna`, `.det-aba` | `.kb-column`, `.det-tab` |
| Chaves de JSON (API, MCP, arquivos de configuração) | `{ sessoes, proximo }` | `{ sessions, next }` |
| Tabelas, colunas e índices do SQLite | `reprocessamentos` | `reprocessings` |
| Opções de linha de comando | `--cenario`, `--porta` | `--scenario`, `--port` |
| Variáveis de ambiente, sempre com o prefixo `AHRENA_CONSOLE_` | `AHRENA_NUCLEO_PORTA` | `AHRENA_CONSOLE_CORE_PORT` (tabela abaixo) |
| Nomes de teste (`test('…')`) e de fixture | | |

### Variáveis de ambiente

Todas com o prefixo `AHRENA_CONSOLE_`, como as que já nasceram assim (`AHRENA_CONSOLE_PORT`, `AHRENA_CONSOLE_URL`, `AHRENA_CONSOLE_DB`). O nome antigo continua aceito até a fase final da migração; quando os dois existem, vale o novo.

| Antiga | Nova | Onde |
| --- | --- | --- |
| `AHRENA_NUCLEO_PORTA` | `AHRENA_CONSOLE_CORE_PORT` | app |
| `AHRENA_NUCLEO_DIR` | `AHRENA_CONSOLE_CORE_DIR` | app e núcleo (dono) |
| `AHRENA_NUCLEO_ENTRY` | `AHRENA_CONSOLE_CORE_ENTRY` | núcleo (dono) |
| `AHRENA_DADOS_DIR` | `AHRENA_CONSOLE_DATA_DIR` | app e núcleo (dono) |
| `AHRENA_ORIGEM` | `AHRENA_CONSOLE_LAUNCH_ORIGIN` | app |
| `AHRENA_ABRIR_MENU` | `AHRENA_CONSOLE_OPEN_MENU_AFTER` | app |
| `AHRENA_NODE` | `AHRENA_CONSOLE_NODE` | app (só o prefixo) |

### Em pt-BR

Tudo o que a pessoa **vê**: textos de tela, rótulos, títulos, dicas, mensagens de erro e de aviso que chegam à tela (inclusive o `error` de uma resposta da API que a /ui mostra), notificações do app e textos do mod. As strings ficam no código como estão; não há camada de tradução (o console é só pt-BR por enquanto).

### A confirmar pelo Fernando

Proposta, para ele decidir:

1. **Comentários de código: inglês.** Fazem parte do código, que é lido por quem contribui. Sem reescrita em massa: comentário novo nasce em inglês, e o que for tocado numa fase da migração passa para o inglês junto com o código. *Alternativa:* deixar os comentários em pt-BR (menos trabalho, mas o código fica bilíngue).
2. **docs/: inglês para o que é novo; nomes de arquivo e pasta em inglês já.** A pasta `docs/decisoes/` vira `docs/decisions/` numa fase própria (com os links consertados), e os registros novos são escritos em inglês. Os registros antigos ficam como estão: são história. Este registro está em pt-BR porque a regra para docs ainda não foi confirmada. *Alternativa:* docs em pt-BR, só os nomes em inglês.
3. **README.md da raiz: inglês**, porque é a porta do repositório público, com um `README.pt-BR.md` para quem usa o console. Os README de pacote (`packages/nucleo/README.md`, `apps/desktop/README.md`) seguem o item 2.
4. **Mensagens de commit: inglês** (ficam no histórico público, ao lado do código). **Pull requests: pt-BR** (título e corpo), porque são a conversa da equipe e a revisão é em português. *Alternativa:* PR em inglês também.
5. **Logs no terminal** (`console.error` do núcleo, `eprintln!` do app): inglês, porque são para quem roda e depura, não para a tela.

Enquanto não houver confirmação, o guarda **não olha** `docs/` nem comentários; olha os itens da tabela "Em inglês" que dá para verificar por script (abaixo).

## O guarda

`test/english-internals.test.mjs`, que roda com `node --test test/` e no CI (`repo-tests`), recusa o que é **novo** e está em português:

- rotas da API e URLs da /ui escritas em `packages/nucleo/src`, `packages/nucleo/ui` e `apps/desktop`;
- nomes de arquivo e de pasta (fora de `docs/` e de `plugins/`, que é do mod e migra no ritmo dele);
- classes CSS;
- variáveis de ambiente lidas ou passadas no código (`process.env`, `env::var`, `AHRENA_*`).

Português é reconhecido por acento, por terminação (`-ção`, `-dade`, `-mento`…) e por um vocabulário tirado do próprio legado (`sessoes`, `painel`, `atencao`…). O que já existia quando a regra foi escrita, inclusive o que estava em PR aberto (#168, #169, #170, #172), está congelado em `english-internals.legacy.json`, que só encolhe: cada fase da migração tira de lá o que renomeou. Identificadores, chaves de JSON e colunas não têm guarda por script: dependem da revisão e do `CLAUDE.md`.

## Migração

Em fases, um PR por fase, com o plano no corpo da issue #173: API (rotas novas com as antigas como alias), /ui, núcleo, app, banco (com migração do SQLite existente sem perder dados) e, por último, a retirada dos alias. **Compatibilidade:** o mod publicado na v0.0.30 chama `/api/painel` e `/abrir/<id>`, e o app instalado chama `/api/atencao` e `/api/mudancas`; essas rotas continuam respondendo até o PR final.

## Alternativas consideradas

- **Tudo em pt-BR.** Coerente com quem usa, mas fecha o repositório para quem contribui de fora. Recusada pelo Fernando.
- **Só o novo em inglês, sem migrar o legado.** Barato, mas deixa o código bilíngue para sempre. Recusada: a issue pede o main sem bastidor em pt-BR.
- **Migrar tudo num PR.** Quebra o mod e o app instalados e conflita com todas as sessões abertas. Recusada em favor das fases com alias.
- **Camada de tradução (i18n) para a tela.** Não há pedido de outra língua na tela; fica para quando houver.

## Consequências

- Todo agente lê a regra no `AGENTS.md` da raiz; o Claude Code chega nele pelo `CLAUDE.md`.
- Durante a migração convivem nomes antigos (no legado congelado) e novos; o guarda impede que o legado cresça.
- As rotas antigas viram alias e saem num PR final, depois que o mod e o app migrarem.
