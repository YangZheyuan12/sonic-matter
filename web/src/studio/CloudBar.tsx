import { useState } from 'react'
import { formatWhen, type CloudSummary } from '../cloud/cloud.ts'

export type CloudBarProps = {
  /** 当前工程在云端对应的 ID；空串表示还没存过。 */
  cloudId: string
  busy: boolean
  /** 上一次操作的结果，直接展示给用户。 */
  notice: string
  projects: CloudSummary[]
  onSave: () => void
  onRefresh: () => void
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onCopyLink: () => void
}

/**
 * 云端工程：保存 / 更新 / 复制分享链接 / 打开 / 删除。
 *
 * 文案上必须诚实：这里没有账号、没有密码、没有登录。写操作只认"本机标识"，
 * 而任何拿到分享链接的人都能打开查看——不许让用户以为这是私有存储。
 */
export default function CloudBar({ cloudId, busy, notice, projects, onSave, onRefresh, onOpen, onDelete, onCopyLink }: CloudBarProps) {
  const [open, setOpen] = useState(false)
  const toggle = () => { const next = !open; setOpen(next); if (next) onRefresh() }
  return <div className="settings-card cloud-bar">
    <div className="setting-row"><span>云端工程</span><div className="buttons">
      <button className="secondary" onClick={onSave} disabled={busy}>{busy ? '处理中…' : cloudId ? '更新云端工程' : '保存到云端'}</button>
      {cloudId ? <button className="secondary" onClick={onCopyLink} disabled={busy}>复制分享链接</button> : null}
      <button className="outline" onClick={toggle} disabled={busy}>{open ? '收起列表' : '我的云端工程'}</button>
    </div></div>
    <p className="hint">云端工程是 Demo 级功能：没有账号密码，只按"哪台浏览器保存的"来区分能否修改；任何拿到分享链接的人都能打开查看工程内容。服务器上最多保存 50 个，单个工程几百 KB 以内。</p>
    {notice ? <p className="hint" role="status">{notice}</p> : null}
    {open ? <div className="cloud-list">
      {projects.length === 0
        ? <p className="hint">这台浏览器还没有云端工程。点「保存到云端」会生成一个分享链接，换设备、换浏览器都能打开。</p>
        : projects.map(item => <div className="setting-row" key={item.id}>
            <span>{formatWhen(item.updatedAt)}</span>
            <div className="buttons">
              <strong>{item.title}{item.id === cloudId ? ' · 当前' : ''}</strong>
              <span>{item.trackCount} 轨 · {item.tempo} BPM</span>
              <button className="outline" onClick={() => onOpen(item.id)} disabled={busy}>打开</button>
              <button className="outline" onClick={() => onDelete(item.id)} disabled={busy} title="删除后这个分享链接立刻失效">删除</button>
            </div>
          </div>)
      }
    </div> : null}
  </div>
}
