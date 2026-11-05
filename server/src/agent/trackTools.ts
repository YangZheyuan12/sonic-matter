import { z } from 'zod'
import { projectSchema, trackSchema } from '../projectSchema.ts'
import {
  addTrackSnapshot,
  removeTrackSnapshot,
  updateTrackSnapshot,
  type TrackMutationResult,
} from '../../../shared/project/trackMutations.ts'
import type { AgentTool } from './toolRegistry.ts'

const trackMutationErrorCodeSchema = z.enum([
  'track_id_conflict',
  'track_limit_reached',
  'track_not_found',
  'last_track_removal_forbidden',
  'invalid_track_update',
])

const trackMutationErrorSchema = z
  .object({
    code: trackMutationErrorCodeSchema,
    message: z.string().min(1).max(500),
    shouldTerminate: z.boolean(),
  })
  .strict()

export const trackToolOutputSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('applied'),
      changed: z.boolean(),
      project: projectSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal('rejected'),
      error: trackMutationErrorSchema,
    })
    .strict(),
])

export type TrackToolOutput = z.infer<typeof trackToolOutputSchema>

const addTrackInputSchema = z
  .object({
    project: projectSchema,
    track: trackSchema,
  })
  .strict()

const trackUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    instrument: z.string().trim().min(1).max(60).optional(),
    color: z.string().trim().min(1).max(32).optional(),
    gain: z.number().min(0).max(1).optional(),
    pan: z.number().min(-1).max(1).optional(),
    muted: z.boolean().optional(),
    solo: z.boolean().optional(),
    start: z.number().min(0).max(120).optional(),
  })
  .strict()
  .refine((update) => Object.keys(update).length > 0, {
    message: '至少需要提供一个轨道更新字段',
  })

const updateTrackInputSchema = z
  .object({
    project: projectSchema,
    trackId: z.string().min(1).max(80),
    update: trackUpdateSchema,
  })
  .strict()

const removeTrackInputSchema = z
  .object({
    project: projectSchema,
    trackId: z.string().min(1).max(80),
  })
  .strict()

type ProjectSnapshot = z.infer<typeof projectSchema>

function toolOutput(
  result: TrackMutationResult<ProjectSnapshot>,
): TrackToolOutput {
  if (!result.ok) {
    return {
      status: 'rejected',
      error: result.error,
    }
  }

  return {
    status: 'applied',
    changed: result.changed,
    project: result.project,
  }
}

export const addTrackTool: AgentTool<
  z.infer<typeof addTrackInputSchema>,
  TrackToolOutput
> = {
  name: 'add_track',
  description:
    '向候选工程添加一条轨道；轨道 ID 不能与现有轨道冲突，且工程最多包含 32 条轨道。',
  inputSchema: addTrackInputSchema,
  outputSchema: trackToolOutputSchema,
  execute: ({ project, track }) => toolOutput(addTrackSnapshot(project, track)),
}

export const updateTrackTool: AgentTool<
  z.infer<typeof updateTrackInputSchema>,
  TrackToolOutput
> = {
  name: 'update_track',
  description:
    '更新候选工程中一条已有轨道的名称、乐器、颜色、音量、声像、静音、独奏或起点；不能修改 ID、类型、音符和片段。',
  inputSchema: updateTrackInputSchema,
  outputSchema: trackToolOutputSchema,
  execute: ({ project, trackId, update }) =>
    toolOutput(updateTrackSnapshot(project, trackId, update)),
}

export const removeTrackTool: AgentTool<
  z.infer<typeof removeTrackInputSchema>,
  TrackToolOutput
> = {
  name: 'remove_track',
  description:
    '从候选工程删除指定轨道；工程必须至少保留一条轨道。',
  inputSchema: removeTrackInputSchema,
  outputSchema: trackToolOutputSchema,
  execute: ({ project, trackId }) =>
    toolOutput(removeTrackSnapshot(project, trackId)),
}

export const trackTools = [
  addTrackTool,
  updateTrackTool,
  removeTrackTool,
] as const
