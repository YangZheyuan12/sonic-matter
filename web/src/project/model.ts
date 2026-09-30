export type Note = {
  id: string
  pitch: number
  start: number
  duration: number
  velocity: number
}

export type Track = {
  id: string
  name: string
  kind: 'midi' | 'audio'
  instrument: string
  color: string
  notes?: Note[]
  clip?: string
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

export const projectDuration = (project: Project) => Math.max(1, Math.min(120, project.duration ?? 10))
export const trackGain = (track: Track) => Math.max(0, Math.min(1, track.gain ?? .8))
export const trackPan = (track: Track) => Math.max(-1, Math.min(1, track.pan ?? 0))
export const trackStart = (track: Track) => Math.max(0, track.start ?? 0)

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
