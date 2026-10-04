import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import OpenAI from 'openai'
import { z } from 'zod'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildMidiFile, MidiExportError } from './midi.ts'
import { badRequest, isAbortError, isClientGone, providerNotConfigured, toAppError, zodDetail } from './errors.ts'
import { logger } from './logger.ts'
import { noteSchema, projectSchema, trackSchema } from './projectSchema.ts'
import {
  agentTimeoutMs,
  asyncHandler,
  errorHandler,
  fetchWithRetry,
  notFoundHandler,
  requestContext,
} from './http.ts'

const app = express()
const port = Number(process.env.PORT ?? 8787)
const envModel = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'
const envBaseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
const envProtocol = process.env.OPENAI_PROTOCOL === 'chat-completions' ? 'chat-completions' : 'responses'
const generatedDir = path.resolve(process.cwd(), 'generated')
const replicateModel = process.env.MUSIC_REPLICATE_MODEL ?? 'meta/musicgen'

app.use(requestContext())
app.use(cors())
app.use(express.json({ limit: '2mb' }))
app.use('/generated', express.static(generatedDir))
const agentConfigSchema = z.object({
  baseUrl: z.string().trim().url().optional(),
  apiKey: z.string().trim().max(500).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  protocol: z.enum(['responses', 'chat-completions']).optional(),
})
const requestWithAgentSchema = z.object({ agent: agentConfigSchema.optional() })
type AgentConfig = z.infer<typeof agentConfigSchema>

const storyArcSchema = z.object({ start: z.number().min(0).max(10), end: z.number().min(0).max(10), title: z.string().min(1).max(40), meaning: z.string().min(1).max(180), musical_role: z.string().min(1).max(180) })
const interpretationSchema = z.object({
  id: z.enum(['physical', 'psychological', 'climate']), title: z.string().min(1).max(40), summary: z.string().min(1).max(180), thesis: z.string().min(1).max(240), story_arc: z.array(storyArcSchema).length(3),
  music_mapping: z.object({ tempo: z.number().int().min(40).max(180), key: z.string().min(1).max(30), density: z.number().min(0).max(1), brightness: z.number().min(0).max(1), tension: z.number().min(0).max(1), instruments: z.array(z.string().min(1).max(40)).min(1).max(5) }),
})
const conceptResponseSchema = z.object({ concept: z.string().min(1).max(80), interpretations: z.array(interpretationSchema).length(3) })
const conceptInputSchema = z.object({ concept: z.string().trim().min(1).max(80) }).merge(requestWithAgentSchema)

// 工程结构（notes / clips / tracks）统一放在 projectSchema.ts，方便单测。
const projectEditSchema = z.object({ project: projectSchema, instruction: z.string().trim().min(1).max(500) }).merge(requestWithAgentSchema)
const editOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_track'), track: trackSchema }),
  z.object({ op: z.literal('update_project'), path: z.enum(['title', 'tempo', 'key']), value: z.union([z.string(), z.number()]) }),
  z.object({ op: z.literal('update_track'), track_id: z.string(), path: z.enum(['name', 'instrument', 'color']), value: z.string() }),
])
const editResponseSchema = z.object({ assistant_message: z.string().min(1).max(240), operations: z.array(editOperationSchema).max(8) })

const soundMixerSchema = z.object({ length: z.number().min(.1).max(30), density: z.number().min(0).max(100), brightness: z.number().min(0).max(100), space: z.number().min(0).max(100), compact: z.number().min(0).max(100) })
const soundPlanSchema = z.object({ title: z.string().min(1).max(80), prompt: z.string().min(1).max(300), duration_seconds: z.number().min(.1).max(30), texture: z.string().min(1).max(80), envelope: z.string().min(1).max(80), space: z.string().min(1).max(80), events: z.array(z.object({ time: z.number().min(0).max(30), event: z.string().min(1).max(120) })).min(1).max(8) })
const soundPlanInputSchema = z.object({ description: z.string().trim().min(1).max(500), mixer: soundMixerSchema }).merge(requestWithAgentSchema)
const musicProviderSchema = z.object({ baseUrl: z.string().trim().url().optional(), apiKey: z.string().trim().max(500).optional(), model: z.string().trim().min(1).max(160).optional() }).optional()
const sfxProviderSchema = z.object({ baseUrl: z.string().trim().url().optional(), apiKey: z.string().trim().max(500).optional(), model: z.string().trim().min(1).max(160).optional() }).optional()
const musicGenerateInputSchema = z.object({ prompt: z.string().trim().min(1).max(1000), duration_seconds: z.number().min(1).max(30).default(10), music: musicProviderSchema })
const soundGenerateInputSchema = z.object({ description: z.string().trim().min(1).max(500), mixer: soundMixerSchema, sfx: sfxProviderSchema })
const musicPlanTrackSchema = z.object({
  id: z.string().min(1).max(40), name: z.string().min(1).max(60), instrument: z.string().min(1).max(40), color: z.string().min(1).max(20),
  notes: z.array(noteSchema).min(1).max(128),
})
const musicPlanSchema = z.object({ title: z.string().min(1).max(120), tempo: z.number().int().min(40).max(180), key: z.string().min(1).max(30), duration: z.number().min(1).max(30), tracks: z.array(musicPlanTrackSchema).min(1).max(4) })
const musicPlanInputSchema = z.object({ project: projectSchema, prompt: z.string().trim().min(1).max(1200) }).merge(requestWithAgentSchema)

const conceptJsonSchema = { type: 'object', additionalProperties: false, properties: {
  concept: { type: 'string' }, interpretations: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', enum: ['physical', 'psychological', 'climate'] }, title: { type: 'string' }, summary: { type: 'string' }, thesis: { type: 'string' },
    story_arc: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { start: { type: 'number' }, end: { type: 'number' }, title: { type: 'string' }, meaning: { type: 'string' }, musical_role: { type: 'string' } }, required: ['start', 'end', 'title', 'meaning', 'musical_role'] } },
    music_mapping: { type: 'object', additionalProperties: false, properties: { tempo: { type: 'integer' }, key: { type: 'string' }, density: { type: 'number' }, brightness: { type: 'number' }, tension: { type: 'number' }, instruments: { type: 'array', items: { type: 'string' } } }, required: ['tempo', 'key', 'density', 'brightness', 'tension', 'instruments'] },
  }, required: ['id', 'title', 'summary', 'thesis', 'story_arc', 'music_mapping'] } },
}, required: ['concept', 'interpretations'] } as const
const editJsonSchema = { type: 'object', additionalProperties: false, properties: {
  assistant_message: { type: 'string' }, operations: { type: 'array', items: { anyOf: [
    { type: 'object', additionalProperties: false, properties: { op: { type: 'string', enum: ['add_track'] }, track: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['midi', 'audio'] }, instrument: { type: 'string' }, color: { type: 'string' }, notes: { type: 'array', items: { type: 'object' } }, clip: { type: 'string' } }, required: ['id', 'name', 'kind', 'instrument', 'color', 'notes', 'clip'] } }, required: ['op', 'track'] },
    { type: 'object', additionalProperties: false, properties: { op: { type: 'string', enum: ['update_project'] }, path: { type: 'string', enum: ['title', 'tempo', 'key'] }, value: { anyOf: [{ type: 'string' }, { type: 'number' }] } }, required: ['op', 'path', 'value'] },
    { type: 'object', additionalProperties: false, properties: { op: { type: 'string', enum: ['update_track'] }, track_id: { type: 'string' }, path: { type: 'string', enum: ['name', 'instrument', 'color'] }, value: { type: 'string' } }, required: ['op', 'track_id', 'path', 'value'] },
  ] } },
}, required: ['assistant_message', 'operations'] } as const
const soundJsonSchema = { type: 'object', additionalProperties: false, properties: {
  title: { type: 'string' }, prompt: { type: 'string' }, duration_seconds: { type: 'number' }, texture: { type: 'string' }, envelope: { type: 'string' }, space: { type: 'string' }, events: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { time: { type: 'number' }, event: { type: 'string' } }, required: ['time', 'event'] } },
}, required: ['title', 'prompt', 'duration_seconds', 'texture', 'envelope', 'space', 'events'] } as const
const pingJsonSchema = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'] } as const
const musicPlanJsonSchema = { type: 'object', additionalProperties: false, properties: {
  title: { type: 'string' }, tempo: { type: 'integer' }, key: { type: 'string' }, duration: { type: 'number' },
  tracks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string' }, name: { type: 'string' }, instrument: { type: 'string' }, color: { type: 'string' },
    notes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, pitch: { type: 'integer' }, start: { type: 'number' }, duration: { type: 'number' }, velocity: { type: 'number' } }, required: ['id', 'pitch', 'start', 'duration', 'velocity'] } },
  }, required: ['id', 'name', 'instrument', 'color', 'notes'] } },
}, required: ['title', 'tempo', 'key', 'duration', 'tracks'] } as const
function resolveAgentConfig(input?: AgentConfig): AgentConfig {
  return { baseUrl: input?.baseUrl || envBaseUrl, apiKey: input?.apiKey || process.env.OPENAI_API_KEY || '', model: input?.model || envModel, protocol: input?.protocol || envProtocol }
}

function createClient(config: AgentConfig) {
  if (!config.apiKey) throw providerNotConfigured('未配置 Agent API Key，无法执行真实 Agent 请求。')
  // maxRetries：只让 SDK 处理瞬时网络抖动；timeout：别让前端无限等下去。
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, timeout: agentTimeoutMs, maxRetries: 2 })
}

/** SDK 的超时/中止错误统一成 PROVIDER_TIMEOUT 哨兵，由 errors.ts 翻成 504。 */
function rethrowAgentError(error: unknown): never {
  if (isAbortError(error)) throw new Error('PROVIDER_TIMEOUT')
  if (error instanceof Error && /timeout|timed out|aborted/i.test(`${error.name} ${error.message}`)) {
    throw new Error('PROVIDER_TIMEOUT')
  }
  throw error
}

async function structuredResponse<T>(input: string, name: string, schema: Record<string, unknown>, parser: z.ZodType<T>, config: AgentConfig, signal?: AbortSignal): Promise<T> {
  const client = createClient(config)
  const requestOptions = { signal, timeout: agentTimeoutMs }
  try {
    if (config.protocol === 'chat-completions') {
      const completion = await client.chat.completions.create({ model: config.model!, messages: [{ role: 'system', content: '你是一个结构化输出 Agent。只输出符合 JSON Schema 的 JSON，不要 Markdown。' }, { role: 'user', content: input }], response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } } }, requestOptions)
      const text = completion.choices[0]?.message?.content
      if (!text) throw new Error('OPENAI_EMPTY_OUTPUT')
      return parser.parse(JSON.parse(text))
    }
    const response = await client.responses.create({ model: config.model!, input, text: { format: { type: 'json_schema', name, strict: true, schema } } }, requestOptions)
    if (response.status === 'incomplete') throw new Error(`OPENAI_INCOMPLETE_${response.incomplete_details?.reason ?? 'unknown'}`)
    if (!response.output_text) throw new Error('OPENAI_EMPTY_OUTPUT')
    return parser.parse(JSON.parse(response.output_text))
  } catch (error) {
    return rethrowAgentError(error)
  }
}
function fallbackConcept(concept: string): z.infer<typeof conceptResponseSchema> {
  return { concept, interpretations: [
    { id: 'physical', title: `物理${concept}`, summary: `从可观察的形态、材质和运动理解${concept}。`, thesis: `${concept}的重量与尺度可以被听见。`, story_arc: [{ start: 0, end: 3, title: '表面', meaning: '先听见它最直观的轮廓。', musical_role: '稀疏高频、开放音程' }, { start: 3, end: 7, title: '内部', meaning: '进入材质内部，感受隐藏的重量。', musical_role: '低频长音、缓慢叠层' }, { start: 7, end: 10, title: '变化', meaning: '让形态在最后一刻发生变化。', musical_role: '颗粒化碎片、宽阔尾响' }], music_mapping: { tempo: 58, key: 'D minor', density: .28, brightness: .68, tension: .5, instruments: ['glass_bell', 'cello', 'sub_bass'] } },
    { id: 'psychological', title: `心理${concept}`, summary: `从记忆、情绪和未被说出的部分理解${concept}。`, thesis: `${concept}既是对象，也是人心里的一块回声。`, story_arc: [{ start: 0, end: 3, title: '可见表面', meaning: '保持克制，只留下一个清晰动机。', musical_role: '单音旋律、留白' }, { start: 3, end: 7, title: '水下意识', meaning: '隐藏的情绪逐渐浮上来。', musical_role: '大提琴持续音、低频脉冲' }, { start: 7, end: 10, title: '裂缝出现', meaning: '真正的情绪穿透表面。', musical_role: '和声短暂失衡、明亮噪点' }], music_mapping: { tempo: 72, key: 'C minor', density: .44, brightness: .42, tension: .72, instruments: ['felt_piano', 'cello', 'granular_pad'] } },
    { id: 'climate', title: `生态${concept}`, summary: `从时间、环境和人与世界的关系理解${concept}。`, thesis: `${concept}也记录着一个系统正在如何变化。`, story_arc: [{ start: 0, end: 3, title: '古老平衡', meaning: '系统维持着缓慢而稳定的呼吸。', musical_role: '规整脉冲、自然泛音' }, { start: 3, end: 7, title: '扰动进入', meaning: '外部压力让节奏变得拥挤。', musical_role: '机械脉冲、密度上升' }, { start: 7, end: 10, title: '留下回声', meaning: '主题淡出，但提醒仍然存在。', musical_role: '稀释旋律、开放尾声' }], music_mapping: { tempo: 84, key: 'A minor', density: .62, brightness: .55, tension: .66, instruments: ['prepared_piano', 'field_texture', 'soft_synth'] } },
  ] }
}
function fallbackMusicPlan(project: z.infer<typeof projectSchema>): z.infer<typeof musicPlanSchema> {
  const source = project.tracks.filter(track => track.kind === 'midi' && track.notes?.length).slice(0, 2)
  const tracks = source.length ? source.map((track, index) => ({ id: `ai-structure-${index + 1}`, name: `${track.name} · 结构化`, instrument: track.instrument, color: track.color, notes: (track.notes ?? []).slice(0, 128) })) : [{ id: 'ai-structure-1', name: '结构化旋律', instrument: 'Synth', color: '#7dd3fc', notes: [{ id: 'generated-1', pitch: 60, start: 0, duration: 0.5, velocity: 90 }, { id: 'generated-2', pitch: 64, start: 0.75, duration: 0.5, velocity: 82 }, { id: 'generated-3', pitch: 67, start: 1.5, duration: 0.75, velocity: 88 }] }]
  return { title: `${project.title} · 结构化草案`, tempo: project.tempo, key: project.key, duration: Math.min(30, project.duration ?? 10), tracks }
}
function fallbackSound(description: string, mixer: z.infer<typeof soundMixerSchema>): z.infer<typeof soundPlanSchema> { return { title: 'Semantic Sound Sketch', prompt: `${description}; density ${mixer.density}%; brightness ${mixer.brightness}%; spaciousness ${mixer.space}%; compactness ${mixer.compact}%`, duration_seconds: mixer.length, texture: mixer.brightness > 60 ? 'bright granular transient' : 'dark granular transient', envelope: mixer.compact > 60 ? 'tight attack, short decay' : 'soft attack, long tail', space: mixer.space > 60 ? 'wide underwater reverb' : 'near-field dry room', events: [{ time: 0, event: 'distant onset' }, { time: Math.max(.1, mixer.length * .42), event: 'textural rupture' }, { time: Math.max(.2, mixer.length * .78), event: 'resonant tail' }] } }
function requiredSecret(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name}_MISSING`)
  return value
}

/** 取音频二进制。上游可能返回 5xx，交给 fetchWithRetry 重试。 */
async function downloadGeneratedAudio(url: string, extension: string, signal?: AbortSignal) {
  const response = await fetchWithRetry(url, {}, { label: '音频下载', signal })
  if (!response.ok) throw new Error(`AUDIO_DOWNLOAD_${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await mkdir(generatedDir, { recursive: true })
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${extension}`
  await writeFile(path.join(generatedDir, filename), buffer)
  return { filename, url: `/generated/${filename}` }
}

async function generateWithReplicate(prompt: string, durationSeconds: number, config?: { baseUrl?: string; apiKey?: string; model?: string }, signal?: AbortSignal) {
  const token = config?.apiKey || requiredSecret('REPLICATE_API_TOKEN')
  const model = config?.model || replicateModel
  const modelPath = model.includes('/') ? `/models/${model}/predictions` : '/predictions'
  const baseUrl = (config?.baseUrl || 'https://api.replicate.com/v1').replace(/\/$/, '')
  const response = await fetchWithRetry(`${baseUrl}${modelPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(model.includes('/') ? {} : { version: model }), input: { prompt, duration: durationSeconds } }),
  }, { label: '音乐生成任务创建', signal })
  if (!response.ok) throw new Error(`REPLICATE_CREATE_${response.status}`)
  let prediction = await response.json() as { id: string; status: string; output?: string | string[]; error?: string }
  const deadline = Date.now() + 180_000
  while (['starting', 'processing'].includes(prediction.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2500))
    const poll = await fetchWithRetry(`${baseUrl}/predictions/${prediction.id}`, { headers: { Authorization: `Bearer ${token}` } }, { label: '音乐生成任务轮询', signal })
    if (!poll.ok) throw new Error(`REPLICATE_POLL_${poll.status}`)
    prediction = await poll.json() as typeof prediction
  }
  if (prediction.status !== 'succeeded') throw new Error(prediction.error ?? `REPLICATE_${prediction.status}`)
  const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output
  if (!output) throw new Error('REPLICATE_EMPTY_OUTPUT')
  return downloadGeneratedAudio(output, 'wav', signal)
}

async function generateWithElevenLabs(description: string, mixer: z.infer<typeof soundMixerSchema>, config?: { baseUrl?: string; apiKey?: string; model?: string }, signal?: AbortSignal) {
  const apiKey = config?.apiKey || requiredSecret('ELEVENLABS_API_KEY')
  const baseUrl = (config?.baseUrl || 'https://api.elevenlabs.io/v1').replace(/\/$/, '')
  const response = await fetchWithRetry(`${baseUrl}/sound-generation`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `${description}. Duration ${mixer.length} seconds. Density ${mixer.density} percent. Brightness ${mixer.brightness} percent. Spaciousness ${mixer.space} percent. Compactness ${mixer.compact} percent.` }),
  }, { label: '音效生成', signal })
  if (!response.ok) throw new Error(`ELEVENLABS_GENERATE_${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await mkdir(generatedDir, { recursive: true })
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`
  await writeFile(path.join(generatedDir, filename), buffer)
  return { filename, url: `/generated/${filename}` }
}
app.get('/api/health', (_req, res) => { const config = resolveAgentConfig(); res.json({ ok: true, agent: Boolean(config.apiKey), model: config.model, baseUrl: config.baseUrl, protocol: config.protocol }) })

app.post('/api/agent/test', asyncHandler(async (req, res) => {
  const parsed = requestWithAgentSchema.safeParse(req.body)
  if (!parsed.success) throw badRequest('Agent 配置格式不正确。', zodDetail(parsed.error))
  const config = resolveAgentConfig(parsed.data.agent)
  const result = await structuredResponse('请回复 ok，并说明连接成功。', 'agent_connection_test', pingJsonSchema, z.object({ ok: z.boolean(), message: z.string() }), config, req.abortSignal)
  return res.json({ ...result, model: config.model, baseUrl: config.baseUrl, protocol: config.protocol })
}))

/** 没配 Key 时用本地 fallback 顶上，其它错误照常抛出。 */
const isNotConfigured = (error: unknown) => toAppError(error).code === 'provider_not_configured'

app.post('/api/concept/interpret', asyncHandler(async (req, res) => {
  const parsed = conceptInputSchema.safeParse(req.body)
  if (!parsed.success) throw badRequest('concept 必须是 1-80 个字符。', zodDetail(parsed.error))
  const { concept, agent } = parsed.data
  const config = resolveAgentConfig(agent)
  try {
    const result = await structuredResponse(['你是“万物声谱”的概念作曲 Agent。', '请把用户输入的抽象或具象词语，分别从物理、心理、生态/社会三个视角解释，并为每个视角设计一个 10 秒的音乐叙事。', '输出必须严格符合 JSON Schema；不要输出 Markdown。', `用户词语：${concept}`].join('\n'), 'concept_interpretation', conceptJsonSchema, conceptResponseSchema, config, req.abortSignal)
    return res.json({ ...result, source: 'agent' })
  } catch (error) {
    if (isNotConfigured(error)) return res.json({ ...fallbackConcept(concept), source: 'fallback', warning: '未配置 API Key，当前使用本地 fallback。' })
    throw error
  }
}))

app.post('/api/project/edit', asyncHandler(async (req, res) => {
  const parsed = projectEditSchema.safeParse(req.body)
  if (!parsed.success) throw badRequest('工程或 Agent 指令格式不正确。', zodDetail(parsed.error))
  const { project, instruction, agent } = parsed.data
  const result = await structuredResponse(['你是音乐工程编辑 Agent。只根据用户指令提出安全、可执行的工程操作。', '优先返回 update_project、update_track 或 add_track；不要删除轨道，不要生成不可编辑的二进制音频。', `当前工程 JSON：${JSON.stringify(project)}`, `用户指令：${instruction}`].join('\n'), 'project_edit_operations', editJsonSchema, editResponseSchema, resolveAgentConfig(agent), req.abortSignal)
  return res.json({ ...result, source: 'agent' })
}))

app.post('/api/sfx/plan', asyncHandler(async (req, res) => {
  const parsed = soundPlanInputSchema.safeParse(req.body)
  if (!parsed.success) throw badRequest('音效描述或调音台参数不正确。', zodDetail(parsed.error))
  const { description, mixer, agent } = parsed.data
  try {
    const result = await structuredResponse(['你是音效设计 Agent。请把声音描述和调音台参数转换为一个可交给音效生成模型的结构化声音计划。', '不要返回音频二进制，只返回 JSON。', `描述：${description}`, `调音台：${JSON.stringify(mixer)}`].join('\n'), 'sound_design_plan', soundJsonSchema, soundPlanSchema, resolveAgentConfig(agent), req.abortSignal)
    return res.json({ ...result, source: 'agent' })
  } catch (error) {
    if (isNotConfigured(error)) return res.json({ ...fallbackSound(description, mixer), source: 'fallback', warning: '未配置 API Key，当前使用本地声音计划。' })
    throw error
  }
}))

app.post('/api/music/plan', asyncHandler(async (req, res) => {
  const parsed = musicPlanInputSchema.safeParse(req.body)
  if (!parsed.success) throw badRequest('音乐工程描述或当前 Project 数据不正确。', zodDetail(parsed.error))
  const { project, prompt, agent } = parsed.data
  try {
    const result = await structuredResponse([
      '你是可编辑音乐工程 Agent。请把用户的音乐意图转换为一个 10 秒左右、可编辑的 MIDI/和弦 Project JSON。',
      '只输出结构化 JSON，不要 Markdown，不要音频 URL，不要二进制音频。',
      '至少生成一条 MIDI 轨道；可以生成旋律、和弦、低音或打击乐轨道。每个音符都必须包含 pitch、start、duration、velocity。',
      '请保持音高在 MIDI 0-127，时间不超过 duration，避免不必要的密集重叠。和弦请用同一时间起始的多个音符表达。',
      `当前工程：${JSON.stringify(project)}`,
      `用户意图：${prompt}`,
    ].join('\n'), 'music_project_plan', musicPlanJsonSchema, musicPlanSchema, resolveAgentConfig(agent), req.abortSignal)
    return res.json({ ...result, source: 'agent' })
  } catch (error) {
    if (isNotConfigured(error)) return res.json({ ...fallbackMusicPlan(project), source: 'fallback', warning: '未配置 Agent API Key，当前沿用现有 MIDI 结构作为可编辑草案。' })
    throw error
  }
}))

app.post('/api/music/generate', asyncHandler(async (req, res) => {
  const parsed = musicGenerateInputSchema.safeParse(req.body)
  if (!parsed.success) throw badRequest('音乐描述或时长不正确。', zodDetail(parsed.error))
  const generated = await generateWithReplicate(parsed.data.prompt, parsed.data.duration_seconds, parsed.data.music, req.abortSignal)
  return res.json({ ...generated, provider: 'replicate', model: parsed.data.music?.model || replicateModel, source: 'audio-model' })
}))

app.post('/api/sfx/generate', asyncHandler(async (req, res) => {
  const parsed = soundGenerateInputSchema.safeParse(req.body)
  if (!parsed.success) throw badRequest('音效描述或调音台参数不正确。', zodDetail(parsed.error))
  const generated = await generateWithElevenLabs(parsed.data.description, parsed.data.mixer, parsed.data.sfx, req.abortSignal)
  return res.json({ ...generated, provider: 'elevenlabs', source: 'audio-model' })
}))

app.post('/api/export/midi', asyncHandler(async (req, res) => {
  const parsed = projectSchema.safeParse(req.body?.project)
  if (!parsed.success) throw badRequest('Project 数据不正确。', zodDetail(parsed.error))
  const project = parsed.data
  const midiTracks = project.tracks.filter(track => track.kind === 'midi').map(track => ({ name: track.name, notes: track.notes ?? [], drum: /drum|perc|鼓|打击/i.test(track.instrument) }))
  if (!midiTracks.length) throw badRequest('当前工程没有 MIDI 轨道。')
  try {
    const data = buildMidiFile(project.tempo, midiTracks)
    res.setHeader('Content-Type', 'audio/midi')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(project.title)}.mid"`)
    return res.send(data)
  } catch (error) {
    if (error instanceof MidiExportError) throw badRequest(error.message)
    throw error
  }
}))

app.use(notFoundHandler)
app.use(errorHandler)

const server = app.listen(port, () => {
  const config = resolveAgentConfig()
  logger.info('Agent server 已启动', {
    url: `http://localhost:${port}`,
    agent: Boolean(config.apiKey),
    model: config.model,
    protocol: config.protocol,
  })
})

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${port} 已被占用：可能是上一次的服务没有退出。可以设置 PORT 换一个端口，或先结束占用进程。`, { code: error.code })
  } else {
    logger.error('服务器启动失败', { code: error.code, error: error.message })
  }
  process.exit(1)
})

function shutdown(signal: string) {
  logger.info('收到退出信号，正在关闭服务', { signal })
  const force = setTimeout(() => process.exit(0), 5_000)
  force.unref?.()
  server.close(() => {
    logger.info('服务已关闭')
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (reason: unknown) => {
  const error = toAppError(reason)
  if (isClientGone(error)) return
  logger.error('未处理的 Promise 拒绝', { code: error.code, detail: error.detail })
})
