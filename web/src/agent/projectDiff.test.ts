import assert from 'node:assert/strict'
import test from 'node:test'
import { createHistory, currentProject, pushHistory, undo } from '../project/history.ts'
import type { Project, Track } from '../project/model.ts'
import { claimApprovedRun } from './approval.ts'
import { buildProjectDiff, revisionCount, validationReports } from './projectDiff.ts'
import type { AgentRun } from './run.ts'

const track = (id: string, name: string, notes: Track['notes'], instrument = 'Piano'): Track => ({
  id,
  name,
  kind: 'midi',
  instrument,
  color: '#fff',
  notes,
})

const source: Project = {
  title: '原工程',
  tempo: 92,
  key: 'C Major',
  tracks: [
    track('remove', '待删除轨', [{ id: 'old', pitch: 60, start: 0, duration: 1, velocity: 80 }]),
    track('keep', '主旋律', [
      { id: 'same', pitch: 60, start: 0, duration: 1, velocity: 80 },
      { id: 'change', pitch: 62, start: 1, duration: 1, velocity: 80 },
      { id: 'delete', pitch: 64, start: 2, duration: 1, velocity: 80 },
    ]),
  ],
}

const candidate: Project = {
  ...source,
  title: '候选工程',
  tempo: 108,
  tracks: [
    track('keep', '主旋律', [
      { id: 'same', pitch: 60, start: 0, duration: 1, velocity: 80 },
      { id: 'change', pitch: 65, start: 1, duration: 1, velocity: 80 },
      { id: 'new', pitch: 67, start: 2, duration: 1, velocity: 80 },
    ], 'Cello'),
    track('add', '新增轨', [{ id: 'added-track-note', pitch: 48, start: 0, duration: 2, velocity: 70 }]),
  ],
}

test('快照 Diff 按稳定 ID 统计轨道与音符的新增、删除和修改', () => {
  const diff = buildProjectDiff(source, candidate)
  assert.deepEqual(diff.tracks, { added: 1, removed: 1, modified: 1 })
  assert.deepEqual(diff.notes, { added: 2, removed: 2, modified: 1 })
  assert.deepEqual(diff.addedTracks, ['新增轨'])
  assert.deepEqual(diff.removedTracks, ['待删除轨'])
  assert.deepEqual(diff.modifiedTracks, ['主旋律'])
  assert.deepEqual(diff.changedProjectFields, ['工程名称', '速度'])
})

test('批准候选快照只写入一个历史步骤，一次撤销恢复批准前引用', () => {
  const history = createHistory(source)
  const approved = pushHistory(history, candidate, '批准 Agent 修改', { key: '' })
  assert.equal(currentProject(approved), candidate)
  assert.equal(approved.entries.length, 2)
  assert.equal(currentProject(undo(approved)), source)
})

test('同一个 Run 只能领取一次本地应用权，重复批准响应不会重复写历史', () => {
  const applied = new Set<string>()
  assert.equal(claimApprovedRun(applied, 'run-1'), true)
  assert.equal(claimApprovedRun(applied, 'run-1'), false)
  assert.equal(claimApprovedRun(applied, 'run-2'), true)
})

test('验收报告与修订次数从 Trace 步骤提取，损坏摘要可以安全降级', () => {
  const report = JSON.stringify({
    passed: true,
    failedRuleIds: [],
    rules: [{ id: 'tracks', type: 'track_count', passed: true, actual: { trackCount: 2 }, reason: '轨道数量符合要求。' }],
  })
  const run: AgentRun = {
    id: 'run-1',
    status: 'awaiting_approval',
    instruction: '增加轨道',
    createdAt: 1,
    updatedAt: 2,
    steps: [
      { id: 'rev-1', kind: 'revision', status: 'succeeded', title: '修订', toolCalls: [] },
      { id: 'check-1', kind: 'validation', status: 'succeeded', title: '最终验收', summary: report, toolCalls: [] },
      { id: 'check-2', kind: 'validation', status: 'failed', title: '截断验收', summary: '{bad', toolCalls: [] },
    ],
  }
  assert.equal(revisionCount(run), 1)
  assert.deepEqual(validationReports(run), [
    { id: 'check-1', title: '最终验收', passed: true, rules: [{ id: 'tracks', passed: true, reason: '轨道数量符合要求。' }] },
    { id: 'check-2', title: '截断验收', passed: false, rules: [] },
  ])
})
