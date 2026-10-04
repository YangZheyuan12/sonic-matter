import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PPQ, MidiExportError, buildMidiFile, clipOverlappingNotes, encodeVarLen, type MidiNote } from './midi.ts'

// 与源码同目录，用 Node 自带的测试运行器执行：node --test "src/**/*.test.ts"

const note = (pitch: number, start: number, duration: number, velocity = 90): MidiNote => ({ pitch, start, duration, velocity })

/** 把生成出来的 `.mid` 拆回 chunk，用于断言字节结构。 */
function parse(buffer: Buffer) {
  assert.equal(buffer.subarray(0, 4).toString('latin1'), 'MThd', '文件必须以 MThd 开头')
  const headerLength = buffer.readUInt32BE(4)
  const format = buffer.readUInt16BE(8)
  const trackCount = buffer.readUInt16BE(10)
  const division = buffer.readUInt16BE(12)
  const chunks: Array<{ id: string; body: Buffer }> = []
  let offset = 8 + headerLength
  while (offset < buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString('latin1')
    const length = buffer.readUInt32BE(offset + 4)
    chunks.push({ id, body: buffer.subarray(offset + 8, offset + 8 + length) })
    offset += 8 + length
  }
  return { format, trackCount, division, chunks, end: offset }
}

const indexOfBytes = (haystack: Buffer, needle: number[]) => haystack.indexOf(Buffer.from(needle))

test('buildMidiFile 写出 format 1 头信息，chunk 长度自洽且没有多余字节', () => {
  const file = buildMidiFile(120, [
    { name: 'melody', notes: [note(60, 0, 0.5)] },
    { name: 'bass', notes: [note(36, 0, 1)] },
  ])
  const { format, trackCount, division, chunks, end } = parse(file)

  assert.equal(format, 1)
  assert.equal(trackCount, 2)
  assert.equal(division, PPQ)
  assert.equal(chunks.length, 2)
  assert.equal(end, file.length, 'chunk 之外不应该有剩余字节')
  for (const chunk of chunks) assert.equal(chunk.id, 'MTrk')
  // 每个 MTrk 都必须以 end-of-track 结束
  for (const chunk of chunks) assert.equal(chunk.body.subarray(-4).toString('hex'), '00ff2f00')
})

test('轨道名与速度事件写在正确的位置', () => {
  const file = buildMidiFile(120, [
    { name: 'melody', notes: [note(60, 0, 0.5)] },
    { name: 'bass', notes: [note(36, 0, 1)] },
  ])
  const { chunks } = parse(file)

  // 00 FF 03 <len> melody
  assert.equal(indexOfBytes(chunks[0].body, [0x00, 0xff, 0x03, 6, 0x6d, 0x65, 0x6c, 0x6f, 0x64, 0x79]), 0)
  assert.equal(indexOfBytes(chunks[1].body, [0x00, 0xff, 0x03, 4, 0x62, 0x61, 0x73, 0x73]), 0)

  // 速度只写在第一个轨道：60000000 / 120 = 500000 = 0x07A120
  assert.ok(indexOfBytes(chunks[0].body, [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]) > 0)
  assert.equal(indexOfBytes(chunks[1].body, [0xff, 0x51, 0x03]), -1)
})

test('速度换算：120 BPM 下 1 秒 = 960 tick，note-on/off 带正确的 delta', () => {
  const [chunk] = parse(buildMidiFile(120, [{ name: 'melody', notes: [note(60, 1, 0.5, 100)] }])).chunks
  // 960 = 0x3C0 -> varLen 87 40；480 -> varLen 83 60
  assert.ok(indexOfBytes(chunk.body, [0x87, 0x40, 0x90, 60, 100]) > 0, 'note-on 应该在 960 tick')
  assert.ok(indexOfBytes(chunk.body, [0x83, 0x60, 0x80, 60, 0]) > 0, 'note-off 应该在 1440 tick')
})

test('velocity 与 pitch 会被钳制到 MIDI 合法范围', () => {
  const [chunk] = parse(buildMidiFile(120, [{ name: 'loud', notes: [note(200, 0, 0.25, 999)] }])).chunks
  assert.ok(indexOfBytes(chunk.body, [0x90, 200, 127]) > 0)
  const [quiet] = parse(buildMidiFile(120, [{ name: 'quiet', notes: [note(60, 0, 0.25, 0)] }])).chunks
  assert.ok(indexOfBytes(quiet.body, [0x90, 60, 1]) > 0)
})

test('clipOverlappingNotes 裁掉同音高的重叠部分', () => {
  const clipped = clipOverlappingNotes([note(60, 0, 1), note(60, 0.5, 1)].map(item => ({ ...item })))
  assert.deepEqual(clipped.map(item => item.duration), [0.5, 1])

  // 完全同起点时，前一个音被压到最小长度，避免 note-off 直接关掉后一个音
  const same = clipOverlappingNotes([note(60, 0.5, 1), note(60, 0.5, 1)])
  assert.deepEqual(same.map(item => item.duration), [0.01, 1])

  // 不同音高互不影响，不重叠的音符保持不变（输出按音高分组，与时间顺序无关）
  const mixed = clipOverlappingNotes([note(60, 0, 1), note(64, 0, 1), note(60, 2, 0.5)])
  assert.deepEqual(mixed.map(item => [item.pitch, item.duration]), [[60, 1], [60, 0.5], [64, 1]])
})

test('encodeVarLen 覆盖 1-4 字节编码', () => {
  assert.deepEqual(encodeVarLen(0), [0x00])
  assert.deepEqual(encodeVarLen(127), [0x7f])
  assert.deepEqual(encodeVarLen(128), [0x81, 0x00])
  assert.deepEqual(encodeVarLen(16383), [0xff, 0x7f])
  assert.deepEqual(encodeVarLen(16384), [0x81, 0x80, 0x00])
  assert.deepEqual(encodeVarLen(0x0fffffff), [0xff, 0xff, 0xff, 0x7f])
})

test('没有 MIDI 轨道时抛 MidiExportError，由路由层翻译成 400', () => {
  assert.throws(() => buildMidiFile(120, []), (error: unknown) => error instanceof MidiExportError && /没有 MIDI 轨道/.test(error.message))
})

test('鼓组轨道写在 MIDI channel 10，普通轨道仍在 channel 1', () => {
  const [drums, melody] = parse(buildMidiFile(120, [
    { name: '鼓组', drum: true, notes: [note(36, 0, 0.25, 110), note(38, 0.5, 0.25, 90)] },
    { name: 'melody', notes: [note(60, 0, 0.5, 100)] },
  ])).chunks
  assert.ok(indexOfBytes(drums.body, [0x99, 36, 110]) > 0, '底鼓用 note-on 0x99')
  assert.ok(indexOfBytes(drums.body, [0x89, 36, 0]) > 0, '底鼓用 note-off 0x89')
  assert.ok(indexOfBytes(drums.body, [0x99, 38, 90]) > 0)
  assert.equal(indexOfBytes(drums.body, [0x90, 36]), -1, '鼓组不应该出现 channel 1 的 note-on')
  assert.ok(indexOfBytes(melody.body, [0x90, 60, 100]) > 0)
})
