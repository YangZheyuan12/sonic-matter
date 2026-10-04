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

/** 某个素材的波形峰值（解不出来就返回空数组，调用方画一条底线即可）。 */
export async function waveformPeaksFor(source: string, buckets = WAVEFORM_BUCKETS): Promise<number[]> {
  try {
    return peaksFromBuffer(await sourceBuffer(source), buckets)
  } catch {
    return []
  }
}

/** 当前描述 + 混音参数的本地预览波形（音效页那个波形条）。 */
export async function previewWaveform(description: string, mixer: SoundMixer, buckets = WAVEFORM_BUCKETS): Promise<number[]> {
  try {
    return peaksFromBuffer(await renderSoundPreview(description, mixer), buckets)
  } catch {
    return []
  }
}
