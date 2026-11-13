import type { Note, Project, Track } from '../project/model.ts'
import type { AgentRun } from './run.ts'

export type ChangeCount = Readonly<{ added: number; removed: number; modified: number }>

export type ProjectDiff = Readonly<{
  tracks: ChangeCount
  notes: ChangeCount
  addedTracks: readonly string[]
  removedTracks: readonly string[]
  modifiedTracks: readonly string[]
  changedProjectFields: readonly string[]
}>

export type ValidationRuleView = Readonly<{
  id: string
  passed: boolean
  reason: string
}>

export type ValidationReportView = Readonly<{
  id: string
  title: string
  passed: boolean
  rules: readonly ValidationRuleView[]
}>

const projectFieldLabels: Readonly<Record<'title' | 'tempo' | 'key' | 'duration' | 'masterGain', string>> = {
  title: '工程名称',
  tempo: '速度',
  key: '调式',
  duration: '时长',
  masterGain: '主音量',
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

const same = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

const notesOf = (track: Track): readonly Note[] => track.kind === 'midi' ? track.notes ?? [] : []

function countNotes(source: readonly Note[], candidate: readonly Note[]): ChangeCount {
  const before = new Map(source.map(note => [note.id, note]))
  const after = new Map(candidate.map(note => [note.id, note]))
  let added = 0
  let removed = 0
  let modified = 0
  for (const [id, note] of after) {
    const previous = before.get(id)
    if (previous === undefined) added += 1
    else if (!same(previous, note)) modified += 1
  }
  for (const id of before.keys()) if (!after.has(id)) removed += 1
  return { added, removed, modified }
}

/** 比较两个结构化工程快照；轨道和音符都以稳定 ID 对齐，不使用文本行号。 */
export function buildProjectDiff(source: Project, candidate: Project): ProjectDiff {
  const before = new Map(source.tracks.map(track => [track.id, track]))
  const after = new Map(candidate.tracks.map(track => [track.id, track]))
  const addedTracks: string[] = []
  const removedTracks: string[] = []
  const modifiedTracks: string[] = []
  let notes: ChangeCount = { added: 0, removed: 0, modified: 0 }
  const addNotes = (change: ChangeCount) => {
    notes = {
      added: notes.added + change.added,
      removed: notes.removed + change.removed,
      modified: notes.modified + change.modified,
    }
  }

  for (const track of candidate.tracks) {
    const previous = before.get(track.id)
    if (previous === undefined) {
      addedTracks.push(track.name)
      addNotes({ added: notesOf(track).length, removed: 0, modified: 0 })
      continue
    }
    if (!same(previous, track)) modifiedTracks.push(track.name)
    addNotes(countNotes(notesOf(previous), notesOf(track)))
  }
  for (const track of source.tracks) {
    if (after.has(track.id)) continue
    removedTracks.push(track.name)
    addNotes({ added: 0, removed: notesOf(track).length, modified: 0 })
  }

  const fields = Object.keys(projectFieldLabels) as Array<keyof typeof projectFieldLabels>
  const changedProjectFields = fields
    .filter(field => !same(source[field], candidate[field]))
    .map(field => projectFieldLabels[field])

  return {
    tracks: {
      added: addedTracks.length,
      removed: removedTracks.length,
      modified: modifiedTracks.length,
    },
    notes,
    addedTracks,
    removedTracks,
    modifiedTracks,
    changedProjectFields,
  }
}

function parsedValidationRules(value: unknown): ValidationRuleView[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (item === null || typeof item !== 'object') return []
    const rule = item as Record<string, unknown>
    if (typeof rule.id !== 'string' || typeof rule.passed !== 'boolean' || typeof rule.reason !== 'string') return []
    return [{ id: rule.id, passed: rule.passed, reason: rule.reason }]
  })
}

/** 从服务端保存的确定性验收 Trace 中提取可展示报告；损坏摘要安全降级为步骤状态。 */
export function validationReports(run: AgentRun): ValidationReportView[] {
  return run.steps.filter(step => step.kind === 'validation').map(step => {
    let passed = step.status === 'succeeded'
    let rules: ValidationRuleView[] = []
    if (step.summary) {
      try {
        const parsed = JSON.parse(step.summary) as Record<string, unknown>
        if (typeof parsed.passed === 'boolean') passed = parsed.passed
        rules = parsedValidationRules(parsed.rules)
      } catch {
        // Trace 可能因长度上限被截断；此时仍展示步骤本身的结果。
      }
    }
    return { id: step.id, title: step.title, passed, rules }
  })
}

export const revisionCount = (run: AgentRun) =>
  run.steps.filter(step => step.kind === 'revision').length
