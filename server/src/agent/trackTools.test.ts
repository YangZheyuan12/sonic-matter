import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectSchema } from '../projectSchema.ts'
import {
  addTrackTool,
  removeTrackTool,
  trackTools,
  trackToolOutputSchema,
  updateTrackTool,
  type TrackToolOutput,
} from './trackTools.ts'
import { AgentToolRegistry, type AgentToolExecutionResult } from './toolRegistry.ts'

const track = (id: string, name = id) => ({
  id,
  name,
  kind: 'midi' as const,
  instrument: 'Felt Piano',
  color: '#7dd3fc',
  notes: [],
  gain: 0.8,
  pan: 0,
  muted: false,
  solo: false,
  start: 0,
})

const project = (...tracks: ReturnType<typeof track>[]) => ({
  title: '测试工程',
  tempo: 92,
  key: 'C Major',
  duration: 10,
  tracks,
})

function registryWithTrackTools(): AgentToolRegistry {
  const registry = new AgentToolRegistry()
  registry.register(addTrackTool)
  registry.register(updateTrackTool)
  registry.register(removeTrackTool)
  return registry
}

function outputOf(result: AgentToolExecutionResult): TrackToolOutput {
  if (!result.ok) {
    throw new Error(`工具调用失败：${result.error.code}`)
  }
  return trackToolOutputSchema.parse(result.output)
}

test('add_track 返回包含新轨道的 Project 快照且不修改原工程', async () => {
  const registry = registryWithTrackTools()
  const original = project(track('melody', '主旋律'))
  const originalSnapshot = structuredClone(original)

  const output = outputOf(
    await registry.execute('add_track', {
      project: original,
      track: track('bass', '低音'),
    }),
  )

  assert.equal(output.status, 'applied')
  if (output.status === 'applied') {
    assert.equal(output.changed, true)
    assert.deepEqual(output.project.tracks.map((item) => item.id), [
      'melody',
      'bass',
    ])
    assert.equal(projectSchema.safeParse(output.project).success, true)
  }
  assert.deepEqual(original, originalSnapshot)
})

test('add_track 拒绝重复 ID 和超过轨道上限', async () => {
  const registry = registryWithTrackTools()
  const duplicate = outputOf(
    await registry.execute('add_track', {
      project: project(track('melody')),
      track: track('melody', '重复轨道'),
    }),
  )

  assert.deepEqual(duplicate, {
    status: 'rejected',
    error: {
      code: 'track_id_conflict',
      message: '轨道 ID“melody”已存在，请更换 ID 后重试。',
      shouldTerminate: false,
    },
  })

  const fullProject = project(
    ...Array.from({ length: 32 }, (_, index) => track(`track-${index + 1}`)),
  )
  const full = outputOf(
    await registry.execute('add_track', {
      project: fullProject,
      track: track('track-33'),
    }),
  )

  assert.equal(full.status, 'rejected')
  if (full.status === 'rejected') {
    assert.equal(full.error.code, 'track_limit_reached')
    assert.equal(full.error.shouldTerminate, true)
  }
})

test('update_track 只更新允许字段并守住音量边界', async () => {
  const registry = registryWithTrackTools()
  const original = project(track('melody', '主旋律'))
  const originalSnapshot = structuredClone(original)

  const output = outputOf(
    await registry.execute('update_track', {
      project: original,
      trackId: 'melody',
      update: {
        name: '  弦乐主题  ',
        instrument: 'String Ensemble',
        gain: 0.45,
        pan: -0.2,
        muted: true,
      },
    }),
  )

  assert.equal(output.status, 'applied')
  if (output.status === 'applied') {
    assert.equal(output.project.tracks[0]?.name, '弦乐主题')
    assert.equal(output.project.tracks[0]?.instrument, 'String Ensemble')
    assert.equal(output.project.tracks[0]?.gain, 0.45)
    assert.equal(output.project.tracks[0]?.pan, -0.2)
    assert.equal(output.project.tracks[0]?.muted, true)
  }
  assert.deepEqual(original, originalSnapshot)

  for (const update of [{ gain: 1.1 }, { id: 'new-id' }, {}]) {
    const result = await registry.execute('update_track', {
      project: original,
      trackId: 'melody',
      update,
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'invalid_tool_input')
    }
  }
})

test('update_track 对不存在轨道返回可重新规划的稳定错误', async () => {
  const output = outputOf(
    await registryWithTrackTools().execute('update_track', {
      project: project(track('melody')),
      trackId: 'missing',
      update: { gain: 0.5 },
    }),
  )

  assert.equal(output.status, 'rejected')
  if (output.status === 'rejected') {
    assert.equal(output.error.code, 'track_not_found')
    assert.equal(output.error.shouldTerminate, false)
  }
})

test('update_track 对幂等更新返回 changed=false 和原快照', async () => {
  const original = project(track('melody'))
  const output = outputOf(
    await registryWithTrackTools().execute('update_track', {
      project: original,
      trackId: 'melody',
      update: { gain: 0.8 },
    }),
  )

  assert.equal(output.status, 'applied')
  if (output.status === 'applied') {
    assert.equal(output.changed, false)
    assert.deepEqual(output.project, original)
  }
})

test('remove_track 返回删除后的新快照且不修改原工程', async () => {
  const registry = registryWithTrackTools()
  const original = project(track('melody'), track('bass'))
  const originalSnapshot = structuredClone(original)

  const output = outputOf(
    await registry.execute('remove_track', {
      project: original,
      trackId: 'bass',
    }),
  )

  assert.equal(output.status, 'applied')
  if (output.status === 'applied') {
    assert.deepEqual(output.project.tracks.map((item) => item.id), ['melody'])
    assert.equal(projectSchema.safeParse(output.project).success, true)
  }
  assert.deepEqual(original, originalSnapshot)
})

test('remove_track 拒绝删除最后一轨并告知 Runner 终止', async () => {
  const output = outputOf(
    await registryWithTrackTools().execute('remove_track', {
      project: project(track('melody')),
      trackId: 'melody',
    }),
  )

  assert.deepEqual(output, {
    status: 'rejected',
    error: {
      code: 'last_track_removal_forbidden',
      message: '工程至少需要保留一条轨道，不能删除最后一条轨道。',
      shouldTerminate: true,
    },
  })
})

test('remove_track 对不存在轨道返回非终止错误', async () => {
  const output = outputOf(
    await registryWithTrackTools().execute('remove_track', {
      project: project(track('melody')),
      trackId: 'missing',
    }),
  )

  assert.equal(output.status, 'rejected')
  if (output.status === 'rejected') {
    assert.equal(output.error.code, 'track_not_found')
    assert.equal(output.error.shouldTerminate, false)
  }
})

test('三个轨道工具均符合 AgentTool 契约', () => {
  assert.equal(addTrackTool.name, 'add_track')
  assert.equal(updateTrackTool.name, 'update_track')
  assert.equal(removeTrackTool.name, 'remove_track')
  assert.deepEqual(
    trackTools.map((tool) => tool.name),
    ['add_track', 'update_track', 'remove_track'],
  )
})
