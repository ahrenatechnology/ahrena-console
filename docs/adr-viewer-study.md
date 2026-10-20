# ADRs dos repositórios numa tela: estudo

- **Issue:** [#174](https://github.com/ahrenatechnology/ahrena-console/issues/174)
- **Data:** 20/10/2026
- **Wireframes:** C28 a C31 em [docs/wireframes](wireframes/), para aprovação antes da implementação
- **Prova:** [spikes/adr-extractor](../spikes/adr-extractor/)

## Resumo

1. Cinco formatos cobrem o que se encontra: MADR 4, MADR 3, MADR 2 (o do log4brains), Nygard (com a variante do adr-tools), Y-statement e os livres, como o `docs/decisoes` deste repositório. O extrator reconhece cada um por sinais que só ele tem e devolve sempre a mesma estrutura.
2. Achar e ler as ADRs custa 2 pontos do GitHub na primeira vez, para todos os repositórios da conta: uma consulta procura 14 pastas em até 20 repositórios, e outra traz o texto de até 50 ADRs. Depois disso, o custo é zero enquanto não houver push, porque o texto é guardado pelo hash do arquivo.
3. Faltar uma seção é comum: o próprio repositório do MADR não escreve status nem data nas suas ADRs. A tela diz "não está no texto" em vez de esconder a seção.
4. O extrator foi testado contra as 7 ADRs deste repositório e contra 39 ADRs públicas de três projetos de referência. Os testes ficam no spike.

## Formatos

| Formato | Como reconhecer | Status e data | Seções | Ligações |
| --- | --- | --- | --- | --- |
| **MADR 4** (2024) | Front matter com `decision-makers`, `consulted` ou `informed`, ou o título `Confirmation` | `status` e `date` no front matter | Context and Problem Statement, Decision Drivers, Considered Options, Decision Outcome (com `### Consequences` e `### Confirmation`), Pros and Cons of the Options, More Information | Texto livre, em geral em More Information ou no status ("superseded by [ADR-0005](…)") |
| **MADR 3** | Front matter com `status`, `date` ou `deciders` e o título Decision Outcome | Front matter | Iguais ao 4, com `### Positive Consequences` e `### Negative Consequences` | Iguais ao 4 |
| **MADR 2** e log4brains | `* Status:` e `* Date:` logo abaixo do título, e Decision Outcome | Linhas de metadado | Iguais ao 3 | No status: `superseded by [slug](arquivo.md)` |
| **Nygard** e adr-tools | `## Status`, `## Context`, `## Decision` e `## Consequences`; o adr-tools põe `# 1. Título` e `Date:` | A seção Status (pode ter duas linhas: "Accepted" e "Supersedes …"); `Date:` | As quatro; não tem alternativas | Linhas na seção Status: Supersedes, Superseded by, Amends, Amended by |
| **Y-statement** | Uma frase: "In the context of …, facing …, we decided for … and neglected …, to achieve …, accepting that …" | O que houver em volta da frase | A frase se divide em contexto, decisão, alternativas descartadas e consequências | Raras |
| **Livres em pt-BR** (como `docs/decisoes`) | Nenhum dos sinais acima | `- **Status:** aceita`, `- **Data:** 18/10/2026` ou ISO | Contexto, Decisão, Opções ou Alternativas consideradas, Consequências, Riscos e as que o autor criar | Metadados com link para outra ADR: "Mexe em", "Parte de", "Substitui" |

Quando nenhum formato é reconhecido, a ADR fica como livre: título, as seções pelos sinônimos e o resto em "Outras seções".

## Pastas

A busca segue esta ordem: `docs/adr`, `docs/adrs`, `docs/decisions`, `docs/decisoes`, `docs/architecture/decisions`, `docs/architecture/adr`, `docs/arch/adr`, `doc/adr`, `doc/architecture/decisions`, `doc/decisions`, `adr`, `adrs`, `decisions` e `architecture/decisions`. São as pastas padrão do adr-tools (`doc/adr`), do MADR (`docs/decisions`), do log4brains (`docs/adr`) e as variações que aparecem nos guias, mais a nossa.

- **É ADR** todo `.md` da pasta, menos `README.md`, `index.md`, `template.md`, `adr-template.md` e `toc.md`.
- **Fica de fora** quem guarda ADRs em outro lugar (um projeto de referência usa `locales/en/examples/…`). Para esses casos, a evolução é uma pasta configurada por repositório, não uma busca na árvore inteira (ver "Riscos").

## Como extrair cada campo

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

Duas escolhas que evitam erro:

- **Ligações só em lugares previsíveis.** "Substitui" é verbo comum em português; procurar no texto inteiro ligaria ADRs que só citam uma troca qualquer. Por isso o extrator lê ligações nos metadados, no status e nas seções de links, nunca no corpo.
- **O texto do repositório é dado, não página.** O Markdown de uma ADR vem de qualquer repositório que a conta enxerga. A tela renderiza sem HTML embutido e só com links `http(s)` e relativos à pasta, como as outras telas fazem com títulos de sessão.

## Teste contra ADRs reais

`node --test spikes/adr-extractor/` roda 7 testes e todos passam. Eles cobrem `docs/decisoes` deste repositório e amostras sintéticas dos cinco formatos (`spikes/adr-extractor/fixtures`).

| Conjunto | ADRs | Formato detectado | O que faltou no texto | Ligações |
| --- | ---: | --- | --- | --- |
| `docs/decisoes` (este repositório) | 7 | livre, pt-BR, nas 7 | só as alternativas da 0004, que não tem a seção | 7 escritas ("Mexe em", "Parte de") e 7 voltas |
| MADR (o repositório do formato) | 19 | MADR 4: 1, MADR 3: 1, MADR sem versão: 17 | status e data nas 19, consequências em 18 | nenhuma |
| adr-tools | 9 | adr-tools, nas 9 | alternativas nas 9 (o formato não tem) | 2 (emenda) |
| log4brains | 11 | MADR 2: 9, livre: 2 | consequências em 9 | 4 (2 substituições, com a volta) |

As 39 ADRs públicas foram lidas na hora, para o teste, e não entraram no repositório. O que faltou nelas falta no texto: o extrator acertou o que existe, e o que não existe vira "não está no texto" na tela.

Em `docs/decisoes`, as datas vêm em dois formatos (`18/10/2026` na 0001 e ISO nas outras) e o status da 0005 tem uma nota ("aceita; revista no mesmo dia: …"). As duas coisas saem normalizadas, com o original guardado.

## Custo no GitHub

Medido em 20/10/2026, com o `gh` desta máquina, contra este repositório e repositórios públicos de referência.

| Leitura | Como | Custo | Tempo |
| --- | --- | ---: | ---: |
| Descoberta: 1 repositório, 7 pastas | GraphQL, um apelido por pasta: `object(expression: "HEAD:docs/adr") { ... on Tree { entries { name type oid } } }` | 1 ponto | 0,7 s |
| Descoberta: 20 repositórios, 14 pastas (280 apelidos) | A mesma, numa consulta só, com `defaultBranchRef { target { oid } }` | 1 ponto | cerca de 4 s |
| Conteúdo: as 7 ADRs deste repositório (124 KB) | GraphQL, um apelido por arquivo: `object(expression: "HEAD:<caminho>") { ... on Blob { oid text } }` | 1 ponto | 1,3 s |
| Conteúdo: 21 ADRs de um repositório | A mesma | 1 ponto | — |
| Árvore inteira (alternativa) | REST `git/trees/HEAD?recursive=1` | 1 requisição; 304 com ETag | 140 KB |

`object` não é conexão paginada, então o custo não cresce com o número de apelidos: cresce o tempo de servidor. Por isso o lote fica em 20 repositórios na descoberta e 50 arquivos no conteúdo, abaixo do teto de CPU da decisão 0001.

### Como a leitura entra no cache da decisão 0001

1. **Descoberta junto com Repositórios.** A lista de C22 já traz o último push de cada repositório. A descoberta só pede os repositórios com push novo, em lotes de 20, e guarda na chave `adrs:dir:<dono>/<repo>` a pasta achada, o commit e os arquivos com o hash (`oid`) de cada um. TTL de 15 min, com o último push como invalidação.
2. **Conteúdo pelo hash.** A chave é `adrs:blob:<oid>`, sem TTL: o hash do Git é o próprio conteúdo, então nunca envelhece. Só os arquivos com hash novo são pedidos, em lotes de 50. O resultado do extrator fica em `adrs:parsed:<oid>:<versão do extrator>`, para não reprocessar.
3. **Abrir uma ADR não chama o GitHub.** O texto veio no lote. "Último commit há 20 dias" (C30, em 1440) é a única leitura sob demanda: `history(first: 1, path: …)`, 1 ponto, TTL de 1 h.
4. **A busca é local.** Busca no título e no texto em cache, no núcleo. A busca de código do GitHub teria limite próprio (10 por minuto) e não indexa todo repositório.
5. **Falhas.** Limite atingido ou rede fora: serve o cache com a hora dele (C31), como as outras chaves. Sem cache e sem GitHub: "sem dados".

**Orçamento:** abrir a tela pela primeira vez, com 8 repositórios e até 50 ADRs, custa 2 pontos. Com a tela aberta e ninguém fazendo push, a releitura da descoberta a cada 15 min dá até 4 pontos por hora; com push, mais 1 ponto por lote de ADRs mudadas. Nada é lido na partida do núcleo: só quando a tela ou a aba abre, como manda a 0001.

**No hub (decisão 0002):** o evento `push` do GitHub App diz quais arquivos mudaram. Se algum está numa pasta de ADR, a chave `adrs:dir` daquele repositório é invalidada, e a descoberta periódica deixa de ser necessária.

## Como fica a implementação (depois do wireframe aprovado)

Bastidores em inglês, tela em pt-BR:

- **Domínio:** `packages/nucleo/src/adrs/` com o extrator do spike passado para TypeScript (`parse.ts`, `link.ts`) e os testes das mesmas amostras.
- **Fonte:** `packages/nucleo/src/github/adrs-source.ts`, com as duas consultas e o lote, sobre o mesmo `githubGraphql` e o cache único do `cli.ts` que Repositórios usa ([#170](https://github.com/ahrenatechnology/ahrena-console/pull/170)).
- **API:**
  - `GET /api/adrs?q=&status=&repo=`: a lista de todos os repositórios, sem o texto;
  - `GET /api/adrs/<owner>/<repo>`: a lista de um repositório, a pasta e a hora da leitura;
  - `GET /api/adrs/<owner>/<repo>/<id>`: a ADR estruturada e o Markdown original, para o botão "Markdown".
- **Telas:** `/ui/adrs` (C28), `/ui/adrs/<owner>/<repo>/<id>` (C30) e a aba ADRs em `/ui/repos/<owner>/<repo>` (C29). CSS em `ui/adrs.css`, com prefixo `adr-`.
- **Mudança ao vivo:** `tipo: 'adrs'`, com a chave `<owner>/<repo>`.
- **Testes:** com o GitHub falso de `src/simulador/github-falso.ts`, sem chamar a API real (critério 4 da issue).

## Riscos e limites

- **Depende do [#170](https://github.com/ahrenatechnology/ahrena-console/pull/170).** O cliente REST com ETag, a lista com o último push e o GitHub falso entram com ele, que ainda está aberto.
- **Pasta fora da lista.** Fica de fora até existir uma pasta configurada por repositório. A árvore inteira pelo REST acharia essas pastas (1 requisição, com ETag), mas pesa 140 KB neste repositório e corta em 100 mil arquivos nos monorepos grandes. Fica como plano B.
- **Status fora do vocabulário.** Vira "Sem status", com o texto original no card Registro.
- **Números repetidos** (duas ADRs 0007 depois de um merge): a chave é o nome do arquivo, não o número; a tela mostra as duas.
- **Repositórios privados.** O token do `gh` lê só o que a pessoa lê. A tela não mostra nada que ela não veria no GitHub.
