import { pitchName, type Project, type Track } from './model.ts'
import { makeNoteIds, ROLL_HIGH_PITCH, ROLL_LOW_PITCH, sortNotes } from './notes.ts'

/**
 * 轨道管理的纯逻辑：乐器预设、鼓组映射、增删改排序。
 *
 * 约定（和历史栈配合）：只要这次操作没有产生实际变化，函数就 **原样返回传入的
 * Project 引用**。App 里的 applyProject 会把「返回同一引用」当成「没有变化」，
 * 于是不会往撤销栈里塞空步骤。
 */

export type DrumVoice = 'kick' | 'snare' | 'clap' | 'hat' | 'openhat' | 'tom' | 'crash'

export type InstrumentPreset = {
  /** 稳定 id：写进 JSON 便于以后换文案。 */
  id: string
  /** 界面上显示的名字，也是本地新建轨道写进 Track.instrument 的值。 */
  label: string
  kind: 'midi' | 'audio'
  color: string
  /** 鼓组：钢琴卷帘会换成鼓件行，合成器也换成打击乐音色。 */
  drum?: boolean
}

export const INSTRUMENT_PRESETS: readonly InstrumentPreset[] = [
  { id: 'felt_piano', label: '毛毡钢琴', kind: 'midi', color: '#7dd3fc' },
  { id: 'glass_bell', label: '玻璃钟琴', kind: 'midi', color: '#a5f3fc' },
  { id: 'cello', label: '大提琴', kind: 'midi', color: '#fca5a5' },
  { id: 'string_ensemble', label: '弦乐群', kind: 'midi', color: '#fdba74' },
  { id: 'sub_bass', label: '低音 Sub', kind: 'midi', color: '#818cf8' },
  { id: 'granular_pad', label: '颗粒铺底', kind: 'midi', color: '#c4b5fd' },
  { id: 'synth_lead', label: '合成主音', kind: 'midi', color: '#f0abfc' },
  { id: 'brass', label: '铜管', kind: 'midi', color: '#fcd34d' },
  { id: 'airy_voice', label: '气声人声', kind: 'midi', color: '#f9a8d4' },
  { id: 'drums', label: '鼓组', kind: 'midi', color: '#fbbf24', drum: true },
]

export const DEFAULT_TRACK_COLOR = '#7dd3fc'
export const MAX_TRACK_NAME = 40

/** 鼓组音高映射：少数几个常用鼓件，覆盖 GM 里最常见的写法。 */
export const DRUM_PARTS: ReadonlyArray<{ pitch: number; label: string; voice: DrumVoice }> = [
  { pitch: 36, label: '底鼓', voice: 'kick' },
  { pitch: 38, label: '军鼓', voice: 'snare' },
  { pitch: 39, label: '拍手', voice: 'clap' },
  { pitch: 42, label: '闭镲', voice: 'hat' },
  { pitch: 45, label: '落地鼓', voice: 'tom' },
  { pitch: 46, label: '开镲', voice: 'openhat' },
  { pitch: 47, label: '中鼓', voice: 'tom' },
  { pitch: 48, label: '中高鼓', voice: 'tom' },
  { pitch: 49, label: '吊镲', voice: 'crash' },
  { pitch: 50, label: '高鼓', voice: 'tom' },
]


const presetKey = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, '')

const PRESETS_BY_ID = new Map(INSTRUMENT_PRESETS.map(preset => [preset.id, preset]))

const PRESET_BY_KEY = new Map<string, InstrumentPreset>()
for (const preset of INSTRUMENT_PRESETS) {
  PRESET_BY_KEY.set(presetKey(preset.id), preset)
  PRESET_BY_KEY.set(presetKey(preset.label), preset)
}

/**
 * 找乐器预设：先按 id、再按名字匹配；Agent 生成的轨道可能写了
 * 「Felt Piano」这类名字，匹配不上时看名字里有没有鼓/DRUM 关键词。
 */
export function presetFor(instrument: string | undefined): InstrumentPreset | undefined {
  if (!instrument) return undefined
  const exact = PRESET_BY_KEY.get(presetKey(instrument))
  if (exact) return exact
  if (/drum|perc|鼓|打击/i.test(instrument)) return PRESETS_BY_ID.get('drums')
  if (/piano|琴|键/i.test(instrument) && !/bell|钟/i.test(instrument)) return PRESETS_BY_ID.get('felt_piano')
  if (/bass|低音/i.test(instrument)) return PRESETS_BY_ID.get('sub_bass')
  if (/bell|glass|钟|玻璃/i.test(instrument)) return PRESETS_BY_ID.get('glass_bell')
  if (/cello|string|violin|弦/i.test(instrument)) return PRESETS_BY_ID.get('cello')
  if (/pad|ambient|granular|氛围|铺底/i.test(instrument)) return PRESETS_BY_ID.get('granular_pad')
  if (/lead|主音|synth|合成/i.test(instrument)) return PRESETS_BY_ID.get('synth_lead')
  return undefined
}

export const instrumentLabel = (instrument: string | undefined) => presetFor(instrument)?.label ?? (instrument?.trim() || '合成音色')

export function isDrumTrack(track: Track | undefined): boolean {
  if (!track || track.kind !== 'midi') return false
  return Boolean(presetFor(track.instrument)?.drum)
}

/** 鼓件的音色类型：先找完全一致的鼓件，再退到最接近的那个。 */
export function drumVoice(pitch: number): DrumVoice {
  const value = Math.round(pitch)
  let best = DRUM_PARTS[0]
  for (const part of DRUM_PARTS) if (Math.abs(part.pitch - value) < Math.abs(best.pitch - value)) best = part
  return best.voice
}

export function drumPartLabel(pitch: number): string {
  const value = Math.round(pitch)
  let best = DRUM_PARTS[0]
  for (const part of DRUM_PARTS) if (Math.abs(part.pitch - value) < Math.abs(best.pitch - value)) best = part
  return best.label
}

export type RollRow = { pitch: number; label: string; black: boolean }

/**
 * 卷帘行：普通 MIDI 轨是 48–84 的半音阶，鼓组轨换成鼓件行（高音在上）。
 * 每行带一个 pitch，卷帘只按行取音高，所以两种轨道共用同一套交互。
 */
export function trackRows(track: Track | undefined): RollRow[] {
  if (isDrumTrack(track)) {
    return [...DRUM_PARTS].sort((a, b) => b.pitch - a.pitch).map(part => ({ pitch: part.pitch, label: part.label, black: false }))
  }
  const rows: RollRow[] = []
  for (let pitch = ROLL_HIGH_PITCH; pitch >= ROLL_LOW_PITCH; pitch -= 1) {
    const semitone = ((pitch % 12) + 12) % 12
    rows.push({ pitch, label: pitchName(pitch), black: [1, 3, 6, 8, 10].includes(semitone) })
  }
  return rows
}

/** 找到离给定音高最近的行（鼓组里 Agent 可能写出 48 之类的音高，也要落在某一行上）。 */
export function rowIndexForPitch(rows: RollRow[], pitch: number): number {
  let best = 0
  for (let index = 1; index < rows.length; index += 1) {
    if (Math.abs(rows[index].pitch - pitch) < Math.abs(rows[best].pitch - pitch)) best = index
  }
  return best
}

/** 卷帘里显示音符名字：鼓组显示「军鼓」这类鼓件名。 */
export function noteLabel(track: Track | undefined, pitch: number): string {
  return isDrumTrack(track) ? drumPartLabel(pitch) : pitchName(pitch)
}

const trimName = (name: string | undefined) => (name ?? '').trim().slice(0, MAX_TRACK_NAME)

/** 生成不冲突的轨道 id（本地新建、复制都走这里）。 */
export function uniqueTrackId(project: Project, base = 'track'): string {
  const used = new Set(project.tracks.map(track => track.id))
  for (let index = 1; index < 999; index += 1) {
    const candidate = `${base}-${index}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/** 生成不冲突的轨道名：「毛毡钢琴」→「毛毡钢琴 2」。 */
export function uniqueTrackName(project: Project, base: string): string {
  const used = new Set(project.tracks.map(track => track.name))
  const trimmed = base.trim() || '新轨道'
  if (!used.has(trimmed)) return trimmed
  for (let index = 2; index < 999; index += 1) {
    const candidate = `${trimmed} ${index}`
    if (!used.has(candidate)) return candidate
  }
  return `${trimmed} ${Date.now().toString(36)}`
}

/** 新建一条空轨道：id / 名字都自动去重，混音参数给一套能直接听的默认值。 */
export function createTrack(project: Project, instrument: string, name?: string): Track {
  const preset = presetFor(instrument)
  return {
    id: uniqueTrackId(project),
    name: uniqueTrackName(project, trimName(name) || preset?.label || '新轨道'),
    kind: preset?.kind ?? 'midi',
    instrument: preset?.label ?? instrument,
    color: preset?.color ?? DEFAULT_TRACK_COLOR,
    notes: [],
    gain: .8,
    pan: 0,
    muted: false,
    solo: false,
    start: 0,
  }
}

export function insertTrack(project: Project, track: Track): Project {
  if (project.tracks.some(item => item.id === track.id)) return project
  return { ...project, tracks: [...project.tracks, track] }
}

/** 复制轨道：音符深拷贝 + 换新 id，插在源轨道后面，名字加「副本」。 */
export function duplicateTrack(project: Project, id: string): Project {
  const index = project.tracks.findIndex(track => track.id === id)
  if (index < 0) return project
  const source = project.tracks[index]
  const trackId = uniqueTrackId(project, 'track')
  const notes = sortNotes(source.notes ?? [])
  const ids = makeNoteIds(trackId, notes, notes.length)
  const copy: Track = {
    ...source,
    id: trackId,
    name: uniqueTrackName(project, `${source.name} 副本`),
    notes: notes.map((note, position) => ({ ...note, id: ids[position] })),
  }
  const next = [...project.tracks]
  next.splice(index + 1, 0, copy)
  return { ...project, tracks: next }
}

export function canRemoveTrack(project: Project, id: string): boolean {
  return project.tracks.length > 1 && project.tracks.some(track => track.id === id)
}

/** 删除轨道：最后一条不允许删（否则卷帘和导出会没有可编辑内容）。 */
export function removeTrack(project: Project, id: string): Project {
  if (!canRemoveTrack(project, id)) return project
  return { ...project, tracks: project.tracks.filter(track => track.id !== id) }
}

/** 上下移动轨道：到边界后原样返回，不产生撤销步骤。 */
export function moveTrack(project: Project, id: string, delta: number): Project {
  const index = project.tracks.findIndex(track => track.id === id)
  if (index < 0) return project
  const target = Math.min(project.tracks.length - 1, Math.max(0, index + (delta > 0 ? 1 : delta < 0 ? -1 : 0)))
  if (target === index) return project
  const next = [...project.tracks]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  return { ...project, tracks: next }
}

export function renameTrack(project: Project, id: string, name: string): Project {
  const trimmed = trimName(name)
  const track = project.tracks.find(item => item.id === id)
  if (!track || !trimmed || trimmed === track.name) return project
  return { ...project, tracks: project.tracks.map(item => item.id === id ? { ...item, name: trimmed } : item) }
}

/** 换乐器：同时带上预设配色，鼓组还会把不属于鼓件行的音高吸附到最近鼓件。 */
export function setTrackInstrument(project: Project, id: string, instrument: string): Project {
  const track = project.tracks.find(item => item.id === id)
  const preset = presetFor(instrument)
  if (!track || !preset || preset.kind !== track.kind || track.instrument === preset.label) return project
  const notes = preset.drum ? (track.notes ?? []).map(note => ({ ...note, pitch: snapPitchToDrum(note.pitch) })) : track.notes
  return { ...project, tracks: project.tracks.map(item => item.id === id ? { ...item, instrument: preset.label, color: preset.color, notes } : item) }
}

/** 把任意音高吸到最近的鼓件行上。 */
export function snapPitchToDrum(pitch: number): number {
  return DRUM_PARTS.reduce((best, part) => Math.abs(part.pitch - pitch) < Math.abs(best - pitch) ? part.pitch : best, DRUM_PARTS[0].pitch)
}

/** 供界面用：把轨道里的乐器名转成 `<select>` 的选项，未知乐器保留成一个选项。 */
export function instrumentOptions(track: Track): Array<{ value: string; label: string }> {
  const options = INSTRUMENT_PRESETS.filter(preset => preset.kind === track.kind).map(preset => ({ value: preset.label, label: preset.label }))
  if (track.kind === 'midi' && !presetFor(track.instrument)) options.push({ value: track.instrument, label: `${track.instrument}（自定义）` })
  return options
}

export function trackNoteCount(track: Track | undefined): number {
  return track?.notes?.length ?? 0
}
