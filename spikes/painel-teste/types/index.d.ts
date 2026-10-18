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

export type Reading = { fleet: Fleet | null; error: string | null; polls: number; latencies: number[] }
export type View = { filter: 'todas' | 'ativa' | 'ociosa' | 'encerrada'; query: string; selected: string | null }

declare module 'claude-code' {
  interface PluginState {
    'ahrena-console-painel': { reading: Reading; view: View }
  }
}
