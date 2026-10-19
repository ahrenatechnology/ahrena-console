# Validações da 0.0.1

As quatro validações que a [proposta](proposta-0.0.1.md) pediu antes do código, feitas em 2026-10-18 num Mac com Claude Desktop 2.42304.0 e Claude Code 2.1.299. O código de cada teste está em [spikes/](../spikes/).

## Resumo

| | Pergunta | Resultado |
| --- | --- | --- |
| **V1** | Um mod consegue mostrar um painel lateral que lê o núcleo local? | **Sim.** Atualiza a cada 5 s, sem limite |
| **V2** | Um artefato consegue ler o núcleo local via `host:`? | **Sim**, com o núcleo instalado como extensão do Desktop. Atualização automática a cada 30 s, ou quase instantânea com long polling |
| **V3** | A UI inline (MCP App) aparece na aba Code a partir de um servidor local? | **Não como MCP App.** Funciona por outro caminho: o Claude lê o núcleo e desenha com a ferramenta `visualize` |
| **V4** | O núcleo ou um artefato alcançam as ferramentas internas do Desktop? | **Não.** O controle vai por hooks |

## O núcleo de teste

[spikes/nucleo-teste/server.mjs](../spikes/nucleo-teste/server.mjs) é um processo Node que lê só nomes, datas e tamanhos dos arquivos em `~/.claude/projects`, nunca o conteúdo. Ele expõe os mesmos dados de três jeitos:

- `GET /api/sessao/<id>` (esta sessão e quantas precisam de você), `GET /api/overview` e `GET /api/fleet` em `127.0.0.1:4720`, para o painel;
- MCP em `/mcp` (HTTP) ou por stdio (`--stdio`), com as ferramentas `fleet_overview` e `open_console`;
- uma MCP App em `ui://ahrena-console/teste.html`.

Os nomes e datas ficam num índice em memória: a primeira leitura varre `~/.claude/projects` uma vez e depois o `fs.watch` atualiza só o arquivo que mudou ([#81](https://github.com/ahrenatechnology/ahrena-console/issues/81)).

### Medir o consumo

[scripts/medir-carga.mjs](../scripts/medir-carga.mjs) sobe o núcleo numa porta separada (4799 por padrão, nunca a 4720), simula as sessões consultando a cada 5 s e mede a CPU e a memória do processo do núcleo (`ps`) e a latência de cada pedido. No fim, desliga o núcleo. Precisa de `npm ci` em `spikes/nucleo-teste`.

```bash
node scripts/medir-carga.mjs --rota sessao --sessoes 20 --abertos 1 --segundos 60
```

`--rota sessao` é o painel de hoje: só os painéis abertos pedem `/api/sessao/<id>`. `--rota frota` repete o comportamento antigo: todas as sessões pedem `/api/fleet`, abertas ou não. `--servidor` mede outro `server.mjs`, para comparar versões. CPU é o tempo de CPU do núcleo na janela dividido pela duração: 100% é um núcleo inteiro. A meta (decisão 0004) é ficar abaixo de 1% com 20 sessões e um painel aberto.

## V1: painel lateral (mod)

**Como:** um plugin do Claude Code ([spikes/painel-teste](../spikes/painel-teste/)) abre um painel com `$.ui.open` e lê o núcleo com `$.http.fetch` num timer de 5 s.

**Resultado:** funciona. O log do núcleo mostra leituras a cada 5 s com o user agent `Bun/1.4.3`, que é o motor do Claude Code. A versão final usa todos os elementos que a aba Code oferece: `Box`, `Text`, `Button`, `Input`, `Select`, `Svg`, `Link`, `Code`, `Markdown` e `Client`. Os testes ([painel.test.tsx](../spikes/painel-teste/hooks/painel.test.tsx)) desenham o painel nas superfícies desktop e terminal.

**O que aprendemos:**

- **Um plugin instalado no escopo user carrega em todas as sessões abertas.** Na primeira versão, o painel abria sozinho em cada uma. No produto, ele abre só pelo comando `/console`.
- **O estado de um mod (`$.state`) sobrevive ao reload do plugin.** Uma versão nova precisa aceitar o estado salvo pela anterior. Isso quebrou o painel uma vez e os testes não pegaram, porque começam com o estado vazio.
- **Hot reload depende de uma pergunta do app**, que é fácil de recusar sem perceber. Instalar como plugin de um marketplace local e rodar `/reload-plugins` é mais previsível.
- **No Desktop, o painel é desenhado com elementos nativos, não com HTML.** Gráficos saem em `Svg`, e animação sai num `Client` com timer próprio.

## V2: artefato com o núcleo local

**Como:** um artefato publicado ([spikes/artefato-teste](../spikes/artefato-teste/console-teste.html)) declara `mcp: {servers: [{server: "host:ahrena-console", tools: ["fleet_overview"]}]}` e lê com `watchTool` (pedido: a cada 5 s) e `callTool`.

**Resultado:** funciona, depois de um ajuste de instalação.

1. Registrado como servidor MCP do **Claude Code** (`claude mcp add`), o artefato deu `server_not_connected`. **A ponte `host:` dos artefatos só enxerga os servidores do Claude Desktop.**
2. Registrado no `claude_desktop_config.json`, exigiria reiniciar o app, o que derruba as outras sessões.
3. **Empacotado como extensão `.mcpb`** ([spikes/extensao-teste](../spikes/extensao-teste/)), instalou com dois cliques e conectou **sem reiniciar**. O log do app registrou `Connected to ahrena-console (2 tools)` e `[localMcpBridge] announcing ahrena-console`.

**Medição:** o log do app (`[ArtifactHostTools] call`) e o log do núcleo mostram as leituras do `watchTool` a 30,0 s, 30,0 s e 30,1 s. O app aplica um piso de 30 s, seja qual for o intervalo pedido.

**O que aprendemos:**

- **O nome do servidor `host:` vem do `display_name` da extensão**, com espaços trocados por `_`. Um `display_name` "Ahrena Workstation Telemetry" vira `host:Ahrena_Workstation_Telemetry`.
- **O log da extensão no app não registra as chamadas que vêm da ponte dos artefatos.** Para medir, o núcleo precisa de log próprio.
- **Long polling contorna o piso de 30 s.** Uma ferramenta que segura a resposta até haver novidade (como o `wait_for_update` do servidor de telemetria da workstation, que responde de 9 a 90 s depois) dá atualização quase instantânea. O app espera uma resposta por cerca de 130 s.

## V3: UI inline na conversa

**Como:** a ferramenta `open_console` declara `_meta.ui.resourceUri = ui://ahrena-console/teste.html`, e o servidor entrega a página com o MIME `text/html;profile=mcp-app`.

**Resultado como MCP App: não funciona na aba Code.** O resultado da ferramenta volta só como texto. O núcleo, com log de cada método MCP, mostra o motivo: ao conectar, o Claude Code anuncia só `{"roots":{...},"elicitation":{...}}`, sem suporte a MCP Apps. Depois da chamada, a página nunca pediu dados ao núcleo.

**O que funciona:** a aba Code desenha os widgets da ferramenta `visualize`. O Claude lê os dados do núcleo (`fleet_overview`, `/api/fleet`) e desenha um card do Console dentro da conversa, com logo, números, gráfico, sessões recentes e botões que mandam mensagens ao Claude (`sendPrompt`).

**Limites desse caminho:** é uma foto do momento (atualiza quando o usuário pede), e o widget não fala direto com o núcleo. No produto, vira uma skill do plugin ("mostra o console"). A MCP App continua valendo para o chat do Claude Desktop e o claude.ai, que anunciam suporte.

## V4: ferramentas internas do Desktop

**Resultado:** não dá. Publicar um artefato que declara `host:ccd_session_mgmt` é recusado na hora:

> built-in server "host:ccd_session_mgmt" — the Claude app's own servers, which it never exposes to pages as host servers

E um processo externo como o núcleo não tem API para chamá-las. O controle de sessões (responder, aprovar), previsto para a 0.0.2, vai por hooks do Claude Code.

## Impacto na proposta

- **Instalação:** o núcleo é distribuído como **extensão `.mcpb`** (dois cliques, sem terminal, sem Node próprio, sem reiniciar) **e** como plugin do Claude Code (painel, hooks e comando `/console`).
- **Atualização ao vivo no artefato:** uma ferramenta `wait_for_changes` com long polling, e o `watchTool` de 30 s como reserva.
- **Painel:** abre só por `/console` e aceita estado salvo por versões anteriores.
- **Inline na aba Code:** por uma skill que desenha o card com a `visualize`; a MCP App fica para o chat do Desktop e o claude.ai.
