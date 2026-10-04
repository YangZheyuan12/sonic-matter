/** 音频片段编辑：纯函数，全部返回新数组；没有变化时原样返回传入的数组，
 *  这样 App 的 applyProject 会把它当成“没有变化”，不会产生空的撤销步骤。 */
import { decodeSoundClip } from '../audio/sfxPreview.ts'
import {
  CLIP_MIN_DURATION,
  clampClip,
  clipEnd,
  isPlayableClip,
  LOCAL_SOUND_CLIP_PREFIX,
  type Clip,
  type Project,
  type Track,
} from './model.ts'

export { CLIP_MIN_DURATION, clipEnd, type Clip }

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const sameClip = (a: Clip, b: Clip) => a.id === b.id && a.source === b.source && a.start === b.start && a.offset === b.offset
  && a.duration === b.duration && a.fadeIn === b.fadeIn && a.fadeOut === b.fadeOut && a.gain === b.gain

/** 素材的默认时长：本地音效计划里存了长度，其它来源（服务端 wav、外链）只能用兜底值。 */
export function clipDurationFor(source: string, fallback = 4) {
  if (!source.startsWith(LOCAL_SOUND_CLIP_PREFIX)) return fallback
  return decodeSoundClip(source)?.mixer.length ?? fallback
}

/** 老工程只有单个 `clip` 字段时的兜底片段，让老工程也能直接裁剪 / 分割。 */
function legacyClips(track: Track) {
  if (!track.clip) return []
  return [clampClip({ id: `clip-${track.id}`, source: track.clip, start: 0, offset: 0, duration: clipDurationFor(track.clip), fadeIn: 0, fadeOut: 0, gain: 1 })]
}

/** 读音频轨的片段的唯一入口：新字段优先，老字段自动升级。 */
export function clipsOf(track: Track | undefined): Clip[] {
  if (!track) return []
  return track.clips?.length ? track.clips : legacyClips(track)
}

/** 音频来源在时间线上的显示名。 */
export function clipSourceLabel(source?: string) {
  if (!isPlayableClip(source)) return 'NO AUDIO'
  if (source!.startsWith('/generated/')) return 'AI AUDIO'
  if (source!.startsWith(LOCAL_SOUND_CLIP_PREFIX)) return 'LOCAL SFX'
  return 'AUDIO'
}

export function makeClipIds(clips: Clip[], count: number) {
  const used = new Set(clips.map(clip => clip.id))
  const ids: string[] = []
  for (let index = 1; ids.length < count; index += 1) {
    const id = `clip-${index}`
    if (!used.has(id)) { used.add(id); ids.push(id) }
  }
  return ids
}

export function createClip(clips: Clip[], source: string, start = 0, duration?: number): Clip {
  const [id] = makeClipIds(clips, 1)
  return clampClip({ id, source, start, offset: 0, duration: duration ?? clipDurationFor(source), fadeIn: 0, fadeOut: 0, gain: 1 })
}

export const clipById = (clips: Clip[], id: string) => clips.find(clip => clip.id === id)

/** 命中测试：时间线上这个时间点落在哪个片段里。 */
export const clipAt = (clips: Clip[], time: number) => clips.find(clip => time >= clip.start && time < clipEnd(clip))

const sameClips = (a: Clip[], b: Clip[]) => a.length === b.length && a.every((clip, index) => sameClip(clip, b[index]))

/** 把一条轨道的片段写回工程：内容没变（老工程的单片段升级后也一样）就返回同一个 Project 引用，
 *  这样 App 的 applyProject 不会记下一个空的撤销步骤。 */
export function setTrackClips(project: Project, trackId: string, clips: Clip[]): Project {
  const track = project.tracks.find(item => item.id === trackId)
  if (!track || clipsOf(track) === clips || sameClips(clipsOf(track), clips)) return project
  return { ...project, tracks: project.tracks.map(item => item.id === trackId ? { ...item, clips, clip: undefined } : item) }
}

function replaceClip(clips: Clip[], next: Clip): Clip[] {
  const index = clips.findIndex(clip => clip.id === next.id)
  if (index < 0) return clips
  const clamped = clampClip(next)
  if (sameClip(clips[index], clamped)) return clips
  return clips.map((clip, current) => current === index ? clamped : clip)
}

/** 水平移动：起点不小于 0，给定时也不越过 `limit`（一般是工程时长）。 */
export function moveClip(clips: Clip[], id: string, delta: number, limit = Number.POSITIVE_INFINITY) {
  const clip = clipById(clips, id)
  if (!clip || !Number.isFinite(delta) || delta === 0) return clips
  return replaceClip(clips, { ...clip, start: clamp(clip.start + delta, 0, Math.max(0, limit - clip.duration)) })
}

/** 拖动左右边缘：改片段的起止，不改素材本身。 */
export function trimClipEdge(clips: Clip[], id: string, edge: 'start' | 'end', delta: number, limit = Number.POSITIVE_INFINITY) {
  const clip = clipById(clips, id)
  if (!clip || !Number.isFinite(delta) || delta === 0) return clips
  if (edge === 'start') {
    // 往左拖是在“把素材里更早的部分露出来”：入点不能为负，起点不能为负，也不能短到看不见。
    const room = Math.max(-clip.offset, -clip.start)
    const moved = clamp(delta, room, clip.duration - CLIP_MIN_DURATION)
    return replaceClip(clips, { ...clip, start: clip.start + moved, offset: clip.offset + moved, duration: clip.duration - moved })
  }
  const moved = clamp(delta, CLIP_MIN_DURATION - clip.duration, limit - clipEnd(clip))
  return replaceClip(clips, { ...clip, duration: clip.duration + moved })
}

/** 在时间线位置 `at` 处一刀两断：左半段保留淡入，右半段保留淡出，右半段换新 id。 */
export function splitClip(clips: Clip[], id: string, at: number) {
  const clip = clipById(clips, id)
  if (!clip) return clips
  const left = at - clip.start
  const right = clipEnd(clip) - at
  if (left < CLIP_MIN_DURATION || right < CLIP_MIN_DURATION) return clips
  const index = clips.indexOf(clip)
  const [newId] = makeClipIds(clips, 1)
  const parts = [
    clampClip({ ...clip, duration: left, fadeOut: 0 }),
    clampClip({ ...clip, id: newId, start: at, offset: clip.offset + left, duration: right, fadeIn: 0 }),
  ]
  return [...clips.slice(0, index), ...parts, ...clips.slice(index + 1)]
}

export function setClipFade(clips: Clip[], id: string, side: 'in' | 'out', value: number) {
  const clip = clipById(clips, id)
  if (!clip || !Number.isFinite(value)) return clips
  if (side === 'in') return replaceClip(clips, { ...clip, fadeIn: clamp(value, 0, clip.duration - clip.fadeOut) })
  return replaceClip(clips, { ...clip, fadeOut: clamp(value, 0, clip.duration - clip.fadeIn) })
}

export function setClipGain(clips: Clip[], id: string, gain: number) {
  const clip = clipById(clips, id)
  if (!clip || !Number.isFinite(gain)) return clips
  return replaceClip(clips, { ...clip, gain: clamp(gain, 0, 1) })
}

export function removeClip(clips: Clip[], id: string) {
  if (!clipById(clips, id)) return clips
  return clips.filter(clip => clip.id !== id)
}
