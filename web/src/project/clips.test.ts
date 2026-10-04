import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeSoundClip, type SoundMixer } from '../audio/sfxPreview.ts'
import { CLIP_MIN_DURATION, LOCAL_SOUND_CLIP_PREFIX, type Clip, type Project, type Track } from './model.ts'
import {
  clipAt,
  clipDurationFor,
  clipSourceLabel,
  clipsOf,
  createClip,
  makeClipIds,
  moveClip,
  removeClip,
  setClipFade,
  setClipGain,
  setTrackClips,
  splitClip,
  trimClipEdge,
} from './clips.ts'

// 与源码同目录，用 Node 自带的测试运行器执行：node --test "src/**/*.test.ts"

const mixer: SoundMixer = { length: 3.2, density: 42, brightness: 64, space: 78, compact: 35 }
const clip = (over: Partial<Clip> = {}): Clip => ({ id: 'clip-1', source: '/generated/a.wav', start: 1, offset: 0, duration: 2, fadeIn: 0, fadeOut: 0, gain: 1, ...over })
const audioTrack = (over: Partial<Track> = {}): Track => ({ id: 'ai-music', name: 'AI 生成音频', kind: 'audio', instrument: 'Audio Model', color: '#c4b5fd', clips: [clip()], gain: .8, ...over })
const project = (track: Track): Project => ({ title: '测试', tempo: 92, key: 'C', duration: 10, tracks: [track] })

test('clipsOf 把老工程的单片段字段升级成片段数组', () => {
  const local = encodeSoundClip('冰面开裂', mixer)
  const upgraded = clipsOf(audioTrack({ clips: undefined, clip: local }))
  assert.equal(upgraded.length, 1)
  assert.equal(upgraded[0].source, local)
  assert.equal(upgraded[0].start, 0)
  assert.equal(upgraded[0].offset, 0)
  assert.equal(upgraded[0].duration, mixer.length, '本地音效的长度取自声音计划的 mixer.length')
  assert.equal(upgraded[0].gain, 1)
  // 没有音频来源的轨道不该凭空多出片段
  assert.deepEqual(clipsOf(audioTrack({ clips: undefined, clip: undefined })), [])
  assert.deepEqual(clipsOf(undefined), [])
  assert.equal(clipsOf(audioTrack())[0].id, 'clip-1')
})

test('clipDurationFor 只对本地音效计划读参数，其它来源用兜底时长', () => {
  assert.equal(clipDurationFor(encodeSoundClip('低频轰鸣', mixer)), mixer.length)
  assert.equal(clipDurationFor(`${LOCAL_SOUND_CLIP_PREFIX}bm90LWpzb24=`), 4, '坏掉的计划回落到兜底值')
  assert.equal(clipDurationFor('/generated/a.wav', 7), 7)
  assert.equal(clipDurationFor('https://example.com/a.mp3'), 4)
})

test('makeClipIds / createClip 给出不冲突的 id，并且数值一开始就合法', () => {
  assert.deepEqual(makeClipIds([], 2), ['clip-1', 'clip-2'])
  assert.deepEqual(makeClipIds([clip({ id: 'clip-1' }), clip({ id: 'clip-2' })], 1), ['clip-3'])
  const created = createClip([clip({ id: 'clip-1' })], '/generated/b.wav', -5, 0)
  assert.equal(created.id, 'clip-2')
  assert.equal(created.start, 0, '起点不能是负数')
  assert.equal(created.duration, CLIP_MIN_DURATION, '时长不能小于最短时长')
  assert.equal(created.gain, 1)
})

test('moveClip 钳制在 0 与工程时长之间，没有变化时返回同一个数组', () => {
  const clips = [clip()]
  assert.equal(moveClip(clips, 'clip-1', 0), clips)
  assert.equal(moveClip(clips, 'nope', 1), clips)
  assert.equal(moveClip(clips, 'clip-1', .5)[0].start, 1.5)
  assert.equal(moveClip(clips, 'clip-1', -5)[0].start, 0)
  assert.equal(moveClip(clips, 'clip-1', 99, 10)[0].start, 8, '不能推出工程时长')
  assert.equal(moveClip(clips, 'clip-1', 99)[0].start, 100, '没有给上限时不限制')
})

test('拖左边缘：起点与入点一起走，受素材头部、时间线 0 点与最短时长限制', () => {
  const base = [clip({ start: 2, offset: 1, duration: 3 })]
  const trimmed = trimClipEdge(base, 'clip-1', 'start', .5)[0]
  assert.deepEqual([trimmed.start, trimmed.offset, trimmed.duration], [2.5, 1.5, 2.5])
  // 往左拖最多把入点推到 0
  const extended = trimClipEdge(base, 'clip-1', 'start', -5)[0]
  assert.deepEqual([extended.start, extended.offset, extended.duration], [1, 0, 4])
  // 起点已经在 0 时没法再把素材往前露出来，整段不动
  const atZero = trimClipEdge([clip({ start: 0, offset: 2, duration: 3 })], 'clip-1', 'start', -1)[0]
  assert.deepEqual([atZero.start, atZero.offset, atZero.duration], [0, 2, 3])
  // 往右拖不能短于最短时长
  const tiny = trimClipEdge(base, 'clip-1', 'start', 99)[0]
  assert.equal(tiny.duration, CLIP_MIN_DURATION)
  assert.equal(trimClipEdge(base, 'clip-1', 'start', 0), base)
})

test('拖右边缘：只改时长，守住最短时长与工程时长', () => {
  const base = [clip({ start: 1, duration: 2 })]
  assert.equal(trimClipEdge(base, 'clip-1', 'end', 1)[0].duration, 3)
  assert.equal(trimClipEdge(base, 'clip-1', 'end', -99)[0].duration, CLIP_MIN_DURATION)
  const capped = trimClipEdge(base, 'clip-1', 'end', 99, 10)[0]
  assert.equal(capped.duration, 9, '片段不能越过工程时长')
  assert.equal(capped.start, 1)
  assert.equal(trimClipEdge(base, 'clip-1', 'end', 0), base)
})

test('splitClip 在指定位置切成两段：右半段换新 id、入点顺延、淡入淡出各归一边', () => {
  const base = [clip({ start: 1, offset: .5, duration: 4, fadeIn: .3, fadeOut: .6 })]
  const parts = splitClip(base, 'clip-1', 3)
  assert.equal(parts.length, 2)
  assert.deepEqual([parts[0].id, parts[0].start, parts[0].offset, parts[0].duration], ['clip-1', 1, .5, 2])
  assert.equal(parts[0].fadeIn, .3)
  assert.equal(parts[0].fadeOut, 0)
  assert.deepEqual([parts[1].id, parts[1].start, parts[1].offset, parts[1].duration], ['clip-2', 3, 2.5, 2])
  assert.equal(parts[1].fadeIn, 0)
  assert.equal(parts[1].fadeOut, .6)
  // 顺序保持：切出来的右半段紧跟在左半段后面
  const three = splitClip([clip({ id: 'a', start: 0, duration: 2 }), base[0]], 'clip-1', 3)
  assert.deepEqual(three.map(item => item.id), ['a', 'clip-1', 'clip-2'])
})

test('splitClip 在太靠边的位置不产生碎片，也不认识不存在的片段', () => {
  const base = [clip({ start: 1, duration: 2 })]
  assert.equal(splitClip(base, 'clip-1', 1), base)
  assert.equal(splitClip(base, 'clip-1', 1 + CLIP_MIN_DURATION / 2), base)
  assert.equal(splitClip(base, 'clip-1', 3), base)
  assert.equal(splitClip(base, 'nope', 2), base)
})

test('淡入淡出互不重叠，增益被钳制到 0-1', () => {
  const base = [clip({ duration: 2, fadeIn: 0, fadeOut: 0 })]
  const faded = setClipFade(base, 'clip-1', 'in', .8)[0]
  assert.equal(faded.fadeIn, .8)
  assert.equal(setClipFade(base, 'clip-1', 'in', 99)[0].fadeIn, 2, '淡入不能超过片段长度')
  const both = setClipFade([clip({ duration: 2, fadeIn: 1.5 })], 'clip-1', 'out', 99)[0]
  assert.deepEqual([both.fadeIn, both.fadeOut], [1.5, .5], '淡出只能吃到剩下的长度')
  assert.equal(setClipFade(base, 'clip-1', 'in', 0), base)
  assert.equal(setClipGain(base, 'clip-1', 2)[0].gain, 1)
  assert.equal(setClipGain(base, 'clip-1', -1)[0].gain, 0)
  assert.equal(setClipGain(base, 'clip-1', 1), base)
})

test('removeClip 按 id 删除，找不到时返回同一个数组', () => {
  const base = [clip({ id: 'a' }), clip({ id: 'b' })]
  assert.deepEqual(removeClip(base, 'a').map(item => item.id), ['b'])
  assert.equal(removeClip(base, 'nope'), base)
})

test('clipAt 做命中测试，clipSourceLabel 给出来源类型', () => {
  const base = [clip({ id: 'a', start: 1, duration: 2 }), clip({ id: 'b', start: 4, duration: 1 })]
  assert.equal(clipAt(base, .5), undefined)
  assert.equal(clipAt(base, 1)?.id, 'a')
  assert.equal(clipAt(base, 2.9)?.id, 'a')
  assert.equal(clipAt(base, 3)?.id, undefined, '片段之间的空隙没有命中')
  assert.equal(clipAt(base, 4.5)?.id, 'b')
  assert.equal(clipSourceLabel('/generated/x.wav'), 'AI AUDIO')
  assert.equal(clipSourceLabel(encodeSoundClip('风', mixer)), 'LOCAL SFX')
  assert.equal(clipSourceLabel('https://example.com/a.mp3'), 'AUDIO')
  assert.equal(clipSourceLabel('声音计划文本'), 'NO AUDIO')
  assert.equal(clipSourceLabel(undefined), 'NO AUDIO')
})

test('setTrackClips 内容没变时返回同一个 Project 引用，写入时顺手清掉老字段', () => {
  const legacy = project(audioTrack({ clips: undefined, clip: '/generated/a.wav' }))
  assert.equal(setTrackClips(legacy, 'ai-music', clipsOf(legacy.tracks[0])), legacy, '老片段升级后没改动就不该写回')
  assert.equal(setTrackClips(legacy, 'nope', [clip()]), legacy)
  const next = setTrackClips(legacy, 'ai-music', [clip({ start: 3 })])
  assert.notEqual(next, legacy)
  assert.equal(next.tracks[0].clips?.[0].start, 3)
  assert.equal(next.tracks[0].clip, undefined, '升级后不该再留着老的 clip 字段')
  assert.equal(legacy.tracks[0].clips, undefined, '原工程不能被就地修改')
})

test('所有片段操作在“没有变化”时都返回同一个数组引用', () => {
  const base = [clip({ start: 2, duration: 2, fadeIn: .5, fadeOut: .5 })]
  const same: Clip[][] = [
    moveClip(base, 'clip-1', 0),
    trimClipEdge(base, 'clip-1', 'start', 0),
    trimClipEdge(base, 'clip-1', 'end', 0),
    splitClip(base, 'clip-1', 2),
    setClipFade(base, 'clip-1', 'in', .5),
    setClipGain(base, 'clip-1', 1),
    removeClip(base, 'nope'),
  ]
  for (const result of same) assert.equal(result, base)
})
