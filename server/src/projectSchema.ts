import { z } from 'zod'

/** 前后端共享的工程结构（对应 web/src/project/model.ts）。
 *  这里只做“进得来”的校验：数值范围、字段类型、片段数组上限。
 *  归一化（补默认值、把老的 clip 升级成 clips）留给前端 normalizeProject。 */

export const noteSchema = z.object({
  id: z.string(),
  pitch: z.number().int().min(0).max(127),
  start: z.number().min(0).max(120),
  duration: z.number().positive().max(30),
  velocity: z.number().min(0).max(127),
})

/** 音频片段：source 最长 24000 字符（够放 local-sfx 的 base64 计划，又不至于让请求体失控）。 */
export const clipSchema = z.object({
  id: z.string().max(80),
  source: z.string().max(24000),
  start: z.number().min(0).max(120),
  offset: z.number().min(0).max(600),
  duration: z.number().min(.1).max(600),
  fadeIn: z.number().min(0).max(600),
  fadeOut: z.number().min(0).max(600),
  gain: z.number().min(0).max(1),
})

export const trackSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['midi', 'audio']),
  instrument: z.string(),
  color: z.string(),
  notes: z.array(noteSchema).optional(),
  /** 老的单片段字段：老工程仍然能提交上来。 */
  clip: z.string().optional(),
  clips: z.array(clipSchema).max(64).optional(),
  gain: z.number().min(0).max(1).optional(),
  pan: z.number().min(-1).max(1).optional(),
  muted: z.boolean().optional(),
  solo: z.boolean().optional(),
  start: z.number().min(0).max(120).optional(),
})

export const projectSchema = z.object({
  title: z.string(),
  tempo: z.number().min(20).max(300),
  key: z.string(),
  duration: z.number().min(1).max(120).optional(),
  masterGain: z.number().min(0).max(1).optional(),
  concept: z.object({
    word: z.string(),
    title: z.string(),
    story: z.array(z.object({ time: z.string(), title: z.string(), text: z.string(), color: z.string() })),
  }).optional(),
  tracks: z.array(trackSchema),
})
