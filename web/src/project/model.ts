export type Note = {
  id: string
  pitch: number
  start: number
  duration: number
  velocity: number
}

/** 音频片段：一段素材在时间线上的一个区间。
 *  - `source` 可以是 `/generated/x.wav`、`local-sfx:<base64>`、`data:`、`blob:`、`http(s)://`
 *  - `offset` 是素材内部的入点，`duration` 是片段时长，裁剪就是改这两个值
 *  - `fadeIn` / `fadeOut` / `gain` 在播放与导出时统一应用，不修改素材本身 */
export type Clip = {
  id: string
  source: string
  start: number
  offset: number
  duration: number
  fadeIn: number
  fadeOut: number
  gain: number
}

export type Track = {
  id: string
  name: string
  kind: 'midi' | 'audio'
  instrument: string
  color: string
  notes?: Note[]
  /** 旧的单片段字段：只在读取老工程时出现，代码里请统一用 clipsOf(track)。 */
  clip?: string
  clips?: Clip[]
  gain?: number
  pan?: number
  muted?: boolean
  solo?: boolean
  start?: number
}

export type Story = { time: string; title: string; text: string; color: string }

export type Project = {
  title: string
  tempo: number
  key: string
  duration?: number
  masterGain?: number
  concept?: { word: string; title: string; story: Story[] }
  tracks: Track[]
}

/** 十二平均律音名，钢琴卷帘与时间轴共用。 */
export const PITCH_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const

export const pitchName = (pitch: number) => `${PITCH_NAMES[((Math.round(pitch) % 12) + 12) % 12]}${Math.floor(Math.round(pitch) / 12) - 1}`

export const projectDuration = (project: Project) => Math.max(1, Math.min(120, project.duration ?? 10))
export const trackGain = (track: Track) => Math.max(0, Math.min(1, track.gain ?? .8))
export const trackPan = (track: Track) => Math.max(-1, Math.min(1, track.pan ?? 0))
export const trackStart = (track: Track) => Math.max(0, track.start ?? 0)

/** 片段最短时长：比这更短的裁剪 / 分割都当作没有变化，避免出现零长片段。 */
export const CLIP_MIN_DURATION = .1

export const clipEnd = (clip: Clip) => clip.start + clip.duration

/** 片段的时间一律精确到毫秒：浮点误差既会让“有没有变化”判断失灵，也会把工程 JSON 弄脏。 */
const clean = (value: number) => Math.round(value * 1000) / 1000

/** 把片段的数值收进合法范围：非负起点 / 入点、最短时长、淡入淡出不超过时长、增益 0-1。 */
export function clampClip(clip: Clip): Clip {
  const duration = Math.max(CLIP_MIN_DURATION, clean(clip.duration))
  const fadeIn = Math.max(0, clean(Math.min(clip.fadeIn, duration)))
  return {
    ...clip,
    start: Math.max(0, clean(clip.start)),
    offset: Math.max(0, clean(clip.offset)),
    duration,
    fadeIn,
    fadeOut: Math.max(0, clean(Math.min(clip.fadeOut, duration - fadeIn))),
    gain: Math.max(0, clean(Math.min(1, clip.gain))),
  }
}

/** 本地渲染音效的 clip 前缀：`local-sfx:<base64(JSON)>`，播放时由浏览器合成器还原。 */
export const LOCAL_SOUND_CLIP_PREFIX = 'local-sfx:'

/** 音频来源是否真的能被渲染出声（服务端生成文件 / 内联音频 / 本地音效计划）。
 *  只写入了计划文本、没有音频来源的轨道会被判定为不可播放，避免出现“有轨道但没声音”。 */
export function isPlayableClip(source?: string) {
  if (typeof source !== 'string' || !source) return false
  return source.startsWith('/generated/') || source.startsWith(LOCAL_SOUND_CLIP_PREFIX) || source.startsWith('data:audio/') || source.startsWith('blob:') || source.startsWith('http')
}

/** 录制旋律与“当前旋律”统一指向的 MIDI 轨：优先 id 为 melody 的轨道，否则第一条 MIDI 轨。 */
export function primaryMelodyTrack(project: Project) {
  return project.tracks.find(track => track.kind === 'midi' && track.id === 'melody') ?? project.tracks.find(track => track.kind === 'midi')
}

/** 从（可能来自用户文件或 Agent 的）任意对象里还原一个合法片段。 */
export function normalizeClip(raw: unknown, index: number): Clip {
  const clip = (raw ?? {}) as Partial<Clip>
  return clampClip({
    id: text(clip.id, `clip-${index + 1}`),
    source: text(clip.source, ''),
    start: Math.max(0, finite(clip.start, 0)),
    offset: Math.max(0, finite(clip.offset, 0)),
    duration: Math.max(CLIP_MIN_DURATION, finite(clip.duration, 2)),
    fadeIn: Math.max(0, finite(clip.fadeIn, 0)),
    fadeOut: Math.max(0, finite(clip.fadeOut, 0)),
    gain: Math.max(0, Math.min(1, finite(clip.gain, 1))),
  })
}

/** 工程里完全没有 MIDI 轨时，录制用的兜底轨道。 */
export function melodyTrackTemplate(notes: Note[] = []): Track {
  return { id: 'melody', name: '灵感旋律', kind: 'midi', instrument: 'Glass Keys', color: '#7dd3fc', notes, gain: .8, pan: 0, muted: false, solo: false, start: 0 }
}

export function audibleTracks(project: Project) {
  const hasSolo = project.tracks.some(track => track.solo)
  return project.tracks.filter(track => !track.muted && (!hasSolo || track.solo))
}

const finite = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
const text = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value : fallback

export function normalizeProject(value: unknown): Project {
  if (!value || typeof value !== 'object') throw new Error('工程文件不是有效的 JSON 对象。')
  const input = value as Partial<Project>
  if (!Array.isArray(input.tracks)) throw new Error('工程文件缺少 tracks 数组。')
  const tracks = input.tracks.map((raw, index): Track => {
    if (!raw || typeof raw !== 'object') throw new Error(`第 ${index + 1} 条轨道格式不正确。`)
    const track = raw as Track
    const kind = track.kind === 'audio' ? 'audio' : 'midi'
    const notes = kind === 'midi' && Array.isArray(track.notes) ? track.notes.map((note, noteIndex) => ({
      id: text(note?.id, `note-${index}-${noteIndex}`),
      pitch: Math.round(Math.max(0, Math.min(127, finite(note?.pitch, 60)))),
      start: Math.max(0, finite(note?.start, 0)),
      duration: Math.max(.02, finite(note?.duration, .25)),
      velocity: Math.round(Math.max(1, Math.min(127, finite(note?.velocity, 90)))),
    })) : undefined
    return {
      id: text(track.id, `track-${index + 1}`),
      name: text(track.name, `轨道 ${index + 1}`),
      kind,
      instrument: text(track.instrument, kind === 'midi' ? 'Synth' : 'Audio'),
      color: text(track.color, '#7dd3fc'),
      notes,
      clip: typeof track.clip === 'string' ? track.clip : undefined,
      clips: Array.isArray(track.clips) ? track.clips.map((clip, clipIndex) => normalizeClip(clip, clipIndex)) : undefined,
      gain: Math.max(0, Math.min(1, finite(track.gain, .8))),
      pan: Math.max(-1, Math.min(1, finite(track.pan, 0))),
      muted: Boolean(track.muted),
      solo: Boolean(track.solo),
      start: Math.max(0, finite(track.start, 0)),
    }
  })
  if (!tracks.length) throw new Error('工程至少需要一条轨道。')
  return {
    title: text(input.title, '未命名工程'),
    tempo: Math.max(20, Math.min(300, finite(input.tempo, 92))),
    key: text(input.key, 'C Major'),
    duration: Math.max(1, Math.min(120, finite(input.duration, 10))),
    masterGain: Math.max(0, Math.min(1, finite(input.masterGain, .9))),
    concept: input.concept,
    tracks,
  }
}

export function loadLocalProject(fallback: Project): Project {
  try {
    const saved = localStorage.getItem('sonic-matter-project')
    return saved ? normalizeProject(JSON.parse(saved)) : normalizeProject(fallback)
  } catch {
    return normalizeProject(fallback)
  }
}
