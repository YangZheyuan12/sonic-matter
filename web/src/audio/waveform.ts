import { renderSoundPreview, type SoundMixer } from './sfxPreview.ts'
import { audioSourceBuffer } from './projectAudio.ts'

/** 波形柱数：音效页与时间线片段共用同一套柱数，方便两处形状对得上。 */
export const WAVEFORM_BUCKETS = 46

/**
 * 把音频通道数据压成 buckets 根柱子（0-1），用来画波形。
 * 每根柱取该区间内的最大绝对值，最后整体归一化：安静的音效也能看出形状。
 */
export function peaksFromChannels(channels: ArrayLike<number>[], buckets: number): number[] {
  if (buckets <= 0 || channels.length === 0) return []
  const length = Math.min(...channels.map(channel => channel.length))
  if (!Number.isFinite(length) || length <= 0) return []
  const peaks: number[] = []
  for (let index = 0; index < buckets; index += 1) {
    const from = Math.floor(index * length / buckets)
    const to = Math.max(from + 1, Math.floor((index + 1) * length / buckets))
    let peak = 0
    for (let sample = from; sample < to && sample < length; sample += 1) {
      for (const channel of channels) {
        const value = Math.abs(channel[sample])
        if (value > peak) peak = value
      }
    }
    peaks.push(peak)
  }
  const loudest = Math.max(...peaks)
  if (!(loudest > 0)) return peaks
  return peaks.map(peak => Math.min(1, peak / loudest))
}

/**
 * 把峰值转成一条上下对称的波形多边形（viewBox 0 0 100 100 里用），
 * 时间线上的片段直接拿它当 SVG polygon 的 points：宽度随便拉伸都不会糊。
 */
export function waveformPolygon(peaks: number[]): string {
  if (peaks.length === 0) return ''
  const x = (index: number) => peaks.length === 1 ? 0 : index / (peaks.length - 1) * 100
  const top = peaks.map((peak, index) => `${x(index).toFixed(2)},${(50 - Math.min(1, Math.max(0, peak)) * 49).toFixed(2)}`)
  const bottom = peaks.map((peak, index) => `${x(index).toFixed(2)},${(50 + Math.min(1, Math.max(0, peak)) * 49).toFixed(2)}`).reverse()
  return [...top, ...bottom].join(' ')
}

/** 一个已经解码好的 AudioBuffer 的峰值；多声道取每根柱的最大值。 */
export function peaksFromBuffer(buffer: AudioBuffer | null | undefined, buckets = WAVEFORM_BUCKETS): number[] {
  if (!buffer) return []
  const channels = Array.from({ length: Math.max(1, buffer.numberOfChannels) }, (_, index) => buffer.getChannelData(index))
  return peaksFromChannels(channels, buckets)
}

// 同一个来源（音效计划或 /generated 音频）在一次会话里只解码一次：时间线上每条片段都要画波形。
const bufferCache = new Map<string, Promise<AudioBuffer | null>>()

function sourceBuffer(source: string) {
  const cached = bufferCache.get(source)
  if (cached) return cached
  const request = audioSourceBuffer(source)
  bufferCache.set(source, request)
  return request
}

/** 素材的波形 + 素材本身多长（片段要按入点 / 时长截取，得知道总长）。 */
export type Waveform = { peaks: number[]; duration: number }

/** 某个素材的波形（解不出来就是空波形，调用方画一条底线即可）。 */
export async function waveformFor(source: string, buckets = WAVEFORM_BUCKETS): Promise<Waveform> {
  try {
    const buffer = await sourceBuffer(source)
    return { peaks: peaksFromBuffer(buffer, buckets), duration: buffer?.duration ?? 0 }
  } catch {
    return { peaks: [], duration: 0 }
  }
}

export async function waveformPeaksFor(source: string, buckets = WAVEFORM_BUCKETS): Promise<number[]> {
  return (await waveformFor(source, buckets)).peaks
}

/** 片段只显示素材里被裁出来的那一段：按入点 / 时长把峰值切出来（量不出素材长度就整段显示）。 */
export function clipPeaks(peaks: number[], sourceDuration: number, offset: number, duration: number): number[] {
  if (peaks.length === 0) return []
  if (!(sourceDuration > 0)) return peaks
  const ratio = (value: number) => Math.max(0, Math.min(1, value / sourceDuration))
  const from = ratio(offset)
  const to = Math.max(from, ratio(offset + duration))
  const start = Math.floor(from * peaks.length)
  const end = Math.max(start + 1, Math.ceil(to * peaks.length))
  return peaks.slice(start, end)
}

/** 当前描述 + 混音参数的本地预览波形（音效页那个波形条）。 */
export async function previewWaveform(description: string, mixer: SoundMixer, buckets = WAVEFORM_BUCKETS): Promise<number[]> {
  try {
    return peaksFromBuffer(await renderSoundPreview(description, mixer), buckets)
  } catch {
    return []
  }
}
