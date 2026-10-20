# Instruções dos agentes, instalação do Ahrena Framework e ADRs de cada repositório: estudo

- **Issues, na ordem de prioridade:**
  - [#183](https://github.com/ahrenatechnology/ahrena-console/issues/183): instruções dos agentes;
  - [#184](https://github.com/ahrenatechnology/ahrena-console/issues/184): instalar o Ahrena Framework;
  - [#174](https://github.com/ahrenatechnology/ahrena-console/issues/174): ADRs, e as PDRs, que entraram em 20/10.
- **Data:** 20/10/2026
- **Wireframes:** C28 a C38 em [docs/wireframes](wireframes/), para aprovação antes da implementação
- **Provas:** [spikes/agent-instructions](../spikes/agent-instructions/), [spikes/framework-install](../spikes/framework-install/) e [spikes/adr-extractor](../spikes/adr-extractor/)

## Resumo

1. **Tudo na tela Repositórios.** As três vivem nela e leem arquivos de texto dos mesmos repositórios, por isso dividem uma única varredura. Uma consulta GraphQL procura, em até 20 repositórios, as 14 pastas de ADR, os arquivos de instrução da raiz e a árvore de `.claude/`; custa 1 ponto e leva cerca de 4 s.
2. **Texto no cache.** O texto vem em lotes de até 50 arquivos, a 1 ponto por lote, e fica no cache pelo hash do Git, sem TTL. Enquanto não há push, reabrir a tela custa zero.
3. **Instruções (#183):** o que pesa é achar os `CLAUDE.md` e `AGENTS.md` das subpastas. Para isso é preciso a árvore inteira do repositório (de 48 KB a 13,7 MB), pedida só quando a aba abre, com ETag. Os `@imports` são resolvidos como o Claude Code resolve: relativos ao arquivo, fora de blocos de código, até 5 saltos.
4. **Instalar (#184):** o framework novo é distribuído por plugins de marketplace, sem transpilação. Instalar num repositório escreve:
   - o marketplace e os plugins habilitados em `.claude/settings.json` (o Claude Code vai completo; o Codex leva só o `AGENTS.md`);
   - um índice de uma linha por regra de julgamento no `AGENTS.md`;
   - `@AGENTS.md` no `CLAUDE.md`, sempre.

   O console monta o plano, mostra o diff e abre um PR num branch novo, sem tocar no branch padrão. O que já existe é mesclado por blocos com marcadores, e um JSON quebrado bloqueia a instalação em vez de virar `{}` (o erro do instalador antigo).
5. **ADRs e PDRs (#174):** as PDRs (decisões de produto) usam o mesmo extrator e a mesma tela; o tipo vem do campo de tipo, do prefixo ou da pasta, e sem sinal fica ADR. Para as ADRs, cinco formatos cobrem o que se encontra. Faltar uma seção é comum: o próprio repositório do MADR não escreve status nem data. A tela diz "não está no texto" em vez de esconder a seção.
6. **Este repositório não tem nenhuma instrução para agentes:** nem `CLAUDE.md`, nem `AGENTS.md`, nem `.claude/`. É o caso do aviso de C33, que agora oferece Instalar.

## Decisões de 20/10 (Fernando, pelo PM)

1. **Repositório do framework.** O padrão é o marketplace público `ahrenatechnology/ahrena-framework`, trocável por `AHRENA_CONSOLE_FRAMEWORK_REPO`.
2. **Plataformas.** O Claude Code vai completo: plugins no `settings.json` e o índice pelo `@AGENTS.md`. O Codex vai só pelo `AGENTS.md`. Plugins no Codex (`.codex/config.toml`) e o Cursor ficam marcados como "a confirmar", e a instalação não escreve nada deles.
3. **Issue.** O PR tem um campo opcional de issue: com número, leva `Refs #N`; vazio, não leva referência.
4. **Nomes.** As abas se chamam "Instruções" e "ADRs".
5. **Import.** A instalação sempre deixa `@AGENTS.md` no `CLAUDE.md`; se a pessoa já importa, não duplica. O aviso "nenhum CLAUDE.md importa este AGENTS.md" só aparece sem o import.

## Parte 1 · Instruções dos agentes (#183)

### O que um agente herda de um repositório

| Arquivo | Quem lê | Como a tela mostra |
| --- | --- | --- |
| `CLAUDE.md` e `.claude/CLAUDE.md` na raiz | O Claude Code, em toda sessão aberta no repositório | Arquivo de instrução "raiz", renderizado |
| `CLAUDE.md` numa subpasta | O Claude Code, quando trabalha em arquivos daquela pasta | "Subpasta", com o caminho |
| `AGENTS.md` na raiz e nas subpastas | Os agentes que seguem a convenção AGENTS.md, entre eles o Codex. O Claude Code o carrega pelo `@AGENTS.md` do `CLAUDE.md`, e a instalação sempre põe esse import | "Importado pelo CLAUDE.md", ou, sem o import, o aviso "nenhum CLAUDE.md importa este AGENTS.md" (C33) |
| `@caminho` dentro desses arquivos | O Claude Code, no lugar do `@` | O bloco aberto no lugar, com a borda laranja (C32) |
| `CLAUDE.local.md` | Só a máquina de quem o criou; costuma ficar fora do git | Não aparece: não está no repositório |
| `.claude/rules/*.md` | O Claude Code; com `paths:` no front matter, só ao mexer nesses caminhos | Card Regras, com o nome e os caminhos |
| `.claude/skills/*/SKILL.md`, `.claude/agents/*.md`, `.claude/commands/**/*.md` | O Claude Code | Nome e descrição do front matter; o comando com o nome que se digita (`/pr:abrir`) |
| `.claude/settings.json` | O Claude Code | Hooks: evento, matcher e quantos comandos, **nunca o comando**, como o Agent Config. Plugins: os que estão com `true` em `enabledPlugins`, e o marketplace. `settings.local.json` fica fora do git |
| `.mcp.json` na raiz | O Claude Code | Os nomes dos servidores; os valores não aparecem |

### Os `@imports`

- **Sintaxe:** `@` seguido de um caminho relativo ao arquivo que importa (`@AGENTS.md`, `@docs/estilo.md`, `@../README.md`), absoluto ou da home (`@~/.claude/meu.md`).
- **O que não é import:** o que está dentro de bloco ou trecho de código, e menções como `@fulano`, sem barra nem extensão.
- **Profundidade:** até 5 saltos.
- **Estados:** cada import resolvido vira um nó da árvore, num destes estados:
  - **achado;**
  - **fora do repositório:** `@~/…`, caminho absoluto ou `..` acima da raiz. Vem da máquina de quem roda, e a tela diz isso;
  - **não existe:** o arquivo foi removido ou o nome está errado (C33);
  - **ciclo;**
  - **fundo demais.**
- **Quem traz cada arquivo:** a árvore dá "AGENTS.md, importado pelo CLAUDE.md" sem regra extra.

### Reaproveitar o Agent Config (#63)

O Agent Config lê o `.claude/` desta máquina pelo disco. As regras de leitura são as mesmas aqui:

- o front matter de skills e agentes;
- os eventos de hook sem o comando;
- as chaves de `enabledPlugins` com `true`;
- as chaves de `mcpServers`.

Hoje `readFrontmatter` é exportado, mas `hooksOf` e `pluginsOf` são funções privadas de `src/agent-config/reading.ts`. A proposta tem dois passos:

1. Passar as três para um módulo puro, `src/agent-config/parse.ts`, sem acesso a disco.
2. Fazer as duas leituras chamarem esse módulo: a do disco (Agent Config) e a do GitHub (esta aba).

O spike faz isso com uma função só, que recebe a lista de caminhos e um `read(path)`. O disco e o GitHub mudam só o `read`.

### Teste

`node --test spikes/agent-instructions/` roda 7 testes e todos passam, contra um repositório falso em memória. Eles cobrem:

- os imports: achado, fora do repositório, inexistente, ciclo, profundidade, e o `@` dentro de código e em menções;
- as subpastas;
- as regras com `paths`, as skills, os agentes, os comandos com subpasta, os hooks sem o comando, os plugins, o MCP e o `settings.json` quebrado;
- o repositório vazio;
- a busca transversal.

Contra três repositórios reais, lidos na hora:

| Repositório | Arquivos de instrução | `.claude/` | Arquivos lidos |
| --- | --- | --- | ---: |
| Um SDK público da Anthropic | `CLAUDE.md` | 1 skill, 1 agente, 3 comandos, hook PostToolUse | 6 |
| Uma GitHub Action pública da Anthropic | `CLAUDE.md` e um `CLAUDE.md` de subpasta | 5 agentes, 3 comandos, hook PostToolUse | 8 |
| Este repositório | nenhum | nenhum | 0 (vazio) |

Nenhum dos três usa `@imports`; o caso fica coberto pelas amostras.

### Busca transversal (depois)

"Quais repositórios têm a regra X" é uma busca no texto já em cache, no núcleo, sem chamar o GitHub. A função está no spike (`searchAcross`). Ela fica para depois do wireframe aprovado, como a issue diz. Não entrou no wireframe.

## Parte 2 · Instalar o Ahrena Framework pelo console (#184)

### O que mudou do instalador antigo para o framework novo

O Ahrena antigo instalava por plataforma com um script de 4 mil linhas (`make bootstrap PLATFORM=cursor|claude-code|codex`).

- **O que fazia:**
  - baixava o repositório inteiro;
  - transpunha cada artefato para a árvore da plataforma (`.claude/rules`, `.claude/skills`, `.cursor/rules/*.mdc`, `.codex/agents/*.toml`, `.agents/skills`);
  - escrevia blocos com marcadores no `CLAUDE.md`, no `AGENTS.md`, no `.gitignore` e no `config.toml`.
- **Problemas, pela leitura do código:**
  - não guardava a lista do que instalou, então o update deixava órfãos e o uninstall deixava sobras;
  - não olhava a stack do repositório: a escolha era manual;
  - um `settings.json` inválido virava `{}` e era reescrito sem backup;
  - mexia na máquina além do repositório (pipx, RTK, labels).

O framework novo ([ARCHITECTURE.md](https://github.com/ahrenatechnology/ahrena-framework/blob/main/ARCHITECTURE.md)) mudou o modelo:

- **Sem transpilação.** Cada plugin tem um manifesto por plataforma (`.claude-plugin`, `.codex-plugin`, `.cursor-plugin`) apontando para o mesmo `skills/`, `agents/` e `commands/`. Nada é copiado para o repositório de quem usa.
- **Catálogo:** 17 plugins no marketplace `ahrena` (`.claude-plugin/marketplace.json`), cada um com fonte `git-subdir` no próprio repositório.
- **Regras, por dois caminhos.** As 36 regras de hoje se dividem assim:
  - 21 mecânicas viram hooks do plugin e custam zero de contexto;
  - 15 de julgamento entram no arquivo sempre carregado da plataforma como **uma linha mais o link**: `CLAUDE.md` no Claude Code, `AGENTS.md` no Codex e `.cursor/rules/*.mdc` no Cursor.
- **Agência (ADR-017 do framework):** uma diretiva entre `<!-- ahrena:agency:start/end -->` no `CLAUDE.md` ou no `AGENTS.md` faz o trabalho de construção entrar pela `athena`. A skill `installing-the-agency` já faz isso: garante ou reporta, sem sobrescrever.

### O que "instalar num repositório" escreve

| Plataforma | Arquivo | O que entra | Base |
| --- | --- | --- | --- |
| Claude Code | `.claude/settings.json` | `extraKnownMarketplaces.ahrena` (fonte GitHub do framework) e `enabledPlugins["<plugin>@ahrena"] = true`. Quem clona recebe a oferta de instalar | O formato que o Agent Config já lê (`enabledPlugins`) |
| Claude Code | `CLAUDE.md` | `@AGENTS.md` num bloco `<!-- ahrena:framework:start/end -->` | O Claude Code carrega o índice pelo import |
| Claude Code e Codex | `AGENTS.md` | Bloco com os plugins e o índice das regras de julgamento dos plugins escolhidos, uma linha cada, com o link para o texto. Em inglês, como o framework | ARCHITECTURE.md, "How rules and docs reach the agent" |
| Codex | — | Nada além do `AGENTS.md` (decisão 2). Habilitar plugins pelo `.codex/config.toml` do projeto fica **a confirmar**: o formato `[marketplaces.ahrena]` e `[plugins."<plugin>@ahrena"] enabled = true` é o do `config.toml` do usuário (conferido nesta máquina, só pelos nomes das tabelas), mas não está provado no escopo de um projeto | — |
| Cursor | `.cursor/rules/ahrena-<regra>.mdc` | **A confirmar** (decisão 2): a tela mostra a opção desabilitada. O plano já sabe gerar uma regra `.mdc` por regra de julgamento, com `description` e `alwaysApply: false`, como o ARCHITECTURE.md descreve | ARCHITECTURE.md |
| Agência (opcional, com o plugin delivery) | `CLAUDE.md` ou `AGENTS.md` | A diretiva da `athena` entre os marcadores da skill `installing-the-agency` | ADR-017 do framework |

**Fica de fora do PR:**

- **DeepSeek:** pede links em `.agents/skills`, que apontam para a máquina de quem roda.
- **`settings.local.json`:** fica fora do git.
- **O que mexe na máquina da pessoa:** a instalação é só um PR.

### Escolher os plugins pelo que o repositório tem

| Sinal no repositório (já lido na varredura de C32) | Plugin sugerido |
| --- | --- |
| sempre | `ahrena-foundation`, `ahrena-contributing`, `ahrena-engineering-fundamentals` (base, não desmarca) |
| `tsconfig.json` ou `.ts` | `ahrena-engineering-typescript` |
| `pyproject.toml`, `requirements.txt` ou `setup.py` | `ahrena-engineering-python` |
| `go.mod` | `ahrena-engineering-go` |
| `Cargo.toml` | `ahrena-engineering-rust` |
| React, Vue, Svelte, Angular no `package.json`, ou `.tsx`/`.vue` | `ahrena-engineering-frontend` |
| Express, Fastify, Nest, Koa ou Hono, ou FastAPI, Django ou Flask | `ahrena-engineering-backend` |
| `dbt_project.yml`, Spark ou Great Expectations | `ahrena-engineering-data` |

- **Os outros** (delivery, quality, security, reliability, observability, code-review, costs) ficam desmarcados.
- **Testes e CI** aparecem como contexto ("achamos testes em `tests/`, CI no GitHub Actions"). Hoje nenhum plugin depende só deles.
- **O motivo de cada sugestão** vai para a tela.
- **Os arquivos que a detecção lê** (`package.json`, `pyproject.toml`) entram no mesmo lote de conteúdo da Parte 1: custo zero a mais.

### Mesclar, nunca sobrescrever

- **Arquivos de texto** (`CLAUDE.md` e `AGENTS.md`): só o que está entre os marcadores do framework muda. Sem marcadores, o bloco vai para o fim. O resto do arquivo não é tocado.
- **`.claude/settings.json`:** é lido como JSON.
  - O plano acrescenta o marketplace se ele não existir e habilita só os plugins que ainda não aparecem.
  - Um plugin que a pessoa desligou (`false`) continua desligado.
  - Nenhuma outra chave muda.
  - **JSON inválido bloqueia a instalação**, com o motivo na tela (C37). Nada é escrito.
- **Idempotente:** rodar o plano de novo sobre o resultado não muda nenhum arquivo. O teste pegou um erro aqui: o `@AGENTS.md` de dentro do bloco era tomado pelo da pessoa, e o bloco mudava na segunda vez.
- **Sem lockfile no repositório:** os marcadores e as chaves `@ahrena` dizem o que é do framework, então um "atualizar" futuro reescreve só isso.

### Como o PR é aberto

O núcleo usa o token do `gh` da pessoa, como já faz para ler. A porta tem quatro escritas e uma leitura:

1. **`defaultBranch`:** o nome e o commit do branch padrão. É a leitura.
2. **`createRef`:** cria o branch `chore/install-ahrena-framework` nesse commit.
3. **`createCommitOnBranch` (GraphQL):** grava todos os arquivos do plano num commit só, com `expectedHeadOid`. Se o branch andou no meio, falha em vez de sobrescrever. Se esse commit sai verificado no GitHub, o que pesaria para a regra de commit assinado, está **a confirmar**.
4. **`createPullRequest`:** abre o PR do branch novo para o padrão.

O branch padrão nunca é escrito: a porta recusa um branch de instalação com o nome do padrão. Com um PR aberto do mesmo branch, devolve o que já existe em vez de abrir outro.

**Permissão.** A tela Repositórios já sabe se a conta pode escrever no repositório. Sem escrita, o botão Instalar dá lugar ao aviso (C37). O token precisa de escrita em conteúdo e em pull requests; o console não lê o token, só usa o `gh`.

**Custo.** São 3 mutações e 1 leitura. No limite primário, uma mutação custa 1 ponto; no secundário, 5. É uma ação de clique, rara, longe de qualquer limite.

**Depois do PR:** a tela acompanha o estado (aberto, CI, review, mergeado) pela leitura de PR que o Kanban do projeto já faz (C11). Depois do merge, a aba mostra o framework instalado e os plugins.

**Issue do PR (decisão 3).** O `ahrena-contributing` pede uma issue para cada PR (`Refs #N`), mas o repositório ainda não tem o framework quando o PR é aberto. A prévia (C36) tem um campo opcional: com número, o corpo leva `Refs #N`; vazio, nenhuma referência. Um valor que não é número é recusado antes de qualquer escrita.

### Teste

`node --test spikes/framework-install/` roda 12 testes e todos passam. Eles cobrem:

- a sugestão de plugins por sinal;
- o índice só com as regras de julgamento;
- a mescla do `CLAUDE.md` e do `settings.json`, com a permissão da pessoa e o plugin desligado preservados;
- a idempotência;
- os blocos;
- o JSON inválido recusado;
- o Cursor;
- o diff;
- o `@AGENTS.md` sempre presente, sem duplicar o da pessoa;
- o campo de issue (com número, vazio e recusado);
- o PR contra um GitHub falso: branch novo, um commit, o padrão intocado, e nenhuma escrita quando o PR já existe, quando não há nada a fazer ou quando um arquivo é recusado.

O catálogo vem do framework real: `spikes/framework-install/catalog.json`, gerado por `catalog.mjs` a partir do commit `9d70de7`.

No exemplo de C36 (Python com FastAPI, `CLAUDE.md` e `settings.json` já existentes), o plano dá 3 arquivos, +40 linhas:

| Arquivo | Ação | Linhas |
| --- | --- | ---: |
| `AGENTS.md` | criar | +21 |
| `CLAUDE.md` | mesclar | +4 |
| `.claude/settings.json` | mesclar | +15 |

Quando o Cursor for confirmado, entram mais 13 regras `.mdc`.

## Parte 3 · ADRs e PDRs (#174)

### Formatos

| Formato | Como reconhecer | Status e data | Seções | Ligações |
| --- | --- | --- | --- | --- |
| **MADR 4** (2024) | Front matter com `decision-makers`, `consulted` ou `informed`, ou o título `Confirmation` | `status` e `date` no front matter | Context and Problem Statement, Decision Drivers, Considered Options, Decision Outcome (com `### Consequences` e `### Confirmation`), Pros and Cons of the Options, More Information | Texto livre, em geral em More Information ou no status ("superseded by [ADR-0005](…)") |
| **MADR 3** | Front matter com `status`, `date` ou `deciders` e o título Decision Outcome | Front matter | Iguais ao 4, com `### Positive Consequences` e `### Negative Consequences` | Iguais ao 4 |
| **MADR 2** e log4brains | `* Status:` e `* Date:` logo abaixo do título, e Decision Outcome | Linhas de metadado | Iguais ao 3 | No status: `superseded by [slug](arquivo.md)` |
| **Nygard** e adr-tools | `## Status`, `## Context`, `## Decision` e `## Consequences`; o adr-tools põe `# 1. Título` e `Date:` | A seção Status (pode ter duas linhas: "Accepted" e "Supersedes …"); `Date:` | As quatro; não tem alternativas | Linhas na seção Status: Supersedes, Superseded by, Amends, Amended by |
| **Y-statement** | Uma frase: "In the context of …, facing …, we decided for … and neglected …, to achieve …, accepting that …" | O que houver em volta da frase | A frase se divide em contexto, decisão, alternativas descartadas e consequências | Raras |
| **Livres em pt-BR** (como `docs/decisoes`) | Nenhum dos sinais acima | `- **Status:** aceita`, `- **Data:** 18/10/2026` ou ISO | Contexto, Decisão, Opções ou Alternativas consideradas, Consequências, Riscos e as que o autor criar | Metadados com link para outra ADR: "Mexe em", "Parte de", "Substitui" |

Quando nenhum formato é reconhecido, a ADR fica como livre: título, as seções pelos sinônimos e o resto em "Outras seções".

### Pastas

A busca segue esta ordem: `docs/adr`, `docs/adrs`, `docs/decisions`, `docs/decisoes`, `docs/architecture/decisions`, `docs/architecture/adr`, `docs/arch/adr`, `doc/adr`, `doc/architecture/decisions`, `doc/decisions`, `adr`, `adrs`, `decisions` e `architecture/decisions`. São as pastas padrão do adr-tools (`doc/adr`), do MADR (`docs/decisions`), do log4brains (`docs/adr`) e as variações que aparecem nos guias, mais a nossa.

- **É ADR** todo `.md` da pasta, menos `README.md`, `index.md`, `template.md`, `adr-template.md` e `toc.md`.
- **Fica de fora** quem guarda ADRs em outro lugar (um projeto de referência usa `locales/en/examples/…`). Para esses casos, a evolução é uma pasta configurada por repositório (ver "Riscos").

### Como extrair cada campo

| Campo | De onde vem, na ordem | Normalização |
| --- | --- | --- |
| Número | Título (`# 1. …`, `# 0001 · …`, `# ADR-0003: …`) ou prefixo do arquivo (`0001-…`) | Inteiro. Prefixo de 8 dígitos (`20200924-…`, o log4brains) é data, não número |
| Título | Primeiro `# `, sem o número; senão, `title` do front matter ou o nome do arquivo | Sem Markdown |
| Status | Front matter, linha de metadado, ou a primeira linha da seção Status | Seis valores: aceita, proposta, substituída, obsoleta, rejeitada e sem status, por palavras em inglês e português ("aceita; revista no mesmo dia" é aceita). O texto original fica ao lado, no card Registro |
| Data | Front matter, linha `Data:`/`Date:`, ou a data no nome do arquivo | `18/10/2026`, ISO com ou sem hora e `20200924` viram ISO. Sem data, a tela diz "sem data" |
| Decisores | `decision-makers`, `deciders` ou a linha "Decisores" | Lista |
| Contexto, decisão, consequências | A seção cujo título bate com os sinônimos (Context, Context and Problem Statement, Contexto, Problema; Decision, Decision Outcome, Decisão; Consequences, Consequências) | Markdown da seção. No MADR 3 e 4, as consequências vêm do `###` dentro de Decision Outcome |
| Opção escolhida | "Chosen option: "X", because" na decisão do MADR | Texto da opção |
| Alternativas | Itens de primeiro nível em Considered Options, Opções ou Alternativas consideradas; senão, os `###` de Pros and Cons | Nome curto: o negrito do item, ou até o travessão, os dois-pontos ou o fim da frase |
| Ligações | Metadados, a seção Status, e as seções Links ou More Information. Verbos: supersedes / substitui, superseded by / substituída por, amends / emenda, amended by, clarifies. Metadado com link para outra ADR e sem verbo ("Mexe em") vira "relacionada" | Alvo pelo arquivo do link ou pelo número. Se A substitui B, B ganha "substituída por A" mesmo que não diga. Link para algo que não é ADR (o backlog) é descartado |
| Outras seções | Qualquer `## ` fora dos sinônimos | Ficam em "Outras seções do texto", fechadas |
| O que falta | Status, data, contexto, decisão, alternativas e consequências que não vieram | A tela mostra a seção tracejada, "não está no texto" |

**Ligações só em lugares previsíveis.** "Substitui" é verbo comum em português, e procurar no texto inteiro ligaria ADRs que só citam uma troca qualquer. Por isso o extrator lê ligações nos metadados, no status e nas seções de links, nunca no corpo.

### Teste contra ADRs reais

`node --test spikes/adr-extractor/` roda 7 testes e todos passam. Eles cobrem `docs/decisoes` deste repositório e amostras sintéticas dos cinco formatos.

| Conjunto | ADRs | Formato detectado | O que faltou no texto | Ligações |
| --- | ---: | --- | --- | --- |
| `docs/decisoes` (este repositório) | 7 | livre, pt-BR, nas 7 | só as alternativas da 0004, que não tem a seção | 7 escritas ("Mexe em", "Parte de") e 7 voltas |
| MADR (o repositório do formato) | 19 | MADR 4: 1, MADR 3: 1, MADR sem versão: 17 | status e data nas 19, consequências em 18 | nenhuma |
| adr-tools | 9 | adr-tools, nas 9 | alternativas nas 9 (o formato não tem) | 2 (emenda) |
| log4brains | 11 | MADR 2: 9, livre: 2 | consequências em 9 | 4 (2 substituições, com a volta) |

As 39 ADRs públicas foram lidas na hora, para o teste, e não entraram no repositório. O que faltou nelas falta no próprio texto, e na tela vira "não está no texto".

Em `docs/decisoes`, as datas vêm em dois formatos (`18/10/2026` na 0001 e ISO nas outras), e o status da 0005 tem uma nota ("aceita; revista no mesmo dia: …"). As duas coisas saem normalizadas, com o original guardado.

### PDRs: as decisões de produto

Uma PDR (*product decision record*) registra uma decisão de produto: o que o produto faz, para quem e por quê. Por exemplo: "plano gratuito com até 3 projetos" ou "onboarding em três passos". Ela tem a mesma forma de uma ADR (status, data, contexto, decisão, alternativas, consequências e ligações), e os times escrevem PDRs com os mesmos modelos: MADR, Nygard ou livre. Por isso o extrator é o mesmo, e a tela de PDR (C38) é a de ADR (C28) com outro rótulo.

**Pastas.** As PDRs ficam em `docs/pdr`, `docs/pdrs`, `docs/product-decisions`, `docs/product/decisions`, `docs/decisoes-de-produto`, `doc/pdr`, `pdr`, `pdrs` ou `product-decisions`. Também aparecem misturadas às ADRs numa pasta só, como `docs/decisoes`. Essas pastas entram na mesma descoberta comum da leitura: são 9 apelidos a mais na mesma consulta, e o custo continua em 1 ponto.

**Como distinguir ADR de PDR**, na ordem, parando no primeiro sinal:

| Sinal | Exemplo | Por quê vem nessa ordem |
| --- | --- | --- |
| 1. Campo de tipo | front matter `type: product` (ou `kind`, `category`), linha `- **Tipo:** produto` | É o único sinal que funciona numa pasta mista, e é o que o autor escreveu de propósito |
| 2. Prefixo | arquivo `PDR-001-…md` ou título `# PDR-001: …` (e `ADR-` para ADR) | Quem numera por tipo já separa no nome |
| 3. Pasta | `docs/pdr/…`, `docs/product-decisions/…` são PDR; `docs/adr/…`, `doc/architecture/decisions/…` são ADR | A pasta diz o tipo quando o arquivo não diz |
| 4. Nenhum sinal | `docs/decisoes/0003-…md` sem campo | Fica ADR: é o uso mais comum. A tela mostra "tipo pelo padrão" para quem quiser escrever o campo |

O extrator devolve `kind` (`adr` ou `pdr`) e o porquê (`campo de tipo`, `prefixo`, `pasta` ou `padrão`). Com isso, as duas telas leem a mesma lista, e uma pasta mista aparece nas duas: as ADRs numa e as PDRs na outra. A linha do grupo diz "separadas das ADRs pelo campo Tipo: produto" (C38).

As 7 ADRs deste repositório não têm campo de tipo e estão em `docs/decisoes`: ficam ADR pelo padrão, como devem. Se um dia o repositório tiver decisões de produto, basta a linha `- **Tipo:** produto` nelas.

**Teste.** Os 8 testes do extrator incluem o caso das PDRs:

- uma pasta mista (`docs/decisoes`) com uma ADR pelo campo, uma PDR pelo campo e uma sem campo, que fica ADR;
- uma pasta de PDR com um MADR 4 de prefixo `PDR-001` e um Nygard só pela pasta;
- a mesma PDR sem campo nem prefixo numa pasta de ADR, que vira ADR, porque a pasta só decide sem sinal melhor.

O teste também achou um erro real: a opção escolhida entre aspas que tinha vírgula ("Three steps, the rest deferred") era cortada na vírgula. Está corrigido.

**Na barra**, o grupo Decisões tem três itens:

- **Das sessões:** a tela atual de decisões, C20 e C21;
- **ADR:** arquitetura, C28 a C31;
- **PDR:** produto, C38. A PDR aberta e os estados usam C30 e C31 com o rótulo trocado.

## Custo no GitHub (leitura)

Medido em 20/10/2026, com o `gh` desta máquina, contra este repositório e repositórios públicos de referência.

| Leitura | Como | Custo | Tempo |
| --- | --- | ---: | ---: |
| Descoberta só das ADRs: 20 repositórios × 14 pastas | GraphQL, um apelido por pasta: `object(expression: "HEAD:docs/adr") { ... on Tree { entries { name type oid } } }` | 1 ponto | cerca de 4 s |
| **Descoberta das duas partes: 20 repositórios** (14 pastas de ADR, `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `.mcp.json` e `.claude/` em 3 níveis) | A mesma consulta, com os apelidos a mais | **1 ponto** | 3,8 a 6,6 s, 32 KB |
| Conteúdo: as 7 ADRs deste repositório (124 KB) | GraphQL, um apelido por arquivo: `object(expression: "HEAD:<caminho>") { ... on Blob { oid text } }` | 1 ponto | 1,3 s |
| Árvore inteira, para os `CLAUDE.md`/`AGENTS.md` de subpastas | REST `git/trees/HEAD?recursive=1` | 1 requisição; 304 com ETag | 0,5 a 1,8 s; de 48 KB (184 arquivos) a 13,7 MB (51 mil arquivos) |

`object` não é conexão paginada, então o custo não cresce com o número de apelidos: cresce o tempo de servidor. Por isso o lote fica em 20 repositórios na descoberta e em 50 arquivos no conteúdo, abaixo do teto de CPU da decisão 0001.

### Como a leitura entra no cache da decisão 0001

1. **Descoberta junto com Repositórios.** A lista de C22 já traz o último push de cada repositório. A descoberta pede só os repositórios com push novo, em lotes de 20, e guarda na chave `repo-files:<owner>/<repo>`:
   - o commit;
   - a pasta de ADR achada, com os arquivos e o `oid` de cada um;
   - os arquivos de instrução da raiz;
   - a árvore de `.claude/`.

   TTL de 15 min, com o último push como invalidação.
2. **Subpastas só na aba Instruções.** A árvore inteira é pedida quando a aba abre, com ETag: o 304 não gasta o limite primário. O cache guarda só os caminhos que interessam, não os 13 MB. A chave é `instructions:tree:<owner>/<repo>:<oid da árvore>`. Se o GitHub cortar a lista (mais de 100 mil arquivos), a tela avisa (C33).
3. **Conteúdo pelo hash.** A chave é `blob:<oid>`, sem TTL: o hash do Git é o próprio conteúdo, então nunca envelhece. Só os arquivos com hash novo são pedidos, em lotes de 50. Os `@imports` que apontam para fora das pastas conhecidas (`@docs/estilo.md`) entram no lote seguinte, pelo caminho. Em geral são 1 ou 2 lotes, e nunca mais que 5, a profundidade máxima. O resultado do extrator fica em `adrs:parsed:<oid>:<versão do extrator>`.
4. **Abrir uma ADR ou um arquivo não chama o GitHub.** O texto veio no lote. "Último commit há 20 dias" (C30, em 1440) é a única leitura sob demanda: `history(first: 1, path: …)`, 1 ponto, TTL de 1 h.
5. **A busca é local.** Busca no título e no texto em cache, no núcleo. A busca de código do GitHub teria limite próprio (10 por minuto) e não indexa todo repositório.
6. **Falhas.** Com o limite atingido ou a rede fora, a tela serve o cache com a hora dele (C31), como as outras chaves. Sem cache e sem GitHub, mostra "sem dados".

### Orçamento

- **Primeira abertura** da tela ADRs, com 8 repositórios e até 50 ADRs: 2 pontos.
- **Aba Instruções de um repositório:** mais 1 requisição REST da árvore (304 nas próximas) e 1 ponto de conteúdo.
- **Tela aberta sem push:** a releitura da descoberta, a cada 15 min, dá até 4 pontos por hora.
- **Partida do núcleo:** nada é lido. A leitura só acontece quando a tela ou a aba abre, como manda a 0001.

**No hub (decisão 0002):** o evento `push` do GitHub App diz quais arquivos mudaram. Se algum é ADR, `CLAUDE.md`, `AGENTS.md` ou está em `.claude/`, a chave daquele repositório é invalidada. A descoberta periódica deixa de ser necessária.

## Segurança: o texto do repositório é dado, não página nem instrução

- **Renderização:** o Markdown vem de qualquer repositório que a conta enxerga. A tela renderiza sem HTML embutido e só com links `http(s)` e relativos ao repositório, como as outras telas fazem com títulos de sessão.
- **Instruções:** um `CLAUDE.md` é, por definição, texto escrito para mandar num agente. O console só mostra esse texto e nunca o entrega a um agente como instrução. Se um dia a busca transversal virar ferramenta do MCP, o resultado sai marcado como dado.
- **Hooks:** a tela não mostra o comando, como o Agent Config. Com isso, nenhum caminho ou argumento de script vai para a tela.
- **Escrita (#184):** é a única tela destas três que escreve no GitHub, e escreve só no clique de "Abrir PR", depois da prévia do diff. A rota de escrita passa pela mesma guarda de mesma origem das outras escritas da `/ui` (decisão 0003). O console não faz push, não escreve no branch padrão e não mexe na máquina da pessoa.

## Como fica a implementação (depois do wireframe aprovado)

Bastidores em inglês, inclusive variáveis de ambiente; tela em pt-BR.

- **Domínio:**
  - `packages/nucleo/src/adrs/` com o extrator do spike passado para TypeScript (`parse.ts`, `link.ts`);
  - `packages/nucleo/src/agent-instructions/` com a leitura e os imports (`read.ts`, `imports.ts`), usando `src/agent-config/parse.ts`;
  - `packages/nucleo/src/framework-install/` com a detecção, o plano, a mescla e o diff (`detect.ts`, `plan.ts`, `merge.ts`, `diff.ts`) e o catálogo do framework, lido do `marketplace.json` e das regras pelo mesmo cache (TTL de 1 h).
- **Fonte:** `packages/nucleo/src/github/repo-files-source.ts`, com a descoberta comum, a árvore com ETag e os lotes de blob. Usa o mesmo `githubGraphql`, o `rest` com ETag de `repos-source.ts` e o cache único do `cli.ts`. As escritas ficam em `packages/nucleo/src/github/pull-request-writer.ts`, com as quatro operações da porta do spike.
- **Configuração:** `AHRENA_CONSOLE_FRAMEWORK_REPO` troca o repositório do framework, para um fork ou para os testes. O padrão é `ahrenatechnology/ahrena-framework`, o marketplace público do framework (decisão 1).
- **API:**
  - `GET /api/adrs?q=&status=&repo=`: a lista de todos os repositórios, sem o texto;
  - `GET /api/adrs/<owner>/<repo>`: a lista de um repositório, a pasta e a hora da leitura;
  - `GET /api/adrs/<owner>/<repo>/<id>`: a ADR estruturada e o Markdown original;
  - `GET /api/pdrs`, `GET /api/pdrs/<owner>/<repo>` e `GET /api/pdrs/<owner>/<repo>/<id>`: as mesmas rotas, filtradas por `kind: pdr`;
  - `GET /api/repos/<owner>/<repo>/agent-instructions`: os arquivos com a árvore de imports e o que `.claude/` traz;
  - `GET /api/repos/<owner>/<repo>/agent-instructions/file?path=`: um arquivo, com os imports já lidos;
  - `GET /api/repos/<owner>/<repo>/framework-install/plan?platforms=&plugins=`: o que achamos, os plugins sugeridos, o plano e o diff de cada arquivo. Não escreve;
  - `POST /api/repos/<owner>/<repo>/framework-install`: abre o PR do plano que a tela mostrou. Recusa se o plano mudou desde a prévia, comparando o hash do plano;
  - `GET /api/repos/<owner>/<repo>/framework-install/pull-request`: o PR aberto e o estado dele.
- **Telas:**
  - `/ui/adrs` (C28) e `/ui/adrs/<owner>/<repo>/<id>` (C30); `/ui/pdrs` (C38) e `/ui/pdrs/<owner>/<repo>/<id>`, com as mesmas telas;
  - as abas ADRs e Instruções em `/ui/repos/<owner>/<repo>` (C29 e C32), com o fluxo Instalar dentro da aba Instruções (C34 a C37);
  - CSS em `ui/adrs.css` (prefixo `adr-`) e `ui/agent-instructions.css` (prefixo `ins-`; o fluxo Instalar usa `ins-install-`).
- **Mudança ao vivo:** `tipo: 'adrs'`, `tipo: 'agent-instructions'` e `tipo: 'framework-install'`, com a chave `<owner>/<repo>`.
- **Testes:** com o GitHub falso de `src/simulador/github-falso.ts`, sem chamar a API real (critério 4 da #174, 5 da #183 e 5 da #184). O falso ganha as quatro escritas, registradas para o teste conferir que o padrão não foi tocado e que nenhum PR real foi aberto.

## Riscos e limites

- **Pasta de ADR fora da lista.** Fica de fora até existir uma pasta configurada por repositório. A árvore inteira acharia essas pastas, mas pesa demais para pedir de todos os repositórios a cada varredura.
- **Árvores enormes.** Acima de 100 mil arquivos, o GitHub corta a lista: os `CLAUDE.md` de subpastas podem faltar, e a tela avisa. Um monorepo grande também tem `AGENTS.md` de exemplo em pastas de teste (um repositório medido tem 11, metade em `evals/`). A tela agrupa por pasta e mostra primeiro a raiz.
- **Status de ADR fora do vocabulário.** Vira "Sem status", com o texto original no card Registro.
- **Números de ADR repetidos** (duas ADRs 0007 depois de um merge): a chave é o nome do arquivo, não o número; a tela mostra as duas.
- **Codex e Cursor por projeto.** Plugins pelo `.codex/config.toml` de um projeto e plugins do Cursor por repositório continuam a confirmar. Até a prova, o Codex fica só com o `AGENTS.md`, e o Cursor fica desabilitado na tela.
- **O framework anda.** Os plugins apontam para o `main` do framework, e o índice do `AGENTS.md` é um retrato do dia da instalação. Um "atualizar" futuro refaz só os blocos com marcadores, com o mesmo fluxo de PR.
- **Repositórios privados.** O token do `gh` lê só o que a pessoa lê. A tela não mostra nada que ela não veria no GitHub.
