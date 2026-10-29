# 0015 · Ditado por voz: o navegador grava, o núcleo transcreve com um whisper.cpp local e nada sai da máquina

- **Status:** proposta (aprovada nos wireframes dos cinco estados; falta a confirmação desta decisão)
- **Data:** 2026-10-29
- **Issue:** [#352](https://github.com/ahrenatechnology/ahrena-console/issues/352)
- **Estende:** [0003](0003-responder-sessao.md) (mais uma escrita de mesma origem da `/ui`) e [0012](0012-remote-reconnect.md) (o núcleo roda um processo a pedido da `/ui`: lista de argumentos, sem shell, um por vez)
- **Toca:** [0009](0009-english-internals.md) (nomes em inglês, texto da tela em pt-BR)

## Contexto

A caixa de mensagem da sessão (`createComposeBox`) só aceita texto digitado. Quem trabalha com o Claude Code costuma ditar mais rápido do que digita. O ditado do navegador (Web Speech API do Chrome) manda o áudio para um serviço do Google: fora de questão. O console roda em 127.0.0.1, então o `getUserMedia` funciona, e a Workstation tem uma GPU (Tesla T4).

## Decisão

1. **O navegador grava, o núcleo transcreve.** A `/ui` pede o microfone (`getUserMedia`), grava na memória, reamostra para 16 kHz mono e codifica um WAV PCM16 em JavaScript (sem ffmpeg). O áudio nunca vai para URL, log, `localStorage` ou DOM.
2. **Motor: whisper.cpp com o modelo ggml `large-v3-turbo`**, no `whisper-server`, falando só em 127.0.0.1.
3. **O núcleo sobe o `whisper-server` sob demanda**, na primeira transcrição, numa porta livre de loopback; derruba depois de 10 minutos parado e ao encerrar. Alternativa: `AHRENA_CONSOLE_WHISPER_URL` aponta para um que já roda (só loopback, http). Binário e modelo vêm de `AHRENA_CONSOLE_WHISPER_BIN` e `AHRENA_CONSOLE_WHISPER_MODEL`, com padrão em `~/.ahrena-console/voice/` (por usuário, compartilhado entre as instalações).
4. **Rotas.** `GET /api/transcription` → `{ version, available, reason, model }`. `POST /api/transcription` (`audio/wav`, até 10 MiB, o que cobre 5 minutos) → `{ text, durationMs }`. Uma transcrição por vez (409). Erros: 403 sem Origin, 415, 503 sem instalação, 413, 400 para WAV que não é 16 kHz mono 16 bits, 502 se o servidor falha.
5. **Escrita de mesma origem (0003).** Só `POST`, caminho exato, `Origin` igual a `http://<Host>`; sem `Origin` é 403 `ui_only`. O áudio e o texto não são guardados nem logados.
6. **Gravador com `ScriptProcessorNode`** (mudo, ligado a um `GainNode` de ganho zero) mais um `AnalyserNode` para o nível. Funciona em todo navegador e dispensa um segundo arquivo servido (o `AudioWorklet` pediria). Está marcado como obsoleto, mas o Chrome e o Safari o mantêm; se um dia sair, troca-se só `startRecording`.
7. **Atalho: Ctrl+Espaço** (começa, e para e transcreve enquanto grava). ⌘+Espaço é do Spotlight. Esc cancela. Aos 5 minutos a gravação para sozinha. O texto entra onde está o cursor e nunca é enviado sozinho.
8. **`npm run core -- voice install`** compila o whisper.cpp de uma tag fixa (`v1.9.5`) com CUDA quando há GPU NVIDIA e `nvcc`, ou na CPU (mais lento, com aviso), e baixa o modelo do repositório do whisper.cpp no Hugging Face. Exige `git` e `cmake`.

## Alternativas rejeitadas

- **Web Speech API do Chrome:** o áudio vai para a nuvem do Google.
- **Transcrever no navegador (whisper em WASM/WebGPU):** o modelo large-v3-turbo não cabe bem e ignora a GPU da Workstation.
- **Um `whisper-server` sempre ligado:** ocupa ~2 GB de VRAM o dia todo para uma função usada de vez em quando.
- **ffmpeg no núcleo:** mais uma dependência; o WAV de 16 kHz sai pronto do navegador.

## Consequências

- Sem o whisper instalado a caixa continua igual, com o microfone apagado e o motivo na linha de estado. Um núcleo antigo (sem a rota) não mostra linha nenhuma.
- A primeira transcrição depois de um tempo parada paga a carga do modelo.
- O `voice install` baixa e compila código de fora: a tag é fixa e a revisão dela é de quem sobe a versão.
