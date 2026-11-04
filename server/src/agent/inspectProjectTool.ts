import { z } from 'zod'
import { projectSchema, trackSchema } from '../projectSchema.ts'
import type { AgentTool } from './toolRegistry.ts'

const inspectableProjectSchema = projectSchema.extend({
  tracks: z.array(trackSchema).max(32),
})

export const inspectProjectInputSchema = z
  .object({
    project: inspectableProjectSchema,
  })
  .strict()

const projectTrackSummarySchema = z
  .object({
    id: z.string().max(80),
    name: z.string().max(120),
    kind: z.enum(['midi', 'audio']),
    instrument: z.string().max(60),
    noteCount: z.number().int().nonnegative().max(4_096),
    clipCount: z.number().int().nonnegative().max(64),
    muted: z.boolean(),
    solo: z.boolean(),
  })
  .strict()

export const inspectProjectOutputSchema = z
  .object({
    title: z.string().min(1).max(120),
    durationSeconds: z.number().min(1).max(120),
    tempoBpm: z.number().min(20).max(300),
    key: z.string().max(30),
    trackCount: z.number().int().nonnegative().max(32),
    midiTrackCount: z.number().int().nonnegative().max(32),
    audioTrackCount: z.number().int().nonnegative().max(32),
    noteCount: z.number().int().nonnegative().max(32 * 4_096),
    clipCount: z.number().int().nonnegative().max(32 * 64),
    instruments: z.array(z.string().min(1).max(60)).max(32),
    tracks: z.array(projectTrackSummarySchema).max(32),
  })
  .strict()

export type InspectProjectInput = z.infer<typeof inspectProjectInputSchema>
export type InspectProjectOutput = z.infer<typeof inspectProjectOutputSchema>

/**
 * 把完整工程压缩成可供 Agent 规划的不可变摘要。
 * 只读取输入并创建新对象，不返回音符、片段或音频 source。
 */
export function inspectProject({
  project,
}: InspectProjectInput): InspectProjectOutput {
  const tracks = project.tracks.map((track) => ({
    id: track.id,
    name: track.name,
    kind: track.kind,
    instrument: track.instrument,
    noteCount: track.kind === 'midi' ? (track.notes?.length ?? 0) : 0,
    clipCount: track.clips?.length ?? (track.clip === undefined ? 0 : 1),
    muted: track.muted ?? false,
    solo: track.solo ?? false,
  }))
  const instruments = Array.from(
    new Set(
      tracks
        .map((track) => track.instrument.trim())
        .filter((instrument) => instrument.length > 0),
    ),
  )

  return {
    title: project.title,
    durationSeconds: project.duration ?? 10,
    tempoBpm: project.tempo,
    key: project.key,
    trackCount: tracks.length,
    midiTrackCount: tracks.filter((track) => track.kind === 'midi').length,
    audioTrackCount: tracks.filter((track) => track.kind === 'audio').length,
    noteCount: tracks.reduce((total, track) => total + track.noteCount, 0),
    clipCount: tracks.reduce((total, track) => total + track.clipCount, 0),
    instruments,
    tracks,
  }
}

export const inspectProjectTool: AgentTool<
  InspectProjectInput,
  InspectProjectOutput
> = {
  name: 'inspect_project',
  description:
    '读取当前音乐工程的时长、速度、调式、轨道、音符、片段和乐器摘要，不修改工程。',
  inputSchema: inspectProjectInputSchema,
  outputSchema: inspectProjectOutputSchema,
  execute: inspectProject,
}
