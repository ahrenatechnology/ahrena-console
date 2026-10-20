// GitHub falso do kanban do projeto (#80, wireframe C11): o Project "Ahrena Console" com as raias
// Backlog, Ready, In Progress, In Review e Done e os 11 cards do wireframe. Mover muda o Status
// em memória, como a mutação do GitHub faria. Só dados sintéticos: o repositório é o do simulador.

import type { ProjectBoardValue, ProjectCard, ProjectRef, ProjectSource } from '../github/project.ts';
import { workKey, type CiState, type ReviewDecision } from '../github/work.ts';
import { REPO_DO_SIMULADOR } from './painel.ts';

/** O Project da demonstração: dono e número que a API mostra. */
export const PROJECT_DO_SIMULADOR: Required<ProjectRef> = { owner: 'exemplo', number: 3, field: 'Status' };

/** As raias do C11, com ids no formato das opções do GitHub. */
export const RAIAS_DO_SIMULADOR = [
  { id: 'b0a1c2d3', name: 'Backlog', color: 'GRAY' },
  { id: 'e4f5a6b7', name: 'Ready', color: 'BLUE' },
  { id: '47fc9ee4', name: 'In Progress', color: 'YELLOW' },
  { id: 'c8d9e0f1', name: 'In Review', color: 'ORANGE' },
  { id: '98236657', name: 'Done', color: 'PURPLE' },
] as const;

const M1 = 'M1 · Local';
const M2 = 'M2 · Bandeja';

interface CardDoC11 {
  raia: (typeof RAIAS_DO_SIMULADOR)[number]['name'];
  tipo: 'Story' | 'Tech Task' | 'Spike' | 'Bug';
  numero: number;
  titulo: string;
  marco: string;
  sub?: [number, number];
  pr?: { numero: number; ci: CiState; review?: ReviewDecision; mergeado?: boolean };
}

const CARDS: CardDoC11[] = [
  { raia: 'Backlog', tipo: 'Tech Task', numero: 80, titulo: 'Kanban do projeto no artefato', marco: M1 },
  { raia: 'Backlog', tipo: 'Story', numero: 87, titulo: 'App na bandeja: N precisam de você', marco: M2 },
  { raia: 'Backlog', tipo: 'Tech Task', numero: 89, titulo: 'Abrir no login com SMAppService', marco: M2 },
  { raia: 'Ready', tipo: 'Story', numero: 35, titulo: 'Esta sessão: estado, contexto e custo', marco: M1 },
  { raia: 'Ready', tipo: 'Story', numero: 36, titulo: 'Subagentes, plano e sessões filhas', marco: M1 },
  { raia: 'In Progress', tipo: 'Story', numero: 42, titulo: 'Kanban de sessões', marco: M1, sub: [2, 4], pr: { numero: 78, ci: 'PENDING' } },
  { raia: 'In Progress', tipo: 'Tech Task', numero: 81, titulo: 'Consumo baixo do painel', marco: M1, sub: [1, 2], pr: { numero: 85, ci: 'SUCCESS' } },
  { raia: 'In Review', tipo: 'Tech Task', numero: 92, titulo: 'Wireframes do painel e da bandeja', marco: M2, pr: { numero: 93, ci: 'SUCCESS', review: 'REVIEW_REQUIRED' } },
  { raia: 'In Review', tipo: 'Bug', numero: 64, titulo: 'Paleta: cor de erro', marco: M1, pr: { numero: 69, ci: 'FAILURE', review: 'CHANGES_REQUESTED' } },
  { raia: 'Done', tipo: 'Spike', numero: 40, titulo: 'Spike: consulta ao GitHub', marco: M1, pr: { numero: 67, ci: 'SUCCESS', review: 'APPROVED', mergeado: true } },
  { raia: 'Done', tipo: 'Spike', numero: 82, titulo: 'Spike: app desktop', marco: M1, pr: { numero: 84, ci: 'SUCCESS', review: 'APPROVED', mergeado: true } },
];

const idDaRaia = (nome: string) => RAIAS_DO_SIMULADOR.find((r) => r.name === nome)!.id;

function card(c: CardDoC11, agora: number, i: number): ProjectCard {
  const url = `https://github.com/${REPO_DO_SIMULADOR}`;
  const feito = c.raia === 'Done';
  return {
    itemId: `PVTI_simulado${c.numero}`,
    kind: 'Issue',
    key: workKey(REPO_DO_SIMULADOR, c.numero),
    repo: REPO_DO_SIMULADOR,
    number: c.numero,
    title: c.titulo,
    url: `${url}/issues/${c.numero}`,
    state: feito ? 'CLOSED' : 'OPEN',
    updatedAt: new Date(agora - (i + 1) * 17 * 60_000).toISOString(),
    type: c.tipo,
    parent: null,
    statusId: idDaRaia(c.raia),
    milestone: c.marco,
    subIssues: c.sub ? { completed: c.sub[0], total: c.sub[1] } : null,
    pullRequest: c.pr
      ? { number: c.pr.numero, url: `${url}/pull/${c.pr.numero}`, state: c.pr.mergeado ? 'MERGED' : 'OPEN', isDraft: false, review: c.pr.review ?? null, ci: c.pr.ci, checks: null }
      : null,
  };
}

/** O Project do C11 em memória. Cada instância começa do wireframe; mover vale até o processo sair. */
export class ProjetoDoSimulador implements ProjectSource {
  private readonly itens: ProjectCard[];
  /** Leituras e mutações feitas (testes). */
  chamadas = { board: 0, move: 0 };

  constructor(agora = Date.now()) {
    this.itens = CARDS.map((c, i) => card(c, agora, i));
  }

  async board(_ref?: ProjectRef): Promise<ProjectBoardValue> {
    this.chamadas.board++;
    return {
      projectId: 'PVT_simulado',
      fieldId: 'PVTSSF_simulado',
      field: PROJECT_DO_SIMULADOR.field,
      title: 'Ahrena Console',
      url: `https://github.com/orgs/${PROJECT_DO_SIMULADOR.owner}/projects/${PROJECT_DO_SIMULADOR.number}`,
      options: RAIAS_DO_SIMULADOR.map((r) => ({ ...r })),
      items: this.itens.map((i) => ({ ...i })),
    };
  }

  async move({ itemId, optionId }: Parameters<ProjectSource['move']>[0]): Promise<{ itemId: string; statusId: string | null }> {
    this.chamadas.move++;
    const item = this.itens.find((i) => i.itemId === itemId);
    if (!item) throw new Error(`o GitHub não devolveu o item ${itemId}`);
    item.statusId = optionId;
    return { itemId, statusId: optionId };
  }
}
