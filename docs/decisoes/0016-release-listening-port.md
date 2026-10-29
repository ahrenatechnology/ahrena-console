# 0016 · Liberar uma porta: o núcleo manda o sinal só ao processo do próprio usuário, confere o dono de novo e age na máquina remota pelo núcleo de lá

- **Status:** aceita (o Fernando aprovou os wireframes C88 a C91, sem "Liberar todas", em 29/10)
- **Data:** 2026-10-29
- **Issue:** [#286](https://github.com/ahrenatechnology/ahrena-console/issues/286)
- **Estende:** [0014](0014-dev-tools-command-catalog.md) (ids e não comando, mesma origem estrita, a máquina remota só age se ela mesma aceitar) e [0003](0003-responder-sessao.md) (mais uma escrita de mesma origem da `/ui`)
- **Toca:** [0008](0008-machine-telemetry-and-dev-console.md) (o Mac lê a remota pela porta do túnel)
- **Numeração:** o 0015 já está tomado nos branches das issues #352 e #356; esta usa o 0016.

## Contexto

O card "Portas em escuta" mostra o que a máquina expõe, e o alerta `port-exposed` diz o que está aberto demais, mas só mostra. Quem vê um postgres em `0.0.0.0` hoje abre um terminal, acha o pid e manda o sinal. O pedido (#286) é fechar a porta pela própria tela, nesta máquina e na Workstation.

É a primeira escrita que **mata um processo** a pedido da `/ui`, e a primeira ação destrutiva que cruza o túnel. O erro caro aqui não é um comando mal montado (não há comando): é matar o processo errado, o núcleo que atende a tela, o app, ou o que uma porta virou entre o clique e o envio.

## Decisão

**A tela manda a porta, o pid que ela viu e o sinal (`TERM` ou `KILL`). O núcleo lê as portas de novo, só age se esse pid ainda é o dono dessa porta e é processo do próprio usuário, e envia o sinal com `process.kill`. Na máquina remota, o Mac repassa o mesmo pedido ao núcleo de lá, que só o aceita se foi iniciado aceitando ações remotas.**

### 1. A rota

- `POST /api/ports/release` `{ port, pid, signal }`, exatamente essas três chaves. `200 { result: 'released' | 'still-listening' }` depois de esperar a porta fechar (5 s para TERM, 3 s para KILL). `409 { error, reason, now? }` quando nada foi enviado; `503` quando as portas não puderam ser lidas.
- `GET /api/ports/release/preview?port=&pid=`: o que o confirmar mostra (processo, comando resumido, as portas do pid), ou os mesmos motivos de recusa. Não envia nada. O comando sai em uma linha curta e passa por `summarizeCommand`, que é uma lista de permissão: mostra o nome do executável, nomes de flag simples, números e palavras comuns, e troca por `***` todo valor de flag (`--x v`, `--x=v`, `-xV`, `-Dnome=v`, flag com ponto), todo `NOME=valor`, toda string entre aspas e tudo que parece chave (`ghp_`, `sk-`, JWT, sequências longas). URLs perdem usuário e query. Perde-se um pouco de identificação (`ssh -N ***`); o nome do processo e as portas continuam na tela. Na máquina remota o Mac aplica o resumo de novo no que o núcleo de lá mandou: uma credencial nunca chega à tela por um núcleo que não a cortou.
- Na máquina remota, as mesmas rotas sob `/api/machines/<id>/ports/release[/preview]`, repassadas ao núcleo de lá. Só port, pid e signal viajam, como pedido sem `Origin`; a resposta é reprojetada (motivos de uma lista fixa, `now` só com nome curto e inteiro).
- Gate próprio, como o das Ferramentas: `Host` loopback, caminho cru exato e `Origin` igual a `http://<Host>`. A rota da máquina remota aceita só o `Origin` da própria `/ui`.

### 2. O que o núcleo recusa (nada é enviado)

- **O pid não é mais o dono da porta** (`owner-changed`, com quem segura agora) ou a porta já está livre (`already-free`).
- **O próprio núcleo** (`self`), **o processo que o iniciou, o app** (`app`), além do bundle `Ahrena Console.app`, e **qualquer ancestral do núcleo**: um supervisor ou um `npm run` acima do pai é do mesmo usuário e derrubaria o núcleo do mesmo jeito. A cadeia parte do `process.ppid` e sobe com `ps -o ppid=` até o pid 1; se um passo não puder ser lido, nada é liberado (`unavailable`): uma cadeia cortada não pode deixar um ancestral passar. O motivo é `app` só quando o comando é o do bundle `Ahrena Console.app`; os outros ancestrais saem como `self`.
- **Pid 1 ou menor** (`system`): processo do sistema, com texto próprio na tela; não é o núcleo.
- **O proxy de um container** (`container`): `docker-proxy` e parentes. A tela aponta para a stack (a frente do Docker, #288) em vez de matar o proxy.
- **Processo de outro usuário** (`other-user`), conferido pelo uid de `ps -o uid=`. Nada de `sudo`: o que pede senha fica com a pessoa.
- Sem uid (Windows): `unavailable`.

SIGTERM é o primeiro pedido. SIGKILL é um segundo pedido, que a tela só faz depois de uma segunda confirmação dizendo o que se perde; o núcleo confere dono e usuário de novo antes de enviar. **O núcleo também exige o TERM:** lembra por 10 minutos cada TERM que enviou a uma porta e pid, e um KILL sem ele é recusado (`term-first`), de modo que a ordem não depende só da tela. Cada ação deixa uma linha no log do núcleo, com porta, pid, sinal e resultado (e a máquina, quando é um relay), nunca o comando.

### 3. A Workstation

- **Desligado por padrão.** O túnel faz o pedido do Mac parecer local lá, então o núcleo de lá recusa um `POST` sem `Origin` (403), a menos que tenha sido iniciado com `--accept-remote-actions` (ou `AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1`). Quem liga é quem está na Workstation, não o Mac. Um pedido de outro site (`Sec-Fetch-Site`) nunca passa.
- **A tela sabe antes de clicar:** `GET /api/ports/release` responde `{ release: true, remoteActions }`; o Mac repassa em `GET /api/machines/<id>/ports/release`. Com a ação desligada lá, a linha mostra Copiar comando (`kill -TERM <pid>`); com um núcleo de lá sem a rota (404), Liberar fica desligado com o motivo.
- O que o Mac confere é pouco de propósito: quem sabe o dono da porta, o usuário e o processo é o núcleo de lá.

### 4. Uma porta por vez

Não há "Liberar todas as que ouvem em todas as interfaces" (critério 7 da #286). Na Workstation de 29/10 quase todas as portas de todas as interfaces são de root (22, 139, 445) ou de container (15306); as que sobram são um runner e um serviço de desenvolvimento. Uma ação em lote mataria o que ninguém olhou. O filtro "Todas as interfaces" fica, e cada linha tem a sua ação.

## Alternativas consideradas

- **"Liberar todas" com lista e uma confirmação.** Era o critério 7. Perde porque a lista é, quase toda, recusa; sobra um clique que mata um runner e um serviço sem o dono olhar cada um.
- **Mandar só a porta, sem o pid.** A tela seria mais simples, mas a porta pode mudar de dono entre o clique e o envio (o postgres sai, um redis entra). O pid que a pessoa viu é o que ela confirmou.
- **`kill` por shell, ou um comando vindo da tela.** Perde pelos motivos da 0012 e da 0014: nada digitado vira comando.
- **`sudo kill` para o que é de root.** O console passaria a lidar com a senha da máquina. A regra é a de sempre: fica com a pessoa, no terminal dela.
- **Matar o `docker-proxy`.** Fecha a porta, mas o container segue de pé e o Docker sobe o proxy de novo. A dona é a stack.
- **Ação remota ligada por padrão, ou o Mac matando por `ssh`.** O túnel deixaria qualquer processo do Mac matar processos na Workstation, ou o console passaria a abrir `ssh` de ação. A escolha fica com a Workstation, como nas Ferramentas.
- **Uma flag só para ações remotas das Ferramentas e das portas.** As Ferramentas (0014) preveem `tools.acceptRemoteActions` no `config.json`, que ainda não existe. Esta decisão usa a opção de linha de comando; unificar as duas é uma conversa para quando o `config.json` existir.

## Consequências

- O núcleo passa a poder encerrar processos do próprio usuário a pedido da `/ui`. A superfície é estreita (três chaves, mesma origem estrita, dono conferido de novo, nunca o núcleo nem o app, sem senha), e o Argos revê `src/ports/` e `src/api/ports.ts` com atenção.
- Um processo pode trocar de pid entre a leitura e o `kill` (reuso de pid). A janela é de milissegundos e o uid é conferido antes do envio; fica como risco aceito. O mesmo vale para a memória do TERM, que é por `porta:pid` e não guarda a hora de início do processo: um pid reaproveitado na mesma porta em até 10 minutos aceitaria um KILL sem TERM próprio, mas o dono e o usuário continuam conferidos antes do sinal.
- O app de bandeja não ganha a ação: ela é do console.
- Reuso: #288 e #350 podem usar o mesmo modelo (ids, dono conferido de novo, remota desligada por padrão) para parar uma stack e fechar um terminal preso.
- Fica para depois: unificar a opção de aceitar ações remotas com a das Ferramentas, e o app mostrar a ação na bandeja.
