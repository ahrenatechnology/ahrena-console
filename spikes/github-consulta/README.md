# github-consulta

Spike #40: quanto custa cada formato de consulta ao GitHub e uma prova mínima do cache. A decisão está em [docs/decisoes/0001-github-consulta-cache.md](../../docs/decisoes/0001-github-consulta-cache.md).

| Arquivo | O quê |
| --- | --- |
| `medir.mjs` | Mede custo (`rateLimit { cost }`), tempo e tamanho de cada formato, e ETag no REST. Cerca de 23 chamadas, em série, com 3 s de pausa |
| `medicoes.json` | Resultado da medição de 18/10/2026 |
| `cache.mjs` | Cache com TTL, leitura velha quando o GitHub falha, uma chamada por chave, pausa no limite e ETag, sobre uma porta de armazenamento |
| `arvore.mjs` | Árvore a partir de nós rasos (chave do pai), filhas ao expandir e mescla de delta |

```bash
cd spikes/github-consulta && node --test
```

```bash
cd spikes/github-consulta && node medir.mjs > medicoes.json
```
