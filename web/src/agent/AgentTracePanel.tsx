import {
  canCancelRun,
  constraintText,
  elapsedText,
  executionStatusLabels,
  runStatusLabels,
  safeTraceText,
  traceSummary,
} from './run.ts'
import type { AgentRunController } from './useAgentRun.ts'

const toolLabel = (name: string) => name.replaceAll('_', ' ')

export default function AgentTracePanel({ controller }: { controller: AgentRunController }) {
  const { resource, creating, polling, canceling, error } = controller
  if (!resource) {
    return <section className="agent-trace empty" aria-label="Agent 执行轨迹">
      <div className="trace-heading"><strong>执行轨迹</strong><span>TRACE</span></div>
      {creating
        ? <p role="status">正在创建 Agent Run…</p>
        : error
          ? <div className="trace-error" role="alert"><strong>Run 创建失败</strong><p>{safeTraceText(error)}</p><button className="outline" onClick={controller.dismissError}>知道了</button></div>
          : <p>提交一条工程修改要求后，这里会显示计划、工具调用和确定性验收结果。</p>}
    </section>
  }

  const run = resource.run
  const cancelVisible = canCancelRun(run.status)
  return <section className={`agent-trace status-${run.status}`} aria-label="Agent 执行轨迹">
    <div className="trace-heading"><strong>执行轨迹</strong><span>TRACE · {run.id.slice(0, 12)}</span></div>
    <div className="trace-state" role="status" aria-live="polite">
      <i aria-hidden="true" />
      <div><strong>{runStatusLabels[run.status]}</strong><span>{polling ? '正在同步服务器状态' : '已停止轮询'}</span></div>
      {cancelVisible && <button className="outline" onClick={() => void controller.cancel()} disabled={canceling}>{canceling ? '取消中…' : '取消 Run'}</button>}
    </div>

    <div className="trace-goal"><small>用户目标</small><p>{safeTraceText(run.instruction, 220)}</p></div>

    <div className="trace-constraints">
      <small>验收约束</small>
      <ul>{resource.constraints.map(constraint => <li key={constraint.id}>{constraintText(constraint)}</li>)}</ul>
    </div>

    {error && <div className="trace-error" role="alert"><strong>状态同步失败</strong><p>{safeTraceText(error)}</p><button className="outline" onClick={controller.dismissError}>知道了</button></div>}
    {run.errorMessage && <div className="trace-error" role="alert"><strong>{run.errorCode ?? 'Run 失败'}</strong><p>{safeTraceText(run.errorMessage)}</p></div>}

    <div className="trace-steps">
      <small>步骤记录 · 仅展示安全摘要，不展示模型隐含推理</small>
      {run.steps.length === 0
        ? <p className="trace-waiting">正在等待第一条执行记录…</p>
        : run.steps.map((step, index) => <article className={`trace-step step-${step.status}`} key={step.id}>
          <header><b>{index + 1}</b><strong>{safeTraceText(step.title, 120)}</strong><span>{executionStatusLabels[step.status]} · {elapsedText(step.startedAt, step.finishedAt)}</span></header>
          {traceSummary(step.summary) && <p>{traceSummary(step.summary)}</p>}
          {step.toolCalls.map(call => <div className={`trace-tool tool-${call.status}`} key={call.id}>
            <div><code>{toolLabel(call.toolName)}</code><span>{executionStatusLabels[call.status]} · {elapsedText(call.startedAt, call.finishedAt)}</span></div>
            <p><b>输入</b>{safeTraceText(call.inputSummary)}</p>
            {call.outputSummary && <p><b>结果</b>{safeTraceText(call.outputSummary)}</p>}
            {call.errorMessage && <p className="trace-tool-error"><b>{call.errorCode ?? '错误'}</b>{safeTraceText(call.errorMessage)}</p>}
          </div>)}
        </article>)}
    </div>
  </section>
}
