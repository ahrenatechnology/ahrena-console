# Núcleo com dono único

Um núcleo por máquina, não importa quem o suba: o app de bandeja, a extensão `.mcpb` do Claude Desktop, o terminal e, depois, o plugin (issue #86, item 6.6; decisão [0005](../../../../docs/decisoes/0005-app-desktop.md), seção "Como o app fala com o núcleo"). Quem chega primeiro serve; os outros adotam.

| Arquivo | O quê |
| --- | --- |
| [lock.ts](lock.ts) | A trava `~/.ahrena-console/nucleo.json`: leitura, escrita atômica com 0600, liberação pelo token |
| [probe.ts](probe.ts) | Pid vivo, `GET /api/overview` (nome, versão, pid e commit), comparação de versões e a reserva da porta |
| [commit.ts](commit.ts) | O commit deste checkout e se outro commit é ancestral dele |
| [start.ts](start.ts) | `startOrAdopt`: o `start` como função, para o comando e para a ponte do MCP |
| [clients.ts](clients.ts) | Clientes registrados em `~/.ahrena-console/clientes/<pid>` |
| [owner.ts](owner.ts) | As regras: `examine`, `planStart` (adotar, recuperar, substituir), `claimLock`, `stopCore`, `watchParent` |
| [cli.ts](cli.ts) | `npm run core -- status\|start\|stop`. O caminho antigo `src/dono/cli.ts` é um atalho para ele, que o app de bandeja chama até a fase 4 da #173 (sai na fase 6) |

## A trava

`~/.ahrena-console/nucleo.json`, criada pelo núcleo depois que a API já ouve na porta, apagada por ele ao sair:

As chaves do arquivo continuam em português, porque outros núcleos instalados o leem; no código, a `Lock` tem nomes em inglês e `lock.ts` converte na leitura e na escrita:

```json
{ "pid": 4242, "porta": 4720, "versao": "0.0.1", "inicio": "2026-10-19T12:00:00.000Z", "token": "<64 hex>", "pai": 777 }
```

- **Atômica e exclusiva:** grava um temporário na mesma pasta e o liga com `link`, que falha se já há trava: de dois núcleos que a criam ao mesmo tempo (em portas diferentes), um só consegue, e o outro fecha e adota. Para tirar uma trava (órfã, ou a própria ao sair), move com `rename` e confere o token; se não era a esperada, ela volta para o lugar. Quem lê vê uma trava inteira, nunca metade.
- **Permissão:** o arquivo é 0600 e a pasta, 0700. A pasta é fechada também quando já existia aberta (o `mkdir` de antes dava 0755), porque o banco mora nela. O `token` é aleatório (32 bytes) e é dos clientes locais: provar que leram a trava, para rotas que mudam estado. Ele não aparece no `status` nem no log.
- **Viva** quando o pid existe **e** a porta responde `/api/overview` com `"name": "ahrena-console"` (ou `"nome"`, num núcleo de antes da #173 fase 2b) **e o mesmo `pid`**. Pid morto, porta muda, porta de outro processo (o pid da trava foi reaproveitado) ou arquivo ilegível: **órfã**, e quem sobe a recupera.
- **Nunca sinaliza um estranho:** `stop` e `--replace` só mandam SIGTERM ou SIGKILL depois de conferir, antes de cada sinal, que a porta responde com aquele pid (ou, com a porta já fechada, que o processo ainda é o `node … src/api/cli.ts`).

## Subir ou adotar

1. Lê a trava. Se está viva, **adota**: imprime porta e versão e sai com 0, sem abrir o banco.
2. Senão, **prende a porta** em 127.0.0.1 antes de abrir o banco. É o sistema que garante um núcleo só quando dois sobem ao mesmo tempo: só um consegue a porta. O outro espera o núcleo responder e o adota.
3. Abre o banco, sobe a API na porta e grava a trava.

Se a porta está presa por algo que não responde como núcleo em 30 s, sai com 1. Se responde como núcleo sem trava (uma `--demo`, uma `--sem-trava` ou um núcleo de antes da #86), adota e avisa.

`--demo` e `--sem-trava` não leem nem gravam a trava e **nunca adotam**: se a porta já tem núcleo, saem com 1 e pedem outra porta. Quem pede a demo não recebe o núcleo real.

Vale a trava, não a `--porta`: se o núcleo da máquina já roda em outra porta, quem sobe o adota lá.

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
- `--parent <pid>` em quem adota: o pid vira **cliente registrado** (`~/.ahrena-console/clientes/<pid>`).
- O núcleo **sai** quando o pai morreu **e** nenhum cliente registrado está vivo. Enquanto houver um, fica. Cliente morto é apagado da pasta.
- Sem `--parent`, ninguém vigia: o núcleo subido no terminal só sai com `stop`, SIGTERM ou Ctrl-C, mesmo que clientes se registrem.
- O pai e os clientes são conferidos pelo pid, a cada segundo. Se um morrer e o número for reaproveitado antes da próxima volta, o núcleo não percebe e fica de pé: o erro possível é ficar, nunca sair à toa nem sinalizar o processo novo.

Exemplo: o app sobe com `--parent <app>`; a extensão adota com `--parent <extensão>`. O app cai: o núcleo fica pela extensão. O Claude Desktop fecha: o núcleo sai e apaga a trava.

## O comando

```bash
npm run core -- status                            # 0 se há núcleo de pé, 1 se não
npm run core -- start                             # adota ou sobe em segundo plano, e espera responder
npm run core -- start --parent 777 --json         # para o app e a extensão
npm run core -- start -- --sem-github             # depois de --, opções da API
npm run core -- stop
```

Os nomes antigos (`npm run nucleo`, `subir`, `parar`, `--porta`, `--pai`, `--substituir`) continuam aceitos até a fase 6 da #173; se vierem os dois, vale o novo. A linha do `--json` não muda: chaves e valores em português, porque o app a lê.

`start` sobe a API (`src/api/cli.ts`) num processo à parte, com o log em `~/.ahrena-console/nucleo.log`, e só volta quando ela responde. Com `--json`, uma linha:

```json
{"estado":"de-pe","url":"http://127.0.0.1:4720","porta":4720,"pid":4242,"versao":"0.0.1","inicio":"…","pai":777,"subiu":true}
```

`subiu: false` quer dizer que adotou. `npm run api` (em primeiro plano) usa o mesmo mecanismo: se há núcleo, adota e sai com 0.

### Quem usa como

| Quem | Como |
| --- | --- |
| **App de bandeja** (#87) | `node <núcleo>/src/dono/cli.ts subir --pai <pid do app> --json` (o atalho para `src/owner/cli.ts`, até a fase 4). Lê `porta` e `subiu`. Ao sair, chama `parar` só se `subiu` foi `true`; se o app cair, o núcleo sai sozinho pelo `--pai` |
| **Extensão `.mcpb` e a ponte stdio do MCP** | `npm run mcp` (src/mcp/cli.ts), no Node do Claude Desktop, já faz isso: chama `startOrAdopt` com `parent` no próprio pid e lê a porta da trava a cada pedido. Quando o Desktop fecha, a ponte sai e o núcleo sai junto, se ninguém mais estiver registrado |
| **Terminal** | `npm run core -- start` (segundo plano) ou `npm run api` (primeiro plano), sem `--parent`. `npm run core -- status` e `stop` |
| **Plugin e hooks** | Leem `porta` da trava (decisão 0005, item 4); hoje ainda usam `AHRENA_CONSOLE_PORT` ou 4720 |

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
