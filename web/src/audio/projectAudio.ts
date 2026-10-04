import type { Project, Track } from '../project/model.ts'
import { audibleTracks, isPlayableClip, LOCAL_SOUND_CLIP_PREFIX, projectDuration, trackGain, trackPan, trackStart } from '../project/model.ts'
import { decodeSoundClip, renderSoundPreview } from './sfxPreview.ts'
import { clipsOf, type Clip } from '../project/clips.ts'
import { drumVoice, isDrumTrack, type DrumVoice } from '../project/tracks.ts'

const audioFiles = new Map<string, Promise<ArrayBuffer>>()
type SampleDefinition = { url: string; rootPitch: number }
type SampleManifest = { instruments?: Record<string, SampleDefinition> }
let sampleManifest: Promise<SampleManifest> | null = null
let liveContext: AudioContext | null = null
let liveSources: AudioScheduledSourceNode[] = []
let playbackGeneration = 0

const fetchAudio = (url: string) => {
  const cached = audioFiles.get(url)
  if (cached) return cached
  const request = fetch(url).then(response => {
    if (!response.ok) throw new Error(`音频载入失败 (${response.status})`)
    return response.arrayBuffer()
  })
  audioFiles.set(url, request)
  return request
}

/** 鼓组不走采样：合成器里有专门的打击乐音色，也不需要 WAV 根音。 */
function sampleKey(instrument: string) {
  const value = instrument.toLowerCase()
  if (/drum|perc|鼓|打击/.test(value)) return 'drums'
  if (/bass|低音/.test(value)) return 'bass'
  if (/cello|string|violin|弦|大提琴/.test(value)) return 'strings'
  if (/bell|glass|钟|玻璃|mallet/.test(value)) return 'bell'
  if (/pad|ambient|granular|氛围/.test(value)) return 'pad'
  return 'piano'
}

async function loadInstrumentSample(context: BaseAudioContext, instrument: string) {
  try {
    sampleManifest ??= fetch('/soundfonts/manifest.json').then(response => response.ok ? response.json() as Promise<SampleManifest> : {})
    const manifest = await sampleManifest
    const definition = manifest.instruments?.[sampleKey(instrument)]
    if (!definition) return null
    const bytes = await fetchAudio(definition.url)
    const buffer = await context.decodeAudioData(bytes.slice(0))
    return { buffer, rootPitch: definition.rootPitch }
  } catch {
    return null
  }
}

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>()

/** 白噪声：军鼓、拍手、镲片都要用，按 context 缓存一份半秒的循环片段。 */
function noiseBuffer(context: BaseAudioContext) {
  const cached = noiseBuffers.get(context)
  if (cached) return cached
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * .5), context.sampleRate)
  const data = buffer.getChannelData(0)
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1
  noiseBuffers.set(context, buffer)
  return buffer
}

const DRUM_NOISE: Record<Exclude<DrumVoice, 'kick' | 'tom'>, { filter: BiquadFilterType; frequency: number; decay: number }> = {
  snare: { filter: 'bandpass', frequency: 1900, decay: .18 },
  clap: { filter: 'bandpass', frequency: 1200, decay: .14 },
  hat: { filter: 'highpass', frequency: 8000, decay: .06 },
  openhat: { filter: 'highpass', frequency: 7800, decay: .3 },
  crash: { filter: 'highpass', frequency: 4200, decay: .9 },
}

/** 打击乐音色：底鼓 / 落地鼓是带音高下坠的正弦，其它是噪声加滤波。 */
function scheduleDrum(context: BaseAudioContext, voice: DrumVoice, start: number, duration: number, level: number, output: AudioNode) {
  const sources: AudioScheduledSourceNode[] = []
  const decay = voice === 'kick' || voice === 'tom' ? (voice === 'kick' ? .32 : .38) : DRUM_NOISE[voice].decay
  // 音尾：最短给 0.1 秒，最长不超过乐器本身的自然衰减，避免长音符拖着不放。
  const ring = Math.max(.1, Math.min(decay, duration + .12))
  if (voice === 'kick' || voice === 'tom') {
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(voice === 'kick' ? 150 : 240, start)
    oscillator.frequency.exponentialRampToValueAtTime(voice === 'kick' ? 45 : 110, start + Math.min(.18, ring))
    envelope.gain.setValueAtTime(.0001, start)
    envelope.gain.exponentialRampToValueAtTime(Math.max(.0002, level), start + .006)
    envelope.gain.exponentialRampToValueAtTime(.0001, start + ring)
    oscillator.connect(envelope).connect(output)
    oscillator.start(start)
    oscillator.stop(start + ring + .02)
    return [oscillator]
  }
  const settings = DRUM_NOISE[voice]
  const source = context.createBufferSource()
  const filter = context.createBiquadFilter()
  const envelope = context.createGain()
  source.buffer = noiseBuffer(context)
  source.loop = true
  filter.type = settings.filter
  filter.frequency.value = settings.frequency
  filter.Q.value = .8
  envelope.gain.setValueAtTime(.0001, start)
  envelope.gain.exponentialRampToValueAtTime(Math.max(.0002, level * (voice === 'crash' ? .5 : 1)), start + .004)
  envelope.gain.exponentialRampToValueAtTime(.0001, start + ring)
  source.connect(filter).connect(envelope).connect(output)
  source.start(start)
  source.stop(start + ring + .02)
  sources.push(source)
  if (voice === 'snare') {
    // 军鼓的“皮声”：加一段短促的三角波，噪声去掉后仍然听得出来是军鼓。
    const body = context.createOscillator()
    const bodyGain = context.createGain()
    body.type = 'triangle'
    body.frequency.value = 190
    bodyGain.gain.setValueAtTime(.0001, start)
    bodyGain.gain.exponentialRampToValueAtTime(Math.max(.0002, level * .6), start + .005)
    bodyGain.gain.exponentialRampToValueAtTime(.0001, start + Math.min(ring, .2))
    body.connect(bodyGain).connect(output)
    body.start(start)
    body.stop(start + Math.min(ring, .2) + .02)
    sources.push(body)
  }
  return sources
}

function trackOutput(context: BaseAudioContext, track: Track, destination: AudioNode) {
  const gain = context.createGain()
  const pan = context.createStereoPanner()
  gain.gain.value = trackGain(track)
  pan.pan.value = trackPan(track)
  gain.connect(pan).connect(destination)
  return gain
}

function scheduleNotes(context: BaseAudioContext, track: Track, destination: AudioNode, origin: number, offset: number, sample: { buffer: AudioBuffer; rootPitch: number } | null = null) {
  const sources: AudioScheduledSourceNode[] = []
  const output = trackOutput(context, track, destination)
  const drum = isDrumTrack(track)
  for (const note of track.notes ?? []) {
    const noteStart = trackStart(track) + note.start
    const noteEnd = noteStart + note.duration
    if (noteEnd <= offset) continue
    const start = origin + Math.max(0, noteStart - offset)
    const duration = Math.max(.02, noteEnd - Math.max(offset, noteStart))
    if (drum) {
      sources.push(...scheduleDrum(context, drumVoice(note.pitch), start, duration, .26 * note.velocity / 127, output))
      continue
    }
    const envelope = context.createGain()
    const level = (sample ? .5 : .13) * note.velocity / 127
    envelope.gain.setValueAtTime(.0001, start)
    envelope.gain.linearRampToValueAtTime(level, start + Math.min(.02, duration / 3))
    envelope.gain.linearRampToValueAtTime(.0001, start + duration)
    if (sample) {
      const source = context.createBufferSource()
      source.buffer = sample.buffer
      source.playbackRate.value = Math.pow(2, (note.pitch - sample.rootPitch) / 12)
      source.connect(envelope).connect(output)
      source.start(start)
      source.stop(start + duration + .02)
      sources.push(source)
    } else {
      const oscillator = context.createOscillator()
      oscillator.type = track.instrument.toLowerCase().includes('bass') ? 'sine' : 'triangle'
      oscillator.frequency.value = 440 * Math.pow(2, (note.pitch - 69) / 12)
      oscillator.connect(envelope).connect(output)
      oscillator.start(start)
      oscillator.stop(start + duration + .02)
      sources.push(oscillator)
    }
  }
  return sources
}

async function decodeClipSource(context: BaseAudioContext, source: string): Promise<AudioBuffer | null> {
  // 本地音效计划：片段里只存参数，播放 / 导出时用浏览器合成器现场渲染。
  if (source.startsWith(LOCAL_SOUND_CLIP_PREFIX)) {
    const plan = decodeSoundClip(source)
    if (!plan) return null
    try {
      return await renderSoundPreview(plan.description, plan.mixer)
    } catch {
      return null
    }
  }
  if (!isPlayableClip(source)) return null
  // 单个来源载入失败（文件被删、服务重启）只跳过用到它的片段，不要拖垮整个工程的播放。
  try {
    const bytes = await fetchAudio(source)
    return await context.decodeAudioData(bytes.slice(0))
  } catch {
    return null
  }
}

/** 量一个素材的真实长度（加入工程时用，量不出来就返回 0 让调用方兜底）。 */
export async function audioSourceDuration(source: string) {
  try {
    const buffer = await decodeClipSource(new OfflineAudioContext(1, 1, 44100), source)
    return buffer?.duration ?? 0
  } catch {
    return 0
  }
}

// 同一次播放 / 导出里，多个片段可能来自同一个素材（分割出来的两半就是），只解码一次。
const decodedSources = new WeakMap<BaseAudioContext, Map<string, Promise<AudioBuffer | null>>>()

function decodeClip(context: BaseAudioContext, source: string) {
  let cache = decodedSources.get(context)
  if (!cache) { cache = new Map(); decodedSources.set(context, cache) }
  const cached = cache.get(source)
  if (cached) return cached
  const request = decodeClipSource(context, source)
  cache.set(source, request)
  return request
}

/** 轨道上真正能出声的片段；只写了计划文本、没有音频来源的片段会被跳过。 */
const playableClips = (track: Track) => clipsOf(track).filter(clip => isPlayableClip(clip.source))

/** 排一个片段：起点 = 轨道起始 + 片段起点，素材入点 = 片段入点（播放到一半时还要加上已经过去的时间），
 *  淡入 / 淡出 / 增益在这里用包络实现，不改素材本身。 */
function scheduleClip(context: BaseAudioContext, track: Track, clip: Clip, buffer: AudioBuffer, destination: AudioNode, origin: number, offset: number) {
  const clipStart = trackStart(track) + clip.start
  const clipStop = clipStart + clip.duration
  if (clipStop <= offset) return []
  const playFrom = Math.max(0, offset - clipStart)
  const duration = Math.max(.01, clip.duration - playFrom)
  const when = origin + Math.max(0, clipStart - offset)
  // 素材比自己以为的短时（裁过头 / 文件被换过）也不能拿到负数或 NaN 的入点。
  const bufferLimit = Number.isFinite(buffer.duration) ? Math.max(0, buffer.duration - .01) : Number.POSITIVE_INFINITY
  const bufferOffset = Math.max(0, Math.min(clip.offset + playFrom, bufferLimit))
  const level = Math.max(.0001, clip.gain)
  // 淡入淡出加起来超过片段长度时按比例压缩，避免两条斜坡打架。
  const scale = clip.fadeIn + clip.fadeOut > duration ? duration / (clip.fadeIn + clip.fadeOut) : 1
  const fadeIn = clip.fadeIn * scale
  const fadeOut = clip.fadeOut * scale
  // 从淡入中间开始播（播放头正好落在淡入里）时，包络要从对应的中间值接着走，不能从 0 重新爬。
  const resumed = playFrom < fadeIn && fadeIn > 0 ? Math.max(.0001, level * (playFrom / fadeIn)) : level
  const source = context.createBufferSource()
  const envelope = context.createGain()
  source.buffer = buffer
  envelope.gain.setValueAtTime(resumed, when)
  if (playFrom < fadeIn) envelope.gain.linearRampToValueAtTime(level, when + fadeIn - playFrom)
  if (fadeOut > 0) {
    envelope.gain.setValueAtTime(level, Math.max(when + Math.max(0, fadeIn - playFrom), when + duration - fadeOut))
    envelope.gain.linearRampToValueAtTime(.0001, when + duration)
  }
  source.connect(envelope).connect(trackOutput(context, track, destination))
  source.start(when, bufferOffset)
  source.stop(when + duration + .01)
  return [source]
}

export function stopProjectAudio() {
  playbackGeneration++
  liveSources.forEach(source => { try { source.stop() } catch { /* source already ended */ } })
  liveSources = []
}

export async function playProjectAudio(project: Project, offset = 0) {
  stopProjectAudio()
  const generation = playbackGeneration
  liveContext ??= new AudioContext()
  if (liveContext.state === 'suspended') await liveContext.resume()
  const tracks = audibleTracks(project)
  const audioTracks = tracks.filter(track => track.kind === 'audio' && playableClips(track).length > 0)
  const midiTracks = tracks.filter(track => track.kind === 'midi')
  const [decodedClips, decodedSamples] = await Promise.all([
    Promise.all(audioTracks.flatMap(track => playableClips(track).map(async clip => ({ track, clip, buffer: await decodeClip(liveContext!, clip.source) })))),
    Promise.all(midiTracks.map(async track => ({ track, sample: await loadInstrumentSample(liveContext!, track.instrument) }))),
  ])
  if (generation !== playbackGeneration) return false
  const master = liveContext.createGain()
  master.gain.value = Math.max(0, Math.min(1, project.masterGain ?? .9))
  master.connect(liveContext.destination)
  const origin = liveContext.currentTime + .06
  liveSources.push(...decodedSamples.flatMap(({ track, sample }) => scheduleNotes(liveContext!, track, master, origin, offset, sample)))
  liveSources.push(...decodedClips.flatMap(item => item.buffer ? scheduleClip(liveContext!, item.track, item.clip, item.buffer, master, origin, offset) : []))
  return true
}

export async function renderProjectAudio(project: Project) {
  const sampleRate = 44100
  const duration = projectDuration(project)
  const context = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate)
  const master = context.createGain()
  master.gain.value = Math.max(0, Math.min(1, project.masterGain ?? .9))
  master.connect(context.destination)
  const tracks = audibleTracks(project)
  const audioTracks = tracks.filter(track => track.kind === 'audio' && playableClips(track).length > 0)
  const midiTracks = tracks.filter(track => track.kind === 'midi')
  const [decodedClips, decodedSamples] = await Promise.all([
    Promise.all(audioTracks.flatMap(track => playableClips(track).map(async clip => ({ track, clip, buffer: await decodeClip(context, clip.source) })))),
    Promise.all(midiTracks.map(async track => ({ track, sample: await loadInstrumentSample(context, track.instrument) }))),
  ])
  decodedSamples.forEach(({ track, sample }) => scheduleNotes(context, track, master, 0, 0, sample))
  decodedClips.forEach(item => { if (item.buffer) scheduleClip(context, item.track, item.clip, item.buffer, master, 0, 0) })
  return context.startRendering()
}
