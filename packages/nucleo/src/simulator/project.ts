// Fake GitHub for the project kanban (#80, wireframe C11): the "Ahrena Console" Project with the
// Backlog, Ready, In Progress, In Review and Done lanes and the wireframe's 11 cards. Moving changes
// the Status in memory, as GitHub's mutation would. Synthetic data only: the repository is the simulator's.

import type { ProjectBoardValue, ProjectCard, ProjectRef, ProjectSource } from '../github/project.ts';
import { workKey, type CiState, type ReviewDecision } from '../github/work.ts';
import { SIMULATOR_REPO } from './panel.ts';

/** The demo's Project: the owner and number the API shows. */
export const SIMULATOR_PROJECT: Required<ProjectRef> = { owner: 'exemplo', number: 3, field: 'Status' };

/** C11's lanes, with ids in the format of GitHub's options. */
export const SIMULATOR_LANES = [
  { id: 'b0a1c2d3', name: 'Backlog', color: 'GRAY' },
  { id: 'e4f5a6b7', name: 'Ready', color: 'BLUE' },
  { id: '47fc9ee4', name: 'In Progress', color: 'YELLOW' },
  { id: 'c8d9e0f1', name: 'In Review', color: 'ORANGE' },
  { id: '98236657', name: 'Done', color: 'PURPLE' },
] as const;

const M1 = 'M1 · Local';
const M2 = 'M2 · Bandeja';

/** A card of wireframe C11. */
interface C11Card {
  lane: (typeof SIMULATOR_LANES)[number]['name'];
  type: 'Story' | 'Tech Task' | 'Spike' | 'Bug';
  number: number;
  title: string;
  milestone: string;
  sub?: [number, number];
  pr?: { number: number; ci: CiState; review?: ReviewDecision; merged?: boolean; draft?: boolean };
}

const CARDS: C11Card[] = [
  { lane: 'Backlog', type: 'Tech Task', number: 80, title: 'Kanban do projeto no artefato', milestone: M1 },
  { lane: 'Backlog', type: 'Story', number: 87, title: 'App na bandeja: N precisam de você', milestone: M2 },
  { lane: 'Backlog', type: 'Tech Task', number: 89, title: 'Abrir no login com SMAppService', milestone: M2 },
  { lane: 'Ready', type: 'Story', number: 35, title: 'Esta sessão: estado, contexto e custo', milestone: M1 },
  { lane: 'Ready', type: 'Story', number: 36, title: 'Subagentes, plano e sessões filhas', milestone: M1 },
  { lane: 'In Progress', type: 'Story', number: 42, title: 'Kanban de sessões', milestone: M1, sub: [2, 4], pr: { number: 78, ci: 'PENDING', draft: true } },
  { lane: 'In Progress', type: 'Tech Task', number: 81, title: 'Consumo baixo do painel', milestone: M1, sub: [1, 2], pr: { number: 85, ci: 'SUCCESS', draft: true } },
  { lane: 'In Review', type: 'Tech Task', number: 92, title: 'Wireframes do painel e da bandeja', milestone: M2, pr: { number: 93, ci: 'SUCCESS', review: 'REVIEW_REQUIRED' } },
  { lane: 'In Review', type: 'Bug', number: 64, title: 'Paleta: cor de erro', milestone: M1, pr: { number: 69, ci: 'FAILURE', review: 'CHANGES_REQUESTED' } },
  { lane: 'Done', type: 'Spike', number: 40, title: 'Spike: consulta ao GitHub', milestone: M1, pr: { number: 67, ci: 'SUCCESS', review: 'APPROVED', merged: true } },
  { lane: 'Done', type: 'Spike', number: 82, title: 'Spike: app desktop', milestone: M1, pr: { number: 84, ci: 'SUCCESS', review: 'APPROVED', merged: true } },
];

const laneId = (name: string) => SIMULATOR_LANES.find((r) => r.name === name)!.id;

function card(c: C11Card, now: number, i: number): ProjectCard {
  const url = `https://github.com/${SIMULATOR_REPO}`;
  const done = c.lane === 'Done';
  return {
    itemId: `PVTI_simulado${c.number}`,
    kind: 'Issue',
    key: workKey(SIMULATOR_REPO, c.number),
    repo: SIMULATOR_REPO,
    number: c.number,
    title: c.title,
    url: `${url}/issues/${c.number}`,
    state: done ? 'CLOSED' : 'OPEN',
    updatedAt: new Date(now - (i + 1) * 17 * 60_000).toISOString(),
    type: c.type,
    parent: null,
    statusId: laneId(c.lane),
    milestone: c.milestone,
    subIssues: c.sub ? { completed: c.sub[0], total: c.sub[1] } : null,
    pullRequest: c.pr
      ? { number: c.pr.number, url: `${url}/pull/${c.pr.number}`, state: c.pr.merged ? 'MERGED' : 'OPEN', isDraft: c.pr.draft ?? false, review: c.pr.review ?? null, ci: c.pr.ci, checks: null }
      : null,
  };
}

/** C11's Project in memory. Each instance starts from the wireframe; a move lasts until the process exits. */
export class SimulatorProject implements ProjectSource {
  private readonly items: ProjectCard[];
  /** Reads and mutations done (tests). */
  calls = { board: 0, move: 0 };

  constructor(now = Date.now()) {
    this.items = CARDS.map((c, i) => card(c, now, i));
  }

  async board(_ref?: ProjectRef): Promise<ProjectBoardValue> {
    this.calls.board++;
    return {
      projectId: 'PVT_simulado',
      fieldId: 'PVTSSF_simulado',
      field: SIMULATOR_PROJECT.field,
      title: 'Ahrena Console',
      url: `https://github.com/orgs/${SIMULATOR_PROJECT.owner}/projects/${SIMULATOR_PROJECT.number}`,
      options: SIMULATOR_LANES.map((r) => ({ ...r })),
      items: this.items.map((i) => ({ ...i })),
    };
  }

  async move({ itemId, optionId }: Parameters<ProjectSource['move']>[0]): Promise<{ itemId: string; statusId: string | null }> {
    this.calls.move++;
    const item = this.items.find((i) => i.itemId === itemId);
    if (!item) throw new Error(`o GitHub não devolveu o item ${itemId}`);
    item.statusId = optionId;
    return { itemId, statusId: optionId };
  }
}
