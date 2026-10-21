# 0013 · Ferramentas: o núcleo instala e atualiza só pelo catálogo, mostra o comando antes e nunca pede senha

- **Status:** proposta, a confirmar pelo Fernando junto com os wireframes C57 a C61
- **Data:** 2026-10-21
- **Issue:** [#280](https://github.com/ahrenatechnology/ahrena-console/issues/280)
- **Estende:** [0012](0012-remote-reconnect.md) (o núcleo roda um processo a pedido da `/ui`: lista de argumentos, sem shell, tempo limite, um por vez) e [0003](0003-responder-sessao.md) (mais escritas de mesma origem da `/ui`)
- **Toca:** [0008](0008-machine-telemetry-and-dev-console.md) (cada máquina se mede com o próprio núcleo; o Mac lê a remota pela porta do túnel)

## Contexto

Quem trabalha com o Claude Code e o console depende de um conjunto de ferramentas que envelhece sozinho: CLIs (`gh`, `aws`, `wrangler`, `gcloud`, `docker`, `colima`, o próprio `claude`), servidores MCP configurados no Claude Code, linguagens (Node com TypeScript, Python, Rust, Go) e um runtime de containers. Hoje cada uma é conferida à mão, com o comando de cada gerenciador, em duas máquinas: o Mac e a Workstation (Ubuntu). Um `gh` velho que não entende uma flag ou um Colima parado só aparecem quando algo quebra.

A tela Ferramentas (#280) mostra isso e oferece Instalar, Atualizar, Iniciar e Parar. É a primeira vez que o console muda software da máquina, e o repositório é público: a forma como ele escolhe e roda os comandos precisa ser estreita, verificável no código e igual nas três plataformas.

## Decisão

**O núcleo lê cada ferramenta com uma sonda fixa e só roda comandos de um catálogo escrito no código dele, revisado por PR. A tela manda o id do item e o id da ação, nunca texto. Antes de rodar, ela mostra o comando exato e pede Confirmar. O núcleo roda sem shell, com tempo limite e um de cada vez, e nunca roda nada que peça senha de administrador: nesses casos a tela mostra o comando para a pessoa rodar.**

### 1. O catálogo

Um módulo do núcleo (`packages/nucleo/src/tools/catalog.ts`), não um arquivo de configuração: mudar o catálogo é um PR, com revisão de segurança. Cada entrada:

```ts
{
  id: 'gh', label: 'GitHub CLI', group: 'cli',            // cli | mcp | runtime | container
  probe: { argv: ['gh', '--version'], version: /gh version (\S+)/ },
  sources: [
    { id: 'homebrew', platforms: ['darwin', 'linux'], binaryUnder: ['/opt/homebrew', '/home/linuxbrew', '/usr/local/Cellar'],
      latest: { kind: 'homebrew', formula: 'gh' },
      actions: {
        install: { steps: [['brew', 'install', 'gh']], timeoutSeconds: 600 },
        update:  { steps: [['brew', 'upgrade', 'gh']], timeoutSeconds: 600 } } },
    { id: 'apt', platforms: ['linux'], binaryUnder: ['/usr/bin'], latest: { kind: 'apt', package: 'gh' },
      actions: { update: { steps: [['sudo', 'apt-get', 'install', '--only-upgrade', 'gh']], admin: true } } },
    { id: 'winget', platforms: ['win32'], latest: { kind: 'winget', id: 'GitHub.cli' },
      actions: { update: { steps: [['winget', 'upgrade', '--id', 'GitHub.cli', '--scope', 'user', '--silent']], timeoutSeconds: 600 } } },
  ],
}
```

- **Cada passo é uma lista**: o executável e os argumentos, um a um. Nada de `&&`, `|`, `~`, `$VAR` ou aspas. Uma ação de dois passos (`fnm install 24.11.0`, depois `fnm default 24.11.0`) são dois passos; o segundo só roda se o primeiro sair com 0.
- **Versões no comando vêm do próprio núcleo**, da leitura de "mais recente" (seção 2), e só quando batem com o formato de versão da entrada (`^\d+(\.\d+){0,3}$`). É o único valor que entra num argumento e não está escrito no catálogo.
- **`admin: true`** marca o passo que pede senha de administrador (`sudo`, um `.pkg`, um serviço do sistema, UAC). O núcleo nunca roda esse passo; a tela mostra o texto dele com Copiar e "Rodei, verificar de novo". Além da marca, o executor recusa qualquer passo cujo executável seja `sudo`, `doas`, `pkexec`, `su`, `runas` ou `osascript`, mesmo que a entrada esqueça a marca. Um teste prova as duas coisas.
- **Uma ferramenta fora do catálogo** pode aparecer (um servidor MCP qualquer, uma CLI achada no PATH), mas só para leitura.

### 2. O que a tela mostra, e de onde vem

- **Instalada:** a sonda do catálogo, por `execFile` sem shell, com 5 s de tempo limite, no PATH do shell de login (o mesmo da 0012). **De onde veio** é o caminho real do binário (`realpath`) contra o `binaryUnder` de cada fonte: `/opt/homebrew` é Homebrew, `~/.local/share/fnm` é fnm, `/usr/local/aws-cli` é o instalador oficial. Sem fonte que bata, a origem é "instalada à mão" e não há ação.
- **Mais recente:** dos metadados do gerenciador, sem baixar o pacote:

| Fonte | Como lê | Rede |
| --- | --- | --- |
| Homebrew | `brew info --json=v2 --installed` com `HOMEBREW_NO_AUTO_UPDATE=1`, do cache local da API | Só em Verificar agora, que roda `brew update` antes (sem senha) |
| apt | `apt-cache policy <pacote>`, das listas locais | Nunca: `apt-get update` pede sudo. A tela diz a idade das listas e mostra o comando |
| winget | `winget show --id <id>` e `winget list --upgrade-available`, do cache da fonte | Sim, o winget atualiza a fonte sozinho |
| npm global | `npm view <pacote> version` | Sim |
| rustup, uv, fnm | `rustup check`, `uv python list`, `fnm list-remote --lts` | Sim |
| Claude Code | o canal do instalador nativo, o mesmo que `claude update` consulta | Sim |
| Instalador oficial (aws, Go) | a lista pública de versões do fornecedor (por exemplo, `go.dev/dl/?mode=json`) | Sim |

- **Cache:** o resultado vai para o banco do núcleo (tabela `tool_checks`: item, máquina, fonte, instalada, mais recente, hora, erro) e vale 6 h. A tela abre com o cache e a hora; Verificar agora refaz. **Sem rede**, a instalada continua certa (é local) e a mais recente é a do cache, com a hora; instalar e atualizar ficam desligados. Sem leitura nenhuma, a coluna fica vazia, nunca "em dia".

### 3. Como roda

- **A rota recebe ids**: `POST /api/tools/<toolId>/actions/<actionId>` (`install`, `update`, `start`, `stop`), sem corpo que vire comando. O núcleo resolve a fonte pela própria detecção e o comando pelo catálogo; responde `202` com o trabalho. `DELETE /api/tools/jobs/<jobId>` cancela. O estado vai em `GET /api/tools` e as mudanças em `/api/changes`.
- **O confirmar mostra o que vai rodar**: os passos montados, a fonte, a versão de destino e o tempo limite. O `POST` leva o `planDigest` do que a tela mostrou; se o núcleo montar outra coisa (o cache mudou entre o diálogo e o clique), recusa com 409 e a tela mostra o novo.
- **O processo:** `spawn(argv[0], argv.slice(1), { shell: false })`, num grupo próprio, entrada padrão fechada, a pasta do usuário como pasta de trabalho, o ambiente do núcleo menos `AHRENA_CONSOLE_*`, mais `NONINTERACTIVE=1` e `HOMEBREW_NO_AUTO_UPDATE=1`. Tempo limite por passo (600 s por padrão, até 1800): SIGTERM e, 5 s depois, SIGKILL no grupo, como na 0012.
- **Um por vez, em fila, por máquina.** Dois gerenciadores ao mesmo tempo disputam o PATH, o disco e os próprios travamentos (o lock do Homebrew, o do npm). "Atualizar 5" põe cinco itens na fila, na ordem mostrada; a tela mostra a fila.
- **A saída aparece na tela**, ao contrário da 0012. Lá a saída era de um login (código de dispositivo, conta); aqui é de um gerenciador de pacotes. Mesmo assim, antes de mandar uma linha à tela o núcleo apaga credencial de URL (`https://usuario:senha@`) e o valor de parâmetros como `token=`, e guarda só as últimas 200 linhas em memória. A saída inteira vai para `tools.log`, na pasta de dados da instalação, 0600, com rotação em 1 MB.
- **Ao sair com 0**, o núcleo roda a sonda de novo e grava a versão nova. Saiu com outro código ou passou do tempo, a tela mostra o código, o tempo, as últimas linhas e onde está o log, e oferece Tentar de novo.

### 4. Mesma origem

As escritas (`POST` e `DELETE`) são exceções de mesma origem da `/ui`, como as da 0003 e da 0012, e mais estritas: exigem `Origin` igual ao do núcleo e `Host` em loopback. Um pedido sem `Origin` (que a 0012 aceita da bandeja) é recusado aqui, porque nenhum chamador local precisa dele. Um teste prova que outro `Origin`, e a falta dele, recebem 403 e que nada roda.

### 5. A Workstation

- **Ler** é como na 0008: o núcleo do Mac pede `GET /api/tools` ao núcleo de lá pela porta do túnel e mostra com o seletor de máquina. Lá, o núcleo usa o catálogo de lá, com as fontes do Linux.
- **Agir lá é desligado por padrão.** O túnel faz o pedido do Mac parecer local na Workstation, então a regra é recusar: o núcleo de lá só aceita uma ação sem `Origin` vinda do encaminhamento se o config de lá disser `"tools": { "acceptRemoteActions": true }`. Quem liga é quem está na Workstation, não o Mac. Desligado, a tela mostra cada ação como Copiar comando.
- **Ligado**, o Mac só repassa o id do item e da ação (e o `planDigest`); quem monta e roda o comando é o núcleo de lá, com o catálogo de lá e como o usuário de lá. O confirmar diz "Roda na Workstation". O que pede sudo continua com a pessoa, lá.

### 6. Servidores MCP

- **A lista** vem dos arquivos de configuração do Claude Code (`~/.claude.json`, escopos de usuário e local, e o `.mcp.json` de cada projeto das sessões). O núcleo lê nome, escopo, transporte, o nome do comando, o pacote fixado nos argumentos (`@playwright/mcp@0.0.41`) e o host da URL. **Os valores de `env` e de cabeçalhos são descartados na leitura**, nunca guardados nem registrados em log: a tela mostra só quantas variáveis há. A URL perde caminho e parâmetros. Um teste com um segredo de mentira no arquivo prova que ele não aparece em nenhuma resposta nem no log.
- **O estado** (conectado, falhou, precisa de login) vem de `claude mcp list`, só quando a pessoa pede Verificar conexões, porque esse comando sobe cada servidor stdio. Fica em cache com a hora.
- **Atualizar** só existe para um servidor que o catálogo conhece, no escopo de usuário e sem variáveis nem cabeçalhos: dois passos do próprio Claude Code, `claude mcp remove -s user <nome>` e `claude mcp add -s user <nome> -- npx -y <pacote>@<versão>`. O escopo de projeto nunca: é o `.mcp.json` do repositório, e muda por PR. Login de servidor remoto é do Claude Code (`/mcp`); o console não faz OAuth por ele.

### 7. Containers

- **macOS:** o Colima com o Docker CLI, código aberto, é o recomendado. A tela lê `colima status --json` (VM, CPU, memória, disco, runtime), o contexto do `docker` e a contagem de containers. Iniciar e Parar são `colima start` e `colima stop`, sem senha.
- **Linux:** o Docker Engine. Iniciar e parar o serviço do sistema pedem sudo: `admin: true`, a tela mostra o comando. O Docker sem root (`systemctl --user start docker`) roda sem senha e entra no catálogo.
- **Windows:** o Docker Desktop é comum e pede licença paga em empresa maior; a proposta é o Podman Desktop (`winget install --id RedHat.Podman-Desktop --scope user`, `podman machine start`). Ligar o WSL 2 pede administrador e fica como comando.
- **Docker Desktop achado** em qualquer plataforma é só lido: o console não o inicia nem o atualiza.
- O uso de disco por imagem, volumes, build cache e as stacks com a sessão dona continuam nas telas das máquinas (0008); Ferramentas mostra a saúde do runtime e um link.

## Alternativas consideradas

- **Só mostrar, sem ações.** Mais simples e sem risco, mas o pedido é manter em dia, e a parte que cansa é lembrar o comando de cada gerenciador nas duas máquinas.
- **Uma caixa de comando na tela, ou comandos no `config.json` do usuário** (como o `reconnect` da 0012). A 0012 vale para um comando que só o usuário sabe; aqui os comandos são públicos e iguais para todo mundo. Um catálogo no código é revisado uma vez, por PR, e não deixa uma página ou um arquivo injetar um comando.
- **Rodar num shell** (`"update": "brew upgrade gh"`). Perde pelos motivos da 0012: interpolação e aspas mudam o sentido do texto.
- **Pedir a senha de administrador pela tela** (ou `osascript ... with administrator privileges`, ou UAC). O console passaria a lidar com a senha da máquina. A regra é a mesma do resto do console: o que pede senha fica com a pessoa, no terminal dela.
- **Atualizar sozinho, em segundo plano.** Muda a máquina sem a pessoa ver, às vezes no meio de uma sessão que usa a ferramenta. A tela avisa; quem decide é a pessoa.
- **Pedir a uma sessão do Claude Code que instale.** Funciona, mas o comando passa a ser o que o modelo escreveu, e o console não pode garantir o que roda.
- **Ações na Workstation ligadas por padrão.** Pelo túnel, qualquer processo do Mac falaria com o núcleo de lá como se fosse local; a escolha fica com a Workstation.
- **`brew bundle` com um Brewfile** cobre o Homebrew, não apt, winget, npm, rustup nem MCP. Pode ser uma fonte a mais do catálogo depois.

## Consequências

- O núcleo passa a instalar software na máquina, a pedido da `/ui`. A superfície é estreita (ids, mesma origem estrita, catálogo no código, um por vez, sem senha), e o Argos faz a revisão de segurança do executor e de cada entrada nova do catálogo.
- Acrescentar uma ferramenta é um PR no catálogo, com a sonda, as fontes e um teste que monta os passos de cada plataforma.
- A tela fica honesta sobre o que o console não faz: o apt da Workstation, o `.pkg` da AWS e o serviço do Docker no Linux aparecem como comandos para copiar.
- Risco aceito: um gerenciador pode, por conta própria, pedir algo interativo (uma licença, uma confirmação). Com a entrada fechada e `NONINTERACTIVE=1`, o comando falha em vez de travar, e a tela mostra a falha.
- Fica para depois: o app de bandeja avisar "3 atualizações" (a tela não depende disso), e o painel da sessão sugerir instalar uma CLI que a sessão acabou de procurar.
