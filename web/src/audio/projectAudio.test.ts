import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Note, Project, Track } from '../project/model.ts'
import { renderProjectAudio } from './projectAudio.ts'

// 与源码同目录，用 Node 自带的测试运行器执行：node --test "src/**/*.test.ts"
// 这里不真的出声：用一个“记录式”假 Web Audio，断言排了哪些音色、什么时候响、参数怎么走。

type ParamEvent = { type: string; value: number; time: number }

class FakeParam {
  value = 0
  events: ParamEvent[] = []
  setValueAtTime(value: number, time: number) { this.events.push({ type: 'set', value, time }); return this }
  exponentialRampToValueAtTime(value: number, time: number) { this.events.push({ type: 'exp', value, time }); return this }
  linearRampToValueAtTime(value: number, time: number) { this.events.push({ type: 'lin', value, time }); return this }
}

class FakeNode {
  kind: string
  connects: FakeNode[] = []
  constructor(kind: string) { this.kind = kind }
  connect(target: FakeNode) { this.connects.push(target); return target }
  disconnect() {}
}

class FakeSource extends FakeNode {
  started: number[] = []
  stopped: number[] = []
  start(time = 0) { this.started.push(time) }
  stop(time = 0) { this.stopped.push(time) }
}

class FakeOscillator extends FakeSource {
  type = 'sine'
  frequency = new FakeParam()
  constructor() { super('oscillator') }
}

class FakeBufferSource extends FakeSource {
  buffer: unknown = null
  loop = false
  playbackRate = new FakeParam()
  constructor() { super('bufferSource') }
}

class FakeBiquadFilter extends FakeNode {
  type = 'lowpass'
  frequency = new FakeParam()
  Q = new FakeParam()
  constructor() { super('biquad') }
}

class FakeGain extends FakeNode {
  gain = new FakeParam()
  constructor() { super('gain') }
}

class FakePanner extends FakeNode {
  pan = new FakeParam()
  constructor() { super('panner') }
}

class FakeContext {
  static latest: FakeContext | null = null
  readonly sampleRate = 44100
  readonly currentTime = 0
  readonly destination = new FakeGain()
  nodes: FakeNode[] = []
  buffers: Array<{ length: number; sampleRate: number }> = []
  constructor() { FakeContext.latest = this }
  private track<T extends FakeNode>(node: T) { this.nodes.push(node); return node }
  createGain() { return this.track(new FakeGain()) }
  createStereoPanner() { return this.track(new FakePanner()) }
  createOscillator() { return this.track(new FakeOscillator()) }
  createBufferSource() { return this.track(new FakeBufferSource()) }
  createBiquadFilter() { return this.track(new FakeBiquadFilter()) }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const buffer = { length, sampleRate, numberOfChannels: 1, duration: length / sampleRate, getChannelData: () => new Float32Array(length) }
    this.buffers.push(buffer)
    return buffer
  }
  async startRendering() { return { sampleRate: this.sampleRate, length: 1, getChannelData: () => new Float32Array(1) } as unknown as AudioBuffer }
}

const note = (pitch: number, start: number, duration = .25, velocity = 120): Note => ({ id: `${pitch}-${start}`, pitch, start, duration, velocity })
const track = (over: Partial<Track>): Track => ({ id: 'melody', name: 'melody', kind: 'midi', instrument: 'Glass Keys', color: '#7dd3fc', gain: 1, ...over })
const project = (tracks: Track[]): Project => ({ title: '测试', tempo: 120, key: 'C', duration: 2, masterGain: 1, tracks })

async function render(tracks: Track[]) {
  const globals = globalThis as { OfflineAudioContext?: unknown }
  const previous = globals.OfflineAudioContext
  globals.OfflineAudioContext = FakeContext
  try {
    await renderProjectAudio(project(tracks))
  } finally {
    globals.OfflineAudioContext = previous
  }
  assert.ok(FakeContext.latest, '应该创建了 OfflineAudioContext')
  return FakeContext.latest
}

const only = <T extends FakeNode>(nodes: FakeNode[], kind: string) => nodes.filter(node => node.kind === kind) as T[]

test('鼓组轨用合成打击乐：底鼓是下坠的正弦，军鼓是噪声加皮声，闭镲是短促高通噪声', async () => {
  const context = await render([track({
    id: 'drums', instrument: '鼓组', notes: [note(36, 0), note(38, 1), note(42, 1.5)],
  })])
  const oscillators = only<FakeOscillator>(context.nodes, 'oscillator')
  const noise = only<FakeBufferSource>(context.nodes, 'bufferSource')
  const filters = only<FakeBiquadFilter>(context.nodes, 'biquad')

  const kick = oscillators.find(node => node.frequency.events[0]?.value === 150)
  assert.ok(kick, '底鼓应该有一个 150Hz 起跳的正弦')
  assert.deepEqual(kick.frequency.events.map(event => event.value), [150, 45], '底鼓要从 150Hz 掉到 45Hz')
  assert.equal(kick.started[0], 0, '底鼓在 0s')
  assert.ok(kick.stopped[0]! < .5, '底鼓音尾要短')

  const snareBody = oscillators.find(node => node.frequency.value === 190)
  assert.ok(snareBody, '军鼓要有一段 190Hz 的皮声')
  assert.equal(snareBody.started[0], 1)
  const snareNoise = filters.find(node => node.type === 'bandpass' && node.frequency.value === 1900)
  assert.ok(snareNoise, '军鼓噪声走 1900Hz 带通')

  const hat = filters.find(node => node.type === 'highpass' && node.frequency.value === 8000)
  assert.ok(hat, '闭镲噪声走高通')
  const hatStops = noise.filter(node => node.started[0] === 1.5).map(node => node.stopped[0]!)
  assert.ok(hatStops.every(stop => stop - 1.5 >= .05 && stop - 1.5 <= .15), `闭镲必须短促（0.05-0.15s），实际 ${hatStops}`)
  assert.equal(context.buffers.length, 1, '白噪声只生成一份并复用')
  assert.equal(noise.length, 2, '军鼓与闭镲各一路噪声，底鼓不用噪声')
})

test('长音符不会拖着打击乐一直响，音尾不超过乐器本身衰减', async () => {
  const context = await render([track({ id: 'drums', instrument: '鼓组', notes: [note(36, 0, 4)] })])
  const kick = only<FakeOscillator>(context.nodes, 'oscillator')[0]
  assert.ok(kick.stopped[0]! > .3 && kick.stopped[0]! < .4, `底鼓音尾应该接近 0.32s，实际 ${kick.stopped[0]}`)
})

test('普通 MIDI 轨仍然按音高合成，鼓组音色不会串到旋律轨', async () => {
  const context = await render([track({ notes: [note(69, 0)] })])
  const oscillator = only<FakeOscillator>(context.nodes, 'oscillator')[0]
  assert.equal(oscillator.type, 'triangle')
  assert.ok(Math.abs(oscillator.frequency.value - 440) < .001, 'A4 应该是 440Hz')
  assert.equal(only<FakeBufferSource>(context.nodes, 'bufferSource').length, 0, '旋律轨不该用噪声')
})
