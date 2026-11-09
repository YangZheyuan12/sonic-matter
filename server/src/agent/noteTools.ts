import { z } from 'zod'
import { noteSchema, projectSchema } from '../projectSchema.ts'
import {
  MAX_NOTES_PER_TRACK,
  replaceTrackNotesSnapshot,
  type NoteMutationResult,
} from '../../../shared/project/noteMutations.ts'
import type { AgentTool } from './toolRegistry.ts'

const replacementNoteSchema = noteSchema.extend({
  id: z.string().min(1).max(80),
  velocity: z.number().int().min(1).max(127),
}).strict()

const replaceTrackNotesInputSchema = z.object({
  project: projectSchema,
  trackId: z.string().min(1).max(80),
  notes: z.array(replacementNoteSchema).max(MAX_NOTES_PER_TRACK),
}).strict()

const noteMutationErrorSchema = z.object({
  code: z.enum([
    'track_not_found',
    'non_midi_track',
    'note_limit_reached',
    'duplicate_note_id',
    'invalid_note',
    'note_out_of_project_bounds',
  ]),
  message: z.string().min(1).max(500),
  shouldTerminate: z.boolean(),
}).strict()

export const replaceTrackNotesOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    changed: z.boolean(),
    project: projectSchema,
  }).strict(),
  z.object({
    status: z.literal('rejected'),
    error: noteMutationErrorSchema,
  }).strict(),
])

export type ReplaceTrackNotesOutput = z.infer<typeof replaceTrackNotesOutputSchema>
type ProjectSnapshot = z.infer<typeof projectSchema>

function replacementOutput(
  result: NoteMutationResult<ProjectSnapshot>,
): ReplaceTrackNotesOutput {
  if (!result.ok) return { status: 'rejected', error: result.error }
  return {
    status: 'applied',
    changed: result.changed,
    project: result.project,
  }
}

export const replaceTrackNotesTool: AgentTool<
  z.infer<typeof replaceTrackNotesInputSchema>,
  ReplaceTrackNotesOutput
> = {
  name: 'replace_track_notes',
  description:
    '原子替换指定 MIDI 轨的全部音符；校验音高、起点、时长、力度、唯一 ID、工程边界和 4096 个音符上限。',
  inputSchema: replaceTrackNotesInputSchema,
  outputSchema: replaceTrackNotesOutputSchema,
  execute: ({ project, trackId, notes }) =>
    replacementOutput(replaceTrackNotesSnapshot(project, trackId, notes)),
}

const validationPathPartSchema = z.union([z.string(), z.number().int()])
const projectValidationIssueSchema = z.object({
  code: z.enum([
    'invalid_project_schema',
    'invalid_note',
    'notes_on_audio_track',
    'duplicate_note_id',
    'note_out_of_project_bounds',
  ]),
  path: z.array(validationPathPartSchema).max(16),
  message: z.string().min(1).max(500),
}).strict()

const validateProjectInputSchema = z.object({ project: z.unknown() }).strict()

export const validateProjectOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('valid'),
    project: projectSchema,
    noteCount: z.number().int().nonnegative().max(32 * MAX_NOTES_PER_TRACK),
  }).strict(),
  z.object({
    status: z.literal('invalid'),
    issues: z.array(projectValidationIssueSchema).min(1).max(100),
  }).strict(),
])

export type ValidateProjectOutput = z.infer<typeof validateProjectOutputSchema>

function validateProject(project: unknown): ValidateProjectOutput {
  const parsed = projectSchema.safeParse(project)
  if (!parsed.success) {
    return {
      status: 'invalid',
      issues: parsed.error.issues.slice(0, 100).map((issue) => ({
        code: 'invalid_project_schema' as const,
        path: issue.path.map((part) =>
          typeof part === 'symbol' ? part.description ?? part.toString() : part,
        ).slice(0, 16),
        message: issue.message.slice(0, 500),
      })),
    }
  }

  const candidate = parsed.data
  const duration = candidate.duration ?? 10
  const issues: z.infer<typeof projectValidationIssueSchema>[] = []
  let noteCount = 0

  for (const [trackIndex, track] of candidate.tracks.entries()) {
    const notes = track.notes ?? []
    noteCount += notes.length
    if (track.kind === 'audio' && notes.length > 0) {
      issues.push({
        code: 'notes_on_audio_track',
        path: ['tracks', trackIndex, 'notes'],
        message: `音频轨“${track.id}”不能包含 MIDI 音符。`,
      })
      continue
    }

    const ids = new Set<string>()
    for (const [noteIndex, note] of notes.entries()) {
      if (!note.id || !Number.isInteger(note.velocity) || note.velocity < 1) {
        issues.push({
          code: 'invalid_note',
          path: ['tracks', trackIndex, 'notes', noteIndex],
          message: `音符 ${noteIndex + 1} 的 ID 或力度不符合业务约束。`,
        })
      }

      if (ids.has(note.id)) {
        issues.push({
          code: 'duplicate_note_id',
          path: ['tracks', trackIndex, 'notes', noteIndex, 'id'],
          message: `轨道“${track.id}”中存在重复音符 ID“${note.id}”。`,
        })
      }
      ids.add(note.id)

      if (note.start >= duration || note.start + note.duration > duration) {
        issues.push({
          code: 'note_out_of_project_bounds',
          path: ['tracks', trackIndex, 'notes', noteIndex],
          message: `音符“${note.id}”超出工程的 ${duration} 秒边界。`,
        })
      }

      if (issues.length >= 100) break
    }
    if (issues.length >= 100) break
  }

  return issues.length > 0
    ? { status: 'invalid', issues }
    : { status: 'valid', project: candidate, noteCount }
}

export const validateProjectTool: AgentTool<
  z.infer<typeof validateProjectInputSchema>,
  ValidateProjectOutput
> = {
  name: 'validate_project',
  description:
    '对候选工程执行最终验收，检查完整 Project Schema、轨道类型、重复音符 ID 和音符是否越过工程边界。',
  inputSchema: validateProjectInputSchema,
  outputSchema: validateProjectOutputSchema,
  execute: ({ project }) => validateProject(project),
}

export const noteTools = [replaceTrackNotesTool, validateProjectTool] as const
