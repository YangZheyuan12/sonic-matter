import type { Project } from '../project/model.ts'
import { buildProjectDiff, revisionCount, validationReports } from './projectDiff.ts'
import { safeTraceText } from './run.ts'
import type { AgentRunController } from './useAgentRun.ts'

type AgentReviewPanelProps = {
  controller: AgentRunController
  onApproved: (runId: string, project: Project) => void
  onRejected: () => void
}

const countText = (count: { added: number; removed: number; modified: number }, unit: string) =>
  `新增 ${count.added} ${unit} · 删除 ${count.removed} ${unit} · 修改 ${count.modified} ${unit}`

export default function AgentReviewPanel({ controller, onApproved, onRejected }: AgentReviewPanelProps) {
  const { resource, sourceProject, deciding } = controller
  const candidate = resource?.candidateProject
  if (!resource || (!candidate && resource.decision === undefined)) return null

  const run = resource.run
  const diff = sourceProject && candidate ? buildProjectDiff(sourceProject, candidate) : null
  const reports = validationReports(run)
  const revisions = revisionCount(run)
  const awaiting = run.status === 'awaiting_approval' && resource.decision === undefined && candidate !== undefined

  const approve = async () => {
    const result = await controller.approve()
    if (result?.decision === 'approved' && result.approvedProject) {
      onApproved(result.run.id, result.approvedProject)
    }
  }
  const reject = async () => {
    const result = await controller.reject()
    if (result?.decision === 'rejected') onRejected()
  }

  return <section className="agent-review" aria-label="Agent 工程修改审阅">
    <div className="review-heading"><strong>候选工程审阅</strong><span>PROJECT DIFF</span></div>

    {diff && <div className="diff-summary">
      <div><small>轨道变化</small><strong>{countText(diff.tracks, '条')}</strong></div>
      <div><small>音符变化</small><strong>{countText(diff.notes, '个')}</strong></div>
      {diff.changedProjectFields.length > 0 && <p>工程属性：{diff.changedProjectFields.join('、')}</p>}
      {diff.addedTracks.length > 0 && <p className="diff-added">＋ 新增：{diff.addedTracks.join('、')}</p>}
      {diff.removedTracks.length > 0 && <p className="diff-removed">－ 删除：{diff.removedTracks.join('、')}</p>}
      {diff.modifiedTracks.length > 0 && <p className="diff-modified">● 修改：{diff.modifiedTracks.join('、')}</p>}
    </div>}

    <div className="review-validation">
      <div><small>确定性验收</small><span>自动修订 {revisions} 次</span></div>
      {reports.length === 0
        ? <p>尚未生成验收报告。</p>
        : reports.map((report, index) => <article key={report.id} className={report.passed ? 'passed' : 'failed'}>
          <header><b>{report.passed ? '✓' : '!'}</b><strong>{safeTraceText(report.title, 100)}</strong><span>第 {index + 1} 次验收</span></header>
          {report.rules.map(rule => <p key={rule.id}><i>{rule.passed ? '通过' : '未通过'}</i>{safeTraceText(rule.reason, 220)}</p>)}
          {report.rules.length === 0 && <p>{report.passed ? '本轮约束全部通过。' : '本轮存在未通过约束。'}</p>}
        </article>)}
    </div>

    {awaiting && <div className="review-actions">
      <p>批准后才会写入当前工程，并作为一个独立历史步骤保留；拒绝不会修改工程。</p>
      <div>
        <button className="outline" onClick={() => void reject()} disabled={deciding !== null}>{deciding === 'reject' ? '拒绝中…' : '拒绝候选'}</button>
        <button className="primary" onClick={() => void approve()} disabled={deciding !== null}>{deciding === 'approve' ? '批准中…' : '批准并应用'}</button>
      </div>
    </div>}

    {resource.decision === 'approved' && <p className="review-decision approved" role="status">已批准并加入工程历史；可点击撤销恢复批准前状态。</p>}
    {resource.decision === 'rejected' && <p className="review-decision rejected" role="status">已拒绝候选工程，当前工程保持不变。</p>}
  </section>
}
