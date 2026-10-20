# Núcleo com dono único, um por instalação

Um núcleo por **instalação**, em porta aleatória (issue #221; decisão [0010](../../../../docs/decisoes/0010-core-per-installation.md), que substitui o "um por máquina" da [0005](../../../../docs/decisoes/0005-app-desktop.md)). Cada instalação (o app, o checkout de desenvolvimento ou o terminal, a extensão `.mcpb`) roda o próprio núcleo, com a própria pasta de dados e o próprio banco. **Dentro** de uma instalação vale a regra da #86: quem chega primeiro serve, os outros adotam. **Entre** instalações, ninguém adota ninguém; quem precisa achar um núcleo lê o registro de instâncias.

| Arquivo | O quê |
| --- | --- |
| [installation.ts](installation.ts) | A instalação (`app`, `dev`, `mcpb`), a pasta de dados de cada uma, a pasta do usuário (`consoleHome`) e a porta pedida |
| [registry.ts](registry.ts) | O registro de instâncias `~/.ahrena-console/instances/<id>.json`: gravar, apagar, `listInstances`, `pickInstance`, `verifyInstance` |
| [start-guard.ts](start-guard.ts) | A guarda de subida `core.starting` da pasta de dados: com a porta 0, é ela que deixa um só abrir o banco |
| [lock.ts](lock.ts) | A trava `nucleo.json` da pasta de dados: leitura, escrita atômica com 0600, liberação pelo token |
| [probe.ts](probe.ts) | Pid vivo, `GET /api/overview` (nome, versão, pid e commit), comparação de versões e a reserva da porta |
| [commit.ts](commit.ts) | O commit deste checkout e se outro commit é ancestral dele |
| [start.ts](start.ts) | `startOrAdopt`: o `start` como função, para o comando e para a ponte do MCP |
| [clients.ts](clients.ts) | Clientes registrados em `<pasta de dados>/clientes/<pid>` |
| [owner.ts](owner.ts) | As regras: `examine`, `planStart` (adotar, recuperar, substituir), `claimLock`, `stopCore`, `watchParent` |
| [cli.ts](cli.ts) | `npm run core -- status\|start\|stop`. O caminho antigo `src/dono/cli.ts` é um atalho para ele, que o app de bandeja chama até a fase 4 da #173 (sai na fase 6) |

## Instalação, pasta de dados e porta

`--installation <app|dev|mcpb>` (padrão `dev`) diz de qual instalação é o núcleo. A pasta de dados é `--data-dir`, senão `AHRENA_CONSOLE_DATA_DIR`, senão a da instalação:

| Instalação | Pasta de dados |
| --- | --- |
| `dev` (checkout e terminal) | `~/.ahrena-console/`, como antes: o banco de quem já usava continua lá |
| `app` | `~/Library/Application Support/dev.ahrena.console/` (fora do macOS, `$XDG_DATA_HOME` ou `~/.local/share`, e `%APPDATA%` no Windows) |
| `mcpb` (extensão) | `~/.ahrena-console/installations/mcpb/`, até a extensão passar a pasta dela com `--data-dir` |

Na pasta de dados ficam o banco (`nucleo.sqlite`, a menos que `--db` ou `AHRENA_CONSOLE_DB` digam outro; fora da pasta de dados, o núcleo avisa no log, porque `AHRENA_CONSOLE_DB` exportado vale para qualquer instalação e duas usariam o mesmo arquivo), o log (`nucleo.log`), os clientes (`clientes/`), a trava (`nucleo.json`) e a guarda de subida (`core.starting`). A pasta é 0700, como antes.

Fica em `~/.ahrena-console/` (a pasta do usuário, `consoleHome()`; `AHRENA_CONSOLE_HOME` a troca, para testes) o que não é dado de um núcleo: o registro de instâncias, `contas.json`, `machines.json`, `dev-console.json`, `perfis.json`, `backups/` e o `hooks.log`. Na instalação `dev`, as duas pastas são a mesma.

**Porta:** por padrão `0`, e o sistema escolhe uma livre. O núcleo a anuncia no log (`listening on port <n> · installation <i> · data <pasta>`), na trava, no registro e na linha `--json` do `start`. `--port`, `AHRENA_CONSOLE_CORE_PORT` ou o nome antigo `AHRENA_CONSOLE_PORT` forçam uma porta, para testes, demos e a transição (decisão 0010, item 7: quem quiser os hooks do mod publicado no núcleo de desenvolvimento o sobe com `--port 4720`).

## O registro de instâncias

Cada núcleo com trava grava `~/.ahrena-console/instances/<id>.json` depois que a API já ouve e que a trava é dele, e o apaga ao sair (SIGTERM, SIGINT, saída normal e saída pela morte do pai):

```json
{ "id": "app-4242", "installation": "app", "pid": 4242, "port": 53817, "version": "0.0.1", "commit": "cc20484", "dataDir": "/Users/…/Library/Application Support/dev.ahrena.console", "startedAt": "2026-10-20T12:00:00.000Z" }
```

- `id` é `<instalação>-<pid>`, e um núcleo só grava o próprio arquivo: dois núcleos nunca disputam o mesmo.
- Gravado de uma vez (temporário e `rename`), 0600, numa pasta 0700. **O token da trava nunca vai para o registro.**
- `listInstances()` devolve as entradas vivas (pid existe), da mais antiga para a mais nova (`startedAt`); as de pid morto e as ilegíveis saem da lista e o arquivo é apagado. Um núcleo morto com SIGKILL deixa a entrada, e só quem lê a limpa.
- `pickInstance({ installation })` devolve a entrada viva da instalação pedida, senão a primeira viva, senão `null`.
- `verifyInstance(i)` confere que a porta responde `/api/overview` com aquele pid. Use antes de mandar algo que muda estado: um pid vivo pode ser um número reaproveitado.
- Uma falha ao gravar o registro vai para o log e não derruba o núcleo; um arquivo que não dá para ler agora (permissão, uma pasta) é pulado, não apagado.
- `--demo` e `--no-lock` (`--sem-trava`) **não** se registram: não são o núcleo da instalação, e ninguém deve achá-los por ali.

```ts
import { listInstances, pickInstance, verifyInstance } from '@ahrena-console/nucleo/owner';
const core = pickInstance({ installation: 'dev' });
if (core && (await verifyInstance(core))) fetch(`http://127.0.0.1:${core.port}/api/overview`);
```

## A trava

`nucleo.json` na pasta de dados, criada pelo núcleo depois que a API já ouve na porta, apagada por ele ao sair:

As chaves do arquivo continuam em português, porque outros núcleos instalados o leem; no código, a `Lock` tem nomes em inglês e `lock.ts` converte na leitura e na escrita:

```json
{ "pid": 4242, "porta": 4720, "versao": "0.0.1", "inicio": "2026-10-19T12:00:00.000Z", "token": "<64 hex>", "pai": 777 }
```

- **Atômica e exclusiva:** grava um temporário na mesma pasta e o liga com `link`, que falha se já há trava: de dois núcleos que a criam ao mesmo tempo (em portas diferentes), um só consegue, e o outro fecha e adota. Para tirar uma trava (órfã, ou a própria ao sair), move com `rename` e confere o token; se não era a esperada, ela volta para o lugar. Quem lê vê uma trava inteira, nunca metade.
- **Permissão:** o arquivo é 0600 e a pasta, 0700. A pasta é fechada também quando já existia aberta (o `mkdir` de antes dava 0755), porque o banco mora nela. O `token` é aleatório (32 bytes) e é dos clientes locais: provar que leram a trava, para rotas que mudam estado. Ele não aparece no `status` nem no log.
- **Viva** quando o pid existe **e** a porta responde `/api/overview` com `"name": "ahrena-console"` (ou `"nome"`, num núcleo de antes da #173 fase 2b) **e o mesmo `pid`**. Pid morto, porta muda, porta de outro processo (o pid da trava foi reaproveitado) ou arquivo ilegível: **órfã**, e quem sobe a recupera.
- **Nunca sinaliza um estranho:** `stop` e `--replace` só mandam SIGTERM ou SIGKILL depois de conferir, antes de cada sinal, que a porta responde com aquele pid (ou, com a porta já fechada, que o processo ainda é o `node … src/api/cli.ts`).

## Subir ou adotar

1. Lê a trava da pasta de dados. Se está viva, **adota**: imprime porta e versão e sai com 0, sem abrir o banco.
2. Pega a **guarda de subida** da pasta de dados (`core.starting`, criada de forma exclusiva), com qualquer porta: com a porta `0`, e com uma subida na `0` e outra numa porta forçada, as portas não decidem mais quem abre o banco. Quem a acha presa por um pid vivo espera; com a guarda na mão, lê a trava de novo e adota o núcleo que subiu nesse meio-tempo. Guarda de pid morto é recuperada. Um sinal antes do fim da subida sai pelo `exit`, que solta a guarda e tira a entrada do registro.
3. **Prende a porta** em 127.0.0.1 antes de abrir o banco (com `0`, a que o sistema der). Com uma porta forçada, é o sistema que garante um núcleo só quando dois sobem ao mesmo tempo: só um consegue a porta. O outro espera o núcleo responder e o adota.
4. Abre o banco e sobe a API **no mesmo socket** que prendeu (sem soltar a porta no meio, por isso ninguém a pega antes), grava a trava, solta a guarda e grava a entrada do registro.

Se a porta forçada está presa por algo que não responde como núcleo em 30 s, sai com 1. Se responde como o núcleo de **outra instalação** (está no registro com outra pasta de dados, ou tem a trava da pasta `dev`), sai com 1 e pede outra porta: não adota. Se responde como núcleo sem trava (uma `--demo`, uma `--sem-trava` ou um núcleo de antes da #86), adota e avisa.

`--demo` e `--sem-trava` não leem nem gravam a trava e **nunca adotam**: se a porta já tem núcleo, saem com 1 e pedem outra porta. Quem pede a demo não recebe o núcleo real.

Vale a trava, não a `--port`: se o núcleo da instalação já roda em outra porta, quem sobe o adota lá.

A adoção e o `--replace` (versão e commit, abaixo) valem só dentro da mesma pasta de dados.

### Versão e código

A `VERSAO_DA_API` muda pouco, e dois checkouts da mesma versão podem ser códigos diferentes. Por isso o `/api/overview` diz também o `commit` do núcleo no ar, e quem sobe compara:

| O núcleo no ar | Sem `--replace` | Com `--replace` |
| --- | --- | --- |
| Mesma versão e commit, ou versão mais nova | Adota | Adota |
| Versão mais velha | Avisa e adota | Para o velho e sobe |
| Mesma versão, commit ancestral deste | Avisa e adota | Para o velho e sobe |
| Mesma versão, outro commit (mais novo ou de outro branch) | Avisa e adota | Avisa e adota: para trocar, `stop` antes |

Ninguém fica sem núcleo por causa da versão. Parar o velho é SIGTERM e, depois de 10 s, SIGKILL. Sem git (o app empacotado), não há commit, e só a versão conta.

## A regra do `--parent`

- `--parent <pid>` no núcleo que sobe (na API, `--pai`): ele vigia esse pid a cada segundo.
- `--parent <pid>` em quem adota: o pid vira **cliente registrado** (`<pasta de dados>/clientes/<pid>`).
- O núcleo **sai** quando o pai morreu **e** nenhum cliente registrado está vivo. Enquanto houver um, fica. Cliente morto é apagado da pasta.
- Sem `--parent`, ninguém vigia: o núcleo subido no terminal só sai com `stop`, SIGTERM ou Ctrl-C, mesmo que clientes se registrem.
- O pai e os clientes são conferidos pelo pid, a cada segundo. Se um morrer e o número for reaproveitado antes da próxima volta, o núcleo não percebe e fica de pé: o erro possível é ficar, nunca sair à toa nem sinalizar o processo novo.

Exemplo: o app sobe com `--parent <app>`; a extensão adota com `--parent <extensão>`. O app cai: o núcleo fica pela extensão. O Claude Desktop fecha: o núcleo sai e apaga a trava.

## O comando

```bash
npm run core -- status                            # 0 se há núcleo desta instalação de pé, 1 se não; lista o registro
npm run core -- start                             # adota ou sobe em segundo plano (porta aleatória), e espera responder
npm run core -- start --installation app --parent 777 --json   # para o app
npm run core -- start --port 4720                 # porta forçada (os hooks do mod publicado)
npm run core -- start --data-dir /tmp/x           # outra pasta de dados
npm run core -- start -- --sem-github             # depois de --, opções da API
npm run core -- stop --installation app           # para só o núcleo daquela instalação
```

Os nomes antigos (`npm run nucleo`, `subir`, `parar`, `--porta`, `--pai`, `--substituir`) continuam aceitos até a fase 6 da #173; se vierem os dois, vale o novo. As chaves que a linha do `--json` já tinha não mudam (chaves e valores em português, porque o app as lê); as novas (`installation`, `dataDir`, `instances`) nascem em inglês. Na API, `--port`, `--db`, `--parent`, `--replace` e `--no-lock` ganharam o nome em inglês, e os antigos (`--porta`, `--banco`, `--pai`, `--substituir`, `--sem-trava`) continuam aceitos.

`start` sobe a API (`src/api/cli.ts`, com `--port`, `--installation` e `--data-dir`) num processo à parte, com o log em `<pasta de dados>/nucleo.log`, e só volta quando ela responde. Com `--json`, uma linha; `porta` é a que o núcleo recebeu, e `installation` e `dataDir` (chaves novas, em inglês) dizem de quem é:

```json
{"estado":"de-pe","url":"http://127.0.0.1:53817","porta":53817,"pid":4242,"versao":"0.0.1","inicio":"…","pai":777,"subiu":true,"commit":"cc20484","installation":"app","dataDir":"/Users/…/Library/Application Support/dev.ahrena.console"}
```

`status --json` dá a mesma linha (ou `{"estado":"parado",…}`) com `installation`, `dataDir` e `instances`, a lista do registro (as entradas como no arquivo, sem token). Sem `--json`, uma linha por instância: `dev-4242 · dev · port 53817 · pid 4242 · version 0.0.1 (cc20484) · /Users/…/.ahrena-console`.

`subiu: false` quer dizer que adotou. `npm run api` (em primeiro plano) usa o mesmo mecanismo: se há núcleo, adota e sai com 0.

### Quem usa como

| Quem | Como |
| --- | --- |
| **App de bandeja** (#87) | `node <núcleo>/src/dono/cli.ts subir --pai <pid do app> --json` (o atalho para `src/owner/cli.ts`, até a fase 4). Lê `porta` e `subiu`. Ao sair, chama `parar` só se `subiu` foi `true`; se o app cair, o núcleo sai sozinho pelo `--pai` |
| **Extensão `.mcpb` e a ponte stdio do MCP** | `npm run mcp` (src/mcp/cli.ts), no Node do Claude Desktop, já faz isso: chama `startOrAdopt` com `parent` no próprio pid e lê a porta da trava a cada pedido. Quando o Desktop fecha, a ponte sai e o núcleo sai junto, se ninguém mais estiver registrado |
| **Terminal** | `npm run core -- start` (segundo plano) ou `npm run api` (primeiro plano), sem `--parent`. `npm run core -- status` e `stop` |
| **Plugin e hooks** | Hoje ainda usam `AHRENA_CONSOLE_PORT` ou 4720. Na #221 passam a ler o registro e mandar para todos os núcleos vivos (decisão 0010, item 4) |

A ponte do MCP e o app continuam passando a porta (4720 ou a de `AHRENA_CONSOLE_PORT`) até os PRs seguintes da #221, que os levam ao registro.

O `scripts/medir-carga.mjs` sobe com `--sem-trava` numa porta à parte.

## Testes

[test/owner/owner.test.ts](../../test/owner/owner.test.ts) sobe núcleos de verdade, cada um com um `HOME` falso numa pasta temporária e numa porta livre:
- duas e três subidas ao mesmo tempo dão um núcleo só;
- trava órfã por pid morto, por porta muda e por pid reaproveitado, sem sinalizar o processo estranho;
- versão mais velha e commit diferente, com e sem `--substituir` (na API) e `replace`;
- `--demo` e `--sem-trava` com a porta ocupada;
- a pasta 0700, a trava exclusiva e a liberação que devolve a trava alheia;
- pai morto com e sem cliente registrado;
- a ponte do MCP subindo, adotando e saindo.

[test/owner/installations.test.ts](../../test/owner/installations.test.ts), também com `HOME` falso e porta `0`:
- a pasta de cada instalação, `--data-dir`, `AHRENA_CONSOLE_DATA_DIR` e a porta pedida;
- o registro: 0600 numa pasta 0700, sem token, entradas de pid morto e ilegíveis limpas, a ordem e o `pickInstance`;
- a guarda de subida: a segunda espera a primeira, e a de pid morto é recuperada;
- a porta `0` anunciada no `--json`, na trava e no registro, e a porta forçada (`--port`, `AHRENA_CONSOLE_CORE_PORT`);
- dois núcleos de instalações diferentes ao mesmo tempo, em portas e bancos diferentes; a mesma instalação adota;
- duas subidas da mesma instalação na porta `0` dão um núcleo só; a porta forçada de outra instalação não é adotada;
- a entrada sai com SIGTERM, SIGINT e a morte do pai; `--demo` e `--no-lock` não se registram.
