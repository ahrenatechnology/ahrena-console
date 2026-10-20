// Esqueleto: a tela chega nos próximos commits.
import { cabecalho } from '../dom.js';
import { carregando } from '../estados.js';

export function montar(area) {
  area.replaceChildren(cabecalho({ icone: 'repos', titulo: 'Repositórios' }), carregando());
}
