import test from 'node:test'
import assert from 'node:assert/strict'
import {
  copyNotes,
  deleteNotes,
  FREE_STEP_SECONDS,
  makeNoteIds,
  mergeNotes,
  moveNotes,
  notesInRange,
  nudgeNotes,
  pasteNotes,
  pasteOffsetFor,
  quantizeNotes,
  replaceSelection,
  resizeNotes,
  ROLL_HIGH_PITCH,
  ROLL_LOW_PITCH,
  setVelocity,
  snapDuration,
  snapSeconds,
  snapTime,
  sortNotes,
  summarizeSelection,
  toggleSelection,
  type NoteWindow,
} from './notes.ts'
import type { Note } from './model.ts'

const window: NoteWindow = { duration: 8, snap: 0.5, lowPitch: ROLL_LOW_PITCH, highPitch: ROLL_HIGH_PITCH }

const note = (id: string, pitch: number, start: number, duration = 0.5, velocity = 90): Note => ({ id, pitch, start, duration, velocity })

test('snapSeconds 把网格换算成秒，off 表示自由输入', () => {
  assert.equal(snapSeconds('1/4', 0.5), 0.5)
  assert.equal(snapSeconds('1/8', 0.5), 0.25)
  assert.equal(snapSeconds('1/16', 0.5), 0.125)
  assert.equal(snapSeconds('off', 0.5), 0)
})

test('snapTime 吸附到网格并夹在工程范围内', () => {
  assert.equal(snapTime(1.13, 0.5, 8), 1)
  assert.equal(snapTime(1.31, 0.5, 8), 1.5)
  assert.equal(snapTime(-3, 0.5, 8), 0)
  assert.equal(snapTime(99, 0.5, 8), 7.5)
  assert.equal(snapTime(3.157, 0, 8), 3.157)
})

test('snapDuration 至少一个网格且不越过工程尾部', () => {
  assert.equal(snapDuration(0.31, 0, 0.5, 8), 0.5)
  assert.equal(snapDuration(0.9, 0, 0.5, 8), 1)
  assert.equal(snapDuration(6, 7.5, 0.5, 8), 0.5)
  assert.equal(snapDuration(0.01, 2, 0, 8), 0.02)
})

test('moveNotes 整组平移并保持相对间距', () => {
  const base = [note('a', 60, 1), note('b', 62, 2)]
  const moved = moveNotes(base, ['a', 'b'], { time: 0.5, pitch: 2 }, window)
  assert.deepEqual(moved.map(item => [item.pitch, item.start]), [[62, 1.5], [64, 2.5]])
})

test('moveNotes 只在选中的音符上生效', () => {
  const base = [note('a', 60, 1), note('b', 62, 2)]
  const moved = moveNotes(base, ['b'], { time: 1 }, window)
  assert.equal(moved.length, 1)
  assert.equal(moved[0].id, 'b')
})

test('moveNotes 把整组夹在工程尾部之前', () => {
  const base = [note('a', 60, 6.5, 0.5), note('b', 62, 7, 0.5)]
  const moved = moveNotes(base, ['a', 'b'], { time: 2 }, window)
  assert.deepEqual(moved.map(item => item.start), [7, 7.5])
  assert.deepEqual(moveNotes([note('a', 60, 7.5, 0.5)], ['a'], { time: 2 }, window), [])
})

test('moveNotes 把整组夹在音高窗口内', () => {
  const base = [note('a', 81, 1), note('b', 83, 2)]
  const moved = moveNotes(base, ['a', 'b'], { pitch: 5 }, window)
  assert.deepEqual(moved.map(item => item.pitch), [82, ROLL_HIGH_PITCH])
})

test('moveNotes 对已经越界的音符只做同方向夹紧', () => {
  const base = [note('a', 60, 7.5, 1)]
  assert.deepEqual(moveNotes(base, ['a'], { time: 1 }, window), [])
  assert.deepEqual(moveNotes(base, ['a'], { time: -1 }, window).map(item => item.start), [6.5])
  assert.deepEqual(moveNotes(base, ['a'], { pitch: 1 }, window).map(item => item.pitch), [61])
})

test('moveNotes 没有实际位移时返回空补丁', () => {
  const base = [note('a', ROLL_HIGH_PITCH, 1)]
  assert.deepEqual(moveNotes(base, ['a'], { pitch: 3 }, window), [])
  assert.deepEqual(moveNotes(base, [], { time: 1 }, window), [])
})

test('nudgeNotes 左右按网格、上下按半音，关闭吸附时用 50ms 步进', () => {
  const base = [note('a', 60, 1)]
  assert.deepEqual(nudgeNotes(base, ['a'], { steps: 2 }, window).map(item => item.start), [2])
  assert.deepEqual(nudgeNotes(base, ['a'], { semitones: 12 }, window).map(item => item.pitch), [72])
  const free = nudgeNotes(base, ['a'], { steps: 2 }, { duration: 8, snap: 0 })
  assert.deepEqual(free.map(item => item.start), [1.1])
})

test('resizeNotes 拉伸整组且单个音符不短于一个网格', () => {
  const base = [note('a', 60, 1, 0.5), note('b', 62, 2, 1)]
  const resized = resizeNotes(base, ['a', 'b'], 0.5, window)
  assert.deepEqual(resized.map(item => item.duration), [1, 1.5])
  const shrunk = resizeNotes(base, ['a', 'b'], -2, window)
  assert.deepEqual(shrunk.map(item => item.duration), [0.5, 0.5])
})

test('resizeNotes 不会把整组拖过工程尾部', () => {
  const base = [note('a', 60, 7, 0.5)]
  const resized = resizeNotes(base, ['a'], 5, window)
  assert.equal(resized[0].duration, 1)
  assert.equal(resized[0].start + resized[0].duration, 8)
})

test('quantizeNotes 把起点与时长吸附到网格', () => {
  const base = [note('a', 60, 1.13, 0.31), note('b', 62, 2.87, 0.9)]
  const quantized = quantizeNotes(base, ['a', 'b'], window)
  assert.deepEqual(quantized.map(item => [item.start, item.duration]), [[1, 0.5], [3, 1]])
})

test('quantizeNotes 在自由模式下不做任何事', () => {
  const base = [note('a', 60, 1.13, 0.31)]
  assert.deepEqual(quantizeNotes(base, ['a'], { duration: 8, snap: 0 }), [])
})

test('deleteNotes 只删除选中的音符', () => {
  const base = [note('a', 60, 1), note('b', 62, 2), note('c', 64, 3)]
  assert.deepEqual(deleteNotes(base, ['a', 'c']).map(item => item.id), ['b'])
})

test('setVelocity 统一力度并忽略没有变化的部分', () => {
  const base = [note('a', 60, 1, 0.5, 90), note('b', 62, 2, 0.5, 20)]
  assert.deepEqual(setVelocity(base, ['a', 'b'], 64).map(item => item.velocity), [64, 64])
  assert.deepEqual(setVelocity(base, ['a'], 900).map(item => item.velocity), [127])
  assert.deepEqual(setVelocity(base, ['a'], 90), [])
})

test('mergeNotes 把补丁合并回原列表并按时间排序', () => {
  const base = [note('a', 60, 1), note('b', 62, 2)]
  const merged = mergeNotes(base, [{ ...base[1], start: 0.25 }])
  assert.deepEqual(merged.map(item => [item.id, item.start]), [['b', 0.25], ['a', 1]])
  assert.equal(mergeNotes(base, []), base)
})

test('copyNotes 复制选中音符且不共享引用', () => {
  const base = [note('a', 60, 1), note('b', 62, 2)]
  const copied = copyNotes(base, ['a'])
  assert.deepEqual(copied.map(item => item.id), ['a'])
  assert.notEqual(copied[0], base[0])
})

test('pasteOffsetFor 优先贴播放头，播放头靠前时错开一格', () => {
  assert.equal(pasteOffsetFor(4, 1, 0.5), 3)
  assert.equal(pasteOffsetFor(1, 1, 0.5), 0.5)
  assert.equal(pasteOffsetFor(0, 1, 0.5), 0.5)
  assert.equal(pasteOffsetFor(0, 1, 0), FREE_STEP_SECONDS)
})

test('pasteNotes 平移整段、换新 id 并夹在工程范围内', () => {
  const base = [note('a', 60, 1, 0.5), note('b', 62, 2, 0.5)]
  const clip = copyNotes(base, ['a', 'b'])
  const pasted = pasteNotes(base, clip, { offset: 0.5, duration: 8, snap: 0.5, makeIds: count => makeNoteIds('melody', base, count) })
  assert.deepEqual(pasted.ids, ['roll-melody-1', 'roll-melody-2'])
  assert.deepEqual(sortNotes(pasted.notes).map(item => item.start), [1, 1.5, 2, 2.5])
  const pushed = pasteNotes(base, clip, { offset: 99, duration: 8, snap: 0.5, makeIds: count => makeNoteIds('melody', base, count) })
  assert.deepEqual(sortNotes(pushed.notes).filter(item => item.id.startsWith('roll-')).map(item => item.start), [6.5, 7.5])
})

test('pasteNotes 把粘贴到负时间的整段贴回 0', () => {
  const clip = [note('a', 60, 4, 0.5)]
  const pasted = pasteNotes([], clip, { offset: -10, duration: 8, snap: 0.5, makeIds: () => ['new-1'] })
  assert.deepEqual(pasted.notes.map(item => item.start), [0])
})

test('pasteNotes 把超出音高窗口的音符夹回窗口内', () => {
  const clip = [note('a', 120, 1, 0.5)]
  const pasted = pasteNotes([], clip, { offset: 0, duration: 8, snap: 0.5, makeIds: () => ['new-1'] })
  assert.equal(pasted.notes[0].pitch, ROLL_HIGH_PITCH)
})

test('pasteNotes 空剪贴板不做任何事', () => {
  const base = [note('a', 60, 1)]
  assert.equal(pasteNotes(base, [], { offset: 1, duration: 8, snap: 0.5, makeIds: () => [] }).notes, base)
})

test('makeNoteIds 接着最大序号生成且不与现有 id 冲突', () => {
  const first = makeNoteIds('melody', [], 2)
  assert.deepEqual(first, ['roll-melody-1', 'roll-melody-2'])
  const existing = [note('roll-melody-7', 60, 0), note('other', 60, 0)]
  assert.deepEqual(makeNoteIds('melody', existing, 2), ['roll-melody-8', 'roll-melody-9'])
  assert.deepEqual(makeNoteIds('melody', [note('roll-melody-1', 60, 0)], 1), ['roll-melody-2'])
})

test('notesInRange 框选相交的音符', () => {
  const base = [note('a', 60, 1, 1), note('b', 62, 4, 0.5), note('c', 90, 1, 1)]
  assert.deepEqual(notesInRange(base, { startTime: 1.5, endTime: 2.5, lowPitch: 48, highPitch: 84 }), ['a'])
  assert.deepEqual(notesInRange(base, { startTime: 0, endTime: 9, lowPitch: 48, highPitch: 84 }), ['a', 'b'])
})

test('summarizeSelection 汇总音高、时间与力度范围', () => {
  const base = [note('a', 60, 1, 1, 70), note('b', 64, 3, 0.5, 110)]
  assert.deepEqual(summarizeSelection(base, ['a', 'b']), { count: 2, lowPitch: 60, highPitch: 64, minStart: 1, maxEnd: 3.5, minVelocity: 70, maxVelocity: 110 })
  assert.equal(summarizeSelection(base, []), null)
})

test('toggleSelection 与 replaceSelection 覆盖单击和 Shift 加选', () => {
  assert.deepEqual(toggleSelection(['a'], 'b'), ['a', 'b'])
  assert.deepEqual(toggleSelection(['a', 'b'], 'a'), ['b'])
  assert.equal(replaceSelection(['a'], 'a').length, 1)
  assert.deepEqual(replaceSelection(['a', 'b'], 'c'), ['c'])
})

test('sortNotes 按起点再按音高排序', () => {
  const mixed = [note('c', 60, 1), note('a', 64, 1), note('b', 60, 0)]
  assert.deepEqual(sortNotes(mixed).map(item => item.id), ['b', 'a', 'c'])
})
