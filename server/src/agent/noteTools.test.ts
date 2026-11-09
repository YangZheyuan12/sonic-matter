import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_NOTES_PER_TRACK, replaceTrackNotesSnapshot } from '../../../shared/project/noteMutations.ts'
import { projectSchema } from '../projectSchema.ts'
import {
  noteTools,
  replaceTrackNotesOutputSchema,
  replaceTrackNotesTool,
  validateProjectOutputSchema,
  validateProjectTool,
  type ReplaceTrackNotesOutput,
  type ValidateProjectOutput,
} from './noteTools.ts'
import { AgentToolRegistry, type AgentToolExecutionResult } from './toolRegistry.ts'

const note = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  pitch: 60,
  start: 0,
  duration: 0.5,
  velocity: 90,
  ...patch,
})

const track = (
  id: string,
  kind: 'midi' | 'audio' = 'midi',
  notes: ReturnType<typeof note>[] = [],
) => ({
  id,
  name: id,
  kind,
  instrument: kind === 'midi' ? 'Felt Piano' : 'Audio',
  color: '#7dd3fc',
  notes,
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
  duration: 4,
  tracks,
})

function registryWithNoteTools(): AgentToolRegistry {
  const registry = new AgentToolRegistry()
  registry.register(replaceTrackNotesTool)
  registry.register(validateProjectTool)
  return registry
}

function outputOf<T>(
  result: AgentToolExecutionResult,
  parse: (output: unknown) => T,
): T {
  if (!result.ok) throw new Error(`工具调用失败：${result.error.code}`)
  return parse(result.output)
}

test('replace_track_notes 原子替换 MIDI 音符并返回合法的新工程快照', async () => {
  const original = project(track('melody', 'midi', [note('old')]))
  const originalSnapshot = structuredClone(original)
  const replacement = [
    note('n1', { pitch: 64, start: 0.5, duration: 1, velocity: 100 }),
    note('n2', { pitch: 67, start: 2, duration: 0.5, velocity: 80 }),
  ]

  const output = outputOf<ReplaceTrackNotesOutput>(
    await registryWithNoteTools().execute('replace_track_notes', {
      project: original,
      trackId: 'melody',
      notes: replacement,
    }),
    (value) => replaceTrackNotesOutputSchema.parse(value),
  )

  assert.equal(output.status, 'applied')
  if (output.status === 'applied') {
    assert.equal(output.changed, true)
    assert.deepEqual(output.project.tracks[0]?.notes, replacement)
    assert.equal(projectSchema.safeParse(output.project).success, true)
  }
  assert.deepEqual(original, originalSnapshot)
})

test('replace_track_notes 对完全相同的音符返回 changed=false', async () => {
  const notes = [note('n1')]
  const original = project(track('melody', 'midi', notes))
  const output = outputOf<ReplaceTrackNotesOutput>(
    await registryWithNoteTools().execute('replace_track_notes', {
      project: original,
      trackId: 'melody',
      notes,
    }),
    (value) => replaceTrackNotesOutputSchema.parse(value),
  )

  assert.equal(output.status, 'applied')
  if (output.status === 'applied') assert.equal(output.changed, false)
})

test('replace_track_notes 拒绝不存在的轨道和错误轨道类型', async () => {
  const registry = registryWithNoteTools()
  const original = project(track('audio', 'audio'))
  const missing = outputOf<ReplaceTrackNotesOutput>(
    await registry.execute('replace_track_notes', {
      project: original,
      trackId: 'missing',
      notes: [],
    }),
    (value) => replaceTrackNotesOutputSchema.parse(value),
  )
  const wrongKind = outputOf<ReplaceTrackNotesOutput>(
    await registry.execute('replace_track_notes', {
      project: original,
      trackId: 'audio',
      notes: [note('n1')],
    }),
    (value) => replaceTrackNotesOutputSchema.parse(value),
  )

  assert.equal(missing.status, 'rejected')
  if (missing.status === 'rejected') assert.equal(missing.error.code, 'track_not_found')
  assert.equal(wrongKind.status, 'rejected')
  if (wrongKind.status === 'rejected') assert.equal(wrongKind.error.code, 'non_midi_track')
})

test('replace_track_notes 拒绝越过工程边界和重复 ID，失败时不产生部分修改', () => {
  const original = project(track('melody', 'midi', [note('old')]))
  const originalSnapshot = structuredClone(original)

  const outOfBounds = replaceTrackNotesSnapshot(original, 'melody', [
    note('valid'),
    note('late', { start: 3.8, duration: 0.5 }),
  ])
  const duplicate = replaceTrackNotesSnapshot(original, 'melody', [
    note('same'),
    note('same', { start: 1 }),
  ])

  assert.equal(outOfBounds.ok, false)
  if (!outOfBounds.ok) assert.equal(outOfBounds.error.code, 'note_out_of_project_bounds')
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'duplicate_note_id')
  assert.deepEqual(original, originalSnapshot)
})

test('replace_track_notes 在输入层拒绝恶意超长数组、NaN 和越界音高', async () => {
  const registry = registryWithNoteTools()
  const original = project(track('melody'))
  const invalidNotes = [
    Array.from({ length: MAX_NOTES_PER_TRACK + 1 }, (_, index) => note(`n${index}`)),
    [note('nan', { start: Number.NaN })],
    [note('high', { pitch: 128 })],
  ]

  for (const notes of invalidNotes) {
    const result = await registry.execute('replace_track_notes', {
      project: original,
      trackId: 'melody',
      notes,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'invalid_tool_input')
  }
})

test('validate_project 验收合法工程并统计音符', async () => {
  const candidate = project(
    track('melody', 'midi', [note('n1')]),
    track('bass', 'midi', [note('n2', { pitch: 48 })]),
  )
  const output = outputOf<ValidateProjectOutput>(
    await registryWithNoteTools().execute('validate_project', { project: candidate }),
    (value) => validateProjectOutputSchema.parse(value),
  )

  assert.equal(output.status, 'valid')
  if (output.status === 'valid') {
    assert.equal(output.noteCount, 2)
    assert.equal(projectSchema.safeParse(output.project).success, true)
  }
})

test('validate_project 报告 Schema、音频轨音符和工程边界问题', async () => {
  const registry = registryWithNoteTools()
  const structurallyInvalid = outputOf<ValidateProjectOutput>(
    await registry.execute('validate_project', {
      project: project(track('melody', 'midi', [note('bad', { velocity: Number.NaN })])),
    }),
    (value) => validateProjectOutputSchema.parse(value),
  )
  const businessInvalid = outputOf<ValidateProjectOutput>(
    await registry.execute('validate_project', {
      project: project(
        track('audio', 'audio', [note('audio-note')]),
        track('melody', 'midi', [
          note('weak', { velocity: 0 }),
          note('late', { start: 3.8, duration: 0.5 }),
        ]),
      ),
    }),
    (value) => validateProjectOutputSchema.parse(value),
  )

  assert.equal(structurallyInvalid.status, 'invalid')
  if (structurallyInvalid.status === 'invalid') {
    assert.equal(structurallyInvalid.issues[0]?.code, 'invalid_project_schema')
  }
  assert.equal(businessInvalid.status, 'invalid')
  if (businessInvalid.status === 'invalid') {
    assert.deepEqual(
      businessInvalid.issues.map((issue) => issue.code),
      ['notes_on_audio_track', 'invalid_note', 'note_out_of_project_bounds'],
    )
  }
})

test('第 7 天两个工具均符合 AgentTool 契约', () => {
  assert.equal(replaceTrackNotesTool.name, 'replace_track_notes')
  assert.equal(validateProjectTool.name, 'validate_project')
  assert.deepEqual(noteTools.map((tool) => tool.name), [
    'replace_track_notes',
    'validate_project',
  ])
})
