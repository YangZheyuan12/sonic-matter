import type { Project, Track } from '../project/model'
import { audibleTracks, isPlayableClip, LOCAL_SOUND_CLIP_PREFIX, projectDuration, trackGain, trackPan, trackStart } from '../project/model'
import { decodeSoundClip, renderSoundPreview } from './sfxPreview'

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

function sampleKey(instrument: string) {
  const value = instrument.toLowerCase()
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
  for (const note of track.notes ?? []) {
    const noteStart = trackStart(track) + note.start
    const noteEnd = noteStart + note.duration
    if (noteEnd <= offset) continue
    const start = origin + Math.max(0, noteStart - offset)
    const duration = Math.max(.02, noteEnd - Math.max(offset, noteStart))
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
