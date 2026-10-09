import type { Page } from '../navigation.ts'

export type DefinitionStep = 'brief' | 'sound'
export type WorkflowId = 'start' | DefinitionStep | 'studio' | 'sfx'

export const workflowItems: ReadonlyArray<{ id: WorkflowId; label: string }> = [
  { id: 'start', label: '开始' },
  { id: 'brief', label: '游戏简报' },
  { id: 'sound', label: '声音方向' },
  { id: 'studio', label: '音乐工作室' },
  { id: 'sfx', label: '音效实验室' },
]

export function activeWorkflow(page: Page, step: DefinitionStep): WorkflowId | null {
  if (page === 'explore') return 'start'
  if (page === 'concept') return step
  if (page === 'studio') return 'studio'
  if (page === 'sound') return 'sfx'
  return null
}

