# Várias contas do Claude (spike #106)

Prova mínima da [decisão 0006](../../docs/decisoes/0006-multiplas-contas.md): duas pastas de configuração do Claude Code (`CLAUDE_CONFIG_DIR`) rodando ao mesmo tempo, cada uma com a sua conta, e o que um hook enxerga de cada uma. Código descartável.

## O que tem aqui

| Arquivo | O quê |
| --- | --- |
| [prova.sh](prova.sh) | Cria uma pasta temporária com `HOME` falso e duas pastas de configuração (`a` e `b`), sobe a API falsa e roda `claude -p` nas duas ao mesmo tempo, cada uma com uma conta e uma org sintéticas |
| [api-falsa.mjs](api-falsa.mjs) | Servidor em `127.0.0.1` que responde `/v1/messages` em streaming com "ok". Faz o CLI rodar sem login e sem chamar a Anthropic |
| [hook.sh](hook.sh) | Hook de `SessionStart` e `Stop` que grava o payload e as variáveis de conta do ambiente na pasta de configuração |
| [medir.py](medir.py) | Mede, só leitura e só com contagens, o índice de sessões do Claude Desktop e os transcripts. Não imprime UUID, e-mail, nome nem caminho |

## Rodar

```bash
sh spikes/multiplas-contas/prova.sh
```

```bash
python3 -I spikes/multiplas-contas/medir.py
```

A prova não toca no login, no Keychain nem no `~/.claude` de quem roda: o `HOME` é falso, a chave de API é falsa e a API é local. As contas são UUIDs sintéticos (`00000000-0000-4000-8000-00000000000a` e `…0b`).

## O que ela mostra

Saída da prova (Claude Code 2.1.302, macOS 26.7), resumida:

```
== arquivos (HOME falso deve ficar vazio)
a/.claude.json
a/projects/<projeto>/<sessão a>.jsonl
a/settings.json
b/.claude.json
b/projects/<projeto>/<sessão b>.jsonl
b/settings.json
== hooks da pasta a
evento: SessionStart
transcript_path sob: a/projects
CLAUDE_CODE_ACCOUNT_UUID=00000000-0000-4000-8000-00000000000a
CLAUDE_CODE_ORGANIZATION_UUID=00000000-0000-4000-8000-0000000000a1
CLAUDE_CONFIG_DIR=a
evento: Stop
…
== hooks da pasta b
evento: SessionStart
transcript_path sob: b/projects
CLAUDE_CODE_ACCOUNT_UUID=00000000-0000-4000-8000-00000000000b
CLAUDE_CODE_ORGANIZATION_UUID=00000000-0000-4000-8000-0000000000b1
CLAUDE_CONFIG_DIR=b
…
```

- As duas sessões rodam juntas, cada uma com `.claude.json`, `settings.json`, hooks e transcripts na própria pasta. Nada vai para o `HOME`.
- O hook herda do CLI `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_ACCOUNT_UUID` e `CLAUDE_CODE_ORGANIZATION_UUID`, e o `transcript_path` aponta para dentro da pasta de configuração.
- O payload do hook não tem campo de conta.

O que ela **não** mostra: o login OAuth de verdade em cada pasta (o Keychain separa por pasta, ver a decisão), o Claude Code num container e as sessões por SSH.
