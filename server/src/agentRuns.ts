import crypto from 'node:crypto'
import express, { type RequestHandler } from 'express'
import { z } from 'zod'
import { asyncHandler } from './http.ts'
import { badRequest, conflict, notFound, zodDetail } from './errors.ts'
import { projectSchema } from './projectSchema.ts'
import {
  evaluationConstraintsSchema,
  type EvaluationConstraint,
} from './agent/evaluator.ts'
import { inspectProjectTool } from './agent/inspectProjectTool.ts'
import { noteTools } from './agent/noteTools.ts'
import {
  createAgentPlan,
  type AgentPlannerModel,
  type PlannerResult,
} from './agent/planner.ts'
import { executeWithRevisions } from './agent/revisionLoop.ts'
import { inspectClientAgentBaseUrl } from './agent/securityPolicy.ts'
import {
  AgentRunStore,
  type AgentRunResource,
  type AgentRunResourceMutation,
} from './agent/runStore.ts'
import { transitionRun } from './agent/stateMachine.ts'
import { AgentToolRegistry } from './agent/toolRegistry.ts'
import { trackTools } from './agent/trackTools.ts'
import { agentRunSchema, type AgentRun } from './agent/types.ts'

const runIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/)

export const DEFAULT_AGENT_PLANNER_TIMEOUT_MS = 45_000

export const agentRunConnectionSchema = z.object({
  baseUrl: z.string().trim().url().optional(),
  apiKey: z.string().trim().max(500).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  protocol: z.enum(['responses', 'chat-completions']).optional(),
}).strict()

export type AgentRunConnection = z.infer<typeof agentRunConnectionSchema>

const createRunSchema = z.object({
  instruction: z.string().trim().min(1).max(500),
  project: projectSchema,
  constraints: evaluationConstraintsSchema,
  agent: agentRunConnectionSchema.optional(),
}).strict()

type Project = z.infer<typeof projectSchema>

export type AgentRunPlannerAccess = Readonly<{
  agentKeyAvailable: boolean
  model?: AgentPlannerModel
}>

type AgentRunAuth = Readonly<{
  requireAccount: RequestHandler
  protectMutation: RequestHandler
}>

export type AgentRunsRouterDependencies = Readonly<{
  store: AgentRunStore
  auth: AgentRunAuth
  registry?: AgentToolRegistry
  resolvePlanner?: (connection?: AgentRunConnection) => AgentRunPlannerAccess
  plan?: typeof createAgentPlan
  execute?: typeof executeWithRevisions
  now?: () => number
  newId?: () => string
  plannerTimeoutMs?: number
}>

type ActiveRun = Readonly<{
  ownerId: string
  controller: AbortController
}>

export function createDefaultAgentToolRegistry(): AgentToolRegistry {
  const registry = new AgentToolRegistry()
  registry.register(inspectProjectTool)
  registry.register(trackTools[0])
  registry.register(trackTools[1])
  registry.register(trackTools[2])
  registry.register(noteTools[0])
  registry.register(noteTools[1])
  return registry
}

function responseOf(resource: AgentRunResource) {
  return {
    run: resource.run,
    constraints: resource.constraints,
    ...(resource.candidateProject === undefined
      ? {}
      : { candidateProject: resource.candidateProject }),
    ...(resource.approvedProject === undefined
      ? {}
      : { approvedProject: resource.approvedProject }),
    ...(resource.decision === undefined ? {} : { decision: resource.decision }),
    ...(resource.decidedAt === undefined ? {} : { decidedAt: resource.decidedAt }),
  }
}

function ownerIdOf(req: express.Request): string {
  const ownerId = req.auth?.account.id
  if (!ownerId) throw new Error('认证中间件没有提供账号 ID。')
  return ownerId
}

function idOf(req: express.Request): string {
  const value = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id
  const parsed = runIdSchema.safeParse(value)
  if (!parsed.success) throw badRequest('Run ID 格式不正确。', zodDetail(parsed.error))
  return parsed.data
}

function getOwnedOrThrow(store: AgentRunStore, id: string, ownerId: string) {
  const resource = store.getOwned(id, ownerId)
  if (resource === null) throw notFound('这个 Agent Run 不存在，或者不属于当前账号。')
  return resource
}

function mutationResponse(
  outcome: AgentRunResourceMutation,
  action: '取消' | '批准' | '拒绝',
) {
  if (outcome.kind === 'missing') {
    throw notFound('这个 Agent Run 不存在，或者不属于当前账号。')
  }
  if (outcome.kind === 'conflict') {
    throw conflict(outcome.message, `当前状态：${outcome.resource.run.status}`)
  }
  return {
    ...responseOf(outcome.resource),
    action,
    idempotent: outcome.kind === 'idempotent',
  }
}

function failedRun(run: AgentRun, code: string, message: string, now: number): AgentRun {
  const result = transitionRun(run, {
    type: 'run_failed',
    occurredAt: Math.max(Math.floor(now), run.updatedAt),
    errorCode: code,
    errorMessage: message.slice(0, 500),
  })
  return result.ok ? result.run : run
}

type PlanningOutcome =
  | Readonly<{ kind: 'result'; result: PlannerResult }>
  | Readonly<{ kind: 'timeout' }>
  | Readonly<{ kind: 'canceled' }>

async function planWithDeadline(
  task: (signal: AbortSignal) => Promise<PlannerResult>,
  externalSignal: AbortSignal,
  timeoutMs: number,
): Promise<PlanningOutcome> {
  if (externalSignal.aborted) return { kind: 'canceled' }
  const deadline = new AbortController()
  const signal = AbortSignal.any([externalSignal, deadline.signal])
  let timer: ReturnType<typeof setTimeout> | undefined
  let onCanceled: (() => void) | undefined
  try {
    return await Promise.race([
      task(signal).then((result) => ({ kind: 'result', result }) as const),
      new Promise<PlanningOutcome>((resolve) => {
        timer = setTimeout(() => {
          deadline.abort(new DOMException('Planner 执行超时', 'TimeoutError'))
          resolve({ kind: 'timeout' })
        }, timeoutMs)
      }),
      new Promise<PlanningOutcome>((resolve) => {
        onCanceled = () => resolve({ kind: 'canceled' })
        externalSignal.addEventListener('abort', onCanceled, { once: true })
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onCanceled !== undefined) externalSignal.removeEventListener('abort', onCanceled)
  }
}

/**
 * 创建、查询、取消和审批 Agent Run 的 HTTP 路由。
 * 执行在响应 202 后继续进行，客户端通过 GET 轮询 Trace。
 */
export function agentRunsRouter(dependencies: AgentRunsRouterDependencies) {
  const router = express.Router()
  const registry = dependencies.registry ?? createDefaultAgentToolRegistry()
  const plan = dependencies.plan ?? createAgentPlan
  const execute = dependencies.execute ?? executeWithRevisions
  const now = dependencies.now ?? Date.now
  const newId = dependencies.newId ?? crypto.randomUUID
  const plannerTimeoutMs = Math.max(
    1,
    Math.min(300_000, Math.floor(
      dependencies.plannerTimeoutMs ?? DEFAULT_AGENT_PLANNER_TIMEOUT_MS,
    )),
  )
  const activeRuns = new Map<string, ActiveRun>()

  const runInBackground = async (
    resource: AgentRunResource,
    project: Project,
    constraints: readonly EvaluationConstraint[],
    access: AgentRunPlannerAccess,
    controller: AbortController,
  ) => {
    const { id } = resource.run
    try {
      const planning = await planWithDeadline(
        (signal) => plan(
          {
            instruction: resource.run.instruction,
            agentKeyAvailable: access.agentKeyAvailable,
            signal,
          },
          { registry, ...(access.model === undefined ? {} : { model: access.model }) },
        ),
        controller.signal,
        plannerTimeoutMs,
      )
      let current = dependencies.store.getOwned(id, resource.ownerId)
      if (current === null || current.run.status === 'canceled') return
      if (planning.kind === 'canceled' || controller.signal.aborted) {
        dependencies.store.cancelOwned(id, resource.ownerId, now())
        return
      }
      if (planning.kind === 'timeout') {
        dependencies.store.update(failedRun(
          current.run,
          'planner_timeout',
          'Agent Planner 已达到执行时限，请稍后重试。',
          now(),
        ))
        return
      }
      const plannerResult = planning.result
      if (!plannerResult.ok) {
        dependencies.store.update(failedRun(
          current.run,
          plannerResult.error.code,
          plannerResult.error.message,
          now(),
        ))
        return
      }

      const transitioned = transitionRun(current.run, {
        type: 'plan_completed',
        occurredAt: Math.max(Math.floor(now()), current.run.updatedAt),
      })
      if (!transitioned.ok) return
      const executingRun = dependencies.store.update(transitioned.run)
      if (executingRun === null) return

      const result = await execute(
        {
          run: executingRun,
          initialPlan: plannerResult.plan,
          project,
          constraints,
          signal: controller.signal,
        },
        {
          registry,
          store: dependencies.store,
          ...(access.model === undefined ? {} : { model: access.model }),
          now,
        },
      )
      if (result.status !== 'rejected') {
        dependencies.store.setCandidateProject(id, resource.ownerId, result.candidateProject)
      }
    } catch {
      const current = dependencies.store.getOwned(id, resource.ownerId)
      if (current === null || ['completed', 'failed', 'canceled'].includes(current.run.status)) return
      dependencies.store.update(failedRun(
        current.run,
        'run_api_execution_failed',
        'Agent Run 执行失败，请稍后重试。',
        now(),
      ))
    } finally {
      activeRuns.delete(id)
    }
  }

  router.use(dependencies.auth.requireAccount)

  router.post('/', dependencies.auth.protectMutation, asyncHandler(async (req, res) => {
    const parsed = createRunSchema.safeParse(req.body)
    if (!parsed.success) {
      throw badRequest('Agent Run 输入不正确。', zodDetail(parsed.error))
    }
    const endpointSecurity = inspectClientAgentBaseUrl(parsed.data.agent?.baseUrl)
    if (!endpointSecurity.safe) {
      throw badRequest('Agent 服务地址不安全。', endpointSecurity.message)
    }
    const ownerId = ownerIdOf(req)
    const createdAt = Math.max(0, Math.floor(now()))
    const id = runIdSchema.parse(newId())
    const run = agentRunSchema.parse({
      id,
      status: 'planning',
      instruction: parsed.data.instruction,
      createdAt,
      updatedAt: createdAt,
      steps: [],
    })
    const resource = dependencies.store.createOwned({
      run,
      ownerId,
      constraints: parsed.data.constraints,
      sourceProject: parsed.data.project,
    })
    const access = dependencies.resolvePlanner?.(parsed.data.agent) ?? {
      agentKeyAvailable: false,
    }
    const controller = new AbortController()
    activeRuns.set(id, { ownerId, controller })
    queueMicrotask(() => {
      void runInBackground(
        resource,
        parsed.data.project,
        parsed.data.constraints,
        access,
        controller,
      )
    })
    res.location(`/api/agent/runs/${id}`)
    return res.status(202).json(responseOf(resource))
  }))

  router.get('/:id', asyncHandler(async (req, res) => {
    const resource = getOwnedOrThrow(dependencies.store, idOf(req), ownerIdOf(req))
    return res.json(responseOf(resource))
  }))

  router.post('/:id/cancel', dependencies.auth.protectMutation, asyncHandler(async (req, res) => {
    const id = idOf(req)
    const ownerId = ownerIdOf(req)
    const outcome = dependencies.store.cancelOwned(id, ownerId, now())
    if (outcome.kind !== 'missing') {
      const active = activeRuns.get(id)
      if (active?.ownerId === ownerId) active.controller.abort()
    }
    return res.json(mutationResponse(outcome, '取消'))
  }))

  router.post('/:id/approve', dependencies.auth.protectMutation, asyncHandler(async (req, res) => {
    const outcome = dependencies.store.decideOwned(idOf(req), ownerIdOf(req), 'approved', now())
    return res.json(mutationResponse(outcome, '批准'))
  }))

  router.post('/:id/reject', dependencies.auth.protectMutation, asyncHandler(async (req, res) => {
    const outcome = dependencies.store.decideOwned(idOf(req), ownerIdOf(req), 'rejected', now())
    return res.json(mutationResponse(outcome, '拒绝'))
  }))

  return router
}
