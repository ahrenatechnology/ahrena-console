export type SessionRow = {
  project: string
  id: string
  state: 'ativa' | 'ociosa' | 'encerrada'
  lastActivity: string
  sizeKb: number
}

export type Fleet = {
  totals: { projects: number; sessions: number; active: number; idle: number; sizeMb: number }
  recent: SessionRow[]
  activityByHour: number[]
  topProjects: { project: string; sessions: number }[]
  generatedAt: string
}

export type IssuePr = { number: number; state: string; isDraft: boolean; url: string; review: string | null; ci: string | null }
export type IssueRow = {
  repo: string
  number: number
  title: string
  url: string
  updatedAt: string
  labels: string[]
  assignees: string[]
  prs: IssuePr[]
  stage: string
}
export type Issues = { total: number; shown: number; byStage: Record<string, number>; items: IssueRow[]; generatedAt: string }

export type Tab = 'visao' | 'projetos' | 'trabalho' | 'sessoes'

export type Reading = {
  fleet: Fleet | null
  work: Work | null
  projects: Project[] | null
  projectItems: ProjectItems | null
  projectsError: string | null
  error: string | null
  workError: string | null
  polls: number
  latencies: number[]
}

export type View = {
  tab: Tab
  filter: 'todas' | 'ativa' | 'ociosa' | 'encerrada'
  query: string
  selected: string | null
  stage: string
  org: string
  issueQuery: string
  selectedIssue: string | null
  workMode: 'arvore' | 'estagio' | 'kanban'
  expanded: string[]
  project: string | null
  projectView: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'ahrena-console-painel': { reading: Reading; view: View }
  }
}

export type WorkNode = {
  key: string
  repo: string
  number: number
  title: string
  url: string
  state: string
  updatedAt: string
  type: string | null
  rank: number
  progress: { total: number; completed: number; pct: number } | null
  assignees: string[]
  labels: string[]
  prs: IssuePr[]
  stage: string
  parent: string | null
  children: string[]
}
export type Work = { nodes: Record<string, WorkNode>; roots: string[]; byType: Record<string, number>; count: number; generatedAt: string }

export type SelectOption = { name: string; color: string }
export type ProjectView = { number: number; name: string; layout: 'board' | 'table' | 'roadmap'; filter: string; groupBy: string | null; columnsBy: string | null }
export type Project = { id: string; org: string; number: number; title: string; url: string; updatedAt: string; itemCount: number; views: ProjectView[]; selects: Record<string, SelectOption[]> }
export type ProjectItem = {
  id: string
  kind: 'Issue' | 'PullRequest' | 'DraftIssue'
  number: number | null
  title: string
  url: string | null
  state: string
  updatedAt: string
  repo: string | null
  type: string | null
  milestone: string | null
  assignees: string[]
  labels: string[]
  parent: string | null
  progress: { total: number; completed: number; pct: number } | null
  prs: IssuePr[]
  fields: Record<string, string | null>
}
export type ProjectItems = { id: string; items: ProjectItem[]; generatedAt: string }
