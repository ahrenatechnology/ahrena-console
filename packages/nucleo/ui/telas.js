// O registro das telas: a rota, o item da barra e o arquivo de cada uma (veja o README.md).
//
// - `rota`: o caminho no navegador; `:id` casa um segmento.
// - `item`: o item na barra lateral. Sem `item`, a tela não aparece na barra e `acende` diz qual item
//   fica aceso quando ela está aberta (o Detalhe acende Sessões, como no A5).
// - `arquivo`: o módulo da tela em `ui/telas/`. Sem ele, a moldura mostra o cabeçalho e o estado vazio.
// - `titulo`, `sub` e `icone`: o cabeçalho do estado vazio e o título da janela.

export const TELAS = [
  {
    id: 'dashboard',
    rota: '/ui',
    item: { rotulo: 'Dashboard', icone: 'dashboard' },
    titulo: 'Dashboard',
    sub: 'O agora das suas sessões',
    icone: 'dashboard',
    arquivo: '/ui/telas/dashboard.js',
  },
  {
    id: 'mural',
    rota: '/ui/mural',
    item: { rotulo: 'Mural ao vivo', icone: 'mural' },
    titulo: 'Mural ao vivo',
    sub: 'Um card por sessão aberta nesta máquina',
    icone: 'mural',
    arquivo: '/ui/telas/mural.js', // #34
  },
  {
    id: 'sessoes',
    rota: '/ui/sessoes',
    item: { rotulo: 'Sessões', icone: 'sessoes' },
    titulo: 'Sessões',
    sub: 'As sessões registradas nesta máquina',
    icone: 'sessoes',
    arquivo: null, // #28
  },
  {
    id: 'detalhe',
    rota: '/ui/sessoes/:id',
    acende: 'sessoes',
    titulo: 'Sessão',
    sub: null,
    icone: 'sessoes',
    arquivo: null, // #29 e #30
  },
];

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A tela e os parâmetros de um caminho, ou `null` se nenhuma casa. */
export function acharTela(caminho, telas = TELAS) {
  const partes = caminho.replace(/\/+$/, '').split('/');
  for (const tela of telas) {
    const molde = tela.rota.split('/');
    if (molde.length !== partes.length) continue;
    const params = {};
    let casa = true;
    for (let i = 0; i < molde.length && casa; i++) {
      if (molde[i].startsWith(':')) {
        let valor = '';
        try {
          valor = decodeURIComponent(partes[i]);
        } catch {}
        if (ID.test(valor)) params[molde[i].slice(1)] = valor;
        else casa = false;
      } else casa = molde[i] === partes[i];
    }
    if (casa) return { tela, params };
  }
  return null;
}
