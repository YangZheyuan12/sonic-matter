import { z } from 'zod'

/** 前后端共享的工程结构（对应 web/src/project/model.ts）。
 *  这里只做“进得来”的校验：数值范围、字段类型、字符串与数组上限。
 *  上限不是业务规则，只是防止一个请求把内存和服务打满；具体数值都留了很大余量。
 *  归一化（补默认值、把老的 clip 升级成 clips）留给前端 normalizeProject。 */

export const noteSchema = z.object({
  id: z.string().max(80),
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
  id: z.string().min(1).max(80),
  name: z.string().max(120),
  kind: z.enum(['midi', 'audio']),
  instrument: z.string().max(60),
  color: z.string().max(32),
  notes: z.array(noteSchema).max(4096).optional(),
  /** 老的单片段字段：老工程仍然能提交上来（也可能是 base64 的本地音效计划，所以上限和 source 一致）。 */
  clip: z.string().max(24000).optional(),
  clips: z.array(clipSchema).max(64).optional(),
  gain: z.number().min(0).max(1).optional(),
  pan: z.number().min(-1).max(1).optional(),
  muted: z.boolean().optional(),
  solo: z.boolean().optional(),
  start: z.number().min(0).max(120).optional(),
})

const sceneBriefSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().max(120),
  description: z.string().max(800),
  moods: z.array(z.string().max(60)).max(12).optional(),
})

const eventBriefSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().max(120),
  description: z.string().max(800),
  category: z.string().max(80).optional(),
})

export const gameBriefSchema = z.object({
  title: z.string().max(120),
  genre: z.string().max(120),
  gameplay: z.string().max(2000),
  world: z.string().max(2000),
  references: z.array(z.string().max(160)).max(12),
  scenes: z.array(sceneBriefSchema).max(32),
  events: z.array(eventBriefSchema).max(64),
})

const musicDirectionSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().max(120),
  summary: z.string().max(800),
  moods: z.array(z.string().max(60)).max(12),
  suitableScenes: z.array(z.string().max(120)).max(16),
  recommendedInstruments: z.array(z.string().max(80)).max(24),
  demoIds: z.array(z.string().max(120)).max(24).optional(),
})

const sfxDirectionSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().max(120),
  summary: z.string().max(800),
  tags: z.array(z.string().max(60)).max(12),
  demoIds: z.array(z.string().max(120)).max(24).optional(),
})

export const gameAnalysisSchema = z.object({
  summary: z.string().max(2000),
  moods: z.array(z.string().max(60)).max(16),
  musicDirections: z.array(musicDirectionSchema).max(8),
  sfxDirections: z.array(sfxDirectionSchema).max(8),
  recommendedInstruments: z.array(z.string().max(80)).max(32),
  recommendedMaterials: z.array(z.string().max(80)).max(32),
  avoidDirections: z.array(z.string().max(160)).max(24),
})

export const soundDirectionSchema = z.object({
  musicStyle: z.array(z.string().max(80)).max(12),
  musicMood: z.array(z.string().max(80)).max(12),
  primaryInstruments: z.array(z.string().max(80)).max(16),
  secondaryInstruments: z.array(z.string().max(80)).max(24),
  rhythmIntensity: z.number().min(0).max(100),
  melodicDensity: z.number().min(0).max(100),
  ambienceLevel: z.number().min(0).max(100),
  sfxStyle: z.array(z.string().max(80)).max(12),
  selectedDemos: z.array(z.string().max(120)).max(32),
})

export const projectAssetSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().max(160),
  kind: z.enum(['music', 'sfx', 'ambience', 'voice']),
  origin: z.enum(['generated', 'uploaded', 'recorded']),
  status: z.enum(['draft', 'confirmed', 'archived']),
  source: z.string().max(24000),
  createdAt: z.number().min(0),
  sceneId: z.string().max(80).optional(),
  eventId: z.string().max(80).optional(),
})

export const projectSchema = z.object({
  title: z.string().min(1).max(120),
  tempo: z.number().min(20).max(300),
  key: z.string().max(30),
  duration: z.number().min(1).max(120).optional(),
  masterGain: z.number().min(0).max(1).optional(),
  concept: z.object({
    word: z.string().max(80),
    title: z.string().max(120),
    story: z.array(z.object({
      time: z.string().max(30),
      title: z.string().max(120),
      text: z.string().max(800),
      color: z.string().max(32),
    })).max(24),
  }).optional(),
  gameBrief: gameBriefSchema.optional(),
  gameAnalysis: gameAnalysisSchema.optional(),
  soundDirection: soundDirectionSchema.optional(),
  assets: z.array(projectAssetSchema).max(128).optional(),
  currentSceneId: z.string().max(80).optional(),
  tracks: z.array(trackSchema).min(1).max(32),
})
