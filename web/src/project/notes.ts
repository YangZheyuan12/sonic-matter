import type { Note } from './model'

/** 钢琴卷帘的音高窗口：和界面上 37 行琴键一一对应。 */
export const ROLL_LOW_PITCH = 48
export const ROLL_HIGH_PITCH = 84
export const ROLL_ROWS = ROLL_HIGH_PITCH - ROLL_LOW_PITCH + 1

export const MIN_NOTE_DURATION = 0.02
export const MIN_VELOCITY = 1
export const MAX_VELOCITY = 127

/** 关闭吸附后，键盘/拖拽使用的最小步进（秒）。 */
export const FREE_STEP_SECONDS = 0.05

export type SnapChoice = '1/4' | '1/8' | '1/16' | 'off'

/** 吸附网格切换成秒；`'off'` 返回 0，表示自由输入。 */
export function snapSeconds(choice: SnapChoice, beat: number) {
  if (choice === '1/4') return beat
  if (choice === '1/16') return beat / 4
  if (choice === '1/8') return beat / 2
  return 0
}

/** 拖拽/缩放都基于同一份快照重算，这里统一收口音符窗口参数。 */
export type NoteWindow = { duration: number; snap: number; lowPitch?: number; highPitch?: number }

const round = (value: number) => Math.round(value * 1000) / 1000
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const lowest = (values: number[]) => Math.min(...values)
const highest = (values: number[]) => Math.max(...values)
const asSet = (ids: Iterable<string>) => (ids instanceof Set ? ids : new Set(ids))

export const clampVelocity = (velocity: number) => clamp(Math.round(velocity), MIN_VELOCITY, MAX_VELOCITY)
export const clampPitch = (pitch: number, lowPitch = 0, highPitch = 127) => clamp(Math.round(pitch), lowPitch, highPitch)

/** 统一排序：先按起点，再按音高，保证列表稳定、导出可预期。 */
export const sortNotes = (notes: Note[]) => [...notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch)

export function toggleSelection(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]
}

/** 单击选中：已经单独选中自己时保持原数组，避免多余的重渲染。 */
export function replaceSelection(ids: string[], id: string) {
  return ids.length === 1 && ids[0] === id ? ids : [id]
}

/** 吸附起点；`snap <= 0` 时只做范围限制。 */
export function snapTime(value: number, snap: number, duration: number) {
  const limit = Math.max(MIN_NOTE_DURATION, duration)
  if (!(snap > 0)) return round(clamp(value, 0, limit))
  const lastStart = Math.max(0, limit - snap)
  return round(clamp(Math.round(value / snap) * snap, 0, lastStart))
}

/** 吸附时长：至少一个网格，且不越过工程尾部。 */
export function snapDuration(value: number, start: number, snap: number, duration: number) {
  const step = snap > 0 ? snap : MIN_NOTE_DURATION
  const limit = Math.max(step, Math.max(MIN_NOTE_DURATION, duration) - start)
  return round(clamp(Math.round(value / step) * step, step, limit))
}

/* 下面这些编辑函数都以「拖拽起点的快照」为输入，只返回发生变化的音符（补丁），
   交给 mergeNotes 合并回当前列表；没有变化时返回空数组，避免无意义的重渲染与历史记录。 */

/** 平移选中的音符：整组保持相对间距，一起在工程范围内夹紧。 */
export function moveNotes(base: Note[], ids: Iterable<string>, delta: { time?: number; pitch?: number }, window: NoteWindow): Note[] {
  const target = asSet(ids)
  const picked = base.filter(note => target.has(note.id))
  if (!picked.length) return []
  const lowPitch = window.lowPitch ?? ROLL_LOW_PITCH
  const highPitch = window.highPitch ?? ROLL_HIGH_PITCH
  const duration = Math.max(MIN_NOTE_DURATION, window.duration)
  let time = delta.time ?? 0
  if (window.snap > 0) time = Math.round(time / window.snap) * window.snap
  const spanStart = lowest(picked.map(note => note.start))
  const spanEnd = highest(picked.map(note => note.start + note.duration))
  // 只按移动方向夹紧：向右不越过工程尾部，向左不越过 0；已经越界时保持不动。
  if (time > 0) time = Math.min(time, Math.max(0, duration - spanEnd))
  if (time < 0) time = Math.max(time, -spanStart)
  const lowestPitch = lowest(picked.map(note => note.pitch))
  const highestPitch = highest(picked.map(note => note.pitch))
  let pitch = Math.round(delta.pitch ?? 0)
  if (pitch > 0) pitch = Math.min(pitch, Math.max(0, highPitch - highestPitch))
  if (pitch < 0) pitch = Math.max(pitch, lowPitch - lowestPitch)
  if (!time && !pitch) return []
  return picked.map(note => ({ ...note, start: round(note.start + time), pitch: note.pitch + pitch }))
}

/** 键盘微调：左右按网格（关闭吸附时按 50ms），上下按半音。 */
export function nudgeNotes(base: Note[], ids: Iterable<string>, delta: { steps?: number; semitones?: number }, window: NoteWindow) {
  const step = window.snap > 0 ? window.snap : FREE_STEP_SECONDS
  return moveNotes(base, ids, { time: (delta.steps ?? 0) * step, pitch: delta.semitones ?? 0 }, window)
}

/** 拉伸选中的音符：整组一起伸缩，单个音符不会短于一个网格。 */
export function resizeNotes(base: Note[], ids: Iterable<string>, deltaDuration: number, window: NoteWindow): Note[] {
  const target = asSet(ids)
  const picked = base.filter(note => target.has(note.id))
  if (!picked.length) return []
  const step = window.snap > 0 ? window.snap : MIN_NOTE_DURATION
  const duration = Math.max(MIN_NOTE_DURATION, window.duration)
  let delta = window.snap > 0 ? Math.round(deltaDuration / step) * step : deltaDuration
  delta = Math.min(delta, Math.max(0, duration - highest(picked.map(note => note.start + note.duration))))
  const next = picked.map(note => ({ ...note, duration: snapDuration(note.duration + delta, note.start, window.snap, duration) }))
  const changed = next.some((note, index) => note.start !== picked[index].start || note.duration !== picked[index].duration)
  return changed ? next : []
}

/** 把选中音符的起点与时长吸附到当前网格。 */
export function quantizeNotes(base: Note[], ids: Iterable<string>, window: NoteWindow): Note[] {
  if (!(window.snap > 0)) return []
  const target = asSet(ids)
  const picked = base.filter(note => target.has(note.id))
  if (!picked.length) return []
  const next = picked.map(note => {
    const start = snapTime(note.start, window.snap, window.duration)
    return { ...note, start, duration: snapDuration(note.duration, start, window.snap, window.duration) }
  })
  const changed = next.some((note, index) => note.start !== picked[index].start || note.duration !== picked[index].duration)
  return changed ? next : []
}

export function deleteNotes(notes: Note[], ids: Iterable<string>) {
  const target = asSet(ids)
  return notes.filter(note => !target.has(note.id))
}

export function setVelocity(base: Note[], ids: Iterable<string>, velocity: number): Note[] {
  const target = asSet(ids)
  const next = clampVelocity(velocity)
  const picked = base.filter(note => target.has(note.id) && note.velocity !== next)
  return picked.length ? picked.map(note => ({ ...note, velocity: next })) : []
}

/** 复制：只挑出选中的音符，保持相对位置，粘贴时再决定偏移。 */
export function copyNotes(notes: Note[], ids: Iterable<string>) {
  const target = asSet(ids)
  return notes.filter(note => target.has(note.id)).map(note => ({ ...note }))
}

/** 把补丁合并回当前列表，保持原有顺序；没有变化的音符直接复用。 */
export function mergeNotes(notes: Note[], patches: Note[]) {
  if (!patches.length) return notes
  const table = new Map(patches.map(note => [note.id, note]))
  return sortNotes(notes.map(note => table.get(note.id) ?? note))
}

/** 粘贴：整体平移、夹在工程与音高窗口内，并换上一批新 id。 */
export function pasteNotes(
  notes: Note[],
  clipboard: Note[],
  options: { offset: number; duration: number; snap: number; lowPitch?: number; highPitch?: number; makeIds: (count: number) => string[] },
): { notes: Note[]; ids: string[] } {
  if (!clipboard.length) return { notes, ids: [] }
  const lowPitch = options.lowPitch ?? ROLL_LOW_PITCH
  const highPitch = options.highPitch ?? ROLL_HIGH_PITCH
  const duration = Math.max(MIN_NOTE_DURATION, options.duration)
  const earliest = lowest(clipboard.map(note => note.start))
  const latest = highest(clipboard.map(note => note.start + note.duration))
  // 整段必须留在 [0, duration] 内：先贴左边界，再压回工程尾部。
  const minOffset = -earliest
  const maxOffset = Math.max(minOffset, duration - latest)
  const offset = clamp(options.offset, minOffset, maxOffset)
  const ids = options.makeIds(clipboard.length)
  const inserted = clipboard.map((note, index) => {
    const start = round(Math.max(0, note.start + offset))
    return {
      ...note,
      id: ids[index],
      pitch: clampPitch(note.pitch, lowPitch, highPitch),
      start,
      duration: snapDuration(note.duration, start, options.snap, duration),
    }
  })
  return { notes: sortNotes([...notes, ...inserted]), ids }
}

/** 粘贴落点：优先贴到播放头；播放头不在片段之后时，向右错开一格，避免原地重叠。 */
export function pasteOffsetFor(playhead: number, earliest: number, snap: number) {
  const step = snap > 0 ? snap : FREE_STEP_SECONDS
  return playhead > earliest ? playhead - earliest : step
}

/** 生成不冲突的音符 id：接着现有的最大序号往下排，可预测也便于测试。 */
export function makeNoteIds(trackId: string, existing: Note[], count: number): string[] {
  const prefix = `roll-${trackId}-`
  const used = new Set<string>()
  let max = 0
  for (const note of existing) {
    used.add(note.id)
    if (!note.id.startsWith(prefix)) continue
    const suffix = Number(note.id.slice(prefix.length))
    if (Number.isFinite(suffix)) max = Math.max(max, suffix)
  }
  const ids: string[] = []
  for (let index = 0; index < count; index++) {
    let next = max + index + 1
    let id = `${prefix}${next}`
    while (used.has(id)) id = `${prefix}${(next += 1000)}`
    used.add(id)
    ids.push(id)
  }
  return ids
}

/** 框选：与矩形相交的音符都算命中（起点落在区间内，或时长跨过区间）。 */
export function notesInRange(notes: Note[], range: { startTime: number; endTime: number; lowPitch: number; highPitch: number }) {
  return notes
    .filter(note => note.pitch >= range.lowPitch && note.pitch <= range.highPitch && note.start < range.endTime && note.start + note.duration > range.startTime)
    .map(note => note.id)
}

export type SelectionSummary = { count: number; lowPitch: number; highPitch: number; minStart: number; maxEnd: number; minVelocity: number; maxVelocity: number }

export function summarizeSelection(notes: Note[], ids: Iterable<string>): SelectionSummary | null {
  const target = asSet(ids)
  const picked = notes.filter(note => target.has(note.id))
  if (!picked.length) return null
  return {
    count: picked.length,
    lowPitch: lowest(picked.map(note => note.pitch)),
    highPitch: highest(picked.map(note => note.pitch)),
    minStart: round(lowest(picked.map(note => note.start))),
    maxEnd: round(highest(picked.map(note => note.start + note.duration))),
    minVelocity: lowest(picked.map(note => note.velocity)),
    maxVelocity: highest(picked.map(note => note.velocity)),
  }
}
