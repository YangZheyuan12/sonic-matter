import type { AgentRun, AgentRunStatus } from './types.ts'

export const terminalRunStatuses = [
  'completed',
  'failed',
  'canceled',
] as const satisfies readonly AgentRunStatus[]

export type TerminalRunStatus = (typeof terminalRunStatuses)[number]
export type ActiveRunStatus = Exclude<AgentRunStatus, TerminalRunStatus>

type TimedRunEvent = Readonly<{
  occurredAt: number
}>

export type AgentRunEvent =
  | (TimedRunEvent & Readonly<{ type: 'plan_completed' }>)
  | (TimedRunEvent & Readonly<{ type: 'execution_completed' }>)
  | (TimedRunEvent & Readonly<{ type: 'validation_passed' }>)
  | (TimedRunEvent & Readonly<{ type: 'validation_failed' }>)
  | (TimedRunEvent & Readonly<{ type: 'revision_completed' }>)
  | (TimedRunEvent & Readonly<{ type: 'approval_granted' }>)
  | (TimedRunEvent &
      Readonly<{ type: 'approval_rejected'; reason?: string }>)
  | (TimedRunEvent &
      Readonly<{
        type: 'run_failed'
        errorCode: string
        errorMessage: string
      }>)
  | (TimedRunEvent & Readonly<{ type: 'run_canceled'; reason?: string }>)

export type AgentRunEventType = AgentRunEvent['type']

export type AgentRunTransitionResult =
  | Readonly<{
      ok: true
      run: AgentRun
    }>
  | Readonly<{
      ok: false
      code: 'invalid_run_transition' | 'invalid_run_event_time'
      message: string
      currentStatus: AgentRunStatus
      eventType: AgentRunEventType
    }>

const transitionTable: Readonly<
  Record<
    AgentRunStatus,
    Readonly<Partial<Record<AgentRunEventType, AgentRunStatus>>>
  >
> = {
  planning: {
    plan_completed: 'executing',
    run_failed: 'failed',
    run_canceled: 'canceled',
  },
  executing: {
    execution_completed: 'validating',
    run_failed: 'failed',
    run_canceled: 'canceled',
  },
  validating: {
    validation_passed: 'awaiting_approval',
    validation_failed: 'revising',
    run_failed: 'failed',
    run_canceled: 'canceled',
  },
  revising: {
    revision_completed: 'executing',
    run_failed: 'failed',
    run_canceled: 'canceled',
  },
  awaiting_approval: {
    approval_granted: 'completed',
    approval_rejected: 'canceled',
    run_failed: 'failed',
    run_canceled: 'canceled',
  },
  completed: {},
  failed: {},
  canceled: {},
}

const terminalRunStatusSet = new Set<AgentRunStatus>(terminalRunStatuses)

export function isTerminalRunStatus(
  status: AgentRunStatus,
): status is TerminalRunStatus {
  return terminalRunStatusSet.has(status)
}

function transitionError(
  run: AgentRun,
  event: AgentRunEvent,
  code: 'invalid_run_transition' | 'invalid_run_event_time',
  message: string,
): AgentRunTransitionResult {
  return {
    ok: false,
    code,
    message,
    currentStatus: run.status,
    eventType: event.type,
  }
}

function runWithoutError(run: AgentRun): Omit<
  AgentRun,
  'errorCode' | 'errorMessage'
> {
  const { errorCode: _errorCode, errorMessage: _errorMessage, ...rest } = run
  return rest
}

export function transitionRun(
  current: AgentRun,
  event: AgentRunEvent,
): AgentRunTransitionResult {
  if (
    !Number.isSafeInteger(event.occurredAt) ||
    event.occurredAt < current.updatedAt
  ) {
    return transitionError(
      current,
      event,
      'invalid_run_event_time',
      '事件时间必须是安全整数，且不能早于 Run 的更新时间。',
    )
  }

  const nextStatus = transitionTable[current.status][event.type]

  if (nextStatus === undefined) {
    return transitionError(
      current,
      event,
      'invalid_run_transition',
      `Agent Run 不能从 ${current.status} 通过 ${event.type} 事件转换。`,
    )
  }

  const nextRunBase = {
    ...runWithoutError(current),
    status: nextStatus,
    updatedAt: event.occurredAt,
  }

  if (event.type === 'run_failed') {
    return {
      ok: true,
      run: {
        ...nextRunBase,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
      },
    }
  }

  if (event.type === 'approval_rejected') {
    return {
      ok: true,
      run: {
        ...nextRunBase,
        errorCode: 'approval_rejected',
        errorMessage: event.reason ?? '用户拒绝应用 Agent 修改。',
      },
    }
  }

  if (event.type === 'run_canceled' && event.reason !== undefined) {
    return {
      ok: true,
      run: {
        ...nextRunBase,
        errorCode: 'run_canceled',
        errorMessage: event.reason,
      },
    }
  }

  return {
    ok: true,
    run: nextRunBase,
  }
}
