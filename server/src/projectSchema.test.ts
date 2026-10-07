import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectSchema, trackSchema } from './projectSchema.ts'

const clip = (over: Record<string, unknown> = {}) => ({ id: 'clip-1', source: '/generated/a.wav', start: 0, offset: 0, duration: 10, fadeIn: 0, fadeOut: 0, gain: 1, ...over })
const audioTrack = (over: Record<string, unknown> = {}) => ({ id: 'ai-music', name: 'AI 生成音频', kind: 'audio', instrument: 'Audio Model', color: '#c4b5fd', clips: [clip()], ...over })
const project = (tracks: unknown[]) => ({ title: '测试工程', tempo: 92, key: 'C', duration: 10, tracks })

test('带 clips 的音频片段能通过校验并保留数值', () => {
  const parsed = trackSchema.parse(audioTrack({ clips: [clip({ start: 1.5, offset: .25, duration: 3, fadeIn: .4, fadeOut: .2, gain: .5 })] }))
  assert.equal(parsed.clips?.length, 1)
  assert.deepEqual(parsed.clips?.[0], { id: 'clip-1', source: '/generated/a.wav', start: 1.5, offset: .25, duration: 3, fadeIn: .4, fadeOut: .2, gain: .5 })
})

test('片段数值越界会被挡下来，不会带进工程', () => {
  assert.equal(trackSchema.safeParse(audioTrack({ clips: [clip({ start: -1 })] })).success, false)
  assert.equal(trackSchema.safeParse(audioTrack({ clips: [clip({ gain: 1.4 })] })).success, false)
  assert.equal(trackSchema.safeParse(audioTrack({ clips: [clip({ duration: 0 })] })).success, false)
  assert.equal(trackSchema.safeParse(audioTrack({ clips: [clip({ offset: -2 })] })).success, false)
  assert.equal(trackSchema.safeParse(audioTrack({ clips: [{ source: '/generated/a.wav' }] })).success, false, '缺少 id / 时长等必填字段要报错')
})

test('片段数组有上限，避免请求体被塞爆', () => {
  const many = Array.from({ length: 65 }, (_, index) => clip({ id: `clip-${index}` }))
  assert.equal(trackSchema.safeParse(audioTrack({ clips: many })).success, false)
  assert.equal(trackSchema.safeParse(audioTrack({ clips: many.slice(0, 64) })).success, true)
})

test('老工程的单片段字段与 MIDI 轨仍然能提交上来', () => {
  const legacy = projectSchema.parse(project([audioTrack({ clips: undefined, clip: '/generated/old.wav' })]))
  assert.equal(legacy.tracks[0].clip, '/generated/old.wav')
  assert.equal(legacy.tracks[0].clips, undefined)
  const midi = projectSchema.parse(project([{ id: 'cello', name: '水下大提琴', kind: 'midi', instrument: 'Cello', color: '#a78bfa', notes: [{ id: 'c1', pitch: 48, start: 1.8, duration: 1.2, velocity: 70 }] }]))
  assert.equal(midi.tracks[0].notes?.length, 1)
})

test('前端多塞的未知字段会被剥掉，不会让请求 400', () => {
  const parsed = projectSchema.parse({ ...project([audioTrack()]), somethingNew: 'x' })
  assert.equal('somethingNew' in parsed, false)
  assert.equal(parsed.tracks[0].clips?.length, 1)
})

test('游戏音频上下文可以通过工程 Schema 并被保留', () => {
  const parsed = projectSchema.parse({
    ...project([audioTrack()]),
    gameBrief: {
      title: '海底遗迹',
      genre: '探索解谜',
      gameplay: '寻找线索',
      world: '被海水吞没的古城',
      references: ['作品 A'],
      scenes: [{ id: 'ruins', name: '遗迹', description: '夜晚遗迹', moods: ['神秘'] }],
      events: [{ id: 'door', name: '石门打开', description: '沉重的石门开启', category: '机关' }],
    },
    gameAnalysis: {
      summary: '安静、神秘',
      moods: ['神秘'],
      musicDirections: [{ id: 'wide', title: '空旷神秘', summary: '留白较多', moods: ['神秘'], suitableScenes: ['遗迹'], recommendedInstruments: ['Pad'] }],
      sfxDirections: [{ id: 'natural', title: '写实自然', summary: '克制', tags: ['水下'] }],
      recommendedInstruments: ['钢琴'],
      recommendedMaterials: ['石材'],
      avoidDirections: ['过度明亮'],
    },
    soundDirection: {
      musicStyle: ['空旷神秘'],
      musicMood: ['神秘'],
      primaryInstruments: ['钢琴'],
      secondaryInstruments: ['Pad'],
      rhythmIntensity: 20,
      melodicDensity: 35,
      ambienceLevel: 85,
      sfxStyle: ['写实自然'],
      selectedDemos: ['demo-wide'],
    },
    assets: [{ id: 'sfx-1', title: '石门开启', kind: 'sfx', origin: 'generated', status: 'confirmed', source: '/generated/door.wav', createdAt: 123, sceneId: 'ruins', eventId: 'door' }],
    currentSceneId: 'ruins',
  })

  assert.equal(parsed.gameBrief?.scenes[0].id, 'ruins')
  assert.equal(parsed.gameAnalysis?.musicDirections[0].title, '空旷神秘')
  assert.equal(parsed.soundDirection?.ambienceLevel, 85)
  assert.equal(parsed.assets?.[0].source, '/generated/door.wav')
  assert.equal(parsed.currentSceneId, 'ruins')
})

test('游戏音频上下文的数组和文本上限生效', () => {
  const base = project([audioTrack()])
  const brief = {
    title: 'x', genre: 'x', gameplay: 'x', world: 'x', references: [], scenes: [], events: [],
  }
  assert.equal(projectSchema.safeParse({ ...base, gameBrief: { ...brief, references: Array.from({ length: 13 }, () => 'x') } }).success, false)
  assert.equal(projectSchema.safeParse({ ...base, soundDirection: { musicStyle: [], musicMood: [], primaryInstruments: [], secondaryInstruments: [], rhythmIntensity: 101, melodicDensity: 0, ambienceLevel: 0, sfxStyle: [], selectedDemos: [] } }).success, false)
  assert.equal(projectSchema.safeParse({ ...base, assets: Array.from({ length: 129 }, (_, index) => ({ id: `a-${index}`, title: 'x', kind: 'sfx', origin: 'generated', status: 'draft', source: '/generated/x.wav', createdAt: 0 })) }).success, false)
})
test('字符串与数组都有上限，挡住整包塞爆请求体的做法', () => {
  assert.equal(projectSchema.safeParse(project([audioTrack({ name: 'x'.repeat(121) })])).success, false)
  assert.equal(projectSchema.safeParse(project([audioTrack({ instrument: 'x'.repeat(61) })])).success, false)
  assert.equal(projectSchema.safeParse(project([audioTrack({ id: '' })])).success, false)
  assert.equal(projectSchema.safeParse({ ...project([audioTrack()]), title: '' }).success, false)
  assert.equal(projectSchema.safeParse({ ...project([audioTrack()]), key: 'x'.repeat(31) }).success, false)
  assert.equal(projectSchema.safeParse({ ...project([audioTrack()]), tracks: [] }).success, false)
  const manyTracks = Array.from({ length: 33 }, (_, index) => audioTrack({ id: `t-${index}` }))
  assert.equal(projectSchema.safeParse({ ...project([audioTrack()]), tracks: manyTracks }).success, false)
  const note = (index: number) => ({ id: `n-${index}`, pitch: 60, start: 0, duration: .5, velocity: 90 })
  const midiTrack = (count: number) => ({ id: 'melody', name: '旋律', kind: 'midi', instrument: 'Piano', color: '#fff', notes: Array.from({ length: count }, (_, index) => note(index)) })
  assert.equal(projectSchema.safeParse(project([midiTrack(4097)])).success, false, '音符数量超上限要挡下来')
  assert.equal(projectSchema.safeParse(project([midiTrack(4096)])).success, true)
  // 上限留了余量：正常工程与 base64 的本地音效计划都能进来
  assert.equal(projectSchema.safeParse(project([audioTrack({ name: 'x'.repeat(120) })])).success, true)
  assert.equal(trackSchema.safeParse(audioTrack({ clips: undefined, clip: 'local-sfx:' + 'a'.repeat(9000) })).success, true)
})
