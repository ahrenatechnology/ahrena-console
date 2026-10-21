# 0010 · Um núcleo por instalação, em porta aleatória, com registro de instâncias

- **Status:** aceita
- **Data:** 2026-10-20
- **Issue:** [#221](https://github.com/ahrenatechnology/ahrena-console/issues/221)
- **Substitui:** em [0005](0005-app-desktop.md), a regra "um núcleo por máquina; quem chegar primeiro serve, os outros adotam" (seção "Como o app fala com o núcleo", itens 1 e 4). O resto da 0005 continua valendo.
- **Supera:** [#220](https://github.com/ahrenatechnology/ahrena-console/issues/220)

## Contexto

A 0005 pôs um núcleo só na máquina, na 4720: quem sobe primeiro serve, os outros adotam. Na primeira instalação da app-v0.0.1 isso falhou: o app adotou um núcleo antigo, subido de um checkout, e a janela mostrou a /ui velha, embora o app trouxesse o núcleo novo dentro. Adotar junta instalações de versões diferentes num processo só, e quem adota não escolhe o código que roda.

O Claude Code resolve o mesmo problema de outro jeito: um processo por sessão e um lockfile por IDE em `~/.claude/ide/`, que quem precisa lê para achar quem está vivo.

## Decisão

Em 20/10 o Fernando decidiu: **um núcleo por instalação, em porta aleatória.** Cada instalação (o app, o checkout de desenvolvimento ou o terminal, a extensão `.mcpb`) é autônoma e roda o próprio núcleo, com o próprio banco.

1. **Porta aleatória.** O núcleo pede a porta `0` ao sistema e anuncia a que recebeu. `--port` e `AHRENA_CONSOLE_CORE_PORT` continuam forçando uma porta, para testes, demos e a transição (item 7).
2. **Pasta de dados por instalação.** Banco, logs e clientes ficam na pasta da instalação:

   | Instalação | Pasta de dados |
   | --- | --- |
   | `app` | `~/Library/Application Support/dev.ahrena.console/` |
   | `dev` (checkout e terminal) | `~/.ahrena-console/`, como hoje |
   | `mcpb` (extensão) | a pasta da extensão |

   Dois núcleos nunca escrevem no mesmo SQLite. Dentro de uma pasta, a trava de hoje (`nucleo.json`, com pid, porta e token, 0600) continua garantindo um escritor só: um segundo núcleo **da mesma instalação** adota o primeiro. Entre instalações, ninguém adota ninguém.
3. **Registro de instâncias.** Cada núcleo grava `~/.ahrena-console/instances/<id>.json` depois que a API ouve, e apaga ao sair:

   ```json
   { "id": "app-4242", "installation": "app", "pid": 4242, "port": 53817, "version": "0.0.2", "commit": "cc20484", "dataDir": "/Users/…/Library/Application Support/dev.ahrena.console", "startedAt": "2026-10-20T12:00:00.000Z" }
   ```

   A pasta é 0700 e o arquivo 0600, gravado de forma atômica. O token da trava **não** vai para o registro. Quem lê descarta (e pode apagar) as entradas de pid morto; antes de mandar algo que muda estado, confere em `/api/overview` que a porta responde com aquele pid.
4. **Hooks em leque.** O `forward.mjs` manda cada evento para todos os núcleos vivos do registro, ao mesmo tempo, dentro do prazo curto de hoje (800 ms no total). Cada núcleo tem o retrato inteiro das sessões. Nenhum vivo: desiste calado, como hoje. `AHRENA_CONSOLE_URL` ou `AHRENA_CONSOLE_PORT` definidos mandam para aquele núcleo só.
5. **Quem acha o núcleo.** O app sobe o próprio núcleo (pasta do app, porta `0`, `--parent` no pid do app) e a bandeja só fala com ele; ao sair, encerra só esse. O mod e o MCP leem o registro e preferem o núcleo da própria instalação; sem ele, o vivo que subiu primeiro. A ponte do MCP da extensão, sem nenhum vivo da instalação dela, sobe o próprio, como hoje.
6. **Migração.** Ninguém perde dados: `~/.ahrena-console/nucleo.sqlite` continua sendo o banco do `dev`. O app começa com banco próprio e, na primeira subida, importa o histórico dos transcripts como já faz.
7. **Transição.** Os núcleos publicados antes da #221 (o app 0.0.1, um checkout antigo) ouvem na 4720 e não gravam o registro, e o mod publicado ainda manda os hooks só para a 4720. Até todo núcleo publicado gravar o registro:
   - os hooks mandam também para a 4720, além dos núcleos do registro, a menos que um núcleo do registro já esteja nela; ninguém ouvindo na 4720 é o normal e não vira linha de log;
   - o painel, sem nenhum núcleo vivo no registro, tenta a 4720 e a usa se `/api/overview` responder como núcleo;
   - quem quiser os hooks do mod antigo num núcleo de desenvolvimento o sobe com `--port 4720`.

   A ordem de merge e de publicação é: o núcleo com o registro, o app que sobe o próprio núcleo, e o mod por último. Com o fallback, atualizar o mod antes do app não deixa ninguém sem hooks nem sem painel.

## Consequências

- Cada instalação roda o código que trouxe: o app nunca mais mostra a /ui de outro checkout.
- Dois núcleos de pé dobram a ingestão dos hooks e a memória (cada um importa e guarda a mesma frota). Na máquina de quem desenvolve isso é esperado; para o usuário comum, em geral há um núcleo só, o do app ou o da extensão.
- Some a porta fixa: o painel, o MCP e os hooks passam a depender do registro. Uma entrada esquecida por um núcleo morto à força (SIGKILL) só é limpa por quem lê.
- A adoção da 0005 (`--substituir`, versão e commit) fica valendo só dentro de uma instalação.
- Desde a [#220](https://github.com/ahrenatechnology/ahrena-console/issues/220) (21/10), dentro de uma instalação um núcleo de **versão mais velha** não é mais adotado: quem sobe o para e sobe no lugar, sem `--replace` (o app atualizado adotava o núcleo da versão anterior, mantido de pé pelas pontes do MCP). O `--replace` fica só para um commit ancestral da mesma versão. Vale também para o `dev`: subir um checkout de versão mais nova para o núcleo de um checkout mais velho.
