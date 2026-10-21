# Mandar mensagem a uma sessão

Issue [#61](https://github.com/ahrenatechnology/ahrena-console/issues/61), primeira fatia. Wireframes C51 a C53 (`console-session-message`, `console-session-message-states`, `console-session-message-unavailable`).

No Detalhe de uma sessão, na aba Conversa, a caixa de mensagem manda um texto que você escreveu para a sessão do Claude Code que está aberta **nesta máquina**: no Claude Desktop, num terminal ou num `claude -p`. Não precisa do mod nem do terminal.

## Onde fica na tela

- **Detalhe, aba Conversa:** a caixa fica no pé da conversa. A linha "Para" diz a sessão, onde ela está aberta (Claude Desktop, terminal…), a conta da pasta de configuração e se o Remote Control está ligado. O contador mostra o tamanho em bytes, até 16 KiB. Enviar com o botão ou com ⌘↵ (Ctrl↵ fora do Mac).
- **Dashboard e Sessões:** os itens de "Precisam de você" e as linhas de Sessões com processo vivo ganham **Mandar mensagem**, que abre o Detalhe na Conversa com a caixa em foco. Sem processo vivo, a linha diz "sem processo vivo". Para não sobrecarregar o núcleo, as listas só perguntam pelas sessões que estão na tela e que podem ter processo (uma sessão concluída não pergunta), quatro de cada vez, e guardam a resposta por 15 s.
- Em Sessões, até 1240 px de janela a coluna Mensagem ocupa o lugar do Diretório e da seta; abaixo de 900 px fica só o ícone.

## Como chega

A mensagem entra pela caixa de entrada da mensageria entre sessões do Claude Code. Toda sessão com processo vivo anuncia um socket em `$CLAUDE_CONFIG_DIR/sessions/<pid>.json`; o núcleo escreve nele uma linha com o texto.

- Ao lado do destino, a tela mostra onde a sessão está aberta (Claude Desktop, terminal…), a conta da pasta de configuração em que o processo vivo foi achado e se o Remote Control está ligado.
- Sessão ociosa: a mensagem vira um turno novo. Ocupada: o Claude lê entre uma ferramenta e outra.
- Ela chega marcada como **mensagem de outra sessão**. Não aprova permissão, não roda comando e não muda configuração. `/compact` e `/clear` mandados como mensagem chegam como texto: os botões desses comandos dependem do mod e ficam desligados.
- Com uma permissão pendente, a caixa continua ligada, mas a mensagem não responde à permissão: permitir ou negar continua no Claude Desktop ou no terminal.

## Os estados

| Na tela | O que quer dizer |
| --- | --- |
| Enviando… | O núcleo entregou no socket e espera a sessão começar o turno da mensagem |
| Entregue às HH:MM | O transcript da sessão mostra, depois do envio, o turno que veio do núcleo com exatamente este texto |
| Enviada, sem confirmação | Em 60 s a sessão não começou o turno. Ela pode estar segurando a mensagem pela política `crossSessionInbound`. O console **não reenvia** |
| Não entregue | Nada chegou: sem processo vivo, mais de um processo, socket que sumiu ou recusou a conexão |

O socket não responde nada, nem para uma linha inválida. Por isso "Entregue" só aparece quando a própria sessão mostra o turno novo.

## Quando a caixa fica desligada

- **Sem processo vivo:** a sessão não está aberta nesta máquina. Abra no Claude Desktop; quando o processo voltar, a caixa liga sozinha.
- **Em outra máquina:** a entrega pelo núcleo da Workstation vem no [#282](https://github.com/ahrenatechnology/ahrena-console/issues/282). O Remote Control não leva mensagem do console.
- **Mais de um processo** dizendo ser a mesma sessão: para não entregar no lugar errado, o console não manda.
- **Windows:** lá a caixa de entrada exige o token da sessão, e o núcleo nunca lê esse arquivo.

## Limites e segurança

- Só texto escrito por uma pessoa na `/ui`: de 1 byte a 16 KiB, uma mensagem por vez por sessão (a próxima espera a confirmação da anterior), no máximo 5 por minuto por sessão e 20 por minuto no total.
- Só local: o hub nunca chama a máquina, e não há ferramenta MCP que mande mensagem.
- O pedido é uma exceção de mesma origem da [decisão 0003](decisoes/0003-responder-sessao.md): só da própria `/ui`, nunca de outra página nem de um script sem `Origin`.
- O núcleo nunca abre o arquivo `<pid>.<hash>.key` ao lado do `sessions/<pid>.json`: no macOS e no Linux o token é opcional e o socket já é restrito ao seu usuário. Ele só entrega num socket do próprio usuário, de um processo vivo, que não seja link simbólico.
- **O texto nunca vai para log, mensagem de erro, auditoria nem banco.** A auditoria fica em `<pasta de dados>/messaging-audit.jsonl` (permissão `0600`), uma linha por mensagem: hora, sessão, id da mensagem, mecanismo `inbox`, resultado e motivo, e o SHA-256 do texto.
- O estado de uma mensagem fica na memória do núcleo: se ele reiniciar, a tela perde o estado das mensagens em andamento.

## Para quem integra

As rotas e o contrato estão em [packages/nucleo/README.md](../packages/nucleo/README.md#mandar-mensagem-a-uma-sessão-61). O formato da linha do socket não é documentado pelo Claude Code: o teste de contrato `packages/nucleo/test/messaging/contract-cli.test.ts` roda contra o `claude` instalado com `AHRENA_CONSOLE_CONTRACT_CLI=1`, numa pasta de configuração temporária e com uma API falsa.
