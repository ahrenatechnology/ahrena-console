# adr-extractor

Spike #174: lê uma pasta de registros de decisão (ADRs) em Markdown e devolve, de cada um, número, título, status, data, decisores, contexto, decisão (com a opção escolhida), alternativas, consequências, as outras seções e as ligações (substitui, é substituída por, emenda, relacionadas), com a volta criada quando só um lado escreve. O estudo está em [docs/adr-viewer-study.md](../../docs/adr-viewer-study.md).

| Arquivo | O quê |
| --- | --- |
| `extract.mjs` | O extrator, sem dependências. Também roda como CLI e imprime uma linha por ADR |
| `extract.test.mjs` | Testes contra `docs/decisoes` deste repositório e as amostras |
| `fixtures/` | Amostras sintéticas de MADR 4, MADR 3, Nygard (adr-tools), Y-statement e livre em pt-BR |

```bash
node --test spikes/adr-extractor/
```

```bash
node spikes/adr-extractor/extract.mjs docs/decisoes
```
