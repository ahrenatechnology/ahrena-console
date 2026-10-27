# LinkedIn

Peças da Ahrena para o LinkedIn, feitas a partir do logo em [`../logo-preto.svg`](../logo-preto.svg).

| Arquivo | Uso |
| --- | --- |
| `profile-black.png` / `.svg` | Foto de perfil, 800×800. Fundo preto, "A" laranja, triângulo rosa. É a versão do logo para telas claras e a recomendada. Tem margem para o recorte redondo. |
| `profile-orange.png` / `.svg` | Foto de perfil alternativa: fundo laranja e "A" preto. |
| `logo-black.png` / `logo-orange.png` | O logo com o quadrado arredondado, 800×800, para usar fora do perfil. |
| `banner.png` | Banner do perfil, 1584×396. |
| `banner.html` | A fonte do banner. |

## Banner

- **Linha de cima:** "Open-source agent squad platform", com o triângulo rosa na frente e o logo do GitHub no fim.
- **Título:** "One builder. A whole squad of agents."
- **Subtítulo:** "Turn ideas into real apps with your own AI team."
- **À direita:** o "A" à frente de uma squad de triângulos e um selo "Coming soon" com Ahrena Framework, Ahrena Agents e Ahrena Console.

O lado esquerdo fica vazio de propósito, porque a foto de perfil cobre esse canto. Para deslocar todo o conteúdo, mude o `translate` do grupo `#content` no `banner.html`.

Para gerar o PNG de novo:

```bash
"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1584,396 --virtual-time-budget=8000 --screenshot="$PWD/banner.png" "file://$PWD/banner.html"
```

Rode de dentro de `docs/brand/linkedin/`. As fontes (Poppins e JetBrains Mono) vêm do Google Fonts, então é preciso estar com internet.

As fotos de perfil foram geradas a partir dos SVGs com `qlmanage -t -s 800`.
