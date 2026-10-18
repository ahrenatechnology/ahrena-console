// Filtro de view do GitHub Projects, aplicado aqui do mesmo jeito que o GitHub aplica:
// qualificadores `chave:valor` (valor entre aspas quando tem espaço), negação com `-`,
// vários valores separados por vírgula valem como "ou", e texto solto busca no título.
// Chaves conhecidas: label, type, repo, assignee, milestone, status, is; qualquer outra
// é um campo do projeto (Frente, Priority…), comparado sem diferenciar maiúsculas.
import type { ProjectItem } from '../types'

type Term = { negate: boolean; key: string | null; values: string[] }

export function parseFilter(filter: string): Term[] {
  const terms: Term[] = []
  const re = /(-?)(?:([\p{L}\w.-]+):)?("([^"]*)"|\S+)/gu
  for (const m of filter.matchAll(re)) {
    const raw = m[4] ?? m[3] ?? ''
    if (!raw) continue
    const values = raw.replace(/^"|"$/g, '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean)
    terms.push({ negate: m[1] === '-', key: m[2] ? m[2].toLowerCase() : null, values })
  }
  return terms
}

function valuesOf(item: ProjectItem, key: string): string[] {
  switch (key) {
    case 'label':
      return item.labels
    case 'type':
      return item.type ? [item.type] : []
    case 'repo':
      return item.repo ? [item.repo, item.repo.split('/')[1] ?? ''] : []
    case 'assignee':
      return item.assignees
    case 'milestone':
      return item.milestone ? [item.milestone] : []
    case 'is': {
      const out = [item.state === 'OPEN' ? 'open' : 'closed']
      if (item.kind === 'Issue') out.push('issue')
      if (item.kind === 'PullRequest') out.push('pr')
      if (item.kind === 'DraftIssue') out.push('draft')
      return out
    }
    default: {
      const field = Object.keys(item.fields).find(f => f.toLowerCase() === key)
      const v = field ? item.fields[field] : null
      return v ? [v] : []
    }
  }
}

export function matchesFilter(item: ProjectItem, terms: Term[]): boolean {
  return terms.every(t => {
    const have = t.key ? valuesOf(item, t.key).map(v => v.toLowerCase()) : [item.title.toLowerCase()]
    const hit = t.key ? t.values.some(v => have.includes(v)) : t.values.every(v => have[0]?.includes(v))
    return t.negate ? !hit : hit
  })
}
