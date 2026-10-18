import { expect, test } from 'claude-code/testing'
import { matchesFilter, parseFilter } from './filtro.ts'

const item = (extra: Record<string, unknown> = {}) => ({
  id: 'x', kind: 'Issue' as const, number: 1, title: 'Configurar federação', url: null, state: 'OPEN', updatedAt: '', repo: 'acme/app',
  type: 'Task', milestone: 'M6', assignees: ['ana'], labels: ['cliente:grupo-primo'], parent: null, progress: null, prs: [],
  fields: { Status: 'Todo', Frente: 'Grupo Primo', Priority: 'P0' } as Record<string, string | null>, ...extra,
})

test('filtro das views do GitHub: label, negação de tipo, campo do projeto e texto', () => {
  const f = parseFilter('label:"cliente:grupo-primo" -type:Initiative -type:"Epic / Milestone"')
  expect(matchesFilter(item(), f)).toBe(true)
  expect(matchesFilter(item({ type: 'Epic / Milestone' }), f)).toBe(false)
  expect(matchesFilter(item({ labels: [] }), f)).toBe(false)
  expect(matchesFilter(item(), parseFilter('Frente:"Grupo Primo"'))).toBe(true)
  expect(matchesFilter(item(), parseFilter('Priority:P0'))).toBe(true)
  expect(matchesFilter(item(), parseFilter('Priority:P1,P0'))).toBe(true)
  expect(matchesFilter(item(), parseFilter('is:closed'))).toBe(false)
  expect(matchesFilter(item(), parseFilter('federação'))).toBe(true)
  expect(matchesFilter(item(), parseFilter(''))).toBe(true)
})
