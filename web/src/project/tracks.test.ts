import assert from 'node:assert/strict'
import test from 'node:test'
import type { Project, Track } from './model.ts'
import { ROLL_HIGH_PITCH, ROLL_LOW_PITCH } from './notes.ts'
import {
  canRemoveTrack,
  createTrack,
  duplicateTrack,
  drumPartLabel,
  drumVoice,
  instrumentLabel,
  instrumentOptions,
  isDrumTrack,
  MAX_TRACK_NAME,
  moveTrack,
  noteLabel,
  presetFor,
  removeTrack,
  renameTrack,
  rowIndexForPitch,
  setTrackInstrument,
  snapPitchToDrum,
  trackRows,
  uniqueTrackId,
  uniqueTrackName,
} from './tracks.ts'

const track = (patch: Partial<Track> = {}): Track => ({ id: 'track-1', name: '轨道 1', kind: 'midi', instrument: '毛毡钢琴', color: '#7dd3fc', notes: [], gain: .8, pan: 0, muted: false, solo: false, start: 0, ...patch })
const project = (...tracks: Track[]): Project => ({ title: '测试', tempo: 90, key: 'C minor', duration: 8, tracks })

test('presetFor 支持 id、中文名和英文写法', () => {
  assert.equal(presetFor('drums')?.label, '鼓组')
  assert.equal(presetFor('毛毡钢琴')?.id, 'felt_piano')
  assert.equal(presetFor('Felt Piano')?.id, 'felt_piano')
  assert.equal(presetFor('DRUM KIT')?.id, 'drums')
  assert.equal(presetFor('granular-pad')?.id, 'granular_pad')
  assert.equal(presetFor('不知名音色'), undefined)
  assert.equal(presetFor(undefined), undefined)
})

test('instrumentLabel 对未知音色原样显示', () => {
  assert.equal(instrumentLabel('鼓组'), '鼓组')
  assert.equal(instrumentLabel('Cello'), '大提琴')
  assert.equal(instrumentLabel('Theremin'), 'Theremin')
  assert.equal(instrumentLabel(undefined), '合成音色')
})

test('isDrumTrack 只认 MIDI 轨的鼓组', () => {
  assert.equal(isDrumTrack(track({ instrument: '鼓组' })), true)
  assert.equal(isDrumTrack(track({ instrument: 'Drum Kit' })), true)
  assert.equal(isDrumTrack(track({ instrument: '鼓组', kind: 'audio' })), false)
  assert.equal(isDrumTrack(track({ instrument: '大提琴' })), false)
  assert.equal(isDrumTrack(undefined), false)
})

test('鼓件映射取最接近的鼓件', () => {
  assert.equal(drumVoice(36), 'kick')
  assert.equal(drumVoice(38), 'snare')
  assert.equal(drumVoice(42), 'hat')
  assert.equal(drumVoice(46), 'openhat')
  assert.equal(drumVoice(47), 'tom')
  assert.equal(drumVoice(49), 'crash')
  assert.equal(drumVoice(30), 'kick')
  assert.equal(drumVoice(90), 'tom')
  assert.equal(drumPartLabel(38), '军鼓')
  assert.equal(drumPartLabel(41), '闭镲')
  assert.equal(snapPitchToDrum(41), 42)
  assert.equal(snapPitchToDrum(36), 36)
})

test('trackRows 普通轨是半音阶、鼓组轨是鼓件行', () => {
  const chromatic = trackRows(track())
  assert.equal(chromatic.length, ROLL_HIGH_PITCH - ROLL_LOW_PITCH + 1)
  assert.equal(chromatic[0].pitch, ROLL_HIGH_PITCH)
  assert.equal(chromatic.at(-1)?.pitch, ROLL_LOW_PITCH)
  assert.equal(chromatic[0].label, 'C6')
  assert.equal(chromatic[0].black, false)
  assert.equal(chromatic[1].label, 'B5')
  assert.equal(chromatic[1].black, false)
  assert.equal(chromatic[2].black, true)

  const drums = trackRows(track({ instrument: '鼓组' }))
  assert.deepEqual(drums.map(row => row.pitch), [50, 49, 48, 47, 46, 45, 42, 39, 38, 36])
  assert.deepEqual(drums.map(row => row.label), ['高鼓', '吊镲', '中高鼓', '中鼓', '开镲', '落地鼓', '闭镲', '拍手', '军鼓', '底鼓'])
  assert.ok(drums.every(row => !row.black))
})

test('行定位与音符标签', () => {
  const chromatic = trackRows(track())
  assert.equal(chromatic[rowIndexForPitch(chromatic, ROLL_HIGH_PITCH)].pitch, ROLL_HIGH_PITCH)
  assert.equal(rowIndexForPitch(chromatic, 60), ROLL_HIGH_PITCH - 60)
  const drums = trackRows(track({ instrument: '鼓组' }))
  assert.equal(drums[rowIndexForPitch(drums, 36)].label, '底鼓')
  // Agent 写出来的 60 也要落在某一行上，而不是越界。
  assert.equal(rowIndexForPitch(drums, 60), 0)
  assert.equal(noteLabel(track({ instrument: '鼓组' }), 38), '军鼓')
  assert.equal(noteLabel(track(), 60), 'C4')
})

test('uniqueTrackId / uniqueTrackName 避开冲突', () => {
  const filled = project(track({ id: 'track-1' }), track({ id: 'track-2', name: '轨道 2' }))
  assert.equal(uniqueTrackId(filled), 'track-3')
  assert.equal(uniqueTrackId(filled, 'drums'), 'drums-1')
  assert.equal(uniqueTrackName(filled, '轨道 1'), '轨道 1 2')
  assert.equal(uniqueTrackName(filled, '大提琴'), '大提琴')
  assert.equal(uniqueTrackName(project(), '   '), '新轨道')
})

test('createTrack 用预设补全颜色与默认混音', () => {
  const created = createTrack(project(), '鼓组')
  assert.equal(created.kind, 'midi')
  assert.equal(created.instrument, '鼓组')
  assert.equal(created.name, '鼓组')
  assert.deepEqual(created.notes, [])
  assert.equal(created.gain, .8)
  assert.equal(created.pan, 0)
  assert.equal(created.start, 0)
  assert.equal(created.color, '#fbbf24')

  const named = createTrack(project(track({ name: '大提琴' })), '大提琴', '大提琴')
  assert.equal(named.name, '大提琴 2')
  assert.equal(createTrack(project(), 'Theremin').instrument, 'Theremin')
})

test('duplicateTrack 深拷贝音符并插在源轨道后面', () => {
  const source = track({ notes: [{ id: 'n1', pitch: 60, start: 1, duration: .5, velocity: 90 }, { id: 'n2', pitch: 64, start: 2, duration: .5, velocity: 80 }] })
  const base = project(source, track({ id: 'track-2', name: '大提琴' }))
  const next = duplicateTrack(base, 'track-1')
  assert.equal(next.tracks.length, 3)
  assert.equal(next.tracks[1].name, '轨道 1 副本')
  assert.notEqual(next.tracks[1].id, 'track-1')
  assert.deepEqual(next.tracks[1].notes?.map(note => note.pitch), [60, 64])
  assert.notEqual(next.tracks[1].notes?.[0].id, 'n1')
  assert.equal(next.tracks[1].notes?.[0].start, 1)
  // 原轨道和它的音符没被改动。
  assert.deepEqual(base.tracks[0].notes?.map(note => note.id), ['n1', 'n2'])
  assert.equal(duplicateTrack(base, 'missing'), base)
})

test('removeTrack 不允许删掉最后一条轨道', () => {
  const base = project(track(), track({ id: 'track-2' }))
  assert.equal(removeTrack(base, 'track-2').tracks.length, 1)
  assert.equal(canRemoveTrack(base, 'track-1'), true)
  const single = project(track())
  assert.equal(removeTrack(single, 'track-1'), single)
  assert.equal(canRemoveTrack(single, 'track-1'), false)
  assert.equal(removeTrack(base, 'missing'), base)
})

test('moveTrack 排序并在边界处不产生变化', () => {
  const base = project(track({ id: 'a', name: 'A' }), track({ id: 'b', name: 'B' }), track({ id: 'c', name: 'C' }))
  assert.deepEqual(moveTrack(base, 'a', 1).tracks.map(item => item.id), ['b', 'a', 'c'])
  assert.deepEqual(moveTrack(base, 'c', -1).tracks.map(item => item.id), ['a', 'c', 'b'])
  assert.equal(moveTrack(base, 'a', -1), base)
  assert.equal(moveTrack(base, 'c', 1), base)
  assert.equal(moveTrack(base, 'missing', 1), base)
})

test('renameTrack 去空格、限长、无变化时返回原引用', () => {
  const base = project(track())
  assert.equal(renameTrack(base, 'track-1', '  主旋律  ').tracks[0].name, '主旋律')
  assert.equal(renameTrack(base, 'track-1', ''), base)
  assert.equal(renameTrack(base, 'track-1', '   '), base)
  assert.equal(renameTrack(base, 'track-1', '轨道 1'), base)
  assert.equal(renameTrack(base, 'missing', '新名字'), base)
  assert.equal(renameTrack(base, 'track-1', 'x'.repeat(80)).tracks[0].name.length, MAX_TRACK_NAME)
})

test('setTrackInstrument 换音色、换配色并把音高吸到鼓件上', () => {
  const base = project(track({ notes: [{ id: 'n1', pitch: 61, start: 1, duration: .25, velocity: 100 }] }))
  const drums = setTrackInstrument(base, 'track-1', '鼓组')
  assert.equal(drums.tracks[0].instrument, '鼓组')
  assert.equal(drums.tracks[0].color, '#fbbf24')
  assert.equal(drums.tracks[0].notes?.[0].pitch, 50)
  // 换回普通音色不会再改音高，也不会“反过来”变成别的乐器。
  assert.equal(setTrackInstrument(base, 'track-1', '毛毡钢琴'), base)
  assert.equal(setTrackInstrument(base, 'track-1', '不知名音色'), base)
  assert.equal(setTrackInstrument(project(track({ kind: 'audio', instrument: 'SFX' })), 'track-1', '鼓组').tracks[0].instrument, 'SFX')
})

test('instrumentOptions 保留未知乐器作为独立选项', () => {
  const midi = instrumentOptions(track())
  assert.ok(midi.some(option => option.value === '鼓组'))
  assert.equal(midi.some(option => option.label.includes('自定义')), false)
  const custom = instrumentOptions(track({ instrument: 'Theremin' }))
  assert.equal(custom.at(-1)?.value, 'Theremin')
  assert.ok(custom.at(-1)?.label.includes('自定义'))
  // 音频轨只列音频预设（当前没有音频预设，所以是空列表，不能混进 MIDI 乐器）。
  assert.deepEqual(instrumentOptions(track({ kind: 'audio', instrument: 'SFX' })), [])
})

test('每个鼓件行都能落到一个打击乐音色，吸附结果稳定', () => {
  const voices = ['kick', 'snare', 'clap', 'hat', 'openhat', 'tom', 'crash']
  for (const row of trackRows(track({ instrument: '鼓组' }))) {
    assert.ok(voices.includes(drumVoice(row.pitch)), `${row.label}(${row.pitch}) 应该有音色`)
    assert.equal(snapPitchToDrum(row.pitch), row.pitch, `${row.label} 吸附后不应该变`)
  }
  // 底鼓、军鼓、闭镲、开镲、吊镲必须各不相同，否则听不出来是鼓组。
  assert.deepEqual(['kick', 'snare', 'hat', 'openhat', 'crash'].map((_, index) => drumVoice([36, 38, 42, 46, 49][index])), ['kick', 'snare', 'hat', 'openhat', 'crash'])
})
