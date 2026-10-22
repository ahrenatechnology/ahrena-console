# 0012 · Reconectar a máquina remota pelo console, com o comando que o usuário escreveu

- **Status:** aceita (o Fernando aprovou os wireframes C50 e A8 em 20/10, com a saída só no log)
- **Data:** 2026-10-20
- **Issue:** [#244](https://github.com/ahrenatechnology/ahrena-console/issues/244)
- **Revê:** em [0008](0008-machine-telemetry-and-dev-console.md), "o app só mostra" para a reconexão (seção 3, a linha "Túnel caído", e seção 6, o item "Ações que mudam estado"). O resto da 0008 continua valendo.
- **Toca:** [0003](0003-responder-sessao.md) (mais uma exceção de mesma origem da `/ui`) e o comentário de 20/10 na [#221](https://github.com/ahrenatechnology/ahrena-console/issues/221) (o `machines.json` só era lido quando o núcleo subia)

## Contexto

A máquina remota chega ao Mac pelo túnel do usuário (0008, seção 2). Esse caminho cai sozinho: a credencial do provedor de nuvem expira, o Mac dorme, a rede muda ou o processo do túnel morre. Hoje o console percebe a queda e mostra "sem conexão" com o motivo (C26, A7), mas para voltar a pessoa sai do console, abre o terminal e roda o que ela já usa para subir o túnel, às vezes com um login no navegador no meio.

A 0008 deixou isso de fora de propósito: o núcleo não abre SSH, não guarda chave, não conhece o host e não sabe de nuvem nenhuma, e o repositório é público. Em 20/10 o Fernando decidiu que o console ganha um **Reconectar**, sem que nada disso mude: quem sabe reconectar continua sendo o usuário, que escreve o comando.

## Decisão

**Cada máquina remota pode ter, no `machines.json`, um comando de reconexão escrito pelo usuário. Quando ela está sem conexão, a tela da máquina e a bandeja oferecem "Reconectar", e o núcleo do Mac roda exatamente esse comando, como processo filho, sem shell, com tempo limite e um por vez. Sem comando configurado, nada roda e a tela explica como configurar.**

### 1. A configuração

O campo `reconnect` é opcional, por máquina:

```json
{ "machines": [ { "id": "workstation", "label": "Workstation", "port": 14720,
    "reconnect": { "command": ["/caminho/para/conectar.sh", "tunnel", "restart"], "timeoutSeconds": 180 } } ] }
```

- `command` é uma **lista**: o primeiro item é o executável (caminho absoluto ou nome no PATH), os outros são os argumentos, passados um a um. Não há shell, nem `~`, `$VAR`, `*`, `|`, `;` ou `&&`: quem precisa disso escreve um script e aponta para ele.
- `timeoutSeconds` é opcional: 180 por padrão, entre 10 e 900. Passou do limite, o núcleo encerra o processo (SIGTERM e, 5 s depois, SIGKILL no grupo).
- Um `reconnect` inválido (lista vazia, item que não é texto, tempo fora da faixa) é ignorado com um aviso no log, e a máquina fica como se não tivesse comando; o resto do arquivo continua valendo.
- O exemplo do README e da tela usa só um script genérico. Nada de provedor, host, perfil ou conta no código, nos testes ou nas docs.

### 2. O núcleo relê o `machines.json`

Até aqui o arquivo era lido uma vez, quando o núcleo subia (`src/api/cli.ts`), e uma edição só valia depois de reiniciar (comentário de 20/10 na #221). Com o `reconnect` isso fica pior: a tela pede para editar o arquivo e o botão não apareceria. O núcleo passa a reler o `machines.json` **a cada volta de leitura das máquinas (30 s) e logo antes de reconectar**, comparando a data de modificação para só reparsear quando mudou. Antes de rodar, o comando vem sempre da leitura mais recente: um comando apagado do arquivo não roda mais, mesmo que a tela ainda mostre o botão. Arquivo inválido mantém a última leitura boa para a tela (as máquinas e o estado continuam aparecendo) e avisa no log, mas **a reconexão fica recusada até o arquivo ser corrigido** (409, "O machines.json está inválido; corrija o arquivo para reconectar."): quem apaga o `reconnect` e deixa um erro de digitação no JSON não vê o comando antigo rodar no clique.

### 3. Quem roda e como

- **O núcleo do Mac**, num processo filho com `spawn(command[0], command.slice(1), { shell: false })`, num grupo próprio (para o tempo limite e o Cancelar pegarem os filhos do script).
- **Só o que está no arquivo.** A rota recebe o `id` da máquina e mais nada: nenhum texto da tela, da URL ou do corpo vira argumento, caminho ou variável de ambiente. Um `id` que não está no `machines.json` dá 404.
- **O ambiente do usuário.** O processo herda o ambiente do núcleo, que no app já tem o PATH do shell de login (`apps/desktop/src-tauri/src/shell_path.rs`), menos as variáveis do próprio console (`AHRENA_CONSOLE_*` e os nomes antigos). A pasta de trabalho é a pasta do usuário. A entrada padrão é fechada: um comando que pede algo no terminal falha em vez de ficar parado.
- **Um por máquina de cada vez.** Um segundo pedido para a mesma máquina, de qualquer lugar (a tela, a bandeja, a notificação), recebe o estado do que já roda, sem rodar outro.
- **Login no navegador.** Se o comando abrir um login (o de um provedor de nuvem, por exemplo), é o navegador do usuário que abre, como no terminal. O console não lê, não preenche e não acompanha esse login: só mostra "aguardando o login no navegador" enquanto o comando não termina.
- **A saída fica fora da `/ui`.** O stdout e o stderr vão para `reconnect.log`, na pasta de dados da instalação (ao lado do banco, com permissão só do usuário), porque podem trazer dado sensível: um código de dispositivo, um nome de conta, um caminho. O núcleo abre o arquivo (acréscimo, 0600; se passou de 1 MB, vira `reconnect.log.1` antes de rodar) e entrega o descritor ao processo como stdout e stderr; o núcleo não lê a saída, que fica como o comando a escreveu, sem prefixo por linha. O núcleo escreve só duas linhas suas: o início antes de rodar (hora, `id` da máquina, `start`, quem pediu) e o fim quando o processo sai (estado, código de saída, duração). Assim um túnel que o script deixa em segundo plano continua escrevendo no arquivo depois que o script sai e depois que o núcleo reinicia, sem levar SIGPIPE. Se o arquivo não abre, uma linha vai para o log do núcleo e o comando roda com a saída descartada. A tela mostra o estado, o tempo, o código de saída e onde está o log.
- **Ao sair com 0**, o núcleo relê a máquina na hora, sem esperar a volta de 30 s, e a tela volta a "Conectada". Saiu com outro código, ou passou do limite, a tela mostra o que houve e oferece "Tentar de novo".

### 4. As rotas

- `POST /api/machines/<id>/reconnect`: começa a reconexão, ou devolve a que já roda. Responde `202` com o estado.
- `DELETE /api/machines/<id>/reconnect`: Cancelar. Encerra o processo do jeito do tempo limite.
- O estado vai em `GET /api/machines`, por máquina: `reconnect: { configured, state: idle|running|succeeded|failed|timed-out|canceled, startedAt, endedAt, exitCode, timeoutSeconds, command, logFile }` (`command` só para a tela mostrar o que vai rodar, `logFile` para dizer onde está a saída; nunca a saída). Uma mudança de estado sai em `/api/mudancas`, para a tela e a bandeja reagirem sem recarregar.
- As duas escritas são **exceções de mesma origem da `/ui`**, como as da 0003: só com `Origin` igual ao do próprio núcleo e o `Host` em loopback. Um teste prova que outro `Origin` é recusado com 403 e que nada roda. A bandeja, que não é página, chama a rota como já chama o `POST /open/<local_…>`: sem `Origin` e com o `Host` em loopback, o pedido local que a 0003 já aceita. Um processo local pode fazer o mesmo, mas esse processo já pode rodar o comando direto; o que a defesa fecha é uma página qualquer do navegador disparando o comando.

### 5. Onde aparece

- **Tela da máquina** (C26 e C50): "Reconectar" na faixa de sem conexão, com a linha do comando que vai rodar; o andamento ("aguardando o login…", o tempo contra o limite, Cancelar); o resultado. Sem `reconnect`, a tela mostra os passos para configurar, sem botão morto.
- **Bandeja** (A7 e A8): o item "Reconectar a Workstation" quando ela está sem conexão e tem comando; enquanto roda, uma linha cinza com o tempo. A notificação "<rótulo> sem conexão" ganha a ação Reconectar.

## Alternativas consideradas

- **Continuar só mostrando** (a 0008 como está). Perdeu porque a queda é frequente (a credencial do provedor expira todo dia) e a volta é sempre o mesmo comando, digitado fora do console.
- **O console sobe o túnel sozinho** (abre o SSH, conhece o host, chama o login do provedor). Perdeu pelos mesmos motivos da 0008: credencial e infraestrutura dentro de um núcleo público, um provedor por vez.
- **Uma linha de comando em texto, rodada num shell** (`"reconnect": "conectar.sh tunnel restart"`). Mais fácil de escrever, mas abre a porta para interpolação e para um texto que muda de sentido com aspas. A lista roda o que está escrito; o shell continua possível, dentro do script do usuário.
- **Mostrar as últimas linhas da saída na tela.** Ajuda a entender um erro sem abrir o log, mas a saída de um login costuma trazer código de dispositivo, conta e URL. O Fernando escolheu deixar fora (a variante A do C50): a tela diz o código de saída, o tempo e onde está o log.
- **Vigiar o arquivo com `fs.watch`.** Mais imediato, mas o `fs.watch` perde eventos com editores que gravam por troca de arquivo e muda de comportamento entre macOS e Linux. Reler pela data de modificação a cada 30 s e antes de reconectar já cobre o "salvei e o botão apareceu".

## Consequências

- O núcleo do Mac passa a executar um processo do usuário a pedido da `/ui`. A superfície é estreita (só o `id`, só mesma origem, só o que está no arquivo, um por vez, com limite), e o Argos faz a revisão de segurança dessa parte no PR.
- Quem consegue escrever no `machines.json` consegue fazer o núcleo rodar um comando. É a mesma pessoa que já roda qualquer coisa no próprio terminal: o arquivo fica na pasta do usuário, e a tela mostra o comando antes do clique.
- O `machines.json` passa a valer sem reiniciar, para tudo, não só para o `reconnect`.
- Risco aceito: no tempo limite e no Cancelar, o SIGKILL vai para o grupo do processo 5 s depois do SIGTERM, mesmo que o grupo já tenha acabado; se nesses 5 s o sistema reusar o número do grupo para outro processo, ele receberia o sinal. No macOS e no Linux o número só volta depois de dar a volta no espaço de pids, e a janela é curta.
- O README ganha o campo `reconnect`, com um exemplo genérico.
