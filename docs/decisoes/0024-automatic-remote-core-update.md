# 0024 · Núcleo remoto: o comando de atualização sai do `connection.credential` e o Mac atualiza sozinho, uma vez por versão

- **Status:** aceita (pedido do Fernando em 2026-11-13, registrado na issue #484: "se o app atualizou, o núcleo tem que atualizar sozinho, tanto o local quanto o remoto. Se algo impedir, que pelo menos haja um botão, mas o ideal é automático"; ele recusou colar um bloco `connection.update` no `machines.json`)
- **Data:** 2026-11-13
- **Issue:** [#484](https://github.com/ahrenatechnology/ahrena-console/issues/484)
- **Substitui:** [0022](0022-remote-core-update-button.md) §1 (o comando só existe se declarado em `connection.update`; a "Alternativa A" rejeitada; o card "Ativar o botão Atualizar" com o bloco pronto) e, na mesma 0022, o item "atualização sem a pessoa pedir" do Fora do escopo e de §8. Substitui também, na [0021](0021-remote-core-update.md), a frase do §1 de que a leitura anônima da versão "nunca decide uma atualização" (agora ela dispara uma tentativa, §2) e os dois itens de "atualização sem a pessoa pedir" (o "Fora do escopo, de novo" do §2 e o Fora do escopo). E substitui, na [0020](0020-remote-owner-credential-over-ssh.md) §1, "o núcleo nunca monta um comando SSH" (só para o comando derivado, §1 daqui) e, como a 0020 estende a [0013](0013-cloud-connectors-and-machine-connection.md) §4, o "o núcleo nunca abre SSH por conta própria" (só para a tentativa automática, §2 daqui). O resto da 0020, da 0021 e da 0013 §4 segue em vigor.
- **Continua valendo da 0022:** o script mandado por stdin (§2), o `--check` antes de qualquer parada e a trava `33` (§3), as fases em NDJSON e a marca "atualizando" (§4), o descarte da credencial e a faixa que some no sucesso (§5), as rotas, o estado, o tempo e o cancelar (§6), a tabela de textos (§7). Nunca `--allow-disconnect`, `--force` nem `--core-options`.
- **Usa:** [0020](0020-remote-owner-credential-over-ssh.md) §1 (o `credential` é o prefixo SSH que a pessoa escreveu), [0021](0021-remote-core-update.md) §1 (a versão lida do `/api/overview`)
- **Toca:** [0009](0009-english-internals.md) (nomes em inglês, texto da tela em pt-BR)

## Contexto

O app foi para a 0.0.18 e o núcleo da Workstation ficou na 0.0.17. A tela de Máquinas pediu ao Fernando para colar um bloco `connection.update` no `machines.json` antes de mostrar o botão Atualizar, e logo abaixo mostrou um `git … && node …` para colar no terminal. Ele recusou os dois: se o app atualizou, o núcleo de lá tem que atualizar sozinho; um botão serve só para quando algo impedir.

A 0022 §1 deixou a "Alternativa A" (montar o comando a partir do `connection.credential`) "como ideia de uma decisão futura, se o Fernando preferir zero arquivo a esta regra". Ele prefere. O núcleo já sabe montar esse comando: `packages/nucleo/src/telemetry/core-update-block.ts` (`buildUpdateBlock`) gera o bloco "pronto" a partir do `credential`, e o validador (`parseUpdate`) o aceita. O núcleo **local** já é trocado quando o app sobe numa versão mais nova ([#220](https://github.com/ahrenatechnology/ahrena-console/issues/220), `packages/nucleo/src/owner/owner.ts`); a falta é só no remoto.

## Decisão

**O núcleo do Mac monta o comando de atualização a partir do `connection.credential` da máquina, quando não há um `connection.update` declarado. Quando a versão que o núcleo remoto responde é mais antiga que a do app, o núcleo do Mac roda sozinho o `--check` e, se passar, a atualização: uma vez por par (máquina, versão alvo), sem clique, sem edição de arquivo e sem a tela aberta. Se essa tentativa falhar ou for recusada, ele não tenta de novo sozinho; a tela oferece "Tentar de novo", que segue o caminho da 0022.**

### 1. De onde vem o comando

1. **`connection.update` declarado e válido:** é ele (`source: "declared"`). Quem escreveu o próprio comando continua mandando.
2. **`connection.update` declarado e inválido:** nada roda e a tela diz o motivo (`problem: "invalid"`, o texto da 0022 §7). **Não cai no derivado.** O texto que a pessoa escreveu explicitamente vence; trocar em silêncio por outro comando esconderia o erro dela e rodaria o que ela não quis.
3. **Sem `connection.update`:** o comando é o que `buildUpdateBlock` monta do `connection.credential` (`source: "derived"`): o prefixo SSH do `credential` copiado como está, e o rabo `<node> <checkout>/packages/nucleo/src/owner/cli.ts remote-credential --port <n>` trocado por `<node> --disable-warning=ExperimentalWarning --input-type=module - --checkout <checkout> --port <n>`. O `<checkout>` é `connection.checkout` ou o que o caminho do `cli.ts` implica. `timeoutSeconds` é o padrão, 300. O comando derivado passa pelo mesmo validador do declarado (`parseUpdate`), então também nunca carrega `--allow-disconnect`, `--force` nem `--core-options`.
4. **Sem `connection.update` e com um `credential` que não tem a forma conhecida:** `problem: "missing"`, nada roda, e a tela diz que não deu para montar o comando e que um `connection.update` declarado resolve.
5. **Sem `connection.update` e sem `connection.credential`:** `problem: "credential-missing"`, como hoje. Um `connection.update` declarado sem `credential` continua valendo (`configured`, `source: "declared"`), mas só pelo botão: o automático exige o `credential` (§2).

A cauda fechada da 0022 §1 não muda: `--ref app-v<versão do app>`, `--mac-telemetry-version <n>`, `--mac-credential-command yes|no`, `--progress json` e, só na conferência, `--check`. O argv de cada chamada é exatamente o comando (declarado ou derivado) mais essa cauda, e um teste prova isso valor a valor.

**Por que isso deixa de quebrar a regra "o Mac só roda o que o usuário escreveu":** o que o Mac executa localmente, o `ssh` com o host, as opções e o `node` de lá, continua sendo o que a pessoa escreveu no `credential`. O que muda é o programa remoto: em vez do `cli.ts remote-credential`, o `node` lê o script do stdin, com o mesmo checkout. A pessoa que declarou o `credential` passa a autorizar também a atualização daquele núcleo; o Fernando pediu exatamente isso. Quem não quer tem duas saídas: declarar um `connection.update` (que tem precedência) ou não declarar o `credential`.

### 2. O disparo automático

**Quando dispara.** A cada leitura do `/api/overview` da máquina (a de 30 s da 0021 §1, que roda com ou sem a tela aberta), o núcleo do Mac olha se:

- a versão que o núcleo remoto respondeu é **estritamente mais antiga** que a do app, por semver (`0.0.17` < `0.0.18`). O caso "mesma versão, commit mais velho", que só existe quando o Mac roda de um checkout, **não** dispara: é ambiente de desenvolvimento e o alvo seria a mesma tag;
- a máquina tem `connection.credential` válido e um comando de atualização válido (declarado ou derivado, §1), e o `machines.json` não está inválido;
- a versão do app tem tag (`app-v<major.minor.patch>`; uma prerelease não dispara);
- não há nenhum job da máquina rodando (nem um `--check` que a pessoa pediu), nem um `--check` bom da pessoa esperando a confirmação (os 5 minutos da 0022 §3): o automático não toma a confirmação aberta de ninguém e, nesse caso, não gasta a tentativa;
- a tentativa automática para aquele alvo ainda não foi gasta.

**O que roda.** O mesmo job da 0022, por dentro, sem as rotas HTTP: o `--check`; se ele sai `0` (`ready`), a atualização na hora, usando aquele `--check` como o "check bom dos últimos 5 minutos" (sem a janela de confirmação, que existe para a pessoa); se o `--check` recusa, para ali. A trava por máquina, as fases, a marca "atualizando" (a queda durante a troca não vira alerta, a barra lateral mostra "Atualizando") e o §5 da 0022 (descartar a credencial, reler na hora, a faixa que some) valem igual. Nunca `--allow-disconnect`, `--force` nem `--core-options`: a gramática não os tem.

**Uma vez por par (máquina, alvo).** A tentativa é gasta no instante em que começa, antes do `--check`, e o núcleo do Mac a grava em `<data-dir>/core-update-auto.json` (`{ "<id da máquina>": "<versão alvo>" }`, só a última versão de cada máquina). Gravar, e não só guardar em memória, é a escolha desta decisão: o núcleo do Mac reinicia a cada abertura do app e a cada reinício do Mac, e uma atualização que voltou com rollback (`40`) pararia o núcleo de lá por um minuto a cada reinício. Um arquivo ausente vale como vazio; um ilegível ou corrompido vale como vazio, com uma linha de log. O pior caso é uma tentativa a mais por alvo. Um alvo novo (o app foi para a próxima versão) arma de novo.

**Também gastam a tentativa automática para o alvo:** uma atualização que a pessoa rodou pelo botão (manual), e qualquer execução, manual ou automática, que saiu `21` ou `22`.

**Sem laço.** Se a tentativa automática falhar ou for recusada, o Mac não tenta de novo sozinho para aquele alvo, nem com espera: o motivo fica na faixa (o texto da 0022 §7) e a pessoa decide. As saídas `21` (sem credencial) e `22` (precisa de `--allow-disconnect`) nunca levam à atualização: o automático exige `credential` (então declara `--mac-credential-command yes`), e um `--check` que sai `21` ou `22` encerra a tentativa antes de qualquer parada.

**A leitura anônima passa a disparar.** A 0021 §1 dizia que a versão lida do `/api/overview` anônimo "serve para avisar, nunca para decidir uma atualização", porque um impostor na porta responde o que quiser. Aqui ela dispara **uma tentativa**, e quem decide continua sendo o script, pelo SSH da pessoa, lendo o git de lá, com `--check` e trava antes de parar. Nada do corpo da resposta entra no argv: a leitura só escolhe a máquina, e só uma versão `^\d+\.\d+\.\d+$` conta. Mas o que um impostor consegue não é pouco, e fica dito: respondendo uma versão velha na porta, ele faz o Mac rodar, uma vez por versão do app, a atualização da Workstation verdadeira para a versão do app. Se a Workstation estava **à frente** do app (o estado `ahead` da 0021 §1, uma `main` mais nova), isso a para por cerca de um minuto e a **rebaixa** para a tag do app, porque o script hoje não recusa um alvo que é ancestral do `HEAD` de lá. A recusa de rebaixamento no `--check` do script é a mitigação certa e fica para a issue [#489](https://github.com/ahrenatechnology/ahrena-console/issues/489) (toca o script, não esta camada); até lá o risco é aceito, com o limite de uma tentativa por versão.

### 3. O estado que a tela lê

Em `GET /api/machines`, no `update` de cada máquina (0022 §6), entram três campos e muda um:

```ts
update: {
  // … os campos da 0022 §6 …
  configured: boolean;                         // há comando válido, declarado ou derivado
  problem: 'missing' | 'invalid' | 'credential-missing' | 'invalid-file' | null; // 'missing' só quando o credential não deu um comando
  source: 'declared' | 'derived' | null;       // de onde veio o comando; null quando não há
  automatic: boolean;                          // a execução de que `state` fala foi disparada pelo Mac, não por um clique
  auto: { target: string; state: 'running' | 'succeeded' | 'failed' } | null;
                                               // a tentativa automática para a versão do app; null = ainda não houve
}
```

- `auto.state` é `running` enquanto o `--check` ou a atualização automática roda, `succeeded` se a atualização automática saiu `0`, e `failed` se o `--check` recusou, se a atualização falhou, ou se a tentativa foi gasta por outro motivo (§2). `failed` diz "o automático já tentou este alvo e não volta a tentar".
- Depois de um reinício do núcleo do Mac, uma tentativa gasta aparece como `{ target, state: "failed" }` sem o job (que vive em memória): a faixa mostra "Atualizar agora" sem o motivo da última vez. Ver o motivo de novo custa um "Atualizar agora", que roda o `--check` primeiro.
- `auto` só diz se o automático ainda vai disparar para este alvo. `failed` também cobre a tentativa gasta por uma atualização manual, mesmo bem-sucedida. A tela escolhe "Tentar de novo" pelo `state` do último job (`refused`, `failed`, `rolled-back`, `rollback-failed`, `timed-out`, `canceled`), não por `auto`.
- `command` (0022 §6, "o do arquivo") é o comando derivado quando `source: "derived"`.
- Entre o fim do `--check` automático e o começo da atualização encadeada, o estado pode aparecer por um instante como `ready` com `automatic: true`: a tela não abre a confirmação quando `automatic` é `true`.
- `setup.block` (o bloco pronto) só vem com `problem: "invalid"`, para a pessoa comparar com o que escreveu.

### 4. A tela (a camada da Iris)

- **O card "Ativar o botão Atualizar" some.** Não há mais o que colar no `machines.json` quando o `credential` existe.
- **Durante a atualização automática** a faixa mostra a fase como na 0022 §4 ("Conferindo", "Fazendo backup", "Trocando o código", "Subindo o núcleo", "Conferindo que respondeu") e o ponto da barra lateral mostra "Atualizando". No sucesso, a faixa some sozinha (0022 §5).
- **"Atualizar agora"** fica na faixa de defasado enquanto o núcleo remoto estiver defasado e nada estiver rodando, para quando o automático ainda não rodou ou foi gasto.
- **"Tentar de novo"** aparece depois de uma falha ou recusa, no lugar do "Atualizar agora", ao lado do motivo (texto da 0022 §7).
- Os dois botões seguem o caminho da 0022 §3: `POST …/update/check`, a confirmação com o resultado, `POST …/update`. Não há atalho sem `--check`. A confirmação só abre para um `--check` que a pessoa pediu (`automatic: false`).
- **O card do comando para colar no terminal** (0021 §2) aparece só depois de uma falha, recolhido, como saída manual.
- **Textos novos** (esta decisão é a fonte deles; os das saídas seguem a tabela da 0022 §7):

| Chave | O que a tela diz |
| --- | --- |
| `problem-missing` | "Não deu para montar o comando de atualização a partir do connection.credential. Declare um connection.update no machines.json." |
| `problem-credential-missing` | "Falta o connection.credential no machines.json. Configure-o e o Console passa a atualizar o núcleo de lá sozinho." |

### 5. O núcleo local

Nada muda: o app que sobe numa versão mais nova troca o núcleo local mais velho (#220). Esta decisão só pede um teste que prove isso (AC7 da #484), e os que existem em `packages/nucleo/test/owner/owner.test.ts` provam.

## Alternativas rejeitadas

- **Um `connection.update` inválido cai no derivado.** Esconderia o erro do que a pessoa escreveu e rodaria outro comando sem ela saber. A tela diz o motivo e o arquivo é corrigido.
- **Guardar a tentativa só em memória.** Mais simples, mas cada reinício do núcleo do Mac (cada abertura do app) rearmaria o automático, e uma atualização que falha depois do `swap` pararia o núcleo de lá a cada vez.
- **Tentar de novo com espera crescente.** Uma recusa do `--check` (`30`, árvore suja; `22`) não some sozinha, e uma falha depois do `swap` já parou o núcleo uma vez. A pessoa decide pelo "Tentar de novo".
- **Disparar também no "mesma versão, commit mais velho".** Só acontece com o Mac rodando de um checkout, e o alvo seria a mesma tag: rodaria a troca sem mudar nada.
- **O núcleo gravar o `connection.update` no `machines.json`.** Rejeitado pela 0022 §1 (Alternativa B) e continua: o arquivo é da pessoa.
- **Esperar a tela abrir para disparar.** O pedido é "sozinho": o app atualizou e o núcleo de lá acompanha, com a tela aberta ou não.

## Riscos, ditos

- **O núcleo de lá para por cerca de um minuto sem ninguém clicar.** É o que o dono pediu. A faixa e a barra lateral mostram "Atualizando" se a tela estiver aberta, e o `--check`, a trava, o backup e o rollback do script valem como no clique.
- **O rollback real ainda não rodou fora de teste** (0022 §9). O primeiro `40` ou `41` real pode vir de uma atualização automática. A faixa mostra o motivo e o caminho do backup, e o automático não tenta de novo.
- **Quem declarou só o `credential` passa a autorizar a atualização.** Decisão do dono; quem não quer declara um `connection.update` próprio ou não declara o `credential`.
- **Um impostor na porta pode disparar uma tentativa** (§2): no máximo uma por versão do app, pelo SSH da pessoa, para a versão do app. Isso inclui parar e **rebaixar** uma Workstation que estava à frente do app, até o script ganhar a recusa de rebaixamento (issue [#489](https://github.com/ahrenatechnology/ahrena-console/issues/489)).

## Plano de camadas

1. **Esta decisão** (PR de documentação, na base da pilha).
2. **apollo · o núcleo do Mac.** O comando derivado com precedência do declarado, `source`, o disparo automático uma vez por (máquina, alvo) com o arquivo `core-update-auto.json`, `automatic` e `auto` no estado, os dois textos novos, o teste do núcleo local (AC7). AC1, AC2, AC3 (lado do núcleo), AC7, AC8.
3. **iris · a tela.** O fim do card "Ativar", "Atualizar agora", "Tentar de novo", o card de copiar só depois de uma falha e recolhido, o andamento da automática. AC3 (o que se vê), AC4, AC5, AC6.

## Plano de testes

Os fakes da 0022 (`test/telemetry/fake-update-ssh.mjs`, `core-update-fixture.ts`), sem SSH real.

- **AC8, o argv derivado:** um `credential` com o prefixo SSH e o `cli.ts remote-credential` vira exatamente prefixo + `node --disable-warning=ExperimentalWarning --input-type=module - --checkout <checkout> --port <n>` + a cauda fechada, valor a valor, no `--check` e na atualização; nada de `--allow-disconnect`, `--force` ou `--core-options`.
- **Precedência:** declarado válido vence o derivado; declarado inválido fica `invalid` e nada roda.
- **AC2, disparo único:** versão remota mais antiga → um `--check` e uma atualização, sem chamada às rotas; a segunda leitura não dispara de novo; um núcleo do Mac novo lendo o mesmo arquivo não dispara de novo; um alvo novo dispara.
- **AC3, sem laço:** `--check` recusado (`21`, `22`, `30`) → nenhuma atualização e `auto.state: failed`; atualização que falha (`40`) → nenhuma segunda tentativa automática; o "Tentar de novo" (as rotas) continua funcionando.
- **Não dispara:** versão igual, mais nova ou desconhecida; sem `credential`; `update` inválido; arquivo inválido; prerelease; com um job rodando; com um `--check` bom da pessoa esperando a confirmação (e sem gastar a tentativa).
- **AC7:** os testes de `owner.test.ts` da #220, marcados com o critério.

## Consequências

- A Workstation acompanha o app sem edição de arquivo nem clique, depois que o `credential` existe (a 0020 já o pede).
- O `connection.update` passa a ser opcional: só quem quer outro comando o declara.
- O núcleo do Mac grava um arquivo pequeno a mais na pasta de dados.
- A 0022 §1 e o "fora do escopo" dela ficam como história; o resto da 0022 segue sendo o contrato do job.
