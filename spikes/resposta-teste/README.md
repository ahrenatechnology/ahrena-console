# Resposta à sessão (spike #58)

Prova mínima da [decisão 0003](../../docs/decisoes/0003-responder-sessao.md): antes de o Claude Code abrir um diálogo de permissão, pergunta ou plano, a sessão publica o pedido no núcleo e espera um pouco pela resposta do console. Sem resposta válida, segue o diálogo local.

| Pasta | O quê |
| --- | --- |
| [hooks](hooks/) | O plugin: `tool.check` (permissão), `tool.call` de `AskUserQuestion` (pergunta), `classic.PermissionRequest` de `ExitPlanMode` (plano). O contrato puro está em `protocolo.ts` |
| [nucleo](nucleo/) | A API de pedidos do núcleo, com token da sessão e token do console |

## Testar

```bash
claude plugin test spikes/resposta-teste
```

```bash
node --test spikes/resposta-teste/nucleo/
```

## Rodar numa sessão

Só para experimentar, sem instalar no escopo do usuário:

```bash
TOKEN_SESSAO=$(openssl rand -hex 32) TOKEN_CONSOLE=$(openssl rand -hex 32) node spikes/resposta-teste/nucleo/pedidos.mjs
```

```bash
claude --plugin-dir spikes/resposta-teste
```

Na sessão, ponha o `TOKEN_SESSAO` no campo `token` do plugin e um valor em `esperaMs` (em `/config`). Com `esperaMs` em `0`, o padrão, nada é consultado. O console responde com o `TOKEN_CONSOLE`:

```bash
curl -s -X POST http://127.0.0.1:4721/api/pedidos/<id>/resposta -H "authorization: Bearer $TOKEN_CONSOLE" -d '{"decisao":"permitir","quem":"ana","canal":"painel"}'
```
