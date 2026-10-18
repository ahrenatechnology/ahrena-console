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

export type Tab = 'visao' | 'kanban' | 'trabalho' | 'sessoes'

export type Reading = {
  fleet: Fleet | null
  work: Work | null
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
