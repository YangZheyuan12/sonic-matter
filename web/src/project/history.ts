import type { Project } from './model'

/** 历史栈最多保留多少步，超出后丢弃最早的快照。 */
export const HISTORY_LIMIT = 80
/** 同一类连续操作（例如一次拖动音符）在这个时间窗内只记一步。 */
export const HISTORY_COALESCE_MS = 700
/** 新建 / 打开工程时的起点标签。 */
export const INITIAL_HISTORY_LABEL = '初始工程'

/**
 * 工程级历史：entries 是不可变工程快照（React 的不可变更新天然共享未变部分，
 * 所以快照只是一串引用），labels[i] 描述“产生 entries[i] 的那次操作”，
 * index 指向当前工程。
 */
export type HistoryState = {
  entries: Project[]
  labels: string[]
  index: number
  limit: number
  lastKey: string
  lastAt: number
}

export function createHistory(project: Project, label = INITIAL_HISTORY_LABEL, limit = HISTORY_LIMIT): HistoryState {
  return { entries: [project], labels: [label], index: 0, limit: Math.max(1, Math.floor(limit)), lastKey: '', lastAt: 0 }
}

export const currentProject = (state: HistoryState) => state.entries[state.index]
export const currentLabel = (state: HistoryState) => state.labels[state.index]
/** 当前处于第几步（起点为 0）。 */
export const historyDepth = (state: HistoryState) => state.index
export const canUndo = (state: HistoryState) => state.index > 0
export const canRedo = (state: HistoryState) => state.index < state.entries.length - 1
/** 将被撤销的那次操作的名字（也就是产生当前工程的操作）。 */
export const undoLabel = (state: HistoryState) => (canUndo(state) ? state.labels[state.index] : '')
/** 将被重做的那次操作的名字。 */
export const redoLabel = (state: HistoryState) => (canRedo(state) ? state.labels[state.index + 1] : '')

/**
 * 记录一次工程修改。
 * - `updater` 返回同一个引用时视为没有变化，不产生历史（配合“只返回补丁”的编辑函数）。
 * - 相同 `key` 且在 HISTORY_COALESCE_MS 内的连续修改会合并成一步，避免拖动一次占满历史。
 */
export function pushHistory(state: HistoryState, next: Project, label: string, options: { key?: string; now?: number } = {}): HistoryState {
  if (next === currentProject(state)) return state
  const key = options.key ?? label
  const now = options.now ?? Date.now()
  const coalesce = key !== '' && key === state.lastKey && now - state.lastAt <= HISTORY_COALESCE_MS && canUndo(state)
  if (coalesce) return { ...state, entries: [...state.entries.slice(0, state.index), next], labels: [...state.labels.slice(0, state.index), label], lastKey: key, lastAt: now }
  const entries = [...state.entries.slice(0, state.index + 1), next]
  const labels = [...state.labels.slice(0, state.index + 1), label]
  const overflow = Math.max(0, entries.length - state.limit)
  return { ...state, entries: entries.slice(overflow), labels: labels.slice(overflow), index: entries.length - 1 - overflow, lastKey: key, lastAt: now }
}

export function undo(state: HistoryState): HistoryState {
  return canUndo(state) ? { ...state, index: state.index - 1, lastKey: '', lastAt: 0 } : state
}

export function redo(state: HistoryState): HistoryState {
  return canRedo(state) ? { ...state, index: state.index + 1, lastKey: '', lastAt: 0 } : state
}
