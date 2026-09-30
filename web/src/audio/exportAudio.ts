import { Mp3Encoder } from 'lamejs'

const pcmChannel = (buffer: AudioBuffer, channelIndex: number) => {
  const source = buffer.getChannelData(Math.min(channelIndex, buffer.numberOfChannels - 1))
  const pcm = new Int16Array(source.length)
  for (let index = 0; index < source.length; index++) pcm[index] = Math.round(Math.max(-1, Math.min(1, source[index])) * 0x7fff)
  return pcm
}

export function audioBufferToWav(buffer: AudioBuffer) {
  const left = pcmChannel(buffer, 0)
  const right = pcmChannel(buffer, 1)
  const bytes = new ArrayBuffer(44 + left.length * 4)
  const view = new DataView(bytes)
  const write = (offset: number, value: string) => Array.from(value).forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)))
  write(0, 'RIFF'); view.setUint32(4, 36 + left.length * 4, true); write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true)
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 4, true)
  view.setUint16(32, 4, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, left.length * 4, true)
  for (let index = 0; index < left.length; index++) {
    view.setInt16(44 + index * 4, left[index], true)
    view.setInt16(46 + index * 4, right[index], true)
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

export function audioBufferToMp3(buffer: AudioBuffer) {
  const left = pcmChannel(buffer, 0)
  const right = pcmChannel(buffer, 1)
  const encoder = new Mp3Encoder(2, buffer.sampleRate, 160)
  const chunks: ArrayBuffer[] = []
  const append = (chunk: Int8Array) => {
    const copy = new ArrayBuffer(chunk.byteLength)
    new Uint8Array(copy).set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    chunks.push(copy)
  }
  for (let index = 0; index < left.length; index += 1152) {
    const chunk = encoder.encodeBuffer(left.subarray(index, index + 1152), right.subarray(index, index + 1152))
    if (chunk.length) append(chunk)
  }
  const tail = encoder.flush()
  if (tail.length) append(tail)
  return new Blob(chunks, { type: 'audio/mpeg' })
}
