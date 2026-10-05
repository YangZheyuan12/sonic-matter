import { canRedo, canUndo, currentLabel, historyDepth, redoLabel, undoLabel, type HistoryState } from '../project/history'

/** 工程级撤销 / 重做：本地编辑与 Agent 修改共用同一条历史。 */
export default function HistoryBar({ state, undo, redo }: { state: HistoryState; undo: () => void; redo: () => void }) {
  const back = canUndo(state), forward = canRedo(state), depth = historyDepth(state), recent = depth ? currentLabel(state) : ''
  return <div className="history-bar">
    <button className="secondary" onClick={undo} disabled={!back} title={back ? `撤销：${undoLabel(state)}（Ctrl/Cmd + Z）` : '没有可以撤销的操作'}>↶ 撤销</button>
    <button className="secondary" onClick={redo} disabled={!forward} title={forward ? `重做：${redoLabel(state)}（Ctrl/Cmd + Shift + Z / Ctrl + Y）` : '没有可以重做的操作'}>↷ 重做</button>
    <small className="history-status">{depth ? `第 ${depth} 步${recent ? ` · 最近：${recent}` : ''} · Ctrl/Cmd + Z 撤销，加 Shift 重做` : '初始工程 · 本地编辑与 Agent 修改都会记录在撤销栈里'}</small>
  </div>
}
