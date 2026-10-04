import type { Project, Track } from '../project/model.ts'
import { audibleTracks, isPlayableClip, LOCAL_SOUND_CLIP_PREFIX, projectDuration, trackGain, trackPan, trackStart } from '../project/model.ts'
import { decodeSoundClip, renderSoundPreview } from './sfxPreview.ts'
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

async function decodeClip(context: BaseAudioContext, track: Track): Promise<AudioBuffer | null> {
  // 本地音效计划：clip 里只存参数，播放 / 导出时用浏览器合成器现场渲染。
  if (track.clip?.startsWith(LOCAL_SOUND_CLIP_PREFIX)) {
    const plan = decodeSoundClip(track.clip)
    if (!plan) return null
    try {
      return await renderSoundPreview(plan.description, plan.mixer)
    } catch {
      return null
    }
  }
  if (!isPlayableClip(track.clip)) return null
  // 单条 clip 载入失败（文件被删、服务重启）只跳过这条轨道，不要拖垮整个工程的播放。
  try {
    const bytes = await fetchAudio(track.clip!)
    return await context.decodeAudioData(bytes.slice(0))
  } catch {
    return null
  }
}

function scheduleClip(context: BaseAudioContext, track: Track, buffer: AudioBuffer, destination: AudioNode, origin: number, offset: number) {
  const clipStart = trackStart(track)
  const clipEnd = clipStart + buffer.duration
  if (clipEnd <= offset) return []
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(trackOutput(context, track, destination))
  const sourceOffset = Math.max(0, offset - clipStart)
  source.start(origin + Math.max(0, clipStart - offset), sourceOffset)
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
  const audioTracks = tracks.filter(track => track.kind === 'audio' && isPlayableClip(track.clip))
  const midiTracks = tracks.filter(track => track.kind === 'midi')
  const [decodedClips, decodedSamples] = await Promise.all([
    Promise.all(audioTracks.map(async track => ({ track, buffer: await decodeClip(liveContext!, track) }))),
    Promise.all(midiTracks.map(async track => ({ track, sample: await loadInstrumentSample(liveContext!, track.instrument) }))),
  ])
  if (generation !== playbackGeneration) return false
  const master = liveContext.createGain()
  master.gain.value = Math.max(0, Math.min(1, project.masterGain ?? .9))
  master.connect(liveContext.destination)
  const origin = liveContext.currentTime + .06
  liveSources.push(...decodedSamples.flatMap(({ track, sample }) => scheduleNotes(liveContext!, track, master, origin, offset, sample)))
  liveSources.push(...decodedClips.flatMap(clip => clip.buffer ? scheduleClip(liveContext!, clip.track, clip.buffer, master, origin, offset) : []))
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
  const audioTracks = tracks.filter(track => track.kind === 'audio' && isPlayableClip(track.clip))
  const midiTracks = tracks.filter(track => track.kind === 'midi')
  const [decodedClips, decodedSamples] = await Promise.all([
    Promise.all(audioTracks.map(async track => ({ track, buffer: await decodeClip(context, track) }))),
    Promise.all(midiTracks.map(async track => ({ track, sample: await loadInstrumentSample(context, track.instrument) }))),
  ])
  decodedSamples.forEach(({ track, sample }) => scheduleNotes(context, track, master, 0, 0, sample))
  decodedClips.forEach(clip => { if (clip.buffer) scheduleClip(context, clip.track, clip.buffer, master, 0, 0) })
  return context.startRendering()
}
