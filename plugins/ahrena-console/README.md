# Ahrena Console: painel lateral

Plugin do Claude Code com o painel da sessão (`/console`), construído sobre os [wireframes aprovados](../../docs/wireframes/) (P0 a P10) e as decisões [0004](../../docs/decisoes/0004-painel-da-sessao.md) e [0006](../../docs/decisoes/0006-multiplas-contas.md). Cobre as issues #35 (4.1), #36 (4.2), #37 (4.3), #116 (4.8) e #102 (decisões).

O painel olha a sessão em que está aberto:

- **Esta sessão:** status com motivo e tempo, modelo, turno, o que ela faz agora e, quando ela espera por você, a faixa com a pergunta, a permissão ou o erro inteiros (P1 a P6);
- **Contexto e custo:** contexto usado, custo estimado com a curva da sessão, tokens e processos em background;
- **Trabalho:** a issue e o PR achados pelo branch, com sub-issues, CI e review;
- **Plano, subagentes e sessões filhas:** o que roda dentro dela (P4);
- **Decisões, uma linha:** "N decisões vigentes", com quantas estão a confirmar; "Ver" abre os cards de cada decisão (origem, há quanto tempo, o que se decidiu, o que foi descartado, o estado e quem decidiu), com o escopo trocado entre Sessão, Família e Branch. A sugerida tem Confirmar e Descartar; a substituída aparece riscada e aponta a nova (P9). Depois de um `/clear`, uma faixa diz quantas decisões da sessão anterior continuam valendo (P10);
- **De fora, uma linha:** "N precisam de você", somando todas as contas, com a divisão por conta ao passar o mouse; "Ver" abre a lista, só a família ou a máquina inteira (P7);
- **Sem o núcleo:** a última leitura, o aviso e uma nova tentativa a cada 5 s (P8).

A conta da sessão aparece ao lado de "ESTA SESSÃO", com o rótulo e a cor que você der a ela.

## Instalar

O plugin é por pasta de configuração (decisão 0006): instale em cada `CLAUDE_CONFIG_DIR` que usar.

```
/plugin install ahrena-console --marketplace ahrenatechnology/ahrena-console
```

Pelo terminal, o mesmo em dois passos (para testar um branch, acrescente `@<branch>` ao repositório):

```bash
claude plugin marketplace add ahrenatechnology/ahrena-console
```

```bash
claude plugin install ahrena-console@ahrena-console
```

O painel de teste (`ahrena-console-painel`, em `spikes/`) também registra `/console`. Desligue-o antes, para os dois não disputarem o comando:

```bash
claude plugin disable ahrena-console-painel@ahrena-console-testes
```

Além do painel, o plugin leva os hooks que mandam os eventos da sessão ao núcleo ([forward.mjs](hooks/forward.mjs), o mesmo de `packages/nucleo/src/ingest/hooks/plugin`). Sem o núcleo no ar, eles não atrapalham nada: desistem em 800 ms e registram a falha em `~/.ahrena-console/hooks.log`.

## Subir o núcleo

O painel lê a API local do núcleo em `127.0.0.1:4720`. Com Node 24 ou mais novo:

```bash
cd packages/nucleo && npm run api
```

Ela importa o histórico de `~/.claude/projects`, segue os transcripts, recebe os hooks, roda a máquina de estados e responde ao painel. O banco fica em `~/.ahrena-console/nucleo.sqlite`. O GitHub usa o token do `gh`. `npm run api -- --help` lista as opções (outra porta, sem GitHub, sem histórico).

Para ver o painel com dados de exemplo, sem tocar em nada real, a demonstração serve um dos cenários dos wireframes a qualquer sessão que abrir o painel:

```bash
cd packages/nucleo && npm run api -- --demo --cenario p4
```

Os cenários vão de `p1` a `p7` (P8 é o núcleo desligado), mais o `p9`, com as decisões da sessão e da sessão mãe. São do simulador: projetos sob `/simulacao`, repositório `exemplo/simulacao`, contas `equipe` e `cliente-exemplo`.

### Porta

Outra porta: `npm run api -- --porta 4730` e, no plugin, a opção `porta` (no `/config`, ou em `pluginConfigs` do `settings.json`).

### Rótulo e cor das contas

O rótulo e a cor são os da conta no núcleo (`ClaudeAccount.label` e `color`). Sem eles, valem os de `~/.ahrena-console/contas.json`, com a chave `<accountUuid>/<organizationUuid>` e a cor em hex; sem nada, "conta 1", "conta 2", com as cores da marca:

```json
{ "<accountUuid>/<organizationUuid>": { "rotulo": "cliente", "cor": "#1baf7a" } }
```

O painel nunca mostra o id. Vale a fonte de menor ordem da decisão 0006 entre a conta gravada na sessão, o ambiente da própria sessão (`CLAUDE_CODE_ACCOUNT_UUID` e `CLAUDE_CODE_ORGANIZATION_UUID`, que o painel lê e manda) e o índice do Claude Desktop, quando a sessão está numa pasta conta/org só. Sem fonte, a sessão fica em "sem conta", nunca na conta de outra.

## Consumo

Regra da issue #81 e da decisão 0004:

- o painel só consulta com ele aberto e à vista; fechado, atrás de outra aba ou com a sessão encerrada, não pede nada;
- a cada 5 s, um pedido só: `GET /api/painel/<esta sessão>`. Nunca a frota. Com as decisões abertas, o mesmo pedido leva `decisoes=<escopo>` e traz a lista; Confirmar e Descartar são um `POST /api/decisoes/<id>/confirmar` (ou `/descartar`) cada, só no clique;
- o núcleo responde do banco e de caches em memória: lê só os eventos novos da sessão, recalcula o custo no máximo a cada 30 s, conta "precisam de você" por índice uma vez a cada 4 s para todos os painéis, confere o índice do Desktop a cada 30 s e nunca espera o GitHub no caminho do pedido.

Os números medidos estão no PR que trouxe o painel e saem de `node scripts/medir-carga.mjs --rota painel`.

## Onde difere dos wireframes

O que os elementos nativos do mod, ou o que ainda não existe, não deixam ficar igual:

| No wireframe | No painel | Por quê |
| --- | --- | --- |
| Faixa "N decisões da sessão anterior" (P10) | Só aparece quando o núcleo manda | A reinjeição depois do `/clear` é da #100; a faixa acende com ela, e "desligar a injeção" ainda não age |
| "ver na conversa" | Rola a conversa até a chamada que originou a decisão; de outra sessão, diz onde ela está | O mod não abre outra sessão no Claude Desktop |
| `CI ✓ 6/6`, `CI … 3/7` | `CI ✓`, `CI … rodando`, `CI ✕ falhou` | O núcleo lê o estado agregado das checagens (decisão 0001), não a contagem |
| "Ir para a sessão" abre a outra sessão | Copia o nome e diz que ela está na barra lateral | O mod não troca de sessão no Claude Desktop |
| "ver a árvore no artefato ›" | Não aparece | O artefato com a árvore (épico #4) ainda não tem link estável |
| Conta da sessão | "◆ rótulo" ao lado de "ESTA SESSÃO" | Os wireframes são de antes da decisão 0006 |
| Cores do tema claro | Paleta do tema escuro | O mod não sabe o tema do app; os tokens são de `packages/marca` |

## Testes

```bash
claude plugin test plugins/ahrena-console
```

Os cenários dos testes (`tests/cenarios.ts`) são a resposta da API para cada cenário do simulador; para regravar depois de mudar a API:

```bash
cd packages/nucleo && node test/api/gravar-cenarios.ts > ../../plugins/ahrena-console/tests/cenarios.ts
```

## Arquivos

| Arquivo | O quê |
| --- | --- |
| [hooks/register.tsx](hooks/register.tsx) | `/console`, o polling com o painel aberto, a leitura do ambiente e as ações |
| [hooks/desenho.tsx](hooks/desenho.tsx) | As telas P1 a P10 com os elementos nativos do mod |
| [hooks/formato.ts](hooks/formato.ts) | Tempo, modelo, tokens, custo, status e motivos |
| [hooks/marca.ts](hooks/marca.ts) | Cores da marca, gerado por `packages/marca` |
| [hooks/forward.mjs](hooks/forward.mjs) | O encaminhador dos hooks para o núcleo |
| [types/index.d.ts](types/index.d.ts) | O contrato da API e o estado do painel |
