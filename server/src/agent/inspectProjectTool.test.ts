import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  inspectProject,
  inspectProjectOutputSchema,
  inspectProjectTool,
  type InspectProjectInput,
} from './inspectProjectTool.ts'
import { AgentToolRegistry } from './toolRegistry.ts'

const note = (id: string, pitch: number) => ({
  id,
  pitch,
  start: 0,
  duration: 0.5,
  velocity: 90,
})

const projectInput = (): InspectProjectInput => ({
  project: {
    title: '潮汐档案',
    tempo: 72,
    key: 'C minor',
    duration: 12,
    tracks: [
      {
        id: 'melody',
        name: '主旋律',
        kind: 'midi',
        instrument: 'Felt Piano',
        color: '#fff',
        notes: [note('note-secret-1', 60), note('note-secret-2', 63)],
        muted: false,
        solo: true,
      },
      {
        id: 'ambience',
        name: '环境声',
        kind: 'audio',
        instrument: 'Field Recording',
        color: '#000',
        clips: [
          {
            id: 'clip-secret-1',
            source: '/generated/private-source.wav',
            start: 0,
            offset: 0,
            duration: 12,
            fadeIn: 1,
            fadeOut: 1,
            gain: 0.8,
          },
        ],
        muted: true,
      },
    ],
  },
})

test('inspect_project 返回足够规划的工程摘要', () => {
  const result = inspectProject(projectInput())

  assert.deepEqual(result, {
    title: '潮汐档案',
    durationSeconds: 12,
    tempoBpm: 72,
    key: 'C minor',
    trackCount: 2,
    midiTrackCount: 1,
    audioTrackCount: 1,
    noteCount: 2,
    clipCount: 1,
    instruments: ['Felt Piano', 'Field Recording'],
    tracks: [
      {
        id: 'melody',
        name: '主旋律',
        kind: 'midi',
        instrument: 'Felt Piano',
        noteCount: 2,
        clipCount: 0,
        muted: false,
        solo: true,
      },
      {
        id: 'ambience',
        name: '环境声',
        kind: 'audio',
        instrument: 'Field Recording',
        noteCount: 0,
        clipCount: 1,
        muted: true,
        solo: false,
      },
    ],
  })
  assert.equal(inspectProjectOutputSchema.safeParse(result).success, true)
})

test('空轨工程会返回零计数摘要', async () => {
  const registry = new AgentToolRegistry()
  registry.register(inspectProjectTool)

  const result = await registry.execute('inspect_project', {
    project: {
      title: '空工程',
      tempo: 92,
      key: 'C Major',
      tracks: [],
    },
  })

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.output, {
      title: '空工程',
      durationSeconds: 10,
      tempoBpm: 92,
      key: 'C Major',
      trackCount: 0,
      midiTrackCount: 0,
      audioTrackCount: 0,
      noteCount: 0,
      clipCount: 0,
      instruments: [],
      tracks: [],
    })
  }
})

test('老版单片段音频工程会使用默认时长并统计 clip', async () => {
  const registry = new AgentToolRegistry()
  registry.register(inspectProjectTool)

  const result = await registry.execute('inspect_project', {
    project: {
      title: '旧版工程',
      tempo: 80,
      key: 'D minor',
      tracks: [
        {
          id: 'legacy-audio',
          name: '旧版音频',
          kind: 'audio',
          instrument: 'Sampler',
          color: '#abc',
          clip: '/generated/legacy.wav',
        },
      ],
    },
  })

  assert.equal(result.ok, true)
  if (result.ok) {
    const output = result.output as Record<string, unknown>
    assert.equal(output.durationSeconds, 10)
    assert.equal(output.clipCount, 1)
    assert.deepEqual(output.instruments, ['Sampler'])
  }
})

test('异常工程在执行前被输入 Schema 拒绝', async () => {
  const registry = new AgentToolRegistry()
  registry.register(inspectProjectTool)

  const malformedProjects = [
    { title: '缺轨道', tempo: 92, key: 'C Major' },
    { title: '错误速度', tempo: Number.NaN, key: 'C Major', tracks: [] },
    { title: '错误轨道', tempo: 92, key: 'C Major', tracks: [null] },
  ]

  for (const project of malformedProjects) {
    const result = await registry.execute('inspect_project', { project })

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'invalid_tool_input')
    }
  }
})

test('相同输入得到相同摘要且不修改原工程', () => {
  const input = projectInput()
  const originalSnapshot = structuredClone(input)

  const first = inspectProject(input)
  const second = inspectProject(input)

  assert.deepEqual(first, second)
  assert.deepEqual(input, originalSnapshot)
  assert.notEqual(first.tracks, input.project.tracks)
})

test('摘要不携带完整音符、片段或音频地址', () => {
  const serialized = JSON.stringify(inspectProject(projectInput()))

  assert.equal(serialized.includes('note-secret'), false)
  assert.equal(serialized.includes('clip-secret'), false)
  assert.equal(serialized.includes('private-source.wav'), false)
  assert.equal(serialized.includes('"notes"'), false)
  assert.equal(serialized.includes('"clips"'), false)
  assert.equal(serialized.includes('"source"'), false)
})
