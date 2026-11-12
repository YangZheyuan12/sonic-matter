import { z } from 'zod'
import { redact } from '../logger.ts'
import { projectSchema } from '../projectSchema.ts'
import {
  evaluateProject,
  evaluationConstraintsSchema,
  type EvaluationConstraint,
  type EvaluationReport,
} from './evaluator.ts'
import { agentPlanSchema, type AgentPlan, type AgentPlannerModel } from './planner.ts'
import { executeAgentPlan } from './runner.ts'
import type { AgentRunStore } from './runStore.ts'
import {
  createRevisionPlan,
  type RevisionPlanner,
} from './revisionPlanner.ts'
import { transitionRun } from './stateMachine.ts'
import type { AgentToolRegistry } from './toolRegistry.ts'
import {
  agentRunSchema,
  agentSchemaLimits,
  type AgentRun,
  type AgentStep,
} from './types.ts'

export const MAX_REVISION_ROUNDS = 2

const revisionLoopInputSchema = z.object({
  run: agentRunSchema,
  initialPlan: agentPlanSchema,
  project: projectSchema,
  constraints: evaluationConstraintsSchema,
  maxRevisions: z.number().int().min(0).max(MAX_REVISION_ROUNDS).optional(),
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
  signal: z.instanceof(AbortSignal).optional(),
}).strict()

type Project = z.infer<typeof projectSchema>

export type RevisionLoopInput = Readonly<{
  run: AgentRun
  initialPlan: AgentPlan
  project: Project
  constraints: readonly EvaluationConstraint[]
  maxRevisions?: number
  timeoutMs?: number
  signal?: AbortSignal
}>

export type RevisionRoundRecord = Readonly<{
  index: number
  kind: 'initial' | 'revision'
  plan: AgentPlan
  report?: EvaluationReport
}>

export type RevisionLoopError = Readonly<{
  code: string
  message: string
  retryable: boolean
}>

export type RevisionLoopResult =
  | Readonly<{
      ok: true
      status: 'awaiting_approval'
      run: AgentRun
      candidateProject: Project
      revisionCount: number
      rounds: readonly RevisionRoundRecord[]
    }>
  | Readonly<{
      ok: false
      status: 'failed' | 'canceled'
      run: AgentRun
      candidateProject: Project
      revisionCount: number
      rounds: readonly RevisionRoundRecord[]
      error: RevisionLoopError
    }>
  | Readonly<{
      ok: false
      status: 'rejected'
      error: RevisionLoopError
    }>

export type RevisionLoopDependencies = Readonly<{
  registry: AgentToolRegistry
  store: Pick<AgentRunStore, 'update'>
  model?: AgentPlannerModel
  planRevision?: RevisionPlanner
  now?: () => number
}>

function timestamp(now: () => number, minimum: number): number {
  const value = Math.floor(now())
  return Number.isSafeInteger(value) && value >= minimum ? value : minimum
}

function clipped(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`
}

function uniqueStepId(run: AgentRun, source: string): string {
  const used = new Set(run.steps.map((step) => step.id))
  let candidate = source.slice(0, agentSchemaLimits.idLength)
  let suffix = 1
  while (used.has(candidate)) {
    const tail = `-${suffix++}`
    candidate = source.slice(0, agentSchemaLimits.idLength - tail.length) + tail
  }
  return candidate
}

function appendTraceStep(run: AgentRun, step: AgentStep): AgentRun {
  if (run.steps.length >= agentSchemaLimits.stepsPerRun) {
    throw new Error('Agent Run 的步骤记录已达到上限。')
  }
  return agentRunSchema.parse({
    ...run,
    updatedAt: Math.max(run.updatedAt, step.finishedAt ?? run.updatedAt),
    steps: [...run.steps, step],
  })
}

function planTraceStep(
  run: AgentRun,
  plan: AgentPlan,
  roundIndex: number,
  now: () => number,
): AgentStep {
  const occurredAt = timestamp(now, run.updatedAt)
  const summary = JSON.stringify(redact({
    round: roundIndex,
    steps: plan.steps.map((step) => ({
      id: step.id,
      objective: step.objective,
      toolName: step.toolName,
      arguments: step.arguments,
    })),
  }))
  return {
    id: uniqueStepId(run, `loop-plan-${roundIndex}`),
    kind: roundIndex === 0 ? 'planning' : 'revision',
    status: 'succeeded',
    title: roundIndex === 0 ? '记录初始执行计划' : `记录第 ${roundIndex} 轮修订计划`,
    summary: clipped(summary, agentSchemaLimits.stepSummaryLength),
    toolCalls: [],
    startedAt: occurredAt,
    finishedAt: occurredAt,
  }
}

function validationTraceStep(
  run: AgentRun,
  report: EvaluationReport,
  roundIndex: number,
  now: () => number,
): AgentStep {
  const occurredAt = timestamp(now, run.updatedAt)
  const summary = clipped(
    JSON.stringify(redact(report)),
    agentSchemaLimits.stepSummaryLength,
  )
  return {
    id: uniqueStepId(run, `loop-validation-${roundIndex}`),
    kind: 'validation',
    status: report.passed ? 'succeeded' : 'failed',
    title: roundIndex === 0 ? '验收初始执行结果' : `验收第 ${roundIndex} 轮修订结果`,
    summary,
    toolCalls: [],
    startedAt: occurredAt,
    finishedAt: occurredAt,
    ...(report.passed
      ? {}
      : {
          errorCode: 'constraints_not_satisfied',
          errorMessage: `未通过 ${report.failedRuleIds.length} 条确定性验收规则。`,
        }),
  }
}

function transitionOrThrow(run: AgentRun, event: Parameters<typeof transitionRun>[1]): AgentRun {
  const result = transitionRun(run, event)
  if (!result.ok) throw new Error(`修订闭环状态转换失败：${result.code}`)
  return result.run
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    )
  }
  return value
}

function stepSignature(step: AgentPlan['steps'][number]): string {
  return `${step.toolName}:${JSON.stringify(stableValue(step.arguments))}`
}

function withoutRepeatedSteps(
  plan: AgentPlan,
  completedSignatures: ReadonlySet<string>,
): AgentPlan | null {
  const steps = plan.steps.filter((step) => !completedSignatures.has(stepSignature(step)))
  if (steps.length === 0) return null
  return agentPlanSchema.parse({ ...plan, steps })
}

function finishRun(
  run: AgentRun,
  error: RevisionLoopError,
  status: 'failed' | 'canceled',
  now: () => number,
): AgentRun {
  if (run.status === 'failed' || run.status === 'canceled' || run.status === 'completed') {
    return run
  }
  const occurredAt = timestamp(now, run.updatedAt)
  return status === 'canceled'
    ? transitionOrThrow(run, {
        type: 'run_canceled',
        occurredAt,
        reason: clipped(error.message, agentSchemaLimits.errorMessageLength),
      })
    : transitionOrThrow(run, {
        type: 'run_failed',
        occurredAt,
        errorCode: error.code,
        errorMessage: clipped(error.message, agentSchemaLimits.errorMessageLength),
      })
}

function persistenceError(): RevisionLoopError {
  return {
    code: 'trace_persistence_failed',
    message: 'Agent Trace 保存失败，已停止继续执行。',
    retryable: true,
  }
}

/** 执行、验收并最多修订两轮；每个阶段都先落 Trace，再进入下一阶段。 */
export async function executeWithRevisions(
  rawInput: RevisionLoopInput,
  dependencies: RevisionLoopDependencies,
): Promise<RevisionLoopResult> {
  const inputResult = revisionLoopInputSchema.safeParse(rawInput)
  if (!inputResult.success) {
    return {
      ok: false,
      status: 'rejected',
      error: {
        code: 'invalid_revision_loop_input',
        message: '自动修订闭环输入未通过校验。',
        retryable: false,
      },
    }
  }
  const input = inputResult.data
  if (input.run.status !== 'executing') {
    return {
      ok: false,
      status: 'rejected',
      error: {
        code: 'invalid_revision_loop_state',
        message: `自动修订闭环只能从 executing 状态开始，当前状态为 ${input.run.status}。`,
        retryable: false,
      },
    }
  }

  const now = dependencies.now ?? Date.now
  const maxRevisions = input.maxRevisions ?? MAX_REVISION_ROUNDS
  const rounds: RevisionRoundRecord[] = []
  const previousPlans: AgentPlan[] = []
  const completedSignatures = new Set<string>()
  let run: AgentRun = input.run
  let candidateProject: Project = input.project
  let currentPlan: AgentPlan = input.initialPlan
  let roundIndex = 0

  const persist = (nextRun: AgentRun): AgentRun | null => {
    try {
      return dependencies.store.update(nextRun)
    } catch {
      return null
    }
  }
  const failed = (
    error: RevisionLoopError,
    status: 'failed' | 'canceled' = 'failed',
  ): RevisionLoopResult => {
    run = finishRun(run, error, status, now)
    const stored = persist(run)
    if (stored !== null) run = stored
    return {
      ok: false,
      status,
      run,
      candidateProject,
      revisionCount: Math.max(0, roundIndex),
      rounds,
      error,
    }
  }

  while (true) {
    if (input.signal?.aborted) {
      return failed(
        { code: 'revision_loop_canceled', message: '用户取消了自动修订。', retryable: false },
        'canceled',
      )
    }

    try {
      run = appendTraceStep(run, planTraceStep(run, currentPlan, roundIndex, now))
    } catch {
      return failed({
        code: 'run_step_limit_exceeded',
        message: '自动修订所需的 Trace 会超过 Run 步骤记录上限。',
        retryable: false,
      })
    }
    const storedPlanRun = persist(run)
    if (storedPlanRun === null) {
      return failed(persistenceError())
    }
    run = storedPlanRun

    const execution = await executeAgentPlan(
      {
        run,
        plan: currentPlan,
        project: candidateProject,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      },
      { registry: dependencies.registry, now },
    )
    if (!execution.ok) {
      if (execution.status === 'rejected') {
        return failed({ ...execution.error })
      }
      run = execution.run
      candidateProject = execution.candidateProject
      rounds.push({
        index: roundIndex,
        kind: roundIndex === 0 ? 'initial' : 'revision',
        plan: currentPlan,
      })
      const storedFailureRun = persist(run)
      if (storedFailureRun !== null) run = storedFailureRun
      return {
        ok: false,
        status: execution.status,
        run,
        candidateProject,
        revisionCount: Math.max(0, roundIndex),
        rounds,
        error: execution.error,
      }
    }

    run = execution.run
    candidateProject = execution.candidateProject
    currentPlan.steps.forEach((step) => completedSignatures.add(stepSignature(step)))
    previousPlans.push(currentPlan)
    const storedExecutionRun = persist(run)
    if (storedExecutionRun === null) return failed(persistenceError())
    run = storedExecutionRun

    const evaluation = evaluateProject({
      project: candidateProject,
      constraints: input.constraints,
    })
    if (!evaluation.ok) {
      return failed({
        code: 'evaluation_failed',
        message: '候选工程无法执行确定性验收。',
        retryable: false,
      })
    }
    const report = evaluation.report
    rounds.push({
      index: roundIndex,
      kind: roundIndex === 0 ? 'initial' : 'revision',
      plan: currentPlan,
      report,
    })
    try {
      run = appendTraceStep(run, validationTraceStep(run, report, roundIndex, now))
    } catch {
      return failed({
        code: 'run_step_limit_exceeded',
        message: '验收 Trace 会超过 Run 步骤记录上限。',
        retryable: false,
      })
    }

    if (report.passed) {
      run = transitionOrThrow(run, {
        type: 'validation_passed',
        occurredAt: timestamp(now, run.updatedAt),
      })
      const stored = persist(run)
      if (stored === null) return failed(persistenceError())
      run = stored
      return {
        ok: true,
        status: 'awaiting_approval',
        run,
        candidateProject,
        revisionCount: roundIndex,
        rounds,
      }
    }

    run = transitionOrThrow(run, {
      type: 'validation_failed',
      occurredAt: timestamp(now, run.updatedAt),
    })
    const storedValidationRun = persist(run)
    if (storedValidationRun === null) return failed(persistenceError())
    run = storedValidationRun

    if (roundIndex >= maxRevisions) {
      return failed({
        code: 'revision_limit_reached',
        message: `候选工程在 ${maxRevisions} 轮修订后仍未通过验收。`,
        retryable: false,
      })
    }
    if (input.signal?.aborted) {
      return failed(
        { code: 'revision_loop_canceled', message: '用户取消了自动修订。', retryable: false },
        'canceled',
      )
    }

    const planner = dependencies.planRevision ?? createRevisionPlan
    const revision = await planner(
      {
        instruction: run.instruction,
        project: candidateProject,
        constraints: input.constraints,
        report,
        previousPlans,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      {
        registry: dependencies.registry,
        ...(dependencies.model === undefined ? {} : { model: dependencies.model }),
      },
    )
    if (!revision.ok) {
      return failed({
        code: 'revision_planning_failed',
        message: revision.error.message,
        retryable: revision.error.code === 'revision_model_failed',
      })
    }
    const filteredPlan = withoutRepeatedSteps(revision.plan, completedSignatures)
    if (filteredPlan === null) {
      return failed({
        code: 'revision_made_no_progress',
        message: 'Revision Planner 只返回了已经成功执行过的步骤，已停止无效重试。',
        retryable: false,
      })
    }

    currentPlan = filteredPlan
    roundIndex += 1
    run = transitionOrThrow(run, {
      type: 'revision_completed',
      occurredAt: timestamp(now, run.updatedAt),
    })
    const storedRevisionRun = persist(run)
    if (storedRevisionRun === null) return failed(persistenceError())
    run = storedRevisionRun
  }
}
