import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  evaluateProject,
  evaluationReportSchema,
  type EvaluationConstraint,
} from './evaluator.ts'

const note = (id: string, start: number) => ({
  id,
  pitch: 60,
  start,
  duration: 0.25,
  velocity: 90,
})

const project = () => ({
  title: '深海遗迹',
  tempo: 92,
  key: 'C minor',
  duration: 8,
  tracks: [
    {
      id: 'melody',
      name: '主旋律',
      kind: 'midi' as const,
      instrument: 'Felt Piano',
      color: '#7dd3fc',
      notes: [note('m1', 0), note('m2', 1), note('m3', 1.999), note('m4', 2)],
    },
    {
      id: 'bass',
      name: '低音',
      kind: 'midi' as const,
      instrument: 'Electric Bass',
      color: '#a78bfa',
      notes: [note('b1', 0.5), note('b2', 1.5)],
    },
    {
      id: 'ambience',
      name: '环境声',
      kind: 'audio' as const,
      instrument: 'Ocean Ambience',
      color: '#22d3ee',
      clips: [],
    },
  ],
})

const passingConstraints = (): EvaluationConstraint[] => [
  { id: 'required-bass', type: 'required_instrument', instrument: 'electric bass' },
  { id: 'forbid-drums', type: 'forbidden_instrument', instrument: 'Drum Kit' },
  { id: 'duration', type: 'duration_range', minSeconds: 6, maxSeconds: 10 },
  { id: 'tracks', type: 'track_count', min: 2, max: 4 },
  {
    id: 'intro-density',
    type: 'section_note_density',
    startSeconds: 0,
    endSeconds: 2,
    minNotesPerSecond: 2.5,
    maxNotesPerSecond: 3,
  },
]

test('五类确定性约束全部满足时输出逐条实际值和通过原因', () => {
  const result = evaluateProject({
    project: project(),
    constraints: passingConstraints(),
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.report.passed, true)
  assert.deepEqual(result.report.failedRuleIds, [])
  assert.deepEqual(result.report.rules.map((rule) => rule.passed), [
    true,
    true,
    true,
    true,
    true,
  ])
  assert.deepEqual(result.report.rules[0]?.actual, {
    instruments: ['Felt Piano', 'Electric Bass', 'Ocean Ambience'],
    matchCount: 1,
  })
  assert.deepEqual(result.report.rules[2]?.actual, { durationSeconds: 8 })
  assert.deepEqual(result.report.rules[3]?.actual, { trackCount: 3 })
  assert.deepEqual(result.report.rules[4]?.actual, {
    startSeconds: 0,
    endSeconds: 2,
    sectionDurationSeconds: 2,
    noteCount: 5,
    notesPerSecond: 2.5,
    selectedTrackIds: ['melody', 'bass'],
    missingTrackIds: [],
  })
  assert.equal(evaluationReportSchema.safeParse(result.report).success, true)
})

test('故意违反每类约束时准确列出全部失败项', () => {
  const constraints: EvaluationConstraint[] = [
    { id: 'need-cello', type: 'required_instrument', instrument: 'Cello' },
    { id: 'no-piano', type: 'forbidden_instrument', instrument: 'felt piano' },
    { id: 'short', type: 'duration_range', maxSeconds: 4 },
    { id: 'few-tracks', type: 'track_count', max: 2 },
    {
      id: 'sparse-intro',
      type: 'section_note_density',
      startSeconds: 0,
      endSeconds: 2,
      trackIds: ['melody'],
      maxNotesPerSecond: 1,
    },
  ]

  const result = evaluateProject({ project: project(), constraints })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.report.passed, false)
  assert.deepEqual(result.report.failedRuleIds, [
    'need-cello',
    'no-piano',
    'short',
    'few-tracks',
    'sparse-intro',
  ])
  assert.deepEqual(result.report.rules.map((rule) => rule.passed), [
    false,
    false,
    false,
    false,
    false,
  ])
  assert.match(result.report.rules[0]?.reason ?? '', /缺少必需乐器“Cello”/)
  assert.match(result.report.rules[1]?.reason ?? '', /1 条使用禁用乐器/)
  assert.match(result.report.rules[2]?.reason ?? '', /8 秒，不满足至多 4 秒/)
  assert.match(result.report.rules[3]?.reason ?? '', /3 条轨道，不满足至多 2 条/)
  assert.deepEqual(result.report.rules[4]?.actual, {
    startSeconds: 0,
    endSeconds: 2,
    sectionDurationSeconds: 2,
    noteCount: 3,
    notesPerSecond: 1.5,
    selectedTrackIds: ['melody'],
    missingTrackIds: [],
  })
})

test('段落密度按左闭右开区间统计起音，并报告不存在的目标轨道', () => {
  const boundary = evaluateProject({
    project: project(),
    constraints: [{
      id: 'boundary',
      type: 'section_note_density',
      startSeconds: 1,
      endSeconds: 2,
      trackIds: ['melody'],
      minNotesPerSecond: 2,
      maxNotesPerSecond: 2,
    }],
  })
  assert.equal(boundary.ok, true)
  if (boundary.ok) {
    assert.equal(boundary.report.rules[0]?.passed, true)
    assert.equal(boundary.report.rules[0]?.actual.noteCount, 2)
  }

  const missing = evaluateProject({
    project: project(),
    constraints: [{
      id: 'missing-track',
      type: 'section_note_density',
      startSeconds: 0,
      endSeconds: 2,
      trackIds: ['ghost'],
      maxNotesPerSecond: 10,
    }],
  })
  assert.equal(missing.ok, true)
  if (missing.ok) {
    assert.equal(missing.report.passed, false)
    assert.deepEqual(missing.report.rules[0]?.actual.missingTrackIds, ['ghost'])
    assert.match(missing.report.rules[0]?.reason ?? '', /未找到轨道 ghost/)
  }
})

test('相同工程和约束得到逐字段相同报告，且不修改输入', () => {
  const candidate = project()
  const snapshot = structuredClone(candidate)
  const constraints = passingConstraints()

  const first = evaluateProject({ project: candidate, constraints })
  const second = evaluateProject({ project: candidate, constraints })

  assert.deepEqual(first, second)
  assert.deepEqual(candidate, snapshot)
})

test('缺省工程时长按 10 秒验收', () => {
  const candidate = project()
  delete (candidate as Partial<typeof candidate>).duration
  const result = evaluateProject({
    project: candidate,
    constraints: [{
      id: 'default-duration',
      type: 'duration_range',
      minSeconds: 10,
      maxSeconds: 10,
    }],
  })

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.report.passed, true)
    assert.deepEqual(result.report.rules[0]?.actual, { durationSeconds: 10 })
  }
})

test('拒绝空范围、倒序区间、重复 ID 和非法工程，而不是生成伪报告', () => {
  const cases: unknown[] = [
    [{ id: 'range', type: 'duration_range' }],
    [{ id: 'density', type: 'section_note_density', startSeconds: 2, endSeconds: 1, maxNotesPerSecond: 1 }],
    [
      { id: 'same', type: 'required_instrument', instrument: 'Piano' },
      { id: 'same', type: 'forbidden_instrument', instrument: 'Drums' },
    ],
  ]

  for (const constraints of cases) {
    const result = evaluateProject({ project: project(), constraints })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'invalid_evaluator_input')
  }

  const invalidProject = evaluateProject({
    project: { ...project(), tracks: [] },
    constraints: passingConstraints(),
  })
  assert.equal(invalidProject.ok, false)
  if (!invalidProject.ok) {
    assert.equal(invalidProject.error.code, 'invalid_evaluator_input')
    assert.equal(invalidProject.error.issues.some((issue) => issue.path[0] === 'project'), true)
  }
})
