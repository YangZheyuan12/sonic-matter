import type { AgentMode } from './types.ts'
import type { Page } from '../navigation.ts'
import { activeWorkflow, workflowItems, type DefinitionStep, type WorkflowId } from './workflow.ts'

type Props = {
  page: Page
  definitionStep: DefinitionStep
  agentMode: AgentMode
  go: (page: Page) => void
  setDefinitionStep: (step: DefinitionStep) => void
}

export default function WorkflowHeader({ page, definitionStep, agentMode, go, setDefinitionStep }: Props) {
  const active = activeWorkflow(page, definitionStep)
  const open = (id: WorkflowId) => {
    if (id === 'start') return go('explore')
    if (id === 'brief' || id === 'sound') {
      setDefinitionStep(id)
      return go('concept')
    }
    go(id === 'studio' ? 'studio' : 'sound')
  }
  const state = page === 'settings'
    ? '本地会话已连接'
    : agentMode === 'agent' ? 'Agent 已连接' : agentMode === 'fallback' ? 'Agent 本地回退' : '本地工程已同步'

  return <header className="workflow-header">
    <button className="brand" onClick={() => go('explore')} aria-label="返回首页"><span>S</span><strong>SONIC / MATTER</strong></button>
    <nav className="workflow-nav" aria-label="创作工作流">
      {workflowItems.map(item => <button key={item.id} className={active === item.id ? 'active' : ''} aria-current={active === item.id ? 'step' : undefined} onClick={() => open(item.id)}><i />{item.label}</button>)}
    </nav>
    <div className="header-actions"><span className="project-state"><b>●</b>{state}</span><button className={`my-button${page === 'settings' ? ' active' : ''}`} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => go('settings')}>我的</button></div>
  </header>
}

