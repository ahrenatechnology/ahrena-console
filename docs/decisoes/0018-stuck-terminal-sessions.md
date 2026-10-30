# 0018 · Terminais presos: o núcleo lê os terminais, manda o sinal em escada só ao processo do próprio usuário e nunca ao sshd do túnel

- **Status:** aceita (o Fernando aprovou os wireframes C96 a C99 em 29/10)
- **Data:** 2026-10-29
- **Issue:** [#350](https://github.com/ahrenatechnology/ahrena-console/issues/350)
- **Estende:** [0014](0014-dev-tools-command-catalog.md) (ids e não comando, mesma origem estrita, a máquina remota só age se ela mesma aceitar), [0016](0016-release-listening-port.md) (o núcleo manda o sinal só ao processo do próprio usuário e confere de novo antes) e [0008](0008-machine-telemetry-and-dev-console.md) (cada máquina se mede com o próprio núcleo; o Mac lê a remota pela porta do túnel)
- **Numeração:** o 0015 está tomado duas vezes, o 0016 é das portas e o 0017 é do Docker (#288); esta usa o 0018.

## Contexto

As abas do painel Terminal do Claude Desktop na Workstation são sessões `ssh` (`sshd: seguim@pts/0,pts/1`) com um `bash -l` por pseudo-terminal. Uma sessão do Claude roda um script na aba, o script fica em primeiro plano e a aba fica presa: não dá para usar nem abrir outra. Em 29/10, o `pts/0` tinha um `bash …/scratchpad/destrava-pedro.sh` em primeiro plano havia 26 min. A saída era entrar por outro caminho e matar na mão.

É a segunda escrita que **mata um processo** a pedido da `/ui` (a primeira é liberar porta, 0016) e a que mais perto chega do que mantém a máquina de pé: o `sshd` de uma sessão pode ser o mesmo por onde passa o túnel do próprio console.

## Decisão

**A leitura dos terminais entra na telemetria de cada máquina. A tela manda o id do terminal, a ação e o pid que ela viu; o núcleo lê os terminais de novo, só age se esse pid ainda é o do terminal, do próprio usuário e fora da lista do que nunca se sinaliza, e envia o sinal com `process.kill`. Na máquina remota, o Mac repassa só esses ids ao núcleo de lá, que só os aceita se aceitar ações remotas.**

### 1. A leitura

- `TelemetryReading.terminals` (`src/telemetry/terminals.ts`): uma sessão por pseudo-terminal, a cada amostra de 30 s. Linux: `ps -eo pid=,ppid=,pgid=,tpgid=,tty=,stat=,etimes=,uid=,user=,args=` e `ss -tnp`; macOS: o `ps` equivalente (`etime`, `command`). Sem shell, tempo limite, como os outros coletores; `ps` que falha deixa `terminals: null`.
- **O primeiro plano** é o grupo cujo id é o `tpgid` do terminal. Só o prompt tem um shell interativo (`bash -l`, `-zsh`) como líder desse grupo: então a sessão está **ociosa**. Qualquer outro líder é "o comando"; estado `T` é **parado** (Ctrl-Z), o resto **rodando**.
- **A conexão** é o ancestral `sshd: usuario@pts/N,pts/M` do shell (e daí os terminais que ela segura); no Mac, o app de terminal; senão, local.
- **Presa:** comando em primeiro plano, rodando, do próprio usuário, que **não** é um interativo conhecido (`vim`, `less`, `top`, `ssh`, `tmux`… mais `terminal.interactiveCommands` do `config.json`), com mais de **15 min**, **ou** que roda de um `/tmp/claude-*/…/scratchpad/` (script de sessão do Claude) com mais de **2 min**. A tolerância de 2 min no scratchpad é nossa: evita alertar para um script que acabou de começar. O núcleo e o que o roda nunca ficam presos.
- **A sessão do Claude** sai do caminho (`…/<uuid da sessão>/scratchpad/`); a tela mostra o título quando a conhece, senão os 8 primeiros caracteres.
- **O alerta `terminal-stuck`** (id `terminal-stuck:<terminal>`, nível erro, desde quando o comando começou) segue o caminho dos outros: bandeja, `/api/changes`, "O que pede atenção". A Workstation o calcula sobre as próprias amostras e o Mac o aceita como aceita os de carga e disco.
- **A remota lida pelo Mac** passa por `sanitizeTerminals`, campo a campo, com tamanho limitado: o que a tela desenha nunca é o JSON cru de outra máquina.

### 2. A rota

- `POST /api/terminals/<id>/actions/<ação>` `{ pid, machine?, confirm? }`, exatamente essas chaves. `<id>` é `pts-0` ou `ttys003`; `<ação>`:

| Ação | Alvo | Sinal |
| --- | --- | --- |
| `interrupt` | o grupo do primeiro plano | SIGINT |
| `terminate` | o grupo do primeiro plano | SIGTERM |
| `kill` | o grupo do primeiro plano | SIGKILL, só com `confirm: true` (a segunda confirmação) |
| `hangup` | a sessão: o `sshd` da conexão (ou o shell, onde não há `sshd`) | SIGHUP |
| `end` | a mesma | SIGTERM |

- A escada é de **um clique por degrau**, na tela: depois de cada sinal a tela lê o terminal de novo e, se o processo continua, oferece o próximo; nada sobe sozinho. O núcleo não impõe a ordem, só o `confirm` do SIGKILL.
- `200 { result: 'sent', action, signal, pid, target }`. `404` máquina ou terminal desconhecidos. `403 { error, reason }` para o que nunca se sinaliza. `409 { error, reason }` quando nada foi enviado (`changed`: o pid não é mais o do terminal; `unreadable`; `confirm-required`). `502` quando a remota não responde.
- Gate próprio, igual ao das Ferramentas (0014 §4) e ao das portas (0016): `Host` loopback, caminho cru exato, `Origin` igual a `http://<Host>`, `application/json`, corpo de até 1 KiB. Sem `Origin` é 403, a menos que o núcleo aceite ações remotas (§4).

### 3. O que o núcleo recusa

Conferido de novo, na hora de agir, sobre uma leitura nova:

- **Outro usuário** (`other-user`): pelo uid de `ps`, nunca por nome. Nada de `sudo`.
- **A conexão `sshd` por onde o túnel do console passa** (`tunnel`): o `sshd` com conexão estabelecida com a porta do próprio núcleo (`ss -tnp`). Só vale para `hangup`/`end`: interromper o comando daquela aba continua permitido, que é o caso do exemplo.
- **O núcleo e o que o roda** (`core`): o pid do núcleo e seus ancestrais (o shell, o `sshd`, o app). O grupo do primeiro plano que contém algum deles também.
- **O pid não é mais o do terminal** (`changed`): outro processo no primeiro plano, o terminal que ficou ocioso, ou o pid que não existe mais (ESRCH).
- O sinal vai ao **grupo** (`process.kill(-pgid)`), não ao shell: a aba continua viva e volta ao prompt.

Encerrar a sessão fecha **todos** os terminais da conexão (`pts/0` e `pts/1` têm o mesmo `sshd`): o confirmar diz quantos e quais.

### 4. A Workstation

- **Ler** é como em tudo da 0008: `terminals` vem na leitura que o Mac já faz.
- **Agir lá é desligado por padrão**, pelo mesmo motivo da 0014 §5 e da 0016 §3: o túnel faz o pedido do Mac parecer local. O núcleo de lá aceita um `POST` sem `Origin` só se subiu com `--accept-remote-actions` ou `AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1`, a mesma opção das portas (0016) e do Docker (0017). Quem liga é quem está na Workstation.
- **A tela sabe antes de clicar:** a leitura traz `remoteActions`. Desligado, cada ação é **Copiar comando** (`kill -INT -- -<pgid>`, `kill -HUP <pid>`), para colar num terminal de lá, que não é o preso. Um núcleo de lá sem a rota (404) mostra a mensagem de atualizar o núcleo.
- O Mac manda só `{ pid, confirm? }`, sem `Origin`, e reprojeta a resposta (motivos de uma lista, textos curtos). Depois de um envio, relê a máquina.

## Alternativas consideradas

- **Uma ação "Liberar a aba" que sobe a escada sozinha** (SIGINT, 5 s, SIGTERM, 5 s, SIGKILL). Mais cômodo, mas o SIGKILL sem a pessoa ver o que sobrou é o erro caro; a tela já pede a segunda confirmação.
- **Matar o shell da aba** em vez do grupo do primeiro plano. Derruba a aba e perde o histórico dela; o objetivo é a aba voltar ao prompt.
- **Agir por `ssh` a partir do Mac.** O console passaria a abrir `ssh` de ação; o túnel e o núcleo de lá já fazem isso, com as regras de lá.
- **Só mostrar e deixar a pessoa matar na mão.** É o que acontece hoje; o pedido é fechar o ciclo na tela.
- **Marcar presa só pelo tempo.** Pegaria o `vim` aberto havia 3 h. A lista de interativos conhecidos e a do `config.json` resolvem; sem elas, um `npm run dev` deixado em primeiro plano de propósito vira Presa depois de 15 min. Risco aceito, com a saída no `config.json`.
- **Uma opção só para ações remotas em `config.json`** (como prevê a 0014). Ela ainda não existe; os terminais usam a opção da 0016, como as portas e o Docker. Só a lista `terminal.interactiveCommands` fica no `config.json`, que o núcleo lê a cada 5 s.

## Consequências

- O núcleo passa a poder encerrar processos e conexões `sshd` do próprio usuário a pedido da `/ui`. A superfície é estreita (três chaves, mesma origem estrita, pid e usuário conferidos de novo, nunca o túnel, o núcleo nem o app, sem senha); o Argos revê `src/telemetry/terminals.ts`, `terminal-actions.ts` e `src/api/terminals.ts` com atenção.
- Reuso de pid entre a leitura e o `kill`: a janela é de milissegundos, o grupo e o uid são conferidos antes. Risco aceito, como na 0016.
- A linha de comando de cada processo fica na leitura (até 300 caracteres), com URL com credencial, `--token x`, `password=x`, `Bearer x` e `-pSEGREDO` mascarados antes de guardar. O mascaramento é por padrão e pode deixar passar um segredo de forma incomum: a leitura vai ao SQLite e pelo túnel.
- Comandos como `claude`, `sudo`, `su`, `psql`, `mysql` e `sqlite3` contam como interativos (esperam a pessoa); `python` e `node` não, porque é neles que um script esquecido prende a aba.
- A detecção do `sshd` do túnel depende do `ss` e do usuário do próprio núcleo; sem `ss`, o `sshd` do túnel não é reconhecido. No Mac não há `sshd` de terminal, então o caso não existe.
- O app de bandeja não ganha a ação: ela é do console. O alerta chega a ele como os outros.
- Fica para depois: os processos `claude`/`ccd-cli` antigos do servidor remoto do Claude Desktop (outro card, outra issue), e unificar o `config.json` com as outras frentes.
