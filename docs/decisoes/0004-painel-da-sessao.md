# 0004 · O painel olha a sessão; o projeto fica no artefato

- **Status:** aceita
- **Data:** 2026-10-18
- **Épico:** [#5](https://github.com/ahrenatechnology/ahrena-console/issues/5) (painel lateral), com efeito em [#4](https://github.com/ahrenatechnology/ahrena-console/issues/4) (artefato) e [#7](https://github.com/ahrenatechnology/ahrena-console/issues/7) (distribuição)
- **Muda:** 4.1, 4.2 e 4.3 ([#35](https://github.com/ahrenatechnology/ahrena-console/issues/35), [#36](https://github.com/ahrenatechnology/ahrena-console/issues/36), [#37](https://github.com/ahrenatechnology/ahrena-console/issues/37)); cria 3.10 ([#80](https://github.com/ahrenatechnology/ahrena-console/issues/80)), 4.6 ([#81](https://github.com/ahrenatechnology/ahrena-console/issues/81)) e 6.5 ([#82](https://github.com/ahrenatechnology/ahrena-console/issues/82))

## Contexto

O painel lateral é um mod do Claude Code: roda dentro de cada sessão e sabe qual sessão é. Até aqui ele mostrava a frota e o projeto inteiros (visão geral, kanban, trabalho do GitHub), copiando o dashboard do Claude Code Agent Monitor.

Dois fatos pesaram contra isso:

- **Ao lado da conversa, a pergunta é sobre a sessão.** Quem olha o painel quer saber o que esta sessão está fazendo, o que roda dentro dela e o que ela espera de você. O projeto inteiro se olha com calma, numa página própria.
- **Consumo.** Em 2026-10-18, com 22 sessões abertas, o painel de teste consultava a frota a cada 5 s em todas elas, mesmo fechado, porque o polling começa no `session.start`. Uma cópia do núcleo de teste sob essa carga gastou **cerca de 36% de um núcleo de CPU** (264 pedidos por minuto, p50 de 111 ms, 96 MB), porque cada pedido varre de novo os transcripts de `~/.claude/projects` (1.889 arquivos).

## Decisão

**O painel olha a sessão em que está aberto. O projeto, a frota e o time ficam no artefato.**

No painel:

- **Esta sessão:** estado com motivo e tempo, modelo, contexto, custo e processos em background (4.1).
- **O que roda dentro dela:** subagentes, plano (feitos/total) e as sessões que ela abriu, como filhas (4.2).
- **O trabalho dela:** a issue e o PR que ela toca, achados pelo branch, com sub-issues, CI e review (4.3).
- **De fora, uma linha só:** "N precisam de você", com clique para chegar até elas. Começa pelas sessões da mesma família (abertas por esta ou que a abriram); a máquina inteira fica como opção.

No artefato, o que é do projeto: dashboard, sessões, kanban de sessões e o **kanban do projeto** (3.10), que reaproveita o núcleo da [#42](https://github.com/ahrenatechnology/ahrena-console/issues/42).

Rascunho do painel estreito (38 colunas):

```
● Ativa · 12 min · Opus 5.5
contexto 62k/200k ▓▓▓░░░░ 31%
custo ~US$ 1,84 (estimativa)
plano 3/5 · "Rodar testes"
─ subagentes ─
  ◐ Explore · 40 s
  ✓ Plan · 2 min
─ trabalho ─
  #42 Kanban · PR #78 · CI ✓
─────────────
⚠ 2 sessões precisam de você
```

## Consumo (4.6)

- O polling começa quando o painel abre e para quando ele fecha. Sessão sem painel aberto não consulta nada. **Emenda de 22/10/2026 (#61, mod 0.0.36; aprovada pelo Fernando com duas condições):** uma exceção, as ordens do console (`/compact`, `/clear`, Remote Control). Sem painel aberto, o mod faz um `GET /api/sessions/<id>/commands` a cada 4 s, só da própria sessão; com o núcleo fora do ar o intervalo cresce até 1 minuto e volta ao normal na primeira resposta. **Por quê:** nenhum processo de fora roda um comando de barra numa sessão, então a ordem só chega se o mod, dentro da sessão, a buscar; e uma sessão sem painel aberto também precisa receber `/compact`. **Condições, ambas atendidas no #307:** (a) a rota responde só da memória, sem ler transcript, banco, `~/.claude` nem a lista de processos vivos, e um teste prova (`test/messaging/orders.test.ts`, com leitores que falham o teste se chamados); (b) o script de carga versionado (`scripts/medir-carga.mjs --ordens 20`) mede o núcleo abaixo de 1% de um núcleo de CPU com 20 sessões buscando a cada 4 s. **Medição (22/10/2026, 90 s, núcleo isolado com um `HOME` vazio, 20 sessões, 1 painel aberto):** 0,26% sem ordens e **0,40% com as 20 sessões buscando ordens** (309 pedidos/min, p50 2 ms, p95 6 ms, 0 erros). Numa máquina com sessões reais escrevendo transcripts o núcleo gasta cerca de 14% mesmo sem ordens (importação e seguidor), então o custo das ordens só aparece isolado: +0,14 ponto percentual.
- O painel pede só a própria sessão e a contagem de quem precisa de você, nunca a frota.
- O núcleo responde do banco, alimentado pelos hooks (1.4) e pelo seguidor de transcripts (1.3), sem varrer `~/.claude/projects` a cada pedido.
- Meta: com 20 sessões abertas e um painel aberto, o núcleo abaixo de 1% de um núcleo de CPU, medido por um script de carga versionado.

## App desktop fora do Claude (6.5)

Fica como spike. A referência principal é o app desktop do Claude Code Agent Monitor (Electron, com servidor embutido e menu na bandeja). A preferência do dono é **Tauri** (Rust e o WebView do sistema), mais leve que o Electron. O app teria que aproveitar o que já está instalado (CLI `claude`, login, servidores MCP, plugins, hooks e o núcleo local), sem duplicar a integração com o Claude.

## Consequências

- O kanban do projeto sai do painel. Enquanto a 3.10 não chega, ele continua no painel de teste.
- O painel deixa de ser um mini-dashboard e fica pequeno: menos dados por pedido, menos telas para manter em 38 colunas.
- A visão do time inteiro depende do artefato e, na nuvem, do hub (épico 7).
