import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeSoundClip, type SoundMixer } from './sfxPreview.ts'
import type { Clip, Note, Project, Track } from '../project/model.ts'
import { playProjectAudio, renderProjectAudio, stopProjectAudio } from './projectAudio.ts'

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
  offsets: number[] = []
  start(time = 0, offset = 0) { this.started.push(time); this.offsets.push(offset) }
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

class FakeDelay extends FakeNode {
  delayTime = new FakeParam()
  constructor() { super('delay') }
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
  /** 按创建顺序记录：工程渲染用的上下文是第一个，渲染本地音效计划时会再建新的。 */
  static all: FakeContext[] = []
  readonly sampleRate: number
  readonly currentTime = 0
  readonly destination = new FakeGain()
  readonly renderLength: number
  nodes: FakeNode[] = []
  buffers: Array<{ length: number; sampleRate: number }> = []
  constructor(_channels = 1, renderLength = 1, sampleRate = 44100) { this.sampleRate = sampleRate; this.renderLength = renderLength; FakeContext.all.push(this) }
  private track<T extends FakeNode>(node: T) { this.nodes.push(node); return node }
  createGain() { return this.track(new FakeGain()) }
  createStereoPanner() { return this.track(new FakePanner()) }
  createOscillator() { return this.track(new FakeOscillator()) }
  createBufferSource() { return this.track(new FakeBufferSource()) }
  createBiquadFilter() { return this.track(new FakeBiquadFilter()) }
  createDelay(_maxDelay = 1) { return this.track(new FakeDelay()) }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const buffer = { length, sampleRate, numberOfChannels: 1, duration: length / sampleRate, getChannelData: () => new Float32Array(length) }
    this.buffers.push(buffer)
    return buffer
  }
  async startRendering() {
    const length = Math.max(1, this.renderLength)
    return { sampleRate: this.sampleRate, length, duration: length / this.sampleRate, numberOfChannels: 1, getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer
  }
}

const note = (pitch: number, start: number, duration = .25, velocity = 120): Note => ({ id: `${pitch}-${start}`, pitch, start, duration, velocity })
const track = (over: Partial<Track>): Track => ({ id: 'melody', name: 'melody', kind: 'midi', instrument: 'Glass Keys', color: '#7dd3fc', gain: 1, ...over })
const project = (tracks: Track[]): Project => ({ title: '测试', tempo: 120, key: 'C', duration: 2, masterGain: 1, tracks })

async function render(tracks: Track[]) {
  const globals = globalThis as { OfflineAudioContext?: unknown }
  const previous = globals.OfflineAudioContext
  FakeContext.all = []
  globals.OfflineAudioContext = FakeContext
  try {
    await renderProjectAudio(project(tracks))
  } finally {
    globals.OfflineAudioContext = previous
  }
  const context = FakeContext.all[0]
  assert.ok(context, '应该创建了 OfflineAudioContext')
  return context
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

// —— item 7 音频片段：一处素材可以摆多次、可以裁剪入点、可以带淡入淡出 ——

const mixer: SoundMixer = { length: 2.4, density: 42, brightness: 64, space: 78, compact: 35 }
const sfx = encodeSoundClip('远处冰层断裂', mixer)
const clip = (over: Partial<Clip>): Clip => ({ id: 'clip-1', source: sfx, start: 0, offset: 0, duration: 2, fadeIn: 0, fadeOut: 0, gain: 1, ...over })
const audioProject = (clips: Clip[], over: Partial<Track> = {}) => project([{
  id: 'sfx', name: '语义音效', kind: 'audio', instrument: 'SFX', color: '#fb7185', gain: 1, clips, ...over,
}] as Track[])
const renderAudio = async (tracks: Track[]) => {
  const globals = globalThis as { OfflineAudioContext?: unknown }
  const previous = globals.OfflineAudioContext
  FakeContext.all = []
  globals.OfflineAudioContext = FakeContext
  try {
    await renderProjectAudio({ ...project(tracks), duration: 8 })
  } finally {
    globals.OfflineAudioContext = previous
  }
  const context = FakeContext.all[0]
  assert.ok(context, '应该创建了工程渲染用的 OfflineAudioContext')
  return context
}

test('同一段素材摆两次：按各自起点排期，入点决定从素材的哪里开始放', async () => {
  const context = await renderAudio(audioProject([clip({ id: 'a', start: .5, duration: 1, offset: 0 }), clip({ id: 'b', start: 3, duration: 1.5, offset: .5 })]).tracks)
  const sources = only<FakeBufferSource>(context.nodes, 'bufferSource')
  assert.equal(sources.length, 2, '两个片段应该各排一路')
  assert.deepEqual(sources.map(node => node.started[0]), [.5, 3])
  assert.deepEqual(sources.map(node => node.offsets[0]), [0, .5], '第二个片段要从素材的第 0.5s 开始放')
  assert.deepEqual(sources.map(node => node.stopped[0]), [1.51, 4.51])
})

test('分割出来的两半会接着响：第二半从素材中间续上', async () => {
  const context = await renderAudio(audioProject([clip({ id: 'a', start: 0, duration: 1, offset: 0 }), clip({ id: 'b', start: 1, duration: 1, offset: 1 })]).tracks)
  const sources = only<FakeBufferSource>(context.nodes, 'bufferSource')
  assert.deepEqual(sources.map(node => node.started[0]), [0, 1])
  assert.deepEqual(sources.map(node => node.offsets[0]), [0, 1])
})

test('淡入淡出和增益写成增益包络，不改素材本身', async () => {
  const context = await renderAudio(audioProject([clip({ start: 1, duration: 2, fadeIn: .5, fadeOut: .25, gain: .4 })]).tracks)
  const envelope = only<FakeGain>(context.nodes, 'gain').find(node => node.gain.events.some(event => event.type === 'lin'))
  assert.ok(envelope, '片段应该有一条斜坡包络')
  assert.deepEqual(envelope.gain.events.map(event => [event.type, event.value, Number(event.time.toFixed(3))]), [
    ['set', .0001, 1],
    ['lin', .4, 1.5],
    ['set', .4, 2.75],
    ['lin', .0001, 3],
  ])
})

test('淡入淡出加起来超过片段长度时按比例压缩，不会出现负的斜坡', async () => {
  const context = await renderAudio(audioProject([clip({ start: 0, duration: 1, fadeIn: 2, fadeOut: 2, gain: 1 })]).tracks)
  const envelope = only<FakeGain>(context.nodes, 'gain').find(node => node.gain.events.some(event => event.type === 'lin'))
  const times = envelope!.gain.events.filter(event => event.type === 'lin').map(event => event.time)
  assert.deepEqual(times.map(value => Number(value.toFixed(3))), [.5, 1], '两条斜坡各占一半并落在片段区间内')
})

test('没有音频来源的片段不出声，也不影响同轨其它片段', async () => {
  const context = await renderAudio(audioProject([clip({ id: 'plan', source: '一段声音计划文本' }), clip({ id: 'real', start: 2 })]).tracks)
  const sources = only<FakeBufferSource>(context.nodes, 'bufferSource')
  assert.equal(sources.length, 1, '只有有来源的片段会排期')
  assert.equal(sources[0].started[0], 2)
})

test('从淡入中间开始播放时，包络接着中间值走，不从头重新爬', async () => {
  const globals = globalThis as { AudioContext?: unknown; OfflineAudioContext?: unknown }
  const previousAudio = globals.AudioContext
  const previousOffline = globals.OfflineAudioContext
  FakeContext.all = []
  globals.AudioContext = FakeContext
  globals.OfflineAudioContext = FakeContext
  let started = false
  try {
    // 片段 1s-3s、淡入 1s，播放头停在 1.5s：正好落在淡入的中点上。
    started = await playProjectAudio(audioProject([clip({ start: 1, duration: 2, fadeIn: 1, gain: .8 })]), 1.5)
  } finally {
    stopProjectAudio()
    globals.AudioContext = previousAudio
    globals.OfflineAudioContext = previousOffline
  }
  assert.equal(started, true)
  const live = FakeContext.all[0]
  const envelope = only<FakeGain>(live.nodes, 'gain').find(node => node.gain.events.some(event => event.type === 'lin'))
  assert.ok(envelope, '片段应该有一条斜坡包络')
  assert.deepEqual(envelope.gain.events.map(event => [event.type, Number(event.value.toFixed(3)), Number(event.time.toFixed(3))]), [
    ['set', .4, .06],
    ['lin', .8, .56],
  ], '包头应该是增益的一半（0.4），再用剩下半段淡入爬到完整增益')
})

test('老工程只有 clip 字段时仍然按整段播放（迁移到片段数组）', async () => {
  const legacy = project([{ id: 'sfx', name: '语义音效', kind: 'audio', instrument: 'SFX', color: '#fb7185', gain: 1, clip: sfx } as Track])
  const context = await renderAudio(legacy.tracks)
  const sources = only<FakeBufferSource>(context.nodes, 'bufferSource')
  assert.equal(sources.length, 1)
  assert.equal(sources[0].started[0], 0)
  assert.equal(sources[0].offsets[0], 0)
})
