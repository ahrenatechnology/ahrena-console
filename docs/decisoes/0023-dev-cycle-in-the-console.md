# 0023 · O ciclo de desenvolvimento no Console: o Dev Console liga cada PR à sessão que o segura e mostra a etapa de cada issue; executar continua fora

- **Status:** aceita (o Fernando aceitou em 12/11, depois do PR #471)
- **Data:** 2026-11-12
- **Issue:** [#470](https://github.com/ahrenatechnology/ahrena-console/issues/470)
- **Estende:** [0008](0008-machine-telemetry-and-dev-console.md) §4 (o Dev Console é derivado do GitHub e das sessões, sem anotação manual)
- **Depende de:** [0003](0003-responder-sessao.md) (a ordem chega pelo mod de dentro da sessão) e da admissão "somente franquia" ([billing-admission](../billing-admission.md), #382, #387), que segura toda execução gerenciada
- **Estudo:** benchmark interno, estudos 07 (T3 Code) e 08 (Orca), [ahrena-benchmark#1](https://github.com/ahrenatechnology/ahrena-benchmark/pull/1) (privado)

## Contexto

O ciclo de desenvolvimento da Ahrena já existe e é mais completo que o dos produtos de referência. Ele passa por estas etapas:

- a rodada (PM e TL);
- a issue com critério de aceite;
- a Athena, que planeja e empilha as camadas;
- o gate do projeto;
- o veredito do Argos;
- o CI;
- o merge feito pela TL ou pela sessão dona;
- staging, onde houver.

O que falta é a tela. Cada etapa vive numa sessão do Claude Desktop, e o dono descobre o estado de um PR abrindo a sessão que o segura. A medição do #420 mostra o preço disso: 77% dos turnos e 64% dos tokens vieram de despertares, não da pessoa.

**O que estudamos.** O T3 Code e o Orca (estudos 07 e 08 do benchmark) fazem bem a parte de produto:

- worktree por tarefa;
- PR ligado à sessão sem anotação;
- vigia de CI;
- review devolvido ao agente;
- estado do agente lido de hooks.

Os dois param no botão de merge e começam todo laço num clique. Nenhum deles tem issue como origem, gate, revisor com veredito, merge por política ou staging.

**O que o núcleo já sabe** (`src/dev-console/`):

- **Os PRs abertos de cada repositório do contexto** (`PullRequestFact`): draft, `mergeable`, `mergeStateStatus`, base e `headRefName`, CI, review e as issues que o PR fecha (`closes`). Também os mergeados na janela.
- **A fila de merge e os motivos de "não pronto"** (`buildMergeQueue`, `NOT_READY_REASONS`).
- **O quadro das issues em seis colunas e o placar.**
- **O repositório e a branch de cada sessão viva** (`ContextSession`). A branch vem do índice do Desktop ou do git; a issue sai do nome da branch.
- **Quem precisa de você** (`attention`, #245).

**O que o núcleo ainda não sabe:**

- **Qual PR é de qual sessão.** Os dois lados estão lidos, mas não ligados.
- **O veredito do Argos.** Ele não é uma review do GitHub (`reviewDecision` vem vazio, porque o Fernando não aprova no GitHub). É um comentário com o marcador `<!-- ahrena-review:<pr>:<sha> -->`, mas o formato não é estável:
  - o #459 usa `## Argos review of <sha8>: REQUEST CHANGES`;
  - o #460 usa `## Argos: approve (...)`;
  - a skill `publishing-review-verdicts` prescreve `**Verdict:** ...` com um SHA de 7 caracteres no marcador, enquanto o #459 e o #460 gravaram o SHA de 40.

  Os comentários são todos da mesma conta (`fernandoseguim`), a mesma que todas as sessões usam.
- **Staging.** O `ahrena-console` não publica deployments no GitHub (`GET /repos/.../deployments` devolve 0).

## Decisão

**O Console passa a mostrar o ciclo, não a executá-lo.** O Dev Console liga cada PR à sessão que o segura (mesmo repositório, `headRefName` igual à branch da sessão). Também lê o veredito do Argos sobre o head atual e mostra, por issue, em que etapa ela está. Quando todos os PRs de uma sessão foram mergeados ou fechados, a tela diz que ela está concluída e oferece Arquivar. Lançar, retomar ou acordar agentes continua fora até a admissão permitir.

### 1. PR ligado à sessão (fatia 1)

- **A regra:** uma sessão e um PR ficam ligados quando estão no mesmo repositório (`repoKey`) e a branch da sessão é igual ao `headRefName` do PR, com `isCrossRepository` falso. Um PR sem sessão viva aparece como "sem sessão"; uma sessão sem PR aparece sem PR.
- **Ambiguidade:** duas sessões na mesma branch (por exemplo, uma filha que herdou a worktree) ligam ao mesmo PR, e a tela mostra as duas. Nada é escolhido por heurística.
- **Onde aparece:** no card da issue do quadro, na fila de merge (a linha do PR ganha a sessão dona e o estado dela) e no painel da sessão (o PR, o CI, o veredito e o motivo de não pronto).
- **Custo no GitHub:** zero chamadas novas. A ligação é feita no núcleo, sobre o que o `DevConsolePullRequests` já traz.

### 2. O veredito do Argos (fatia 1)

- **O contrato é o marcador, e ele precisa levar o veredito.** Ler o título em prosa quebraria a cada variação. Antes da fatia 1, a [ahrena-framework#274](https://github.com/ahrenatechnology/ahrena-framework/issues/274) fixa o marcador como `<!-- ahrena-review:<pr>:<sha> verdict=<approve|request-changes|comment> -->`, com o SHA de 7 a 40 caracteres. A skill `publishing-review-verdicts` passa a escrevê-lo assim.
- **Os comentários antigos:** um marcador sem `verdict=` vira `verdict: 'unknown'`, e a tela mostra "veredito sem formato". Não há heurística sobre o título.
- **O que muda na leitura:** a consulta `DevConsolePullRequests` passa a trazer os últimos comentários de cada PR, e o núcleo procura neles o marcador do Argos.
  - `PullRequestFact` ganha `argos: { verdict: 'approve' | 'request-changes' | 'comment' | 'unknown'; headSha: string; current: boolean } | null`.
  - `current` é verdadeiro quando o head de agora começa pelo SHA do marcador (prefixo, porque o marcador pode ter de 7 a 40 caracteres). Um veredito sobre um head antigo vale como "revisão desatualizada", nunca como aprovado.
- **Fila de merge:** ganha o motivo `argos-pending` (sem veredito atual, ou com veredito atual `unknown`) e `argos-changes` (mudanças pedidas). Um PR só fica "pronto" com veredito `approve` atual, CI verde e sem conflito, que é a política de merge do AGENTS.md.
- **Custo:** a consulta continua sendo uma por repositório, um pouco mais funda. O orçamento da [0001](0001-github-consulta-cache.md) é medido na fatia, antes do merge.
- **O que isso não é:** prova de que o Argos revisou.
  - A leitura aceita só comentários dos autores que o contexto declara (hoje `fernandoseguim`) e mostra o autor na tela. Isso barra pessoas de fora, mas não separa o Argos de qualquer outra sessão: todas comentam pela mesma conta, e qualquer uma pode escrever o marcador.
  - Aceitamos esse risco porque a leitura só mostra. O Console nunca mergeia nem libera merge por ela; quem mergeia continua conferindo o veredito no PR.
  - Uma conta própria para a agência fecharia a brecha, mas fica fora desta decisão.

### 3. A etapa de cada issue (fatia 2)

O card da issue ganha uma linha de etapas, derivada sem anotação:

| Etapa (id) | De onde vem |
| --- | --- |
| Na rodada (`in-round`) | a issue está na Round issue aberta do repositório (a lista de issues dela) |
| Em plano (`planning`) | uma sessão viva tem branch da issue e ainda não há PR que a feche |
| Em construção (`building`) | há PR aberto que fecha a issue; as camadas empilhadas vêm da cadeia `baseRefName` → `headRefName` |
| Em revisão (`in-review`) | o PR do topo está sem veredito atual do Argos, ou com `request-changes` |
| Pronta para merge (`ready`) | veredito `approve` atual, CI verde, sem conflito |
| Mergeada (`merged`) | todos os PRs que fecham a issue foram mergeados |
| Em staging (`staging`) | só em repositório que publica deployments num ambiente chamado `staging`; nos outros a etapa não aparece |

- **A confirmar na fatia:** como a Round issue lista as issues dela (corpo ou sub-issues). A fatia lê o formato do `opening-the-round` e escolhe um. Sem Round issue aberta, a etapa "Na rodada" não aparece.

### 4. Sessão concluída e Arquivar (fatia 3)

- **Concluída:** uma sessão viva cujos PRs ligados estão todos mergeados ou fechados, e que não está trabalhando, aparece como "Concluída" no painel e na lista. É a regra "arquivar o que está feito" do AGENTS.md, agora vista em vez de lembrada.
- **Arquivar:** o botão manda uma ordem `archive` ao mod que roda dentro da sessão, pelo mesmo caminho do `/compact` e do `/clear` (`messaging/orders.ts`, 0003). O núcleo não alcança as ferramentas internas do Desktop (V4), então só a própria sessão se arquiva.
  - **A confirmar:** se o mod consegue arquivar a própria sessão. A fatia começa por essa prova, como o #309 fez com as ordens. Sem a prova, a fatia entrega só o "Concluída", e o arquivamento continua à mão.
  - O #403 (o mod recebe 403 ao buscar as ordens) precisa estar resolvido antes.
- **Nunca automático:** o Console não arquiva sem um clique. Uma sessão arquivada por engano perde o contexto de quem ia retomá-la.

### 5. O que veio do estudo e onde ficou

| Ideia | De | Destino | Por quê |
| --- | --- | --- | --- |
| PR ligado à sessão sem anotação | T3 | **Entra** (§1) | Os dados já estão no núcleo; custo zero no GitHub |
| Sessão concluída quando o PR é mergeado | T3 | **Entra** (§4), com clique | Ataca os despertares do #420 sem arriscar perder contexto |
| Vigiar o PR e acordar o agente (`watch_pull_request`) | T3 | **Depois** | O Auto-fix do Desktop já acorda a sessão dona do PR ligado. Um segundo vigia acordaria a mesma sessão duas vezes, o contrário do #420. Volta quando a fatia 1 mostrar quais PRs ficam sem Auto-fix |
| Diff por turno com checkpoints em refs ocultas | T3 | **Depois**, no #383 | Depende de o núcleo hospedar a execução |
| Agentes de fora por MCP com teto de permissão | T3 | **Depois**, no #127 | O modelo de teto vai para lá |
| Estado do agente por hooks, OSC 7501 e regras publicadas fora do release | Orca | **Depois**, no #379 | Para o Claude os hooks já bastam; as regras servem à paridade com o Codex |
| Comentário de linha no diff mandado à sessão | Orca | **Depois** | Cabe na mensageria (#61), mas o diff da worktree é uma tela nova; vem depois da fatia 2 |
| Da issue para a worktree em um clique | Orca | **Depois**, no #126 | Abrir trabalho é abrir sessão, e a agência entra pela Athena |
| Orquestração com Run, Tasks, `worker_done` e `ack`, sem polling | Orca | **Fora do Console** | É desenho da agência (Athena e Hermes) no ahrena-framework; a issue vai para lá |
| Comentário de review como dado não confiável, com o app resolvendo a thread | Orca | **Fora do Console** | É do Erodos, no ahrena-framework |
| Automações agendadas com `precheck` | Orca | **Depois** | As rotinas do Claude cobrem o agendamento; o `precheck` vale como ideia para elas |
| Botão de merge e "Merge stack" | T3, Orca | **Rejeitada** | O merge é da TL ou da sessão dona, por política; o Fernando não clica em merge |
| App de celular próprio | T3, Orca | **Rejeitada** | O Remote Control da Anthropic já leva as sessões ao celular |

## Fatias

1. **PR ligado à sessão e veredito do Argos** (§1, §2), [#472](https://github.com/ahrenatechnology/ahrena-console/issues/472): núcleo e telas do Dev Console e do painel da sessão. Wireframe primeiro. Depende da [ahrena-framework#274](https://github.com/ahrenatechnology/ahrena-framework/issues/274).
2. **A etapa de cada issue** (§3), [#473](https://github.com/ahrenatechnology/ahrena-console/issues/473): o card do quadro, com a leitura da Round issue. Depende da fatia 1.
3. **Sessão concluída e Arquivar** (§4), [#474](https://github.com/ahrenatechnology/ahrena-console/issues/474): começa pela prova do mod. Depende da fatia 1 e do #403.

Cada fatia entra pela Athena. O que foi para o ahrena-framework: a orquestração sem polling, como referência na [ahrena-framework#246](https://github.com/ahrenatechnology/ahrena-framework/issues/246), e os comentários de review como dado não confiável no Erodos, na [ahrena-framework#279](https://github.com/ahrenatechnology/ahrena-framework/issues/279).

## Consequências

- O Console passa a ser a tela do ciclo da agência, que é o que o T3 e o Orca não têm, sem competir com eles na execução.
- A política de merge ganha uma leitura no núcleo (veredito atual + CI + conflito). Se ela mudar no AGENTS.md, muda também aqui.
- O marcador do Argos vira contrato entre o ahrena-framework e o Console. A fatia 1 depende da [ahrena-framework#274](https://github.com/ahrenatechnology/ahrena-framework/issues/274) e registra o formato num teste; mudar o marcador depois exige mudar os dois.
- Nada desta decisão executa modelo, então a admissão não bloqueia nenhuma das três fatias.
