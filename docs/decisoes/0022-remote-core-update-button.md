# 0022 · Núcleo remoto: o botão Atualizar roda, pelo SSH que o usuário declarou, o script do próprio app, com `--check` antes, trava na máquina e andamento por fase

- **Status:** proposta (a aceitar pelo Fernando antes de qualquer código; o PR da decisão não é mergeado até lá)
- **Data:** 2026-11-12
- **Issue:** [#462](https://github.com/ahrenatechnology/ahrena-console/issues/462)
- **Substitui:** [0021](0021-remote-core-update.md) §2 (a alternativa "`connection.update` no `machines.json`", rejeitada "por ora"). O resto da 0021 (a versão lida do `/api/overview`, o script, a trava do §4, a unidade do systemd) continua valendo e é o que esta decisão usa.
- **Estende:** [0012](0012-remote-reconnect.md) e [0013](0013-cloud-connectors-and-machine-connection.md) §4 (o Mac só roda comando que o usuário escreveu, em lista, sem shell, um por máquina, mesma origem), [0020](0020-remote-owner-credential-over-ssh.md) §1 (o comando SSH em lista, o runner próprio, o teto de saída, a credencial renovada sozinha)
- **Toca:** [0009](0009-english-internals.md) (nomes em inglês, texto da tela em pt-BR), [0003](0003-responder-sessao.md) (mais três rotas de escrita de mesma origem)

## Contexto

A 0021 §2 recomendou que a tela só avisasse e mostrasse um comando `git … && node …` para a pessoa colar no terminal da máquina, e rejeitou "por ora" um `connection.update`, com três razões: o clique para e troca um processo que funciona; exigiria job, progresso, cancelamento e log; e o rollback "precisa de um humano olhando". Ela deixou a decisão aberta "depois que o script provar o rollback na Workstation".

O que mudou, dito sem exagero:

- **O script provou o caminho feliz na máquina real.** Em 2026-11-12 o `update-remote-core.mjs` rodou na Workstation: `--check` saiu 0, a atualização 0.0.16 → 0.0.17 fez o backup, trocou o código, subiu e conferiu (saída 0), e `install-unit` pôs o núcleo sob `ahrena-console-core.service`.
- **O rollback (saídas 40 e 41) NÃO foi provado na máquina real.** Só os testes com repositório git temporário e núcleo falso o exercitam. A condição que a 0021 pôs ("provar o rollback") foi cumprida pela metade, e esta decisão não finge o contrário: ela aposta que o caminho feliz provado, a trava que recusa antes de parar e o rollback testado bastam para um clique com confirmação, e deixa o rollback real como passo manual registrado (§7).
- **O dono recusou o fluxo de copiar e colar** ao usá-lo: "Não faz sentido eu ter que rodar um git command". A razão que sobra da 0021 (o clique para um processo que funciona) é justo o que a confirmação, o `--check` antes e o backup cobrem; as outras duas (job, progresso) são trabalho, não risco.
- **O Mac já roda um comando por SSH escrito pelo usuário**: `connection.credential.command` (0020), com runner próprio, teto de saída, timeout e log sem segredo. O molde existe.

Fatos do código que a proposta usa: `update-remote-core.mjs` sai `0` (ok), `2` (uso), `20`–`23` (trava), `30`–`32` (preflight, backup, processo), `40`/`41` (rollback); `--check` roda só preflight e trava; `--allow-disconnect` pula só `20`–`23`; o script imprime texto livre em stdout e stderr e **não tem trava de execução simultânea nem protocolo de andamento**. Nada disso existe ainda e é trabalho da camada 2 (§3 e §4).

## Decisão

**A tela de Máquinas ganha um botão "Atualizar" na faixa de defasado. O clique abre uma confirmação que já traz o resultado de um `--check` feito antes; confirmado, o núcleo do Mac roda o comando que o usuário declarou em `connection.update` da máquina, em lista e sem shell, mandando por stdin o script do próprio app. O script é a única coisa que para e sobe o núcleo remoto; ele trava a máquina, anuncia as fases em linhas de JSON e sai com os códigos da 0021. Nunca passa `--allow-disconnect`. O copiar-e-colar da 0021 continua na tela como saída quando falta configurar ou quando a pessoa prefere o terminal.**

### 1. Como o Mac executa: `connection.update`, declarado

**Recomendado: `connection.update` explícito**, no mesmo formato de `connection.credential` (0020 §1):

```json
"update": {
  "command": ["/usr/bin/ssh", "-T", "-o", "BatchMode=yes", "-o", "SessionType=default",
    "-o", "ControlMaster=no", "-o", "ClearAllForwardings=yes", "ahrena-tunnel",
    "<node absoluto>", "--disable-warning=ExperimentalWarning", "--input-type=module", "-",
    "--checkout", "<checkout>", "--port", "4720"],
  "timeoutSeconds": 300
}
```

- **Regras do arquivo** (as de `start`, `stop` e `credential`): lista de textos, sem shell, sem expansão, `timeoutSeconds` de 60 a 900 (padrão 300). Um `update` inválido derruba só esse campo, com uma linha de log, e a tela diz "connection.update inválido". O núcleo recusa um `command` que contenha `--allow-disconnect`, `--force` ou `--core-options` (§3): o botão nunca pode ser mais permissivo que o dono quis, e quem quer isso roda o comando à mão, no terminal.
- **O que o núcleo acrescenta ao fim** (uma gramática fechada, a única parte do argv que não está no arquivo): `--ref app-v<major.minor.patch>` (o do próprio app; regex `^app-v\d+\.\d+\.\d+$`), `--mac-telemetry-version <inteiro>`, `--mac-credential-command yes|no`, `--progress json` e, só no passo de conferência, `--check`. Nenhum texto da tela, da URL ou do corpo entra no argv; a rota recebe o `id` da máquina e mais nada (0012). Um teste prova o argv exato de cada chamada, e que `--allow-disconnect` nunca aparece.
- **Por que isso respeita a regra da 0012/0013 §4** ("o Mac só roda o que o usuário escreveu; o núcleo nunca monta SSH"): o que o Mac executa localmente, o `ssh` e tudo até o host e o programa remoto, está escrito pelo usuário. A cauda fechada é a mesma coisa que o pedido por stdin do 0020 §1: parâmetros de um comando declarado, validados por regex, nunca um comando novo. É um passo além da letra da 0012 (que roda argv constante) e é a única parte que o Argos deve olhar com lupa no PR da camada 3; a alternativa (passar tudo por stdin) cabe no `credential`, que não carrega código, mas não cabe aqui, porque o stdin já leva o script (§2).
- **Como o comando nasce com o mínimo de configuração: a tela o monta, a pessoa só cola uma vez.** Quando o `machines.json` já tem `connection.credential.command` (a Workstation tem, desde a 0020), a tela mostra "Ativar o botão Atualizar" com o bloco `"update": {…}` **pronto**: o prefixo SSH copiado do `credential` do próprio arquivo e o rabo trocado pelo `node … --input-type=module - --checkout <checkout> --port <porta>`, com o `<checkout>` tirado do caminho do `owner/cli.ts` do `credential` (ou de `connection.checkout`, 0021 §2). O botão "Copiar o bloco" é a única ação; a pessoa cola em `connection`, salva, e o botão "Atualizar" aparece sozinho (o núcleo relê o arquivo a cada 30 s, 0012 §2). Isso é uma edição de arquivo **uma vez**, não um comando a cada atualização.
- **Alternativa A, rejeitada: derivar o comando do `credential` em tempo de execução, sem nada no arquivo.** Zero configuração, mas é o núcleo quem monta o `ssh` (qual elemento do argv é o host? qual é o `node`?), o que a 0020 §1 proíbe de propósito, e uma pessoa que só declarou o `credential` passaria a autorizar, sem saber, um comando que para e troca um processo. Quebra a regra "só roda o que eu escrevi" no ponto mais sensível. Fica como ideia de uma decisão futura, se o Fernando preferir zero arquivo a esta regra.
- **Alternativa B, rejeitada: o núcleo gravar o `update` no `machines.json` num clique.** O arquivo é do usuário, e um núcleo que escreve no arquivo o comando que depois executa apaga a fronteira entre "o que o usuário escreveu" e "o que o núcleo decidiu". A tela mostra o bloco; quem grava é a pessoa.
- **Quando falta ou está inválido** (a tela diz exatamente o que falta; sem botão morto, como no 0012 §5):
  1. sem `connection.update`: a faixa de defasado traz, no lugar do "Atualizar", "Ativar o botão Atualizar" com o bloco pronto e o "Copiar o bloco"; **o card com o comando para copiar da 0021 continua logo abaixo**, como saída;
  2. sem `connection.update` **e** sem `connection.credential`: a tela diz primeiro para configurar a credencial (449-3, que a trava `21` impõe) e só depois o bloco `update`;
  3. `update` inválido: "O connection.update do machines.json está inválido (<motivo fixo>); corrija o arquivo." mais o bloco pronto e o card de copiar;
  4. `machines.json` inválido como um todo: a recusa da 0012 §2 vale, o botão não aparece.

### 2. Como o script chega à máquina remota: o Mac o manda por stdin

**Recomendado: o núcleo do Mac manda o próprio `update-remote-core.mjs` pelo stdin do `ssh`, e o programa remoto declarado é `node --input-type=module -`** (o Node lê o script do stdin). O script é o do app que está rodando, empacotado junto do núcleo e igual ao de `scripts/remote-core/` no commit do release (um teste compara o arquivo empacotado com o do repositório).

- **Acoplamento de versão:** o script vem do app, o `--ref` é `app-v<versão do app>`, e o script, ao ler o alvo com `git show`, lê o manifesto desse mesmo release. App, script e alvo são a mesma versão por construção; não existe "o script de lá está velho". Isso resolve o problema do bootstrap da 0021 (a Workstation de hoje não tinha o script) sem `git` na linha de comando.
- **O script continua a única coisa que para e sobe o núcleo.** O Mac só entrega bytes e lê a saída; nenhuma decisão de parar ou subir sai do núcleo do Mac. O `fetch` das tags, o preflight, a trava, o backup, o stop, o checkout, o start, a conferência e o rollback continuam todos no script, no lado de lá.
- **O stdin é dados, não comando:** o que o Mac executa é o `ssh` do usuário; o texto que ele envia é o arquivo do app, de tamanho conhecido (teto de 256 KiB, falha se passar). O script, ao rodar do stdin, não acha o próprio arquivo: a camada 2 troca o `if (argv[1] === este arquivo)` por uma detecção de "rodando do stdin" e o `--checkout` já dá o caminho do repositório.
- **Alternativa rejeitada: o comando remoto extrai o script do checkout** (`git fetch && git show app-v…:script | node -`, que é o que o card de copiar faz). Exige um shell remoto no `command` (uma pipeline com `&&`), `git` e rede na máquina antes de o script poder se defender (a trava ainda não rodou), e continua dependente de o checkout ter o release. O stdin tira tudo isso.
- **Limite honesto:** o ssh e o Node reais lendo o script do stdin pela conexão mestra (`ControlMaster=no`) são provados com um comando falso nos testes e só de verdade na primeira atualização real (§7).

### 3. A trava, o `--check`, o `--allow-disconnect` e as duas máquinas

- **`--check` antes de qualquer parada, em dois níveis.** (a) O clique em "Atualizar" **não** atualiza: abre a confirmação e roda `--check` (mesmo comando, mesma cauda mais `--check`; só preflight e trava, nada é tocado). O diálogo mostra o resultado: se o `--check` recusa, o motivo e nada mais; se passa, "pronto para atualizar" com o botão Confirmar. (b) O `POST …/update` só vale se houve um `--check` bom para aquele `id` e aquele alvo nos últimos 5 minutos (409 `check-required` senão); e o script, ao atualizar, **repete a trava** antes de parar (0021 §3 passos 1 e 2). A recusa nunca depende só do primeiro.
- **O botão nunca passa `--allow-disconnect`.** A gramática de §1 não o tem, o `command` do arquivo não pode contê-lo, e há teste. Quem precisa dele (o salto para um alvo sem manifesto, código `22`) o faz no terminal, com o card de copiar, que continua mostrando o comando.
- **Trava de execução simultânea, no script e na máquina remota.** `<data-dir>/update.lock`, criado com `O_EXCL` (`wx`) e modo `0600`, com `{ pid, startedAt }`. É da **máquina**, então vale para dois Macs, uma janela e um terminal ao mesmo tempo. Quem acha o arquivo vivo sai com o **código novo `33`** ("já há uma atualização em andamento"), sem tocar em nada. O arquivo é tomado como velho, com uma linha em `update.log`, se o `pid` não existe (`kill(pid, 0)` falha com `ESRCH`) **ou** se `startedAt` é de mais de 30 min; é removido no fim (`finally`) e também nos sinais tratados. O `--check` não cria a trava, mas lê: com a trava viva sai `33`. Além disso, o núcleo do Mac mantém um job por máquina na memória e devolve o estado do que já roda a um segundo clique (0012), então "dois cliques" nem chegam ao SSH.
- **A saída de `--check` e de tudo que o botão usa vira JSON de uma linha por evento** (§4), para o Mac nunca interpretar texto livre.

### 4. Andamento: o que o script anuncia e como o núcleo do Mac aprende

**O núcleo do Mac não consulta nada: ele lê o stdout do `ssh`, que é um protocolo de linhas JSON que o script escreve com `--progress json`.** Com a flag, as mensagens para humanos vão para o stderr (descartado pelo Mac, como no `credential`) e o stdout carrega só:

```
{"v":1,"event":"phase","phase":"check"}
{"v":1,"event":"phase","phase":"backup"}
{"v":1,"event":"phase","phase":"swap"}      // para o processo e troca o código: a partir daqui não há volta limpa
{"v":1,"event":"phase","phase":"start"}
{"v":1,"event":"phase","phase":"verify"}
{"v":1,"event":"phase","phase":"rollback"}  // só se algo falhou depois do swap
{"v":1,"event":"result","exit":40,"reason":"started-failed","backup":"/…/backups/update-…","oldCommit":"<sha>","newCommit":"<sha>"}
```

- **Fases na tela** (cinco passos, na ordem da issue): `check` = "Conferindo"; `backup` = "Fazendo backup"; `swap` = "Trocando o código"; `start` = "Subindo o núcleo"; `verify` = "Conferindo que respondeu". `rollback` aparece como uma linha extra, "Voltando ao código anterior".
- **O parser é fechado**: até 64 KiB de stdout (passou, mata o grupo e falha, como o `credential`), uma linha por JSON, `v: 1`, `phase` e `reason` de listas fechadas, `exit` inteiro, `backup` caminho absoluto de texto (até 512 caracteres, sem controle, só para mostrar), `oldCommit` e `newCommit` por `/^[0-9a-f]{4,40}$/`. Linha que não parseia ou fora do esquema é ignorada. **A decisão vale pelo código de saída do `ssh`** (que repassa o do script), não pelo JSON: o JSON só dá a fase, o `reason` e o caminho do backup. `reason` fecha a ambiguidade do `30` (`dirty-tree`, `unknown-ref`, `new-dependencies`) e do `32` (`process-mismatch`, `no-options`, `did-not-stop`).
- **Como a tela reage:** o estado muda no núcleo do Mac e sai em `/api/mudancas`, como o do `reconnect` (0012 §4): a tela relê o `GET /api/machines` e redesenha a fase. Sem consulta à máquina remota e sem polling por SSH.
- **A máquina "cai" sozinha durante a troca** (porta fechada por ~1 min): enquanto há um job `update` em `running`, o núcleo marca a máquina como "atualizando" e a queda não vira `machine-unreachable` nem notificação (a mesma ideia do "parada por você", 0013 §4); "Reconectar" e "Parar o túnel" ficam desligados. O ponto da barra lateral mostra "Atualizando".
- **Linha de log do Mac**: só `update (<id da máquina>): <fase final> exit <n>`; nunca a saída nem o script. O caminho do backup fica em memória e na resposta da API.

### 5. Depois do sucesso: nova credencial e a faixa que some sozinha

Sair `0` reinicia o núcleo remoto, e a 0020 §4 já diz que reiniciar o núcleo de lá revoga tudo (a tabela some e a geração muda). Então, ao sair `0`:

1. o núcleo do Mac **descarta a credencial** daquela máquina e marca a revogação (a regra de "reconexão" da 0020 §4, aplicada aqui);
2. relê o `/api/overview` e a telemetria **na hora**, sem esperar os 30 s, como o `reconnect` faz ao sair `0`: o primeiro pedido assinado pede uma credencial nova pelo `connection.credential` (que a conferência do script já provou que funciona, 0021 §3 passo 7);
3. com o `/api/overview` na versão do app, `core.status` vira `current` e a faixa e o botão somem sozinhos. O diálogo de resultado mostra "Atualizado para a 0.0.17" até ser fechado, e o card some junto com a faixa.

Se o `ssh` voltou `0` mas a leitura ainda mostra a versão velha, o resultado fica "conferindo" até a próxima leitura (30 s); se depois de 2 minutos ainda for velha, a tela diz "o núcleo respondeu a versão X; esperava a Y" e deixa o card de copiar à vista.

### 6. As rotas, o estado, o tempo e o cancelar

**Três rotas de escrita novas** (lista fechada, nomes em inglês), todas **de mesma origem da `/ui`** (0003, como as do 0012): `Origin` igual ao do núcleo e `Host` em loopback; a bandeja não chama. Outro `Origin` recebe 403 e nada roda, com teste.

- `POST /api/machines/<id>/update/check`: roda o `--check`. `202` com o estado. `404` se o `id` não está no arquivo; `409` se não há `connection.update` válido ou o arquivo está inválido.
- `POST /api/machines/<id>/update`: atualiza. `202` com o estado, ou o estado do que já roda. `409 check-required` sem um `--check` bom nos últimos 5 min.
- `DELETE /api/machines/<id>/update`: Cancelar (abaixo).

O estado vai em `GET /api/machines`, por máquina, em `update`:

```ts
update: {
  configured: boolean;                 // há connection.update válido
  problem: 'missing' | 'invalid' | 'credential-missing' | null;
  state: 'idle' | 'checking' | 'ready' | 'refused' | 'running' | 'succeeded' | 'rolled-back'
       | 'rollback-failed' | 'failed' | 'timed-out' | 'canceled';
  phase: 'check' | 'backup' | 'swap' | 'start' | 'verify' | 'rollback' | null;
  targetVersion: string;               // a do app
  startedAt: string | null; endedAt: string | null;
  exitCode: number | null;            // o do ssh (= o do script), 255 do próprio ssh
  reason: string | null;              // da lista fechada do §4
  backupPath: string | null;           // só em 40 e 41
  oldCommit: string | null; newCommit: string | null;
  canCancel: boolean;                  // true até o início do swap
  timeoutSeconds: number;
  command: string[];                   // o que vai rodar, para a tela mostrar o que o usuário escreveu (sem a cauda)
}
```

`command` é o do arquivo, para a tela mostrar o que vai rodar antes do clique; nunca a saída nem o script.

- **Tempo.** O `--check` tem 30 s fixos. A atualização usa `timeoutSeconds` do arquivo (padrão 300). O tempo passou **antes** do `swap`: o Mac cancela (abaixo) e o estado é `timed-out`, "nada foi trocado". Passou **depois** do `swap`: o Mac **não** mata o `ssh` (matar no meio da troca deixa a máquina sem o núcleo), marca `timed-out` com o texto "perdi o contato no meio da troca" e deixa o card de copiar e a leitura do `/api/overview` dizerem o que ficou; a faixa só some se a versão chegou. Quem decide como a máquina ficou é o script, que continua até o fim.
- **Cancelar.** Disponível (`canCancel`) enquanto a fase é `check` ou `backup`: o Mac encerra o grupo do `ssh` (o jeito do timeout, 0012) e o script, que trata `SIGHUP`, `SIGPIPE` e o fim do stdin **antes do swap** como cancelamento limpo (solta a trava, sai `130`, nada tocado). A partir do `swap` o botão fica desligado ("não dá para cancelar a troca"; o script **ignora** esses sinais daí em diante e termina, com sucesso ou rollback, para a troca nunca ficar pela metade). `DELETE` depois do `swap` responde `409 not-cancelable`.
- **Falha do próprio SSH:** `255` antes de qualquer fase: "não falei com a Workstation, nada foi alterado". `255` depois do `swap`: contato perdido, como no timeout. `126`/`127` (node ou caminho não achado): "o connection.update não achou o node ou o checkout lá".

### 7. O que a tela diz para cada saída

Texto pt-BR, uma frase do que houve e uma do que fazer; a lista é a do script (0021 §3) mais o `33`, o `130` e o SSH. O wireframe 462-4 e 462-5 traz cada um.

| Saída | O que a tela diz |
| --- | --- |
| `0` | "O núcleo da Workstation foi atualizado para a 0.0.17 e respondeu. A conexão voltou." |
| `20` | "A Workstation e este app falam versões diferentes da telemetria. Nada foi parado. Atualize o app deste Mac e tente de novo." |
| `21` | "A versão nova só responde a quem prova ser o dono, e este Mac ainda não tem o comando de credencial. Nada foi parado. Configure o connection.credential e tente de novo." |
| `22` | "A versão 0.0.17 não traz o manifesto do contrato, então não dá para saber se a Workstation continuaria conectada. Nada foi parado. Para seguir mesmo assim, rode o comando no terminal da Workstation com --allow-disconnect." |
| `23` | "Este Mac não conseguiu informar à Workstation o que suporta. Nada foi parado. É um defeito do app: avise o time." |
| `30` | por `reason`: `dirty-tree` "O repositório da Workstation tem mudanças locais não commitadas"; `unknown-ref` "A versão 0.0.17 não existe no repositório de lá"; `new-dependencies` "A versão traz dependências novas, que o script não instala". Sempre: "Nada foi parado." |
| `31` | "Não foi possível fazer o backup do banco. Nada foi parado; o núcleo segue no ar." |
| `32` | "O Console não confirmou que o processo na porta 4720 é o núcleo deste repositório (ou ele não parou). Nada foi trocado." |
| `33` | "Já há uma atualização em andamento nesta Workstation (outro Mac ou outro terminal). Espere terminar." |
| `40` | "A atualização falhou e a Workstation voltou ao código de antes (<oldCommit>), com o banco restaurado do backup. O núcleo de lá está no ar como estava." |
| `41` | "A atualização falhou e a volta também. A Workstation pode estar sem núcleo. O backup está em <backupPath> e o commit anterior era <oldCommit>. Restaure pelo terminal da Workstation, seguindo o runbook." Com "Copiar o caminho do backup". |
| `130` | "Cancelado antes da troca. Nada foi alterado." |
| SSH `255` / sem fase | "Não consegui falar com a Workstation pelo SSH. Nada foi alterado. Confira o túnel (Reconectar) e tente de novo." |
| tempo antes do `swap` | "A Workstation não respondeu em <n> s. Cancelei antes de trocar qualquer coisa." |
| tempo depois do `swap` | "Perdi o contato no meio da troca. O script continua lá até o fim e volta sozinho se algo falhar. Confira a versão daqui a pouco." |
| código desconhecido | "O comando saiu com o código <n>. Nada na tela é lido da saída." |
| falta configurar | §1: o que falta, o bloco pronto e o card de copiar. |

### 8. Alternativas rejeitadas (além das de §1 e §2)

- **Manter só o copiar-e-colar da 0021.** O dono o recusou ao usá-lo; o critério 1 da #462 pede o clique.
- **O núcleo do Mac abrir SSH sozinho, sem comando declarado.** Rejeitado desde a 0012; nenhuma parte desta decisão o contraria.
- **Executar o `update` sem `--check` prévio e deixar só o script se defender.** O script se defende, mas a confirmação precisa do motivo antes de a pessoa confirmar; sem o `--check` a tela só descobriria a recusa depois de dizer "atualizando".
- **Consulta periódica do estado por um segundo comando SSH (`--status`).** Mais robusta se o `ssh` cai no meio, mas um segundo comando declarado e uma superfície nova; fica fora, com o `/api/overview` como juiz do resultado.
- **Instalar a unidade do systemd (`install-unit`) pelo botão e atualizar sem a pessoa pedir.** Fora da issue (#462), como dito lá.
- **Um `update` por máquina em outra parte do arquivo** (`reconnect`-style, no topo). `connection.update` fica ao lado de `start`, `stop`, `credential` e `checkout`.

### 9. Riscos, ditos

- **O rollback real nunca rodou fora de teste.** Se o primeiro `40` ou `41` for numa atualização por clique, a pessoa terá o backup e o caminho dito na tela, não uma prova prévia. Mitigação: o `--check` e a trava antes, o backup antes de parar, a tela que não esconde o `41`. Um ensaio de falha forçada na Workstation (alvo que não sobe) é passo manual do Fernando e **não** condição para mergear as camadas, mas é condição para chamar a #462 de provada em produção.
- **Parar um processo que funciona por um clique.** Cobertos pela confirmação com o que vai acontecer (para o núcleo, ~1 min sem conexão, backup feito, volta sozinho se falhar), pelo `--check`, pela trava e pelo backup.
- **O Mac passa a executar mais um comando do `machines.json`.** A superfície é a do `credential` mais a cauda fechada de §1; quem escreve no arquivo já podia rodar qualquer coisa no próprio terminal (0012).
- **A cauda do argv** é a única parte que não está no arquivo; testada por argv exato.
- **O script é enviado pelo SSH**: é o arquivo do próprio app, mas o `ssh` autentica a máquina, não o conteúdo. Contra um host impostor, o que protege é o que protege o `credential`: o `ssh` do usuário com `BatchMode` e a chave do host. Não é pior que hoje.
- **A trava depende de arquivo e de `pid`**: dois processos em mesmos `pid` de máquinas diferentes não colidem porque a trava é local da máquina; `pid` reciclado dentro de 30 min mantém a trava (falha fechada, resolvida por `startedAt` > 30 min).

## Plano de camadas

Roteamento: backend para o script e o núcleo, frontend para a tela. Cada camada passa pelo ciclo desenvolver → Argos (no máximo três rodadas); as camadas entram em pilha.

1. **Decisão e wireframe** (este PR), aprovados pelo Fernando antes de qualquer código.
2. **apollo · o script.** `--progress json`, o código `33` e `update.lock`, o tratamento de sinais antes e depois do swap, o `130`, rodar do stdin, os campos `reason`; README/runbook. Testes com repositório git temporário e núcleo falso.
3. **apollo · o núcleo do Mac.** Ler e validar `connection.update`, a gramática da cauda, o runner (como o do `credential`: teto de stdout, grupo de processo, timeout, stderr descartado), o script empacotado com o teste de igualdade, o estado, as três rotas de mesma origem, o descarte da credencial e a releitura ao sair `0`, a marca "atualizando". AC3, AC4, AC5, AC6.
4. **iris · a tela.** O botão na faixa, a confirmação, o andamento, cada resultado, o "falta configurar" com o bloco pronto, a barra lateral. AC1, AC2.
5. **Passo manual (Fernando), fora da pilha:** a primeira atualização real por clique (0.0.17 → a próxima) e, se ele quiser, o ensaio de rollback.

## Plano de testes

Só fakes: sem SSH, sem a Workstation, só o arquivo tocado com `--test-concurrency=1`.

- **Comando falso no lugar do `ssh`.** O `machines.json` de teste declara `["<node>", "fake-ssh.mjs", …]`. O `fake-ssh` lê o stdin (o script), grava-o num arquivo, executa `node - <args>` localmente contra um **repositório git temporário** (dois commits, com e sem o manifesto) e um **núcleo falso** (HTTP que responde `/api/overview`, some quando o processo é morto), com `systemctl` falso no `PATH` e `AHRENA_CONSOLE_PROC_ROOT`; repassa o código de saída. Outros modos do falso: sai `255` sem ler, demora para além do timeout, escreve lixo e uma linha JSON válida, escreve mais de 64 KiB.
- **AC1** (botão, andamento, resultados): estado `idle → checking → ready → running(fase…) → succeeded` com as fases na ordem; cada código de saída (`0`, `20`–`23`, `30`–`32`, `33`, `40`, `41`, `130`, `255`, timeout antes e depois do swap) vira o estado e o `reason` certos, e o `41` carrega o `backupPath`; lixo no stdout é ignorado; mais de 64 KiB falha e mata o grupo. A tela renderiza o texto de cada um (camada 4).
- **AC2** (mesma lista, vista pela tela): o texto de cada saída é o da tabela do §7.
- **AC3** (só o que está declarado): sem `connection.update` → `409` e nada roda; `update` inválido ou com `--allow-disconnect`/`--force`/`--core-options` → `problem: invalid`; o argv de cada chamada é exatamente `command` + a cauda fechada; `id` desconhecido → `404`; outro `Origin` → `403`; o bloco "pronto" que a tela monta é o que o validador aceita (e a partir de um `credential` com o formato do 0020).
- **AC4** (`--check` antes, nunca `--allow-disconnect`): `POST …/update` sem `--check` bom → `409 check-required`; `--check` recusado (`20`–`23`) → nenhuma parada, o `pid` do núcleo falso não muda e nenhum sinal chega; o argv nunca tem `--allow-disconnect`.
- **AC5** (dois cliques e dois Macs): dois `POST` seguidos rodam um `ssh` só; dois scripts ao mesmo tempo contra o mesmo `--data-dir` → um sai `33` sem tocar em nada; trava de `pid` morto e de mais de 30 min é tomada com uma linha em `update.log`; o `--check` com a trava viva sai `33`.
- **AC6** (a faixa some sozinha): saída `0` descarta a credencial, relê na hora, o núcleo falso já na versão do app → `core.status: current`, `update.state: succeeded`, sem ação da pessoa; saída `0` com leitura ainda velha → "conferindo" e depois a mensagem de divergência.
- **Cancelar:** `DELETE` em `check`/`backup` encerra o `ssh` falso e o script sai `130` sem mexer em nada; depois do `swap` → `409`, o `ssh` não é morto.
- **Passo manual que fica para a descrição do PR da camada 3/4:** a primeira atualização real por clique na Workstation (`ssh` real com `ControlMaster=no` lendo o script do stdin; o que o `sshd` faz com `SIGHUP` quando o cliente cai no meio), e o ensaio do rollback real, se o Fernando o quiser.

## Fora do escopo

- Atualização sem a pessoa pedir (agendada, ao detectar a defasagem).
- `install-unit` e reboot pelo botão.
- As arestas do script anotadas na entrega da #449 (banco não restaurado se `systemctl start` falha no meio; `install-unit` sobrescreve a unidade sem cópia; `--data-dir` fora do padrão): issue própria.
- Autenticar quem responde na porta (#315).

## Consequências

- A atualização da Workstation passa a ser um clique, depois de uma edição única do `machines.json` que a própria tela monta.
- O núcleo do Mac ganha mais um runner de processo (ao lado de `start`, `stop`, `credential`), um job por máquina e três rotas de escrita de mesma origem, com a revisão de segurança do Argos na camada 3.
- O script ganha três mudanças de contrato (`33`, `130`, `--progress json`), que a camada 2 documenta no README e testa.
- A 0021 §2 fica como história: o card de copiar continua na tela como saída.
