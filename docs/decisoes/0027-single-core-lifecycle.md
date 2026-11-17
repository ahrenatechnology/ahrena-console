# 0027 · Um núcleo por pasta de dados que sobrevive à sessão que o abriu: prazo ocioso e clientes de qualquer instalação

- **Status:** aceita (escolha do prazo derivada do código e do incidente de 17/11; **a confirmar na revisão** desta issue)
- **Data:** 2026-11-17
- **Issue:** [#706](https://github.com/ahrenatechnology/ahrena-console/issues/706), parte 1 de 3 da [#705](https://github.com/ahrenatechnology/ahrena-console/issues/705)
- **Toca:** [0010](0010-core-per-installation.md) (item 5: quem acha o núcleo; a regra do `--parent`). O resto da 0010 continua valendo: um núcleo por instalação, porta aleatória, registro de instâncias.

## Contexto

Desde a 0010, um núcleo subido com `--parent <pid>` sai **no segundo** em que o pai morre sem nenhum cliente registrado vivo (`watchParent`, em `packages/nucleo/src/owner/owner.ts`). Quem passa `--parent` é o app (o pid do app) e a ponte stdio do MCP quando não acha núcleo da instalação dela (o pid da ponte). Cada sessão do Claude Code abre a própria ponte; a ponte morre quando a sessão termina.

O incidente de 17/11 (app 0.0.21, descrito na #705): o núcleo vivo tinha como pai um `src/mcp/cli.ts`, não o app, e o `nucleo.log` tinha 256 linhas "listening on port". Cada início reimporta o histórico de `~/.claude/projects` num banco de 2,4 GB e fica minutos acima de 100% de CPU.

Lendo o código, há duas causas, e as duas existem em `main`:

1. **O intervalo entre sessões.** Entre o fim de uma sessão e o começo da próxima não há ponte viva. O pai some, a pasta `clientes/` está vazia, e o núcleo sai. A próxima ponte não acha núcleo e sobe outro, que reimporta tudo. Basta trabalhar com uma sessão por vez para cada sessão nova custar um início.
2. **A ponte que usa o núcleo de outra instalação não é cliente dele.** A ponte do checkout (`dev`, o padrão) usa o núcleo do app quando ele está de pé (regra 3 da 0010), mas só se registrava como cliente do núcleo da **própria** pasta de dados (`CoreResolver.becomeClient`, em `src/mcp/target.ts`), de propósito: ela não escreve numa pasta de dados que só leu no registro. Fechar o app derrubava o núcleo do app no meio das sessões que o usavam; a ponte seguinte não achava ninguém e subia um núcleo `dev`, com outro banco e outra importação inteira.

A Workstation roda o núcleo sob systemd (0021, `scripts/remote-core/`), com `src/api/cli.ts` direto e sem `--parent`: ninguém vigia pai nem cliente lá, e o systemd o reinicia se cair.

## Decisão

**Um núcleo por pasta de dados, que não sai junto com a sessão que o abriu. Toda ponte é cliente do núcleo que usa, seja de que instalação for. Quando o pai e todos os clientes somem, o núcleo fica de pé por um prazo ocioso de 8 horas antes de sair; um cliente que chega no prazo o cancela.**

1. **Quando o núcleo pode sair.** Só nestes casos:
   - `npm run core -- stop`, SIGTERM ou SIGINT (como hoje);
   - substituição por um núcleo de versão mais nova da mesma instalação (#220, como hoje);
   - com `--parent`: o pai morreu, nenhum cliente está vivo, e isso durou o **prazo ocioso** inteiro.

   Sem `--parent` nada muda: o núcleo do terminal e o da Workstation só saem pelos dois primeiros.
2. **O prazo ocioso.** 8 horas por padrão, um dia de trabalho com as pausas dele (almoço, reunião, a tampa fechada). `AHRENA_CONSOLE_IDLE_GRACE_SECONDS` muda o prazo, em segundos inteiros; `0` volta ao comportamento de antes (sair na hora). Um valor inválido para o núcleo antes de abrir o banco. A conta é de [`idle-exit.ts`](../../packages/nucleo/src/owner/idle-exit.ts), uma máquina de estados sem relógio: em uso, ocioso desde *t*, expirado. O núcleo escreve uma linha no log quando o prazo começa ("o pai … sumiu e não há cliente registrado; fica de pé por mais 8 h esperando um cliente") e outra quando sai ("… há 8 h; saindo").
3. **Como as pontes se ligam.** A ponte lê o registro a cada pedido, como na 0010, e se registra **uma vez por instância** como cliente do núcleo que escolheu:
   - núcleo da própria pasta de dados: `<pasta de dados>/clientes/<pid>`, como antes;
   - qualquer outro (o do app, para a ponte do checkout; o da mesma instalação com outro `--data-dir`): `~/.ahrena-console/instance-clients/<id da instância>/<pid>`, na pasta por usuário onde já mora o registro de instâncias. A ponte continua sem escrever numa pasta de dados que só leu no registro; o id é conferido pelo formato do registro (`app|dev|mcpb-<pid>`), nunca vira caminho livre.

   O núcleo conta as duas pastas. Ao sair, apaga a própria `instance-clients/<id>/`.
4. **Como o app se liga.** Sem mudança no app: ele sobe ou adota o núcleo da pasta dele com `--parent <pid do app>`. Ao adotar um núcleo que uma ponte subiu na mesma pasta, o pid do app vira cliente registrado; ao subir, é o pai. Nos dois casos o app aberto mantém o núcleo de pé. Fechar o app passa a deixar o núcleo dele vivo pelo prazo ocioso, e o app reaberto dentro dele adota o mesmo núcleo, sem reimportar.
5. **A Workstation fica de fora.** Lá o núcleo roda sob systemd, sem `--parent`; o vigia do pai nem é ligado, então o prazo ocioso e os clientes por instância não mudam nada.

## Alternativas consideradas

- **Só `stop` ou substituição, sem sair por ociosidade (um daemon de verdade).** Resolve o incidente do mesmo jeito e é o mais simples de explicar. Perde porque não há supervisor no Mac: um núcleo de um checkout esquecido, ou do app desinstalado, ficaria de pé para sempre seguindo `~/.claude/projects` e segurando memória, e quem não abre o Console há uma semana não deveria pagar por ele. O prazo ocioso dá o mesmo resultado no dia a dia e ainda termina.
- **Prazo curto (alguns minutos).** Cobre a troca de uma sessão pela seguinte, mas não o almoço nem a reunião, que são exatamente os intervalos de onde vieram as 256 subidas. Enquanto a importação não for incremental (#707), cada início perdido custa minutos de CPU; um núcleo ocioso custa só memória. 8 h pende para o lado barato.
- **Registrar ou deixar launchd/systemd do usuário cuidar do núcleo no Mac.** Daria um núcleo por máquina com supervisão de verdade. Perde porque muda como o app e as pontes sobem o núcleo (a 0010 inteira), pede instalar um agente do sistema e tirá-lo ao desinstalar, e o problema da #706 se resolve sem isso.
- **A ponte escreve em `clientes/` da pasta do núcleo que usa, qualquer que seja.** Era a correção de uma linha para a causa 2. Perde porque a pasta vem do registro, um arquivo que qualquer processo do usuário escreve: a ponte passaria a criar arquivos num caminho que leu de outro, que é o que a regra da 0010 evitava. A pasta por usuário já é escrita e limpa pelas pontes.
- **Uma rota no núcleo para se registrar (`POST /api/clients`).** O núcleo escreveria na própria pasta, sem a ponte tocar nela. Perde por custo: uma rota nova com contrato, token e teste de contrato para o que um arquivo por pid já resolve, e um cliente que morre sem avisar continuaria sendo descoberto pelo pid.
- **Contar atividade (o último pedido ao `/mcp`) em vez de clientes.** Uma sessão aberta e parada não faz pedido; o núcleo sairia debaixo dela.

## Consequências

- Uma sessão nova dentro de 8 h do fim da anterior acha o núcleo de pé: sem início, sem reimportação. O critério AC-1 da #706 é provado por `test/mcp/bridge.test.ts` (os testes `#706/AC-1`) e `test/owner/owner.test.ts`.
- Fechar o app não encerra mais o núcleo dele na hora: ele fica pelo prazo ocioso, ou enquanto uma ponte o usar. Quem quer o núcleo fora já roda `npm run core -- stop --installation app`. A atualização do app continua trocando o núcleo de versão mais velha (#220).
- Um núcleo ocioso segue o histórico e recebe os hooks por até 8 h sem ninguém olhando: memória e um pouco de CPU por esse tempo, em troca de não perder eventos entre sessões.
- A pasta `~/.ahrena-console/instance-clients/` é nova. Um núcleo morto com SIGKILL deixa a pasta dele para trás; ela só tem arquivos de pid e não é lida por mais ninguém.
- Os testes que observam a saída imediata pelo `--parent` rodam com `AHRENA_CONSOLE_IDLE_GRACE_SECONDS=0`.
- A importação incremental (#707) e a retenção de `events` (#708) diminuem o custo de cada início que ainda acontecer; esta decisão diminui quantos acontecem.
