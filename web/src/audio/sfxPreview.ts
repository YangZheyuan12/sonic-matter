import { LOCAL_SOUND_CLIP_PREFIX } from '../project/model'

let previewContext: AudioContext | null = null
let activeNodes: AudioScheduledSourceNode[] = []

export type SoundMixer = { length: number; density: number; brightness: number; space: number; compact: number }

/** 把“描述 + 调音台参数”画成一段声音图，返回本次创建的音频源，便于停止。
 *  实时试听与离线渲染共用同一套合成逻辑，保证试听和加入工程后的声音一致。 */
function buildSoundGraph(context: BaseAudioContext, description: string, mixer: SoundMixer, startTime: number) {
  const sources: AudioScheduledSourceNode[] = []
  const duration = Math.max(.25, Math.min(6, mixer.length))
  const master = context.createGain()
  const filter = context.createBiquadFilter()
  const wet = context.createDelay(1)
  const feedback = context.createGain()
  const space = Math.max(0, Math.min(1, mixer.space / 100))
  master.gain.setValueAtTime(.0001, startTime)
  master.gain.linearRampToValueAtTime(.18, startTime + Math.min(.05, duration / 5))
  master.gain.exponentialRampToValueAtTime(.0001, startTime + duration)
  filter.type = 'lowpass'
  filter.frequency.value = 700 + mixer.brightness * 42
  wet.delayTime.value = .08 + space * .32
  feedback.gain.value = space * .28
  master.connect(filter).connect(context.destination)
  master.connect(wet).connect(feedback).connect(wet)
  wet.connect(context.destination)
  const lower = description.toLowerCase()
  const isBird = /鸟|bird|叫/.test(lower)
  const isWind = /风|wind|气流/.test(lower)
  const isMetal = /金属|metal|钟|冰|ice/.test(lower)
  if (isWind) {
    const buffer = context.createBuffer(1, Math.max(1, Math.ceil(context.sampleRate * duration)), context.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * .3
    const source = context.createBufferSource(); source.buffer = buffer; source.loop = false
    const noiseFilter = context.createBiquadFilter(); noiseFilter.type = 'lowpass'; noiseFilter.frequency.value = 500 + mixer.brightness * 24
    source.connect(noiseFilter).connect(master); source.start(startTime); sources.push(source)
    return sources
  }
  const bursts = Math.max(1, Math.round(1 + mixer.density / 30))
  for (let index = 0; index < bursts; index += 1) {
    const start = startTime + (index / bursts) * duration * .75
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = isBird ? 'sine' : isMetal ? 'triangle' : 'sawtooth'
    const base = isBird ? 900 + mixer.brightness * 18 : isMetal ? 420 + mixer.brightness * 12 : 160 + mixer.brightness * 5
    oscillator.frequency.setValueAtTime(base * (isBird ? .7 : 1), start)
    oscillator.frequency.exponentialRampToValueAtTime(base * (isBird ? 1.8 : .55), start + Math.min(.22, duration / 3))
    envelope.gain.setValueAtTime(.0001, start)
    envelope.gain.linearRampToValueAtTime(.22 / bursts, start + Math.min(.025, duration / 8))
    envelope.gain.exponentialRampToValueAtTime(.0001, Math.min(startTime + duration, start + (isBird ? .28 : .7)))
    oscillator.connect(envelope).connect(master)
    oscillator.start(start); oscillator.stop(Math.min(startTime + duration + .02, start + 1))
    sources.push(oscillator)
  }
  return sources
}

export function playSoundPreview(description: string, mixer: SoundMixer) {
  previewContext ??= new AudioContext()
  const context = previewContext
  activeNodes.forEach(node => { try { node.stop() } catch { /* already ended */ } })
  activeNodes = []
  void context.resume()
  activeNodes = buildSoundGraph(context, description, mixer, context.currentTime + 0.04)
}

/** 离线渲染同一段声音，用于把音效真正加入工程、参与播放与 WAV / MP3 导出。 */
export async function renderSoundPreview(description: string, mixer: SoundMixer) {
  const sampleRate = 44100
  const duration = Math.max(.25, Math.min(6, mixer.length)) + .4
  const context = new OfflineAudioContext(1, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate)
  buildSoundGraph(context, description, mixer, 0)
  return context.startRendering()
}

/** 把音效计划压进 clip 字符串，工程里只保存参数（几十字节），播放时再本地渲染。 */
export function encodeSoundClip(description: string, mixer: SoundMixer) {
  const bytes = new TextEncoder().encode(JSON.stringify({ description, mixer }))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `${LOCAL_SOUND_CLIP_PREFIX}${btoa(binary)}`
}

export function decodeSoundClip(clip?: string): { description: string; mixer: SoundMixer } | null {
  if (!clip || !clip.startsWith(LOCAL_SOUND_CLIP_PREFIX)) return null
  try {
    const binary = atob(clip.slice(LOCAL_SOUND_CLIP_PREFIX.length))
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)))) as { description?: unknown; mixer?: Partial<SoundMixer> }
    if (typeof parsed.description !== 'string' || !parsed.mixer) return null
    const number = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
    return { description: parsed.description, mixer: {
      length: number(parsed.mixer.length, 2.4), density: number(parsed.mixer.density, 42), brightness: number(parsed.mixer.brightness, 64),
      space: number(parsed.mixer.space, 78), compact: number(parsed.mixer.compact, 35),
    } }
  } catch {
    return null
  }
}
