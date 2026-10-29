# 0017 · Docker: o núcleo para, sobe, remove e limpa só pelo catálogo, com os ids lidos do daemon, e volume é outra confirmação

- **Status:** aceita (o Fernando aprovou os wireframes C81 a C85 em 29/10; esta decisão acompanha o PR)
- **Data:** 2026-10-29
- **Issue:** [#288](https://github.com/ahrenatechnology/ahrena-console/issues/288)
- **Estende:** [0014](0014-dev-tools-command-catalog.md) (catálogo no código, ids, `planDigest`, mesma origem estrita, sem senha, um por vez, mostra o comando antes) e [0013](0013-cloud-connectors-and-machine-connection.md) (o Mac repassa uma escrita à máquina remota pelo túnel)
- **Toca:** [0008](0008-machine-telemetry-and-dev-console.md) (o Docker já era lido nas telas das máquinas)

## Contexto

Na Workstation sobram dezenas de containers parados (`floci-aws-gp-local-ecs-*`), stacks do Compose que ninguém mais usa e o disco chega a 96%. Hoje a tela só lê. O pedido da #288 é agir pelo console: parar, subir e remover stacks, parar, reiniciar e remover containers, limpar os parados e reiniciar o daemon quando ele trava, nesta máquina e na remota, sem abrir um terminal.

Diferente de instalar uma CLI (0014), aqui o alvo não está num catálogo fixo: é uma stack ou um container que existe agora no daemon, e a ação **apaga**. Um erro custa dado, não só tempo. E a Workstation fica atrás de um túnel que faz um pedido do Mac parecer local lá.

## Decisão

**O núcleo roda só ações de um catálogo fechado no código (`packages/nucleo/src/docker/catalog.ts`). A tela manda o id da ação, o id do alvo (o nome da stack ou o id de 12 caracteres do container, lidos do Docker agora) e o `planDigest` do plano que mostrou, nunca um comando. Apagar volume é uma ação à parte, com confirmação própria. O que pede senha de administrador é mostrado para a pessoa rodar.**

1. **Ações.** `stack-stop`, `stack-start`, `stack-remove`, `stack-remove-volumes`, `container-stop`, `container-restart`, `container-remove`, `clean` (cinco tipos) e `daemon-restart`. Cada uma monta listas de argumentos (`docker`, depois os argumentos um a um; sem shell, `&&`, `$VAR`).
2. **O alvo vem do daemon.** O núcleo lê `docker ps -a` e `docker volume ls` a cada plano; um nome de stack ou id que não está nessa leitura é 404, e um texto fora do formato (`^[a-z0-9][a-z0-9_-]*$` ou 12 hexadecimais) é recusado antes. As ações de stack agem nos ids que o daemon lista para a stack, nunca num nome interpolado.
3. **Volume é outra pergunta.** `stack-remove` nunca toca volume nem rede. `stack-remove-volumes` só é oferecida quando a stack não tem mais container, lista cada volume com tamanho, nunca inclui um volume que algum container ainda monta (a tela diz "fica") e exige uma caixa de ciência antes do botão.
4. **Limpar tem cinco comandos, cada um explicado e com o espaço que deve liberar** (estimativa do `docker system df`; o número real vem da saída): containers parados há mais de 1 dia, todos os parados, imagens sem nome, redes sem uso, cache de build. **Não há `system prune`, `--all` nem `volume prune`.**
5. **Reiniciar o daemon sem sudo quando dá:** Colima (`colima restart`) e Docker sem root (`systemctl --user restart docker`) o núcleo roda. O Docker do sistema (`sudo systemctl restart docker`) é um plano `admin`: a tela mostra o comando com Copiar e "Rodei, verificar de novo", e o executor recusa qualquer passo com `sudo`, `doas`, `pkexec`, `su`, `runas` ou `osascript` (0014). Docker Desktop é só lido.
6. **Mesmo executor da 0014.** Os trabalhos entram na fila das Ferramentas (`ToolsExecutor.enqueue`): um por vez por máquina, tempo limite, Cancelar, saída mascarada, `tools.log`, mudança `tools` em `/api/changes`. As rotas são `GET /api/docker`, `GET /api/docker/plan`, `POST /api/docker/actions/<id>` e `DELETE /api/docker/jobs/<id>`, com a mesma regra estrita de mesma origem (`Origin` igual e `Host` loopback; sem `Origin` é 403, salvo o item 7).
7. **A Workstation.** O Mac lê `GET /api/docker` do núcleo de lá pelo túnel e reprojeta campo a campo. Para agir, repassa só o id da ação, o id do alvo e o `planDigest` como um pedido local; quem monta e roda é o núcleo de lá, com o catálogo de lá. Esse núcleo só aceita um pedido sem `Origin` (o do túnel) se quem está lá ligar `AHRENA_CONSOLE_ACCEPT_REMOTE_ACTIONS=1`; desligado (o padrão), responde 403 e a tela mostra **Copiar comando**. É o mesmo desenho da 0014 seção 5; a chave é uma variável de ambiente porque o núcleo ainda não lê `config.json`, e vale para todas as ações remotas.
8. **`planDigest` e 409.** O digest cobre a máquina, a ação, o alvo, os passos e o tempo limite. Se o Docker mudou entre abrir o diálogo e confirmar, o núcleo recusa com 409 e devolve o plano novo; a tela o mostra e pede de novo.

## Alternativas consideradas

- **`docker system prune -a --volumes` como o "limpar tudo".** É o que a pessoa digitaria, mas apaga imagens em uso e volumes com dados. Ficou fora: cada limpeza que entra é uma que dá para explicar e que nunca remove dado.
- **Remover a stack e os volumes numa confirmação só (`docker compose down -v`).** Um clique a menos, e o primeiro erro apaga um banco. Os volumes têm confirmação própria, com lista e tamanho.
- **`docker compose -p <stack> down`.** Depende do plugin do Compose e do que ele acha sem os arquivos; agir nos ids do daemon funciona igual com ou sem ele e mostra o comando exato.
- **Uma caixa de comando, ou a tela mandar o argv.** Pelos motivos da 0014: o console não pode garantir o que roda.
- **Ações remotas ligadas por padrão.** Pelo túnel, qualquer processo do Mac falaria com o núcleo de lá como se fosse local.
- **Ler `docker system df -v` para dar o tamanho de todo volume na lista.** Percorre cada volume e pode levar mais de um minuto; os tamanhos só são lidos quando o plano de volumes os pede.

## Consequências

- O núcleo passa a apagar containers, stacks e (com confirmação própria) volumes, a pedido da `/ui`. A superfície é estreita: ids lidos do daemon, catálogo no código, mesma origem estrita, sem senha. O Argos revisa o catálogo e cada ação nova.
- A leitura do Docker passa a trazer a lista de containers por `GET /api/docker`; a telemetria (0008) não muda.
- Um núcleo remoto mais velho responde 404 a `/api/docker` e a tela mantém o card de stacks só de leitura.
- Risco aceito: entre ler e rodar, outro processo pode mudar o Docker; o `planDigest` pega o que mudou no plano, e um `docker rm` de um id que sumiu falha sem efeito.
- Fica para depois: "Liberar volume" (caches npm, pip e cargo, logs, `volume prune` com confirmação de dados) e as abas da tela da máquina, em outro PR.
