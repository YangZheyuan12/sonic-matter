let previewContext: AudioContext | null = null
let activeNodes: AudioScheduledSourceNode[] = []

type Mixer = { length: number; density: number; brightness: number; space: number; compact: number }

export function playSoundPreview(description: string, mixer: Mixer) {
  previewContext ??= new AudioContext()
  const context = previewContext
  activeNodes.forEach(node => { try { node.stop() } catch { /* already ended */ } })
  activeNodes = []
  void context.resume()
  const now = context.currentTime + 0.04
  const duration = Math.max(.25, Math.min(6, mixer.length))
  const master = context.createGain()
  const filter = context.createBiquadFilter()
  const wet = context.createDelay(1)
  const feedback = context.createGain()
  const space = Math.max(0, Math.min(1, mixer.space / 100))
  master.gain.setValueAtTime(.0001, now)
  master.gain.linearRampToValueAtTime(.18, now + Math.min(.05, duration / 5))
  master.gain.exponentialRampToValueAtTime(.0001, now + duration)
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
    const buffer = context.createBuffer(1, context.sampleRate * duration, context.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * .3
    const source = context.createBufferSource(); source.buffer = buffer; source.loop = false
    const noiseFilter = context.createBiquadFilter(); noiseFilter.type = 'lowpass'; noiseFilter.frequency.value = 500 + mixer.brightness * 24
    source.connect(noiseFilter).connect(master); source.start(now); activeNodes.push(source)
    return
  }
  const bursts = Math.max(1, Math.round(1 + mixer.density / 30))
  for (let index = 0; index < bursts; index += 1) {
    const start = now + (index / bursts) * duration * .75
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = isBird ? 'sine' : isMetal ? 'triangle' : 'sawtooth'
    const base = isBird ? 900 + mixer.brightness * 18 : isMetal ? 420 + mixer.brightness * 12 : 160 + mixer.brightness * 5
    oscillator.frequency.setValueAtTime(base * (isBird ? .7 : 1), start)
    oscillator.frequency.exponentialRampToValueAtTime(base * (isBird ? 1.8 : .55), start + Math.min(.22, duration / 3))
    envelope.gain.setValueAtTime(.0001, start)
    envelope.gain.linearRampToValueAtTime(.22 / bursts, start + Math.min(.025, duration / 8))
    envelope.gain.exponentialRampToValueAtTime(.0001, Math.min(now + duration, start + (isBird ? .28 : .7)))
    oscillator.connect(envelope).connect(master)
    oscillator.start(start); oscillator.stop(Math.min(now + duration + .02, start + 1))
    activeNodes.push(oscillator)
  }
}
