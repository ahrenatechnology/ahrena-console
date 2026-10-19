# Núcleo com dono único

Um núcleo por máquina, não importa quem o suba: o app de bandeja, a extensão `.mcpb` do Claude Desktop, o terminal e, depois, o plugin (issue #86, item 6.6; decisão [0005](../../../../docs/decisoes/0005-app-desktop.md), seção "Como o app fala com o núcleo"). Quem chega primeiro serve; os outros adotam.

| Arquivo | O quê |
| --- | --- |
| [trava.ts](trava.ts) | A trava `~/.ahrena-console/nucleo.json`: leitura, escrita atômica com 0600, liberação pelo token |
| [sonda.ts](sonda.ts) | Pid vivo, `GET /api/overview`, comparação de versões e a reserva da porta |
| [clientes.ts](clientes.ts) | Clientes registrados em `~/.ahrena-console/clientes/<pid>` |
| [dono.ts](dono.ts) | As regras: examinar, planejar a subida (adotar, recuperar, substituir), assumir a trava, parar, vigiar o pai |
| [cli.ts](cli.ts) | `npm run nucleo -- status\|subir\|parar` |

## A trava

`~/.ahrena-console/nucleo.json`, gravada pelo núcleo depois que a API já ouve na porta, apagada por ele ao sair:

```json
{ "pid": 4242, "porta": 4720, "versao": "0.0.1", "inicio": "2026-10-19T12:00:00.000Z", "token": "<64 hex>", "pai": 777 }
```

- **Atômica:** grava um temporário na mesma pasta e faz `rename`. Quem lê vê a trava antiga ou a nova, nunca metade.
- **Permissão:** o arquivo é 0600 e a pasta, 0700. O `token` é aleatório (32 bytes) e é dos clientes locais: provar que leram a trava, para rotas que mudam estado. Ele não aparece no `status` nem no log.
- **Viva** quando o pid existe **e** a porta responde `/api/overview` com `"nome": "ahrena-console"`. Pid morto, porta muda ou arquivo ilegível: **órfã**, e quem sobe a recupera (sobrescreve).

## Subir ou adotar

1. Lê a trava. Se está viva, **adota**: imprime porta e versão e sai com 0, sem abrir o banco.
2. Senão, **prende a porta** em 127.0.0.1 antes de abrir o banco. É o sistema que garante um núcleo só quando dois sobem ao mesmo tempo: só um consegue a porta. O outro espera o núcleo responder e o adota.
3. Abre o banco, sobe a API na porta e grava a trava.

Se a porta está presa por algo que não responde como núcleo em 30 s, sai com 1. Se responde como núcleo sem trava (uma `--demo`, ou um núcleo de antes desta versão), adota do mesmo jeito.

Vale a trava, não a `--porta`: se o núcleo da máquina já roda em outra porta, quem sobe o adota lá.

### Versão

Se o núcleo vivo é **mais velho** que o que está subindo, quem sobe avisa (`atenção: o núcleo de pé (pid …) é a versão …, mais velha que esta (…)`), e **adota assim mesmo**: ninguém fica sem núcleo. Com `--substituir`, para o velho (SIGTERM, depois SIGKILL em 10 s) e sobe. Núcleo da mesma versão ou mais novo é adotado sem aviso.

## A regra do `--pai`

- `--pai <pid>` no núcleo que sobe: ele vigia esse pid a cada segundo.
- `--pai <pid>` em quem adota: o pid vira **cliente registrado** (`~/.ahrena-console/clientes/<pid>`).
- O núcleo **sai** quando o pai morreu **e** nenhum cliente registrado está vivo. Enquanto houver um, fica. Cliente morto é apagado da pasta.
- Sem `--pai`, ninguém vigia: o núcleo subido no terminal só sai com `parar`, SIGTERM ou Ctrl-C, mesmo que clientes se registrem.

Exemplo: o app sobe com `--pai <app>`; a extensão adota com `--pai <extensão>`. O app cai: o núcleo fica pela extensão. O Claude Desktop fecha: o núcleo sai e apaga a trava.

## O comando

```bash
npm run nucleo -- status                          # 0 se há núcleo de pé, 1 se não
npm run nucleo -- subir                           # adota ou sobe em segundo plano, e espera responder
npm run nucleo -- subir --pai 777 --json          # para o app e a extensão
npm run nucleo -- subir -- --sem-github           # depois de --, opções da API
npm run nucleo -- parar
```

`subir` sobe a API (`src/api/cli.ts`) num processo à parte, com o log em `~/.ahrena-console/nucleo.log`, e só volta quando ela responde. Com `--json`, uma linha:

```json
{"estado":"de-pe","url":"http://127.0.0.1:4720","porta":4720,"pid":4242,"versao":"0.0.1","inicio":"…","pai":777,"subiu":true}
```

`subiu: false` quer dizer que adotou. `npm run api` (em primeiro plano) usa o mesmo mecanismo: se há núcleo, adota e sai com 0.

### Quem usa como

| Quem | Como |
| --- | --- |
| **App de bandeja** (#87) | `node <núcleo>/src/dono/cli.ts subir --pai <pid do app> --json`. Lê `porta` e `subiu`. Ao sair, chama `parar` só se `subiu` foi `true`; se o app cair, o núcleo sai sozinho pelo `--pai` |
| **Extensão `.mcpb`** | O mesmo comando, com o pid do processo da extensão em `--pai`, no Node do Claude Desktop. Ou, no mesmo processo, `planejarSubida` e `registrarCliente` de `@ahrena-console/nucleo/dono` |
| **Terminal** | `npm run nucleo -- subir` (segundo plano) ou `npm run api` (primeiro plano), sem `--pai`. `npm run nucleo -- status` e `parar` |
| **Plugin e hooks** | Leem `porta` da trava (decisão 0005, item 4); hoje ainda usam `AHRENA_CONSOLE_PORT` ou 4720 |

`--demo` e `--sem-trava` não leem nem gravam a trava (medições numa porta à parte, como o `scripts/medir-carga.mjs`); a porta continua sendo de um só.

## Testes

[test/dono/dono.test.ts](../../test/dono/dono.test.ts) sobe núcleos de verdade, cada um com um `HOME` falso numa pasta temporária e numa porta livre: duas e três subidas ao mesmo tempo (um núcleo só), trava órfã por pid morto e por porta muda, versão mais velha com e sem `--substituir`, pai morto com e sem cliente registrado.
