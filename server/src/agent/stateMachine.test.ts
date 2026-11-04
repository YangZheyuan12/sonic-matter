import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isTerminalRunStatus,
  transitionRun,
  type AgentRunEvent,
} from './stateMachine.ts'
import { agentRunSchema, type AgentRun, type AgentRunStatus } from './types.ts'

const makeRun = (status: AgentRunStatus): AgentRun => ({
  id: 'run-1',
  status,
  instruction: '把主旋律整体升高一个八度',
  createdAt: 1_000,
  updatedAt: 1_100,
  steps: [],
})

type EventWithoutTime = AgentRunEvent extends infer Event
  ? Event extends AgentRunEvent
    ? Omit<Event, 'occurredAt'>
    : never
  : never

const event = (value: EventWithoutTime): AgentRunEvent =>
  ({
    ...value,
    occurredAt: 1_200,
  }) as AgentRunEvent

test('主路径和修订路径中的合法事件进入预期状态', () => {
  const cases: ReadonlyArray<
    readonly [AgentRunStatus, AgentRunEvent, AgentRunStatus]
  > = [
    ['planning', event({ type: 'plan_completed' }), 'executing'],
    ['executing', event({ type: 'execution_completed' }), 'validating'],
    ['validating', event({ type: 'validation_passed' }), 'awaiting_approval'],
    ['validating', event({ type: 'validation_failed' }), 'revising'],
    ['revising', event({ type: 'revision_completed' }), 'executing'],
    ['awaiting_approval', event({ type: 'approval_granted' }), 'completed'],
    [
      'awaiting_approval',
      event({ type: 'approval_rejected', reason: '暂不应用这次修改' }),
      'canceled',
    ],
  ]

  for (const [currentStatus, runEvent, expectedStatus] of cases) {
    const result = transitionRun(makeRun(currentStatus), runEvent)

    assert.equal(result.ok, true, `${currentStatus} + ${runEvent.type}`)
    if (result.ok) {
      assert.equal(result.run.status, expectedStatus)
      assert.equal(result.run.updatedAt, runEvent.occurredAt)
      assert.equal(agentRunSchema.safeParse(result.run).success, true)
    }
  }
})

test('任意活动状态都可以明确失败或取消', () => {
  const activeStatuses: AgentRunStatus[] = [
    'planning',
    'executing',
    'validating',
    'revising',
    'awaiting_approval',
  ]

  for (const status of activeStatuses) {
    const failed = transitionRun(
      makeRun(status),
      event({
        type: 'run_failed',
        errorCode: 'tool_execution_failed',
        errorMessage: '工具执行失败',
      }),
    )
    const canceled = transitionRun(
      makeRun(status),
      event({ type: 'run_canceled', reason: '用户主动取消' }),
    )

    assert.equal(failed.ok, true)
    assert.equal(canceled.ok, true)
    if (failed.ok) {
      assert.equal(failed.run.status, 'failed')
      assert.equal(failed.run.errorCode, 'tool_execution_failed')
      assert.equal(failed.run.errorMessage, '工具执行失败')
    }
    if (canceled.ok) {
      assert.equal(canceled.run.status, 'canceled')
      assert.equal(canceled.run.errorCode, 'run_canceled')
      assert.equal(canceled.run.errorMessage, '用户主动取消')
    }
  }
})

test('completed、failed 和 canceled 都是不可离开的终止状态', () => {
  const terminalStatuses: AgentRunStatus[] = [
    'completed',
    'failed',
    'canceled',
  ]
  const events: AgentRunEvent[] = [
    event({ type: 'plan_completed' }),
    event({ type: 'execution_completed' }),
    event({ type: 'validation_passed' }),
    event({ type: 'validation_failed' }),
    event({ type: 'revision_completed' }),
    event({ type: 'approval_granted' }),
    event({ type: 'approval_rejected' }),
    event({
      type: 'run_failed',
      errorCode: 'unexpected_error',
      errorMessage: '发生未知错误',
    }),
    event({ type: 'run_canceled' }),
  ]

  for (const status of terminalStatuses) {
    assert.equal(isTerminalRunStatus(status), true)
    for (const runEvent of events) {
      const result = transitionRun(makeRun(status), runEvent)

      assert.deepEqual(result, {
        ok: false,
        code: 'invalid_run_transition',
        message: `Agent Run 不能从 ${status} 通过 ${runEvent.type} 事件转换。`,
        currentStatus: status,
        eventType: runEvent.type,
      })
    }
  }
})

test('关键非法转换返回稳定错误而不是静默跳转', () => {
  const cases: ReadonlyArray<readonly [AgentRunStatus, AgentRunEvent]> = [
    ['planning', event({ type: 'approval_granted' })],
    ['executing', event({ type: 'validation_passed' })],
    ['validating', event({ type: 'plan_completed' })],
    ['revising', event({ type: 'approval_granted' })],
    ['awaiting_approval', event({ type: 'execution_completed' })],
  ]

  for (const [currentStatus, runEvent] of cases) {
    const result = transitionRun(makeRun(currentStatus), runEvent)

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'invalid_run_transition')
      assert.equal(result.currentStatus, currentStatus)
      assert.equal(result.eventType, runEvent.type)
    }
  }
})

test('转换返回新快照，不修改原 Run 和 steps 数组', () => {
  const current = makeRun('planning')
  const originalSnapshot = structuredClone(current)
  const result = transitionRun(current, event({ type: 'plan_completed' }))

  assert.equal(result.ok, true)
  assert.deepEqual(current, originalSnapshot)
  if (result.ok) {
    assert.notEqual(result.run, current)
    assert.equal(result.run.steps, current.steps)
  }
})

test('成功转换会清除旧错误，新的失败会写入当前错误', () => {
  const recoveredPlanningRun: AgentRun = {
    ...makeRun('planning'),
    errorCode: 'stale_error',
    errorMessage: '上一阶段遗留的错误',
  }
  const progressed = transitionRun(
    recoveredPlanningRun,
    event({ type: 'plan_completed' }),
  )

  assert.equal(progressed.ok, true)
  if (progressed.ok) {
    assert.equal(progressed.run.errorCode, undefined)
    assert.equal(progressed.run.errorMessage, undefined)
  }

  const failed = transitionRun(
    makeRun('executing'),
    event({
      type: 'run_failed',
      errorCode: 'tool_timeout',
      errorMessage: '工具执行超时',
    }),
  )

  assert.equal(failed.ok, true)
  if (failed.ok) {
    assert.equal(failed.run.errorCode, 'tool_timeout')
    assert.equal(failed.run.errorMessage, '工具执行超时')
  }
})

test('拒绝倒序、负数、小数和非安全整数事件时间', () => {
  const invalidTimes = [1_099, -1, 1_200.5, Number.MAX_SAFE_INTEGER + 1]

  for (const occurredAt of invalidTimes) {
    const result = transitionRun(makeRun('planning'), {
      type: 'plan_completed',
      occurredAt,
    })

    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'invalid_run_event_time')
    }
  }
})

test('isTerminalRunStatus 能收窄活动状态与终止状态', () => {
  assert.equal(isTerminalRunStatus('completed'), true)
  assert.equal(isTerminalRunStatus('failed'), true)
  assert.equal(isTerminalRunStatus('canceled'), true)
  assert.equal(isTerminalRunStatus('planning'), false)
  assert.equal(isTerminalRunStatus('awaiting_approval'), false)
})
