import { apiJson, type ApiOptions } from '../api/client.ts'
import type { Project } from '../project/model.ts'

export type AgentRunStatus =
  | 'planning'
  | 'executing'
  | 'validating'
  | 'revising'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'canceled'

export type AgentExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled'

export type AgentToolCall = {
  id: string
  toolName: string
  status: AgentExecutionStatus
  inputSummary: string
  outputSummary?: string
  errorCode?: string
  errorMessage?: string
  startedAt?: number
  finishedAt?: number
}

export type AgentStep = {
  id: string
  kind: 'planning' | 'tool' | 'validation' | 'revision'
  status: AgentExecutionStatus
  title: string
  summary?: string
  toolCalls: AgentToolCall[]
  startedAt?: number
  finishedAt?: number
  errorCode?: string
  errorMessage?: string
}

export type AgentRun = {
  id: string
  status: AgentRunStatus
  instruction: string
  createdAt: number
  updatedAt: number
  steps: AgentStep[]
  summary?: string
  errorCode?: string
  errorMessage?: string
}

export type EvaluationConstraint =
  | { id: string; type: 'required_instrument'; instrument: string }
  | { id: string; type: 'forbidden_instrument'; instrument: string }
  | { id: string; type: 'duration_range'; minSeconds?: number; maxSeconds?: number }
  | { id: string; type: 'track_count'; min?: number; max?: number }
  | {
      id: string
      type: 'section_note_density'
      startSeconds: number
      endSeconds: number
      minNotesPerSecond?: number
      maxNotesPerSecond?: number
      trackIds?: string[]
    }

export type AgentRunResource = {
  run: AgentRun
  constraints: EvaluationConstraint[]
  candidateProject?: Project
  approvedProject?: Project
  decision?: 'approved' | 'rejected'
  decidedAt?: number
  action?: string
  idempotent?: boolean
}

export type AgentConnection = {
  baseUrl?: string
  apiKey?: string
  model?: string
  protocol?: 'responses' | 'chat-completions'
}

export type CreateAgentRunInput = {
  instruction: string
  project: Project
  constraints: EvaluationConstraint[]
  agent?: AgentConnection
}

const protection = { 'X-Sonic-Auth': '1' }
const RUN_TIMEOUT_MS = 30_000

export const createAgentRun = (input: CreateAgentRunInput, options: ApiOptions = {}) =>
  apiJson<AgentRunResource>('/api/agent/runs', {
    ...options,
    method: 'POST',
    headers: protection,
    body: input,
    timeoutMs: options.timeoutMs ?? RUN_TIMEOUT_MS,
  })

export const getAgentRun = (id: string, options: ApiOptions = {}) =>
  apiJson<AgentRunResource>(`/api/agent/runs/${encodeURIComponent(id)}`, {
    ...options,
    method: 'GET',
    timeoutMs: options.timeoutMs ?? RUN_TIMEOUT_MS,
  })

export const cancelAgentRun = (id: string, options: ApiOptions = {}) =>
  apiJson<AgentRunResource>(`/api/agent/runs/${encodeURIComponent(id)}/cancel`, {
    ...options,
    method: 'POST',
    headers: protection,
    body: {},
    timeoutMs: options.timeoutMs ?? RUN_TIMEOUT_MS,
  })

export const pollingStatuses = new Set<AgentRunStatus>([
  'planning',
  'executing',
  'validating',
  'revising',
])

export const shouldPollRun = (status: AgentRunStatus) => pollingStatuses.has(status)

export const canCancelRun = (status: AgentRunStatus) =>
  shouldPollRun(status) || status === 'awaiting_approval'

const waitForNextPoll = (delayMs: number, signal: AbortSignal) => new Promise<boolean>((resolve) => {
  if (signal.aborted) return resolve(false)
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort)
    resolve(true)
  }, delayMs)
  const onAbort = () => {
    clearTimeout(timer)
    resolve(false)
  }
  signal.addEventListener('abort', onAbort, { once: true })
})

export type PollAgentRunOptions = {
  signal: AbortSignal
  intervalMs?: number
  request?: typeof getAgentRun
  onUpdate?: (resource: AgentRunResource) => void
}

/** 只在活动状态轮询；AbortSignal 会同时中止网络请求和等待计时器。 */
export async function pollAgentRun(
  id: string,
  options: PollAgentRunOptions,
): Promise<AgentRunResource | null> {
  const request = options.request ?? getAgentRun
  const intervalMs = Math.max(0, options.intervalMs ?? 1_000)
  while (!options.signal.aborted) {
    const resource = await request(id, { signal: options.signal })
    if (options.signal.aborted) return null
    options.onUpdate?.(resource)
    if (!shouldPollRun(resource.run.status)) return resource
    if (!await waitForNextPoll(intervalMs, options.signal)) return null
  }
  return null
}

export const runStatusLabels: Readonly<Record<AgentRunStatus, string>> = {
  planning: '正在分析需求',
  executing: '正在执行工具',
  validating: '正在验收结果',
  revising: '正在修订计划',
  awaiting_approval: '等待用户审批',
  completed: '已批准完成',
  failed: '执行失败',
  canceled: '已取消',
}

export const executionStatusLabels: Readonly<Record<AgentExecutionStatus, string>> = {
  pending: '等待中',
  running: '进行中',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
}

const SENSITIVE_JSON_VALUE = /("(?:api[-_ ]?key|authorization|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|cookie|systemPrompt|userPrompt|prompt)"\s*:\s*)"(?:\\.|[^"\\])*"/gi
const SENSITIVE_ASSIGNMENT = /(\b(?:api[-_ ]?key|authorization|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|cookie|systemPrompt|userPrompt|prompt)\b\s*[:=]\s*)([^\s,;]+)/gi

/** 即使服务端摘要意外携带敏感字段，Trace UI 也会再次脱敏并限制长度。 */
export function safeTraceText(value: string, limit = 320): string {
  const safe = value
    .replace(SENSITIVE_JSON_VALUE, '$1"***"')
    .replace(SENSITIVE_ASSIGNMENT, '$1***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
    .replace(/\s+/g, ' ')
    .trim()
  return safe.length <= limit ? safe : `${safe.slice(0, Math.max(0, limit - 1))}…`
}

export function traceSummary(value?: string): string | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (typeof parsed.passed === 'boolean') {
      const failed = Array.isArray(parsed.failedRuleIds)
        ? parsed.failedRuleIds.filter((id): id is string => typeof id === 'string')
        : []
      return parsed.passed ? '确定性验收全部通过。' : `未通过规则：${failed.join('、') || '未知规则'}。`
    }
    if (typeof parsed.round === 'number' && Array.isArray(parsed.steps)) {
      const tools = parsed.steps.flatMap((step) => {
        if (!step || typeof step !== 'object') return []
        const name = (step as Record<string, unknown>).toolName
        return typeof name === 'string' ? [name] : []
      })
      return `第 ${parsed.round + 1} 轮计划包含 ${tools.length} 个工具步骤：${tools.join('、')}。`
    }
  } catch {
    // 非 JSON 摘要仍按安全文本展示。
  }
  return safeTraceText(value)
}

const rangeText = (minimum?: number, maximum?: number, unit = '') => {
  if (minimum !== undefined && maximum !== undefined) return `${minimum}–${maximum}${unit}`
  if (minimum !== undefined) return `不少于 ${minimum}${unit}`
  if (maximum !== undefined) return `不超过 ${maximum}${unit}`
  return '未指定'
}

export function constraintText(constraint: EvaluationConstraint): string {
  switch (constraint.type) {
    case 'required_instrument':
      return `必须包含乐器：${constraint.instrument}`
    case 'forbidden_instrument':
      return `不得包含乐器：${constraint.instrument}`
    case 'duration_range':
      return `工程时长：${rangeText(constraint.minSeconds, constraint.maxSeconds, ' 秒')}`
    case 'track_count':
      return `轨道数量：${rangeText(constraint.min, constraint.max, ' 条')}`
    case 'section_note_density':
      return `${constraint.startSeconds}–${constraint.endSeconds} 秒音符密度：${rangeText(constraint.minNotesPerSecond, constraint.maxNotesPerSecond, ' 个/秒')}`
  }
}

export function elapsedText(startedAt?: number, finishedAt?: number): string {
  if (startedAt === undefined) return '尚未开始'
  if (finishedAt === undefined) return '进行中'
  const duration = Math.max(0, finishedAt - startedAt)
  return duration < 1_000 ? `${duration}ms` : `${(duration / 1_000).toFixed(1)}s`
}
