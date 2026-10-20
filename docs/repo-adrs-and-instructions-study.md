# ADRs e instruções dos agentes de cada repositório: estudo

- **Issues:** [#174](https://github.com/ahrenatechnology/ahrena-console/issues/174) (ADRs) e [#183](https://github.com/ahrenatechnology/ahrena-console/issues/183) (instruções dos agentes)
- **Data:** 20/10/2026
- **Wireframes:** C28 a C33 em [docs/wireframes](wireframes/), para aprovação antes da implementação
- **Provas:** [spikes/adr-extractor](../spikes/adr-extractor/) e [spikes/agent-instructions](../spikes/agent-instructions/)

## Resumo

1. As duas telas leem arquivos de texto dos repositórios que a tela Repositórios (C22) já conhece. Por isso dividem uma única varredura: uma consulta GraphQL procura, em até 20 repositórios, as 14 pastas de ADR, os arquivos de instrução da raiz e a árvore de `.claude/`. Ela custa 1 ponto e leva cerca de 4 s.
2. O texto vem em lotes de até 50 arquivos, a 1 ponto por lote, e fica no cache pelo hash do Git, sem TTL. Enquanto não há push, reabrir a tela custa zero.
3. **ADRs:** cinco formatos cobrem o que se encontra. Faltar uma seção é comum: o próprio repositório do MADR não escreve status nem data nas suas ADRs. A tela diz "não está no texto" em vez de esconder a seção.
4. **Instruções:** o que pesa é achar os `CLAUDE.md` e `AGENTS.md` das subpastas. Para isso é preciso a árvore inteira do repositório, que vai de 48 KB a 13,7 MB. Ela é pedida só quando a aba abre, com ETag. Os `@imports` são resolvidos como o Claude Code resolve: relativos ao arquivo, fora de blocos de código, até 5 saltos.
5. **Este repositório não tem nenhuma instrução para agentes:** nem `CLAUDE.md`, nem `AGENTS.md`, nem `.claude/`. É o caso do aviso de C33.

## Parte 1 · ADRs (#174)

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

## Parte 2 · Instruções dos agentes (#183)

### O que um agente herda de um repositório

| Arquivo | Quem lê | Como a tela mostra |
| --- | --- | --- |
| `CLAUDE.md` e `.claude/CLAUDE.md` na raiz | O Claude Code, em toda sessão aberta no repositório | Arquivo de instrução "raiz", renderizado |
| `CLAUDE.md` numa subpasta | O Claude Code, quando trabalha em arquivos daquela pasta | "Subpasta", com o caminho |
| `AGENTS.md` na raiz e nas subpastas | Os agentes que seguem a convenção AGENTS.md. O Claude Code o carrega quando um `CLAUDE.md` o importa (`@AGENTS.md`); se ele também lê o arquivo sozinho, ainda está **a confirmar** | "Importado pelo CLAUDE.md", ou o aviso "nenhum CLAUDE.md importa este arquivo" (C33) |
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

## Custo no GitHub (as duas partes)

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

## Como fica a implementação (depois do wireframe aprovado)

Bastidores em inglês, inclusive variáveis de ambiente; tela em pt-BR.

- **Domínio:**
  - `packages/nucleo/src/adrs/` com o extrator do spike passado para TypeScript (`parse.ts`, `link.ts`);
  - `packages/nucleo/src/agent-instructions/` com a leitura e os imports (`read.ts`, `imports.ts`), usando `src/agent-config/parse.ts`.
- **Fonte:** `packages/nucleo/src/github/repo-files-source.ts`, com a descoberta comum, a árvore com ETag e os lotes de blob. Usa o mesmo `githubGraphql`, o `rest` com ETag de `repos-source.ts` e o cache único do `cli.ts`.
- **API:**
  - `GET /api/adrs?q=&status=&repo=`: a lista de todos os repositórios, sem o texto;
  - `GET /api/adrs/<owner>/<repo>`: a lista de um repositório, a pasta e a hora da leitura;
  - `GET /api/adrs/<owner>/<repo>/<id>`: a ADR estruturada e o Markdown original;
  - `GET /api/repos/<owner>/<repo>/agent-instructions`: os arquivos com a árvore de imports e o que `.claude/` traz;
  - `GET /api/repos/<owner>/<repo>/agent-instructions/file?path=`: um arquivo, com os imports já lidos.
- **Telas:**
  - `/ui/adrs` (C28) e `/ui/adrs/<owner>/<repo>/<id>` (C30);
  - as abas ADRs e Instruções em `/ui/repos/<owner>/<repo>` (C29 e C32);
  - CSS em `ui/adrs.css` (prefixo `adr-`) e `ui/agent-instructions.css` (prefixo `ins-`).
- **Mudança ao vivo:** `tipo: 'adrs'` e `tipo: 'agent-instructions'`, com a chave `<owner>/<repo>`.
- **Testes:** com o GitHub falso de `src/simulador/github-falso.ts`, sem chamar a API real (critério 4 da #174 e 5 da #183).

## Riscos e limites

- **Pasta de ADR fora da lista.** Fica de fora até existir uma pasta configurada por repositório. A árvore inteira acharia essas pastas, mas pesa demais para pedir de todos os repositórios a cada varredura.
- **Árvores enormes.** Acima de 100 mil arquivos, o GitHub corta a lista: os `CLAUDE.md` de subpastas podem faltar, e a tela avisa. Um monorepo grande também tem `AGENTS.md` de exemplo em pastas de teste (um repositório medido tem 11, metade em `evals/`). A tela agrupa por pasta e mostra primeiro a raiz.
- **Status de ADR fora do vocabulário.** Vira "Sem status", com o texto original no card Registro.
- **Números de ADR repetidos** (duas ADRs 0007 depois de um merge): a chave é o nome do arquivo, não o número; a tela mostra as duas.
- **AGENTS.md no Claude Code.** Se o Claude Code passar a ler o `AGENTS.md` sozinho, o aviso "nenhum CLAUDE.md importa este arquivo" perde o sentido. Isso fica a confirmar antes da implementação.
- **Repositórios privados.** O token do `gh` lê só o que a pessoa lê. A tela não mostra nada que ela não veria no GitHub.
