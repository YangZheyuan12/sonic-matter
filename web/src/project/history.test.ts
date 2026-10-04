import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HISTORY_COALESCE_MS,
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  createHistory,
  currentLabel,
  currentProject,
  pushHistory,
  redo,
  redoLabel,
  undo,
  undoLabel,
} from './history.ts'
import type { Project } from './model.ts'

const project = (title: string): Project => ({ title, tempo: 92, key: 'C Major', duration: 10, masterGain: .9, tracks: [] })
const step = (state: ReturnType<typeof createHistory>, next: Project, label: string, key?: string, at = 0) => pushHistory(state, next, label, { key, now: at })

test('createHistory 以当前工程为起点，不能撤销或重做', () => {
  const state = createHistory(project('A'))
  assert.equal(currentProject(state).title, 'A')
  assert.equal(currentLabel(state), '初始工程')
  assert.equal(canUndo(state), false)
  assert.equal(canRedo(state), false)
  assert.equal(undoLabel(state), '')
  assert.equal(redoLabel(state), '')
})

test('pushHistory 记录新状态后可以撤销，撤销后可以重做', () => {
  const base = createHistory(project('A'))
  const pushed = step(base, project('B'), '改标题')
  assert.equal(currentProject(pushed).title, 'B')
  assert.equal(canUndo(pushed), true)
  assert.equal(undoLabel(pushed), '改标题')
  const back = undo(pushed)
  assert.equal(currentProject(back).title, 'A')
  assert.equal(canRedo(back), true)
  assert.equal(redoLabel(back), '改标题')
  assert.equal(currentProject(redo(back)).title, 'B')
})

test('同一个引用视为没有变化，不产生历史', () => {
  const base = createHistory(project('A'))
  const same = pushHistory(base, currentProject(base), '空操作')
  assert.equal(same, base)
  assert.equal(canUndo(same), false)
})

test('撤销后新的修改会丢弃重做分支', () => {
  let state = createHistory(project('A'))
  state = step(state, project('B'), '到 B', 'k1', 0)
  state = step(state, project('C'), '到 C', 'k2', 10_000)
  state = undo(state)
  assert.equal(currentProject(state).title, 'B')
  state = step(state, project('D'), '到 D', 'k3', 20_000)
  assert.equal(currentProject(state).title, 'D')
  assert.equal(canRedo(state), false)
  assert.equal(currentProject(undo(state)).title, 'B')
})

test('撤销到起点后不能再撤销，重做到末端后不能再重做', () => {
  let state = createHistory(project('A'))
  state = step(state, project('B'), '到 B', 'k1', 0)
  const start = undo(state)
  assert.equal(canUndo(start), false)
  assert.equal(undo(start), start)
  const end = redo(start)
  assert.equal(canRedo(end), false)
  assert.equal(redo(end), end)
})

test('相同 key 的连续操作在时间窗内合并成一步', () => {
  let state = createHistory(project('A'))
  state = step(state, project('B'), '拖动', 'notes:melody', 1000)
  state = step(state, project('C'), '拖动', 'notes:melody', 1400)
  state = step(state, project('D'), '拖动', 'notes:melody', 1800)
  assert.equal(state.entries.length, 2)
  assert.equal(currentProject(state).title, 'D')
  assert.equal(currentProject(undo(state)).title, 'A')
  assert.equal(canRedo(undo(state)), true)
  assert.equal(currentProject(redo(undo(state))).title, 'D')
})

test('key 不同或超出时间窗就不会合并', () => {
  let state = createHistory(project('A'))
  state = step(state, project('B'), '音量', 'gain', 1000)
  state = step(state, project('C'), '声像', 'pan', 1100)
  assert.equal(currentProject(undo(state)).title, 'B')
  state = step(state, project('D'), '音量', 'gain', 1100 + HISTORY_COALESCE_MS + 1)
  assert.equal(currentProject(undo(state)).title, 'C')
})

test('撤销会结束合并窗口，之后的同类操作另起一步', () => {
  let state = createHistory(project('A'))
  state = step(state, project('B'), '拖动', 'notes:melody', 1000)
  state = undo(state)
  state = step(state, project('C'), '拖动', 'notes:melody', 1050)
  assert.equal(currentProject(undo(state)).title, 'A')
  assert.equal(canRedo(undo(state)), true)
})

test('超出上限时丢弃最早的快照，并保持 index 指向当前工程', () => {
  let state = createHistory(project('0'), '初始工程', 3)
  for (let index = 1; index <= 5; index += 1) state = step(state, project(String(index)), `第 ${index} 步`, `k${index}`, index * 10_000)
  assert.equal(state.entries.length, 3)
  assert.equal(state.index, 2)
  assert.equal(currentProject(state).title, '5')
  assert.equal(currentProject(undo(state)).title, '4')
  assert.equal(currentProject(undo(undo(state))).title, '3')
  assert.equal(canUndo(undo(undo(state))), false)
})

test('历史状态是纯函数式的：旧状态不会被改写', () => {
  const base = createHistory(project('A'))
  const pushed = step(base, project('B'), '到 B', 'k1', 0)
  assert.equal(base.entries.length, 1)
  assert.equal(base.index, 0)
  assert.equal(currentProject(base).title, 'A')
  assert.equal(pushed.entries.length, 2)
})

test('默认上限足够长', () => {
  assert.ok(HISTORY_LIMIT >= 50)
})
