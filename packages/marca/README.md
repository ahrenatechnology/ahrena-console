# Marca

Os tokens da marca (cores, temas, status e tipografia) para o painel e o artefato. Item 8.2 do [backlog](../../docs/backlog-0.0.1.md).

A fonte é uma só: [docs/brand/tokens.json](../../docs/brand/tokens.json). O gerador lê esse arquivo e escreve as saídas abaixo, que vão para o repositório. Ninguém edita as saídas à mão.

| Saída | Para quem | Como usa |
| --- | --- | --- |
| [gerado/marca.ts](gerado/marca.ts) | o painel (mod do Claude Code) e o núcleo | cores como strings hex: `paleta`, `ci`, `temas`, `ordemStatus`, `status`, `tipografia` |
| [gerado/marca.css](gerado/marca.css) | o artefato HTML | variáveis CSS: escuro no `:root`, claro por `prefers-color-scheme` ou `data-theme="light"` |
| [spikes/painel-teste/hooks/marca.ts](../../spikes/painel-teste/hooks/marca.ts) | o painel de teste | cópia do `marca.ts`, porque um módulo de hooks só importa arquivos de dentro do próprio plugin |

Ficam de fora o roxo e o rosa antigo, que o `tokens.json` guarda só como histórico. As notas (`_nota`) e os motivos dos status também não entram.

## Por que a fonte fica em docs/brand

O `tokens.json` já é a referência do [design](../../docs/design.md), da [amostra](../../docs/brand/amostra.html) e do teste de contraste. Mantê-lo onde está deixa um só lugar para mudar uma cor, sem mexer nos links e sem um segundo arquivo para manter em dia. O pacote só gera.

## Mudar uma cor

1. Edite `docs/brand/tokens.json` (e a amostra, se a cor aparece nela).
2. Gere de novo:

   ```bash
   node packages/marca/src/gerar.ts
   ```

3. Rode o teste e faça commit da fonte e das saídas juntas.

## Teste

```bash
node --test packages/marca/test/
```

Falha quando uma saída não bate com o `tokens.json` (alguém editou um sem gerar de novo), quando as cópias do `marca.ts` diferem, quando o CSS não traz os dois temas e quando o painel de teste fixa à mão uma cor que já está na marca. Roda junto a validação de [test/tokens.test.mjs](../../test/tokens.test.mjs): o laranja `#f47720`, contraste AA nos dois temas e os 5 status.

## No artefato

```html
<link rel="stylesheet" href="marca.css">
<style>
  body { background: var(--bg); color: var(--text); font-family: var(--font-sans); }
  .ativa { color: var(--status-active-text); background: var(--status-active-badge); }
</style>
```

Num artefato de arquivo único, cole o conteúdo do `marca.css` dentro do `<style>`.
