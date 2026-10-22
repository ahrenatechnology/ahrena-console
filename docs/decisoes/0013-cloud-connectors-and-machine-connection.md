# 0013 · Conectores de nuvem e a conexão da máquina remota: o console entra pelas CLIs das nuvens, sem guardar credencial

- **Status:** aceita com as quatro respostas recomendadas, a confirmar pelo Fernando (wireframes C57 a C67, A9, A10 e P14 aprovados no #283, em 22/10)
- **Data:** 2026-10-21
- **Issues:** [#277](https://github.com/ahrenatechnology/ahrena-console/issues/277) (contas de nuvem) e [#278](https://github.com/ahrenatechnology/ahrena-console/issues/278) (a conexão da máquina remota)
- **Revê:** em [0008](0008-machine-telemetry-and-dev-console.md), seção 6, "abrir login de nuvem" (passa a ser do console, só pela CLI da nuvem) e "subir, parar o túnel" (passa a ser do console, só pelo comando do usuário); em [0012](0012-remote-reconnect.md), seção 3, "o núcleo não lê a saída" (passa a procurar uma lista fechada de padrões no trecho do log da execução, sem mostrar nada dele)
- **Estende:** [0003](0003-responder-sessao.md) (mais rotas de escrita de mesma origem) e a seção Conexões da [#241](https://github.com/ahrenatechnology/ahrena-console/issues/241) (decisão 0011, no PR #246)

## Contexto

A sessão de nuvem expira todo dia. No caso de uso que motivou isto, a Workstation chega ao Mac por SSH sobre o AWS SSM, e o SSM exige uma sessão do IAM Identity Center (SSO) válida: de manhã o túnel caiu, e a pessoa abre o terminal, lembra o perfil, roda `aws sso login`, depois o script do túnel. A #244 (0012) já deu o Reconectar, que roda o script do usuário; mas o console continua cego para a nuvem: não sabe que a causa é o SSO, não sabe até quando a sessão vale, e não sabe qual perfil o túnel usa.

A 0008 deixou nuvem e login fora do núcleo porque o repositório é público e não pode carregar conta, host ou credencial de ninguém. Esta decisão mantém isso e define o mínimo que o núcleo precisa saber de uma nuvem: **qual CLI ela tem, onde fica a configuração dessa CLI e qual subcomando faz o login.**

## Decisão

**Cada nuvem vira um conector do console, ao lado do GitHub, na seção Conexões. O conector lê a configuração que a CLI da nuvem já tem na máquina, mostra contas, perfis e o estado da sessão, e "Entrar" roda o login da própria CLI, que abre o navegador. A máquina remota ganha uma `connection` no `machines.json`, que generaliza o `reconnect` da 0012 com Parar e o vínculo com um perfil de nuvem. O console nunca guarda nem mostra credencial: elas continuam com as CLIs.**

### 1. O que o núcleo roda

Duas origens de comando, e só elas:

| Origem | Exemplo | De onde vêm os argumentos |
| --- | --- | --- |
| **O comando do usuário** no `machines.json` (`connection.start`, `connection.stop`, e o `reconnect` antigo) | `["/caminho/para/conectar.sh", "tunnel", "start"]` | Do arquivo, como na 0012 |
| **Um modelo fixo por conector**, escrito no código | `aws sso login --sso-session <nome>`; `aws sts get-caller-identity --profile <nome>` | O executável e os subcomandos estão no código; o `<nome>` vem da configuração da CLI (`~/.aws/config`) que o núcleo acabou de ler |

A rota recebe um identificador (o `id` da máquina, o nome da sessão SSO) e o núcleo procura esse identificador na leitura mais recente do arquivo. Não achou, 404. **Nenhum texto da tela, da URL ou do corpo vira argumento, caminho ou variável de ambiente**; o nome que vai para a linha de comando é o que está no arquivo, não o que chegou no pedido, e precisa casar com `^[A-Za-z0-9._-]{1,64}$` (fora disso o perfil aparece como "nome não suportado", sem Entrar). Tudo roda como na 0012: `spawn` sem shell, grupo próprio, tempo limite, um por vez por alvo, entrada fechada, saída no `reconnect.log` da instalação, o mesmo da 0012, que passa a receber também os logins dos conectores.

### 2. Os conectores

- **Catálogo fixo no código**: GitHub (0011), AWS, e depois GCP e Azure. "Adicionar" não instala nada: liga a leitura daquele conector e mostra como configurar a CLI se ela não estiver lá. Não há conector de terceiros carregado de fora; o catálogo é o que o código conhece.
- **AWS, fase 1.** Lê `~/.aws/config` (ou `AWS_CONFIG_FILE`) e agrupa os perfis pelas `sso-session`. Perfis no formato antigo (`sso_start_url` no próprio perfil) viram uma sessão cada. Perfis sem SSO (chave de acesso) aparecem como "fora do escopo", sem estado e sem Entrar. A CLI precisa ser a v2, achada no PATH do shell de login (`shell_path.rs`).
- **Entrar** roda `aws sso login --sso-session <nome>` (ou `--profile <nome>` no formato antigo), com tempo limite de 5 min. A página que abre no navegador é da pessoa: o console não lê, não preenche e não acompanha, e só diz "aguardando o login no navegador" (como a 0012).
- **Um login vale para todos os perfis da mesma sessão**, e a tela diz isso.
- **GCP e Azure** entram depois no mesmo molde: `gcloud config configurations list` e `gcloud auth login`; `az account list` e `az login`.

### 2a. Os perfis são de cada máquina

O núcleo de **cada máquina** lê a configuração das CLIs **dela** (o `~/.aws/config` do Mac é um, o da Workstation é outro). O do Mac lê o da Workstation pelo leitor remoto que já existe (0008, seção 2: `GET /api/connectors` do núcleo de lá, pela porta do túnel), como lê o resto da tela.

- **Na tela de cada máquina** (Esta máquina, Workstation), o card **Perfis de nuvem** mostra as sessões daquela máquina, o estado e Entrar ali mesmo (C66, C67).
- **Conexões** é a visão de todas as máquinas: a lista de sessões ganha a coluna Máquina (C61), e a página da AWS tem o seletor Este Mac / Workstation (C58). Os dois lugares leem o mesmo estado; Entrar num muda o outro.
- **O túnel depende de um perfil do Mac** (o SSM sai daqui): o `cloudProfile` da seção 4 aponta sempre para um perfil da máquina que roda o `connection.start`, este Mac. Os perfis da Workstation são os que ela usa para ela mesma (deploy, dados).

**Entrar numa máquina remota é por código, mostrado no Mac.** O Mac pede ao núcleo de lá (`POST /api/machines/<id>/connectors/aws/sessions/<nome>/login`, de mesma origem aqui; o núcleo do Mac repassa só o nome, pelo túnel, como pedido local lá). O núcleo de lá roda `aws sso login --sso-session <nome> --use-device-code --no-browser`, da mesma lista fixa da seção 1, e da saída tira **só** duas coisas, por padrão estrito: a URL de verificação (precisa ser `https` num domínio da AWS) e o código do usuário (`^[A-Z0-9]{4}-[A-Z0-9]{4}$`). O resto vai para o log de lá. O Mac mostra o código e "Abrir a página de login", que abre a URL no navegador **deste Mac** (C67, estado 2). A credencial nasce na aws CLI de lá e nunca passa pelo Mac.

- **Por que não abrir o navegador lá**: o núcleo de lá é um serviço sem tela (ou a tela de lá não é a que a pessoa está olhando); um navegador aberto lá esperaria por ninguém. É o mesmo padrão do código do GitHub na 0011 (C40).
- **O código aparece na /ui**, que a 0012 evita para a saída de comando: é a exceção estreita de um campo de formato fixo, de vida curta (10 min), que só vale com o login da pessoa no navegador, e que ela precisa ver. Nada mais da saída sai do log.
- **Sem login por código lá** (aws CLI antiga, ou núcleo de lá numa versão sem a rota), a tela **mostra o comando** para rodar num terminal de lá, com Copiar, e nada roda (C67, estado 4).

### 3. O estado da sessão, e a pergunta do "até quando"

"Válida ou não" vem de `aws sts get-caller-identity --profile <um perfil da sessão>`, a cada 5 min e logo depois de um login: sai 0, válida; sai com erro de token, expirada. A resposta traz o número da conta e o ARN; o núcleo guarda só que deu certo e o número da conta, para mostrar ao lado do perfil na tela da própria pessoa, e não escreve nada disso no log.

**"Até quando" é a pergunta 1 para o Fernando.** A CLI não tem um comando que diga quando a sessão SSO expira sem devolver credencial junto. O dado está no cache da CLI (`~/.aws/sso/cache/*.json`, campo `expiresAt`), no mesmo arquivo do token.

- **A (recomendada).** O núcleo abre o arquivo do cache daquela sessão, tira só `expiresAt` e descarta o resto na mesma função, sem log, sem guardar e sem devolver mais nada. Um teste com token sentinela prova que ele não aparece em nenhuma resposta, log ou banco. É ler um arquivo de credencial, mesmo sem usar o que importa nele.
- **B.** O núcleo nunca abre o cache. A tela diz "válida", "entrou às 09:12 (há 3 h)" quando o login foi pelo console, e "deve expirar por volta de 17:12" só se a pessoa disser a duração da sessão na configuração do conector (`sessionHours`). Sem isso, "válida, sem hora de fim".

Os wireframes desenham a variante A; a B muda só o texto da linha do "até quando".

### 4. A conexão da máquina remota

```json
{ "machines": [ { "id": "workstation", "label": "Workstation", "port": 14720,
    "connection": {
      "start": { "command": ["/caminho/para/conectar.sh", "tunnel", "start"], "timeoutSeconds": 180 },
      "stop":  { "command": ["/caminho/para/conectar.sh", "tunnel", "stop"] },
      "cloudProfile": { "connector": "aws", "profile": "perfil-dev" } } } ] }
```

- `start` e `stop` têm o formato e as regras do `reconnect` (0012, seção 1). `reconnect` sozinho continua valendo e é lido como `connection.start`; com os dois, vale `connection` e o log avisa.
- **Reconectar** é `stop` (se houver) seguido de `start`. **Subir** é `start`. **Parar** pede confirmação e marca a máquina "parada por você": a queda que se segue não notifica.
- **O estado não precisa de comando novo.** O núcleo já lê os processos `ssh` e sonda cada porta encaminhada (`TunnelReading`, 0008). A conexão junta isso com a porta da máquina, a resposta do núcleo de lá e o estado do perfil vinculado: `up`, `down`, `starting`, `stopping`, `failing` (o último `start` falhou e a porta continua fechada) e `stopped`.
- **`cloudProfile`** liga a máquina a um perfil do conector. Com o SSO expirado e o túnel fora, a ação principal vira "Entrar na AWS e subir o túnel": o login do conector e, se sair 0, o `start`. Com o túnel no ar e a sessão a 15 min de expirar, o card e a bandeja avisam antes da queda.
- **O motivo da queda**, em ordem: (1) o estado do perfil vinculado (expirado → "SSO expirado"); (2) as sondas (porta segurada por outro processo → "Porta 14720 ocupada no Mac por node"; porta aberta sem núcleo → "Túnel no ar, núcleo de lá parado"); (3) depois que um `start` falha, uma **lista fechada de padrões** no trecho do log escrito por aquela execução (do byte em que ela começou até o fim): `TargetNotConnected` → "Agente SSM da máquina offline"; `Could not resolve hostname` → "Host desconhecido no ~/.ssh/config"; `Permission denied (publickey` → "Chave SSH recusada"; `Address already in use` → "Porta ocupada no Mac"; `Token has expired` / `Error loading SSO Token` → "SSO expirado". Nada casou: "O comando saiu com o código N". A tela mostra só a frase da lista; nenhuma linha do log sai do arquivo. Isso revê o "o núcleo não lê a saída" da 0012, que era para evitar SIGPIPE: a leitura é depois que o processo sai, do arquivo, e não muda o descritor que o túnel em segundo plano usa.

### 5. Onde a máquina roda

O **núcleo de lá** lê, uma vez ao subir e a cada hora, de onde puder, com 1 s de limite cada, sem credencial:

1. os metadados da instância (AWS IMDSv2 com token de sessão; depois o servidor de metadados do GCP e o IMDS do Azure): provedor, tipo de instância, região e zona;
2. o registro do agente SSM (`/var/lib/amazon/ssm/registration`, só `ManagedInstanceID` e `Region`), para máquinas gerenciadas que não têm metadados de instância;
3. o DMI (`/sys/class/dmi/id/sys_vendor` e `product_name`), só para o provedor.

O resultado vai na leitura da máquina (`placement: { provider, kind, region, zone, instanceId, source }`). Sem nada, `provider: 'unknown'` e a tela diz "desconhecido". O núcleo do Mac não pergunta nada à nuvem para isso.

### 6. Rotas

- `GET /api/connectors`: os conectores, o estado de cada um e, por conta ou sessão, o estado, o `expiresAt` (variante A), os perfis e o login em andamento. Nunca token, segredo ou saída de comando.
- `POST` e `DELETE /api/connectors/aws/sessions/<nome>/login`: Entrar e Cancelar, nesta máquina.
- `POST` e `DELETE /api/machines/<id>/connectors/aws/sessions/<nome>/login`: o mesmo na máquina remota, repassado ao núcleo de lá; o estado traz `deviceCode: { verificationUri, userCode, expiresAt }` enquanto espera.
- `POST /api/machines/<id>/connection/start`, `/stop`, `/reconnect`, e `DELETE /api/machines/<id>/connection` (Cancelar o que roda). `POST /api/machines/<id>/reconnect` continua como alias da 0012.
- Todas as escritas são **de mesma origem** (0003), como as da 0012: `Origin` igual ao do núcleo e `Host` em loopback; a bandeja chama sem `Origin`, como já faz. Outro `Origin` recebe 403 e nada roda, com teste.
- As mudanças saem em `/api/mudancas` (`{ type: 'connector', key: 'aws' }`, `{ type: 'alert', key: '<id>:connection' }`).

### 7. Onde aparece

- **Barra lateral**: Conexões fica em Controle (como na #241), agora com um ponto que resume o pior estado dos conectores. As contas de nuvem **não** ganham seção própria agora (ver as alternativas). A Workstation, em Máquinas, mostra no ponto o estado da conexão.
- **Conexões** (C57 a C61): o catálogo, o conector AWS com as sessões e os perfis, o login em andamento, os estados, e a lista de sessões de todas as máquinas.
- **Perfis de nuvem** na tela de cada máquina (C66, C67), com o login da Workstation por código.
- **Tela da máquina** (C62 a C65): os cards Conexão e Onde roda no topo da C25; as faixas de falha com o motivo e a ação certa.
- **Bandeja** (A9, A10): o bloco Nuvens e a linha da conexão em Máquinas; as notificações de sessão perto de expirar, expirada, e de queda com o motivo.
- **Painel da sessão** (P14): uma linha no topo quando a sessão roda numa máquina cuja conexão caiu.

## Alternativas consideradas

- **Uma seção "Nuvens" na barra lateral**, com um item por nuvem. Fica mais à vista, mas hoje só há contas, perfis e sessão, que é o mesmo assunto do GitHub em Conexões: entrar numa conta de fora. Duas telas de "entrar" separariam o que tem o mesmo modelo de segurança. Quando o console mostrar informação da nuvem (instâncias, custo), essa informação ganha um item em Máquinas, e Conexões continua sendo onde se entra.
- **Um mercado de conectores carregados de fora** (pacotes de terceiros). Abre o núcleo para código que ninguém revisou rodar comandos. O catálogo fixo cobre as nuvens que importam; um conector novo é um PR.
- **O console guarda a credencial da nuvem** (no Keychain, como o GitHub da 0011). Duplicaria o que a CLI já faz, criaria uma segunda cópia para vazar, e as ferramentas do terminal continuariam usando a da CLI.
- **Um comando de sonda do usuário** (`connection.probe`) para dizer o estado. Mais um comando para escrever, quando as sondas de porta e o processo `ssh` já dizem o estado. Fica para quando aparecer um túnel que elas não enxergam.
- **Mostrar as últimas linhas do log na falha.** Rejeitado de novo, pelo motivo da 0012: a saída de um login tem conta, URL e código.
- **O núcleo do Mac pergunta à nuvem onde a máquina roda** (`aws ssm describe-instance-information`). Exigiria o id da instância no `machines.json` e uma chamada com credencial; a própria máquina sabe isso sem credencial.

## Consequências

- O núcleo passa a conhecer o nome de duas CLIs de nuvem e um punhado de subcomandos fixos. Continua sem conta, host, região ou perfil de ninguém: tudo chega pelos arquivos de quem usa.
- Quem pode escrever no `~/.aws/config` escolhe o nome que vai para a linha do `aws`, limitado pelo padrão da seção 1. É a mesma pessoa que já roda o `aws` no terminal.
- O motivo da queda depende de padrões de texto de ferramentas que mudam; a lista é testada com saídas gravadas e, quando nada casa, a tela cai no código de saída, que é o que existe hoje.
- O Argos faz a revisão de segurança das rotas, do parser do `~/.aws/config` e, na variante A, do leitor do cache.

## Respostas (as recomendadas, a confirmar pelo Fernando)

1. **"Até quando":** variante A. O núcleo lê só o `expiresAt` do cache da aws CLI, com o teste de vazamento.
2. **Conexões em Controle** é o lugar único das contas; sem seção Nuvens.
3. **Um clique** para "Entrar na AWS e subir o túnel" quando o SSO expirou.
4. **Parar o túnel** entra na fase 1, com confirmação, pela tela e pela bandeja.

## Perguntas para o Fernando

1. **"Até quando"**: variante A (lê só o `expiresAt` do cache da CLI) ou B (não abre o cache; "entrou há 3 h" e a duração que você disser)?
2. **Conexões em Controle** como lugar único das contas (recomendado), ou uma seção Nuvens na barra?
3. **"Entrar na AWS e subir o túnel" num clique** quando o SSO expirou (recomendado), ou dois botões separados?
4. **Parar o túnel** pela tela e pela bandeja, com confirmação: entra na fase 1?
