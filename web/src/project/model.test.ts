import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOCAL_SOUND_CLIP_PREFIX,
  audibleTracks,
  isPlayableClip,
  loadLocalProject,
  melodyTrackTemplate,
  normalizeProject,
  primaryMelodyTrack,
  projectDuration,
  trackGain,
  trackPan,
  trackStart,
  type Note,
  type Project,
  type Track,
} from './model.ts'

// 与源码同目录，用 Node 自带的测试运行器执行：node --test "src/**/*.test.ts"
// 不引入 vitest / jsdom，保证零新增依赖也能在 CI 与本地离线跑通。

const midiTrack = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  name: id,
  kind: 'midi',
  instrument: 'Glass Keys',
  color: '#7dd3fc',
  notes: [],
  ...extra,
})

const audioTrack = (id: string, clip?: string): Track => ({
  id,
  name: id,
  kind: 'audio',
  instrument: 'Audio',
  color: '#c4b5fd',
  clip,
})

const project = (tracks: Track[], extra: Partial<Project> = {}): Project => ({
  title: '测试工程',
  tempo: 92,
  key: 'C Major',
  duration: 10,
  masterGain: 0.9,
  tracks,
  ...extra,
})

test('projectDuration 默认 10 秒，并钳制在 1-120 秒之间', () => {
  assert.equal(projectDuration(project([midiTrack('melody')])), 10)
  assert.equal(projectDuration(project([midiTrack('melody')], { duration: 0 })), 1)
  assert.equal(projectDuration(project([midiTrack('melody')], { duration: -5 })), 1)
  assert.equal(projectDuration(project([midiTrack('melody')], { duration: 999 })), 120)
  assert.equal(projectDuration(project([midiTrack('melody')], { duration: 12.5 })), 12.5)
})

test('trackGain / trackPan / trackStart 有默认值且会钳制越界值', () => {
  assert.equal(trackGain(midiTrack('a')), 0.8)
  assert.equal(trackGain(midiTrack('a', { gain: 2 })), 1)
  assert.equal(trackGain(midiTrack('a', { gain: -1 })), 0)

  assert.equal(trackPan(midiTrack('a')), 0)
  assert.equal(trackPan(midiTrack('a', { pan: 5 })), 1)
  assert.equal(trackPan(midiTrack('a', { pan: -5 })), -1)

  assert.equal(trackStart(midiTrack('a')), 0)
  assert.equal(trackStart(midiTrack('a', { start: -3 })), 0)
  assert.equal(trackStart(midiTrack('a', { start: 4.25 })), 4.25)
})

test('isPlayableClip 只认真正的音频来源', () => {
  assert.equal(isPlayableClip('/generated/123.wav'), true)
  assert.equal(isPlayableClip(`${LOCAL_SOUND_CLIP_PREFIX}eyJhIjoxfQ==`), true)
  assert.equal(isPlayableClip('data:audio/wav;base64,AAAA'), true)
  assert.equal(isPlayableClip('blob:http://127.0.0.1:5173/abc'), true)
  assert.equal(isPlayableClip('https://example.com/a.mp3'), true)

  // 这些是“有轨道但没声音”的假 clip，必须判定为不可播放
  assert.equal(isPlayableClip(undefined), false)
  assert.equal(isPlayableClip(''), false)
  assert.equal(isPlayableClip('sound.txt'), false)
  assert.equal(isPlayableClip('gpt-6-astra'), false)
  assert.equal(isPlayableClip('./generated/x.wav'), false)
})

test('primaryMelodyTrack 优先 id 为 melody 的 MIDI 轨，否则退回第一条 MIDI 轨', () => {
  const first = midiTrack('lead')
  const second = midiTrack('melody')
  assert.equal(primaryMelodyTrack(project([first, second]))?.id, 'melody')
  assert.equal(primaryMelodyTrack(project([first, midiTrack('bass')]))?.id, 'lead')
  assert.equal(primaryMelodyTrack(project([audioTrack('audio-1', '/generated/a.wav')])), undefined)
})

test('melodyTrackTemplate 产出可直接录制的兜底轨道', () => {
  const notes: Note[] = [{ id: 'n1', pitch: 60, start: 0, duration: 0.5, velocity: 90 }]
  const template = melodyTrackTemplate(notes)
  assert.equal(template.id, 'melody')
  assert.equal(template.kind, 'midi')
  assert.equal(template.notes?.length, 1)
  assert.equal(template.muted, false)
  assert.equal(melodyTrackTemplate().notes?.length, 0)
})

test('audibleTracks 处理静音与独奏', () => {
  const a = midiTrack('a')
  const b = midiTrack('b', { muted: true })
  const c = midiTrack('c')
  assert.deepEqual(audibleTracks(project([a, b, c])).map(track => track.id), ['a', 'c'])
  assert.deepEqual(audibleTracks(project([a, b, c], {})).map(track => track.id), ['a', 'c'])
  assert.deepEqual(audibleTracks(project([a, midiTrack('b', { solo: true }), c])).map(track => track.id), ['b'])
  // 独奏 + 静音同时存在时，静音优先
  assert.deepEqual(audibleTracks(project([a, midiTrack('b', { solo: true, muted: true })])).map(track => track.id), [])
})

test('normalizeProject 修复脏数据而不是直接崩溃', () => {
  const normalized = normalizeProject({
    title: '   ',
    tempo: 9999,
    masterGain: -1,
    tracks: [
      { name: '', notes: [{ pitch: 300, velocity: 500, start: -2, duration: 0 }] },
      { kind: 'audio', clip: '/generated/a.wav', notes: [{ pitch: 60 }] },
    ],
  })

  assert.equal(normalized.title, '未命名工程')
  assert.equal(normalized.tempo, 300)
  assert.equal(normalized.masterGain, 0)
  assert.equal(normalized.duration, 10)

  const [first, second] = normalized.tracks
  assert.equal(first.id, 'track-1')
  assert.equal(first.name, '轨道 1')
  assert.equal(first.instrument, 'Synth')
  assert.equal(first.kind, 'midi')
  assert.equal(first.gain, 0.8)
  assert.equal(first.notes?.[0].pitch, 127)
  assert.equal(first.notes?.[0].velocity, 127)
  assert.equal(first.notes?.[0].start, 0)
  assert.equal(first.notes?.[0].duration, 0.02)
  assert.equal(first.notes?.[0].id, 'note-0-0')

  // audio 轨不应该带 notes，clip 要保留
  assert.equal(second.kind, 'audio')
  assert.equal(second.notes, undefined)
  assert.equal(second.clip, '/generated/a.wav')
})

test('normalizeProject 保留队友版本的老裁剪字段，但不会把 NaN 写进工程', () => {
  const normalized = normalizeProject({
    tracks: [
      { id: 'ai-music', kind: 'audio', clip: '/generated/a.wav', clipStart: .5, clipEnd: 2, fadeIn: .2, fadeOut: 'x' },
      { id: 'melody', kind: 'midi', clipStart: 1, fadeIn: 1 },
    ],
  })
  const [audio, midi] = normalized.tracks
  assert.equal(audio.clipStart, .5)
  assert.equal(audio.clipEnd, 2)
  assert.equal(audio.fadeIn, .2)
  assert.equal(audio.fadeOut, undefined, '不是有限数字的字段要丢掉')
  assert.equal(midi.clipStart, undefined, '老字段只对音频轨有意义')
  assert.equal(midi.fadeIn, undefined)
  // 归一化后的工程会被 App 写进 localStorage，JSON 里不能出现 null / NaN
  assert.equal(JSON.stringify(normalized).includes('null'), false)
})

test('normalizeProject 对结构性错误给出中文报错', () => {
  assert.throws(() => normalizeProject(null), /不是有效的 JSON 对象/)
  assert.throws(() => normalizeProject('{}'), /不是有效的 JSON 对象/)
  assert.throws(() => normalizeProject({}), /缺少 tracks 数组/)
  assert.throws(() => normalizeProject({ tracks: [] }), /至少需要一条轨道/)
  assert.throws(() => normalizeProject({ tracks: [null] }), /第 1 条轨道格式不正确/)
})

test('normalizeProject 保留游戏音频上下文，并清理非法扩展字段', () => {
  const normalized = normalizeProject({
    gameBrief: {
      title: '海底遗迹',
      genre: '探索解谜',
      gameplay: '在遗迹中寻找线索',
      world: '被海水吞没的古代城市',
      references: ['作品 A', 3, '作品 B'],
      scenes: [{ id: 'ruins', name: '遗迹', description: '夜晚的水下遗迹', moods: ['神秘'] }, { name: '' }],
      events: [{ id: 'door', name: '石门打开', description: '沉重的石门缓慢开启' }],
    },
    gameAnalysis: {
      summary: '安静而神秘',
      moods: ['神秘'],
      musicDirections: [{ id: 'wide', title: '空旷神秘', summary: '留白较多', moods: ['神秘'], suitableScenes: ['遗迹'], recommendedInstruments: ['Pad'] }],
      sfxDirections: [{ id: 'natural', title: '写实自然', summary: '克制的材质感', tags: ['水下'] }],
      recommendedInstruments: ['钢琴'],
      recommendedMaterials: ['石材'],
      avoidDirections: ['过度明亮'],
    },
    soundDirection: {
      musicStyle: ['空旷神秘'],
      musicMood: ['神秘'],
      primaryInstruments: ['钢琴'],
      secondaryInstruments: ['Pad'],
      rhythmIntensity: 120,
      melodicDensity: -5,
      ambienceLevel: 70,
      sfxStyle: ['写实自然'],
      selectedDemos: ['demo-wide'],
    },
    assets: [{ id: 'sfx-1', title: '石门开启', kind: 'sfx', origin: 'generated', status: 'confirmed', source: '/generated/door.wav', createdAt: 123, sceneId: 'ruins', eventId: 'door' }, { title: '', source: '/generated/bad.wav' }],
    currentSceneId: 'ruins',
    tracks: [{ id: 'melody', kind: 'midi' }],
  })

  assert.equal(normalized.gameBrief?.scenes.length, 1)
  assert.deepEqual(normalized.gameBrief?.references, ['作品 A', '作品 B'])
  assert.equal(normalized.gameAnalysis?.musicDirections[0].id, 'wide')
  assert.equal(normalized.soundDirection?.rhythmIntensity, 100)
  assert.equal(normalized.soundDirection?.melodicDensity, 0)
  assert.equal(normalized.assets?.length, 1)
  assert.equal(normalized.assets?.[0].eventId, 'door')
  assert.equal(normalized.currentSceneId, 'ruins')
})

test('normalizeProject 兼容没有新字段的旧工程', () => {
  const normalized = normalizeProject({ tracks: [{ id: 'melody', kind: 'midi' }] })
  assert.equal(normalized.gameBrief, undefined)
  assert.equal(normalized.gameAnalysis, undefined)
  assert.equal(normalized.soundDirection, undefined)
  assert.equal(normalized.assets, undefined)
  assert.equal(normalized.currentSceneId, undefined)
})

test('loadLocalProject 读取本地存档，存档损坏时回退到默认工程', () => {
  const fallback = project([midiTrack('melody')])
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const store = (value: string | null) => Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: { getItem: () => value },
  })
  try {
    store(JSON.stringify({ title: '已保存的工程', tracks: [{ id: 'saved', kind: 'midi' }] }))
    assert.equal(loadLocalProject(fallback).title, '已保存的工程')

    store('{ this is not json')
    assert.equal(loadLocalProject(fallback).title, '测试工程')

    store(JSON.stringify({ tracks: [] }))
    assert.equal(loadLocalProject(fallback).title, '测试工程')

    store(null)
    assert.equal(loadLocalProject(fallback).title, '测试工程')
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
