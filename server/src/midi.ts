/** 标准 MIDI 文件（SMF format 1）生成：纯函数，方便单测与复用。 */

export type MidiNote = { pitch: number; start: number; duration: number; velocity: number }
export type MidiTrackInput = { name: string; notes: MidiNote[] }

export class MidiExportError extends Error {}

/** 每四分音符的 tick 数（写进 MThd 的 division 字段）。 */
export const PPQ = 480

function varLen(value: number) {
  const bytes = [value & 0x7f]
  let v = value >>> 7
  while (v) { bytes.unshift((v & 0x7f) | 0x80); v >>>= 7 }
  return bytes
}
function u16(value: number) { return [(value >> 8) & 0xff, value & 0xff] }
function u32(value: number) { return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff] }
function textBytes(value: string) { return Array.from(new TextEncoder().encode(value)) }

/** 同一个音高上如果音符重叠，前一个音的 note-off 会提前关掉后一个音。
 *  导出前按音高分组排序，把重叠部分裁掉，保证导出的 MIDI 听感和网页播放一致。 */
export function clipOverlappingNotes(notes: MidiNote[]): MidiNote[] {
  const byPitch = new Map<number, MidiNote[]>()
  for (const note of notes) {
    const group = byPitch.get(note.pitch)
    if (group) group.push(note)
    else byPitch.set(note.pitch, [note])
  }
  const sanitized: MidiNote[] = []
  for (const group of byPitch.values()) {
    group.sort((a, b) => a.start - b.start)
    group.forEach((note, index) => {
      const next = group[index + 1]
      const end = next ? Math.min(note.start + note.duration, Math.max(note.start, next.start)) : note.start + note.duration
      sanitized.push({ ...note, duration: Math.max(.01, end - note.start) })
    })
  }
  return sanitized
}

/** 生成单个 MTrk chunk。第一个轨道额外写速度（tempo meta）事件。 */
function trackChunk(track: MidiTrackInput, tempo: number, isFirst: boolean): number[] {
  const events: Array<{ tick: number; order: number; bytes: number[] }> = []
  const trackName = textBytes(track.name)
  events.push({ tick: 0, order: 0, bytes: [0xff, 0x03, trackName.length, ...trackName] })
  if (isFirst) {
    const mpqn = Math.round(60000000 / tempo)
    events.push({ tick: 0, order: 1, bytes: [0xff, 0x51, 0x03, (mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff] })
  }
  for (const note of clipOverlappingNotes(track.notes)) {
    const on = Math.max(0, Math.round(note.start * tempo / 60 * PPQ))
    const off = Math.max(on + 1, Math.round((note.start + note.duration) * tempo / 60 * PPQ))
    events.push({ tick: on, order: 2, bytes: [0x90, note.pitch, Math.max(1, Math.min(127, Math.round(note.velocity)))] })
    events.push({ tick: off, order: 1, bytes: [0x80, note.pitch, 0] })
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  let lastTick = 0
  const body: number[] = []
  for (const event of events) {
    body.push(...varLen(Math.max(0, event.tick - lastTick)), ...event.bytes)
    lastTick = event.tick
  }
  body.push(0x00, 0xff, 0x2f, 0x00)
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body]
}

/** 把若干 MIDI 轨道拼成一个 format 1 的 `.mid` 文件。没有轨道时抛 MidiExportError。 */
export function buildMidiFile(tempo: number, tracks: MidiTrackInput[]): Buffer {
  if (!tracks.length) throw new MidiExportError('当前工程没有 MIDI 轨道。')
  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(PPQ)]
  const chunks = tracks.map((track, index) => trackChunk(track, tempo, index === 0))
  return Buffer.from([...header, ...chunks.flat()])
}

/** 供测试与调试：暴露可变长数量编码。 */
export const encodeVarLen = varLen
