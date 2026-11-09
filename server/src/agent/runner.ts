import { z } from 'zod'
import { redact } from '../logger.ts'
import { projectSchema } from '../projectSchema.ts'
import { agentPlanSchema, MAX_PLAN_STEPS, type AgentPlan } from './planner.ts'
import { transitionRun, type AgentRunEvent } from './stateMachine.ts'
import { AgentToolRegistry } from './toolRegistry.ts'
import {
  agentRunSchema,
  agentSchemaLimits,
  type AgentRun,
  type AgentStep,
  type ToolCall,
} from './types.ts'

export const DEFAULT_RUNNER_TIMEOUT_MS = 90_000

type ProjectSnapshot = z.infer<typeof projectSchema>

export type RunnerError = Readonly<{
  code: string
  message: string
  retryable: boolean
}>

export type RunnerResult =
  | Readonly<{
      ok: true
      status: 'succeeded'
      run: AgentRun
      candidateProject: ProjectSnapshot
      executedStepCount: number
      projectChangeCount: number
    }>
  | Readonly<{
      ok: false
      status: 'failed' | 'canceled'
      run: AgentRun
      candidateProject: ProjectSnapshot
      executedStepCount: number
      projectChangeCount: number
      error: RunnerError
    }>
  | Readonly<{
      ok: false
      status: 'rejected'
      error: RunnerError
      issues?: readonly Readonly<{
        path: readonly (string | number)[]
        message: string
      }>[]
    }>

export type ExecuteAgentPlanInput = Readonly<{
  run: AgentRun
  plan: AgentPlan
  project: ProjectSnapshot
  signal?: AbortSignal
  maxSteps?: number
  timeoutMs?: number
}>

export type ExecuteAgentPlanDependencies = Readonly<{
  registry: AgentToolRegistry
  now?: () => number
}>

const runnerInputSchema = z.object({
  run: agentRunSchema,
  plan: agentPlanSchema,
  project: projectSchema,
  signal: z.instanceof(AbortSignal).optional(),
  maxSteps: z.number().int().min(1).max(MAX_PLAN_STEPS).optional(),
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
}).strict()

function rejected(
  code: string,
  message: string,
  issues?: readonly Readonly<{
    path: readonly (string | number)[]
    message: string
  }>[],
): RunnerResult {
  return {
    ok: false,
    status: 'rejected',
    error: { code, message, retryable: false },
    ...(issues === undefined ? {} : { issues }),
  }
}

function schemaIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) =>
      typeof part === 'symbol' ? part.description ?? part.toString() : part,
    ),
    message: issue.message,
  }))
}

function timestamp(now: () => number, minimum: number): number {
  const value = Math.floor(now())
  return Number.isSafeInteger(value) && value >= minimum ? value : minimum
}

function clipped(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}

function traceErrorCode(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const prefixed = /^[a-z]/.test(normalized) ? normalized : `runner_${normalized || 'error'}`
  return prefixed.slice(0, agentSchemaLimits.errorCodeLength)
}

function projectSummary(value: unknown): unknown {
  const parsed = projectSchema.safeParse(value)
  if (!parsed.success) return '[非法候选工程]'
  return {
    title: parsed.data.title,
    duration: parsed.data.duration ?? 10,
    trackCount: parsed.data.tracks.length,
  }
}

function compactTraceValue(value: unknown, key = '', depth = 0): unknown {
  if (depth > 5) return '[嵌套过深]'
  if (key === 'project') return projectSummary(value)
  if (key === 'notes' && Array.isArray(value)) return `[${value.length} notes]`
  if (key === 'clips' && Array.isArray(value)) return `[${value.length} clips]`
  if (key === 'source' && typeof value === 'string') return `[音频来源已省略，${value.length} 字符]`
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((item) => compactTraceValue(item, '', depth + 1))
    return value.length > 20 ? [...items, `[另有 ${value.length - 20} 项]`] : items
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([itemKey, item]) => [
          itemKey,
          compactTraceValue(item, itemKey, depth + 1),
        ]),
    )
  }
  return value
}

function summarize(value: unknown, limit: number): string {
  const serialized = JSON.stringify(redact(compactTraceValue(value))) ?? 'null'
  return clipped(serialized, limit)
}

function uniqueTraceId(prefix: string, source: string, used: Set<string>): string {
  const clean = source.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60) || 'step'
  let candidate = `${prefix}-${clean}`.slice(0, agentSchemaLimits.idLength)
  let suffix = 1
  while (used.has(candidate)) {
    const tail = `-${suffix++}`
    candidate = `${prefix}-${clean}`.slice(0, agentSchemaLimits.idLength - tail.length) + tail
  }
  used.add(candidate)
  return candidate
}

function appendStep(run: AgentRun, step: AgentStep): AgentRun {
  return {
    ...run,
    updatedAt: Math.max(run.updatedAt, step.finishedAt ?? run.updatedAt),
    steps: [...run.steps, step],
  }
}

function transitionOrThrow(run: AgentRun, event: AgentRunEvent): AgentRun {
  const result = transitionRun(run, event)
  if (!result.ok) {
    throw new Error(`Runner 内部状态转换失败：${result.code}`)
  }
  return result.run
}

function finishFailedRun(
  run: AgentRun,
  error: RunnerError,
  occurredAt: number,
): AgentRun {
  return transitionOrThrow(run, {
    type: 'run_failed',
    occurredAt,
    errorCode: traceErrorCode(error.code),
    errorMessage: clipped(error.message, agentSchemaLimits.errorMessageLength),
  })
}

function finishCanceledRun(
  run: AgentRun,
  reason: string,
  occurredAt: number,
): AgentRun {
  return transitionOrThrow(run, {
    type: 'run_canceled',
    occurredAt,
    reason: clipped(reason, agentSchemaLimits.errorMessageLength),
  })
}

type BusinessFailure = Readonly<{
  code: string
  message: string
  retryable: boolean
}>

function businessFailure(output: unknown): BusinessFailure | undefined {
  if (output === null || typeof output !== 'object') return undefined
  const value = output as Record<string, unknown>

  if (value.status === 'rejected') {
    const error = value.error
    if (error !== null && typeof error === 'object') {
      const details = error as Record<string, unknown>
      return {
        code: typeof details.code === 'string' ? details.code : 'tool_operation_rejected',
        message: typeof details.message === 'string'
          ? details.message
          : '工具正常运行，但业务规则拒绝了操作。',
        retryable: details.shouldTerminate !== true,
      }
    }
    return {
      code: 'tool_operation_rejected',
      message: '工具正常运行，但业务规则拒绝了操作。',
      retryable: false,
    }
  }

  if (value.status === 'invalid') {
    const firstIssue = Array.isArray(value.issues) ? value.issues[0] : undefined
    const issue = firstIssue !== null && typeof firstIssue === 'object'
      ? firstIssue as Record<string, unknown>
      : undefined
    return {
      code: typeof issue?.code === 'string' ? issue.code : 'project_validation_failed',
      message: typeof issue?.message === 'string'
        ? issue.message
        : '候选工程未通过最终验收。',
      retryable: true,
    }
  }

  return undefined
}

function nextCandidateProject(
  current: ProjectSnapshot,
  output: unknown,
): Readonly<
  | { ok: true; project: ProjectSnapshot; changed: boolean }
  | { ok: false; error: RunnerError }
> {
  if (output === null || typeof output !== 'object') {
    return { ok: true, project: current, changed: false }
  }
  const value = output as Record<string, unknown>
  if (value.status !== 'applied') {
    return { ok: true, project: current, changed: false }
  }

  const parsed = projectSchema.safeParse(value.project)
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'invalid_candidate_project',
        message: '工具返回的候选工程未通过 Project Schema。',
        retryable: false,
      },
    }
  }
  return {
    ok: true,
    project: parsed.data,
    changed: value.changed === true,
  }
}

function succeededStep(
  ids: { stepId: string; callId: string },
  planStep: AgentPlan['steps'][number],
  inputSummary: string,
  outputSummary: string,
  startedAt: number,
  finishedAt: number,
): AgentStep {
  const call: ToolCall = {
    id: ids.callId,
    toolName: planStep.toolName,
    status: 'succeeded',
    inputSummary,
    outputSummary,
    startedAt,
    finishedAt,
  }
  return {
    id: ids.stepId,
    kind: 'tool',
    status: 'succeeded',
    title: clipped(planStep.objective, agentSchemaLimits.stepTitleLength),
    summary: `计划步骤 ${planStep.id} 已完成，耗时 ${finishedAt - startedAt}ms。`,
    toolCalls: [call],
    startedAt,
    finishedAt,
  }
}

function failedStep(
  ids: { stepId: string; callId: string },
  planStep: AgentPlan['steps'][number],
  inputSummary: string,
  outputSummary: string | undefined,
  error: RunnerError,
  status: 'failed' | 'canceled',
  startedAt: number,
  finishedAt: number,
): AgentStep {
  const errorMessage = clipped(error.message, agentSchemaLimits.errorMessageLength)
  const call: ToolCall = status === 'canceled'
    ? {
        id: ids.callId,
        toolName: planStep.toolName,
        status: 'canceled',
        inputSummary,
        errorMessage,
        startedAt,
        finishedAt,
      }
    : {
        id: ids.callId,
        toolName: planStep.toolName,
        status: 'failed',
        inputSummary,
        errorCode: traceErrorCode(error.code),
        errorMessage,
        startedAt,
        finishedAt,
      }
  return {
    id: ids.stepId,
    kind: 'tool',
    status,
    title: clipped(planStep.objective, agentSchemaLimits.stepTitleLength),
    summary: outputSummary === undefined
      ? `计划步骤 ${planStep.id} 未完成，耗时 ${finishedAt - startedAt}ms。`
      : clipped(outputSummary, agentSchemaLimits.stepSummaryLength),
    toolCalls: [call],
    startedAt,
    finishedAt,
    errorCode: traceErrorCode(error.code),
    errorMessage,
  }
}

export async function executeAgentPlan(
  rawInput: ExecuteAgentPlanInput,
  dependencies: ExecuteAgentPlanDependencies,
): Promise<RunnerResult> {
  const inputResult = runnerInputSchema.safeParse(rawInput)
  if (!inputResult.success) {
    return rejected(
      'invalid_runner_input',
      'Runner 输入未通过校验。',
      schemaIssues(inputResult.error),
    )
  }

  const input = inputResult.data
  if (input.run.status !== 'executing') {
    return rejected(
      'invalid_runner_state',
      `Runner 只能执行 executing 状态的 Run，当前状态为 ${input.run.status}。`,
    )
  }

  const now = dependencies.now ?? Date.now
  const maxSteps = input.maxSteps ?? MAX_PLAN_STEPS
  const timeoutMs = input.timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS
  let run: AgentRun = input.run
  let candidateProject: ProjectSnapshot = input.project
  let executedStepCount = 0
  let projectChangeCount = 0

  const failWithoutStep = (
    error: RunnerError,
    status: 'failed' | 'canceled',
  ): RunnerResult => {
    const occurredAt = timestamp(now, run.updatedAt)
    run = status === 'canceled'
      ? finishCanceledRun(run, error.message, occurredAt)
      : finishFailedRun(run, error, occurredAt)
    return {
      ok: false,
      status,
      run,
      candidateProject,
      executedStepCount,
      projectChangeCount,
      error,
    }
  }

  if (input.plan.steps.length > maxSteps) {
    return failWithoutStep(
      {
        code: 'step_budget_exceeded',
        message: `计划包含 ${input.plan.steps.length} 步，超过 Runner 的 ${maxSteps} 步预算。`,
        retryable: false,
      },
      'failed',
    )
  }

  if (run.steps.length + input.plan.steps.length > agentSchemaLimits.stepsPerRun) {
    return failWithoutStep(
      {
        code: 'run_step_limit_exceeded',
        message: '执行计划会超过 Agent Run 的步骤记录上限。',
        retryable: false,
      },
      'failed',
    )
  }

  const controller = new AbortController()
  let timedOut = false
  const onExternalAbort = () => controller.abort(input.signal?.reason)
  if (input.signal?.aborted) onExternalAbort()
  else input.signal?.addEventListener('abort', onExternalAbort, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Runner 执行超时', 'TimeoutError'))
  }, timeoutMs)

  const usedStepIds = new Set(run.steps.map((step) => step.id))
  const usedCallIds = new Set(
    run.steps.flatMap((step) => step.toolCalls.map((call) => call.id)),
  )

  try {
    for (const planStep of input.plan.steps) {
      if (timedOut) {
        return failWithoutStep(
          { code: 'runner_timeout', message: 'Runner 已达到总执行超时。', retryable: true },
          'failed',
        )
      }
      if (input.signal?.aborted || controller.signal.aborted) {
        return failWithoutStep(
          { code: 'runner_canceled', message: '用户取消了 Agent 执行。', retryable: false },
          'canceled',
        )
      }
      if (run.status !== 'executing' || executedStepCount >= maxSteps) {
        return failWithoutStep(
          { code: 'step_budget_exceeded', message: 'Runner 在启动新工具前检测到步骤预算已耗尽。', retryable: false },
          'failed',
        )
      }

      const stepId = uniqueTraceId('exec', planStep.id, usedStepIds)
      const callId = uniqueTraceId('call', planStep.id, usedCallIds)
      const startedAt = timestamp(now, run.updatedAt)
      const toolInput = { ...planStep.arguments, project: candidateProject }
      const inputSummary = summarize(
        { ...planStep.arguments, project: projectSummary(candidateProject) },
        agentSchemaLimits.toolInputSummaryLength,
      )
      const toolResult = await dependencies.registry.execute(
        planStep.toolName,
        toolInput,
        { signal: controller.signal },
      )
      const finishedAt = timestamp(now, startedAt)
      executedStepCount += 1

      if (timedOut) {
        const error = {
          code: 'runner_timeout',
          message: 'Runner 在工具执行期间达到总执行超时。',
          retryable: true,
        } satisfies RunnerError
        run = appendStep(run, failedStep(
          { stepId, callId }, planStep, inputSummary, undefined,
          error, 'failed', startedAt, finishedAt,
        ))
        return failWithoutStep(error, 'failed')
      }

      if (input.signal?.aborted) {
        const error = {
          code: 'runner_canceled',
          message: '用户在工具执行期间取消了 Agent。',
          retryable: false,
        } satisfies RunnerError
        run = appendStep(run, failedStep(
          { stepId, callId }, planStep, inputSummary, undefined,
          error, 'canceled', startedAt, finishedAt,
        ))
        return failWithoutStep(error, 'canceled')
      }

      if (!toolResult.ok) {
        const canceled = toolResult.error.code === 'tool_execution_canceled'
        const error = {
          code: toolResult.error.code,
          message: toolResult.error.message,
          retryable: toolResult.error.retryable,
        } satisfies RunnerError
        run = appendStep(run, failedStep(
          { stepId, callId }, planStep, inputSummary, undefined,
          error, canceled ? 'canceled' : 'failed', startedAt, finishedAt,
        ))
        return failWithoutStep(error, canceled ? 'canceled' : 'failed')
      }

      const outputSummary = summarize(
        toolResult.output,
        agentSchemaLimits.toolOutputSummaryLength,
      )
      const rejectedOutput = businessFailure(toolResult.output)
      if (rejectedOutput !== undefined) {
        const error = { ...rejectedOutput } satisfies RunnerError
        run = appendStep(run, failedStep(
          { stepId, callId }, planStep, inputSummary, outputSummary,
          error, 'failed', startedAt, finishedAt,
        ))
        return failWithoutStep(error, 'failed')
      }

      const nextProject = nextCandidateProject(candidateProject, toolResult.output)
      if (!nextProject.ok) {
        run = appendStep(run, failedStep(
          { stepId, callId }, planStep, inputSummary, outputSummary,
          nextProject.error, 'failed', startedAt, finishedAt,
        ))
        return failWithoutStep(nextProject.error, 'failed')
      }

      candidateProject = nextProject.project
      if (nextProject.changed) projectChangeCount += 1
      run = appendStep(run, succeededStep(
        { stepId, callId }, planStep, inputSummary, outputSummary,
        startedAt, finishedAt,
      ))
    }

    const occurredAt = timestamp(now, run.updatedAt)
    run = transitionOrThrow(run, { type: 'execution_completed', occurredAt })
    return {
      ok: true,
      status: 'succeeded',
      run,
      candidateProject,
      executedStepCount,
      projectChangeCount,
    }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', onExternalAbort)
  }
}
