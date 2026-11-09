import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { projectSchema } from '../projectSchema.ts'
import { inspectProjectTool } from './inspectProjectTool.ts'
import { validateProjectTool } from './noteTools.ts'
import { agentPlanSchema, type AgentPlan } from './planner.ts'
import { executeAgentPlan } from './runner.ts'
import { removeTrackTool, updateTrackTool } from './trackTools.ts'
import { AgentToolRegistry, type AgentTool } from './toolRegistry.ts'
import { agentRunSchema, type AgentRun } from './types.ts'

const note = (id: string) => ({
  id,
  pitch: 60,
  start: 0,
  duration: 0.5,
  velocity: 90,
})

const track = (id = 'melody') => ({
  id,
  name: '主旋律',
  kind: 'midi' as const,
  instrument: 'Felt Piano',
  color: '#7dd3fc',
  notes: [note('n1')],
  gain: 0.8,
  pan: 0,
  muted: false,
  solo: false,
  start: 0,
})

const project = () => ({
  title: '测试工程',
  tempo: 92,
  key: 'C Major',
  duration: 4,
  tracks: [track()],
})

const run = (status: AgentRun['status'] = 'executing'): AgentRun => ({
  id: 'run-1',
  status,
  instruction: '把主旋律改成低音，并检查工程。',
  createdAt: 900,
  updatedAt: 1_000,
  steps: [],
})

function plan(
  steps: Array<{
    id: string
    objective: string
    toolName: string
    arguments: Record<string, unknown>
  }>,
): AgentPlan {
  return agentPlanSchema.parse({
    goal: {
      userRequest: '把主旋律改成低音，并检查工程。',
      desiredOutcome: '候选工程中的主旋律使用低音乐器并通过校验。',
    },
    constraints: [
      {
        id: 'step-budget',
        description: '执行步骤不能超过八步。',
        subject: 'runner.step_count',
        operator: 'less_than_or_equal',
        expected: 8,
      },
    ],
    steps,
    acceptanceCriteria: [
      {
        id: 'schema-valid',
        description: '候选工程通过 Project Schema。',
        check: 'project_schema_valid',
      },
    ],
  })
}

function tickingClock(start = 1_000) {
  let value = start
  return () => (value += 10)
}

function waitTool(name: string, onExecute: () => void): AgentTool<
  { project: z.infer<typeof projectSchema> },
  { ok: boolean }
> {
  return {
    name,
    description: '等待取消或超时的测试工具',
    inputSchema: z.object({ project: projectSchema }).strict(),
    outputSchema: z.object({ ok: z.boolean() }).strict(),
    execute: () => {
      onExecute()
      return new Promise<{ ok: boolean }>(() => undefined)
    },
  }
}

function countingTool(name: string, onExecute: () => void): AgentTool<
  { project: z.infer<typeof projectSchema> },
  { ok: boolean }
> {
  return {
    name,
    description: '记录调用次数的测试工具',
    inputSchema: z.object({ project: projectSchema }).strict(),
    outputSchema: z.object({ ok: z.boolean() }).strict(),
    execute: () => {
      onExecute()
      return { ok: true }
    },
  }
}

test('Runner 按计划执行工具、传递候选快照并写入完整 Trace', async () => {
  const registry = new AgentToolRegistry()
  registry.register(inspectProjectTool)
  registry.register(updateTrackTool)
  registry.register(validateProjectTool)
  const original = project()
  const originalSnapshot = structuredClone(original)
  const executionPlan = plan([
    {
      id: 'inspect',
      objective: '读取当前工程摘要。',
      toolName: 'inspect_project',
      arguments: {},
    },
    {
      id: 'update',
      objective: '把主旋律改成低音乐器。',
      toolName: 'update_track',
      arguments: {
        trackId: 'melody',
        update: { name: '低音旋律', instrument: 'Electric Bass', gain: 0.7 },
      },
    },
    {
      id: 'validate',
      objective: '验证候选工程。',
      toolName: 'validate_project',
      arguments: {},
    },
  ])

  const result = await executeAgentPlan(
    { run: run(), plan: executionPlan, project: original },
    { registry, now: tickingClock() },
  )

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.status, 'succeeded')
    assert.equal(result.run.status, 'validating')
    assert.equal(result.executedStepCount, 3)
    assert.equal(result.projectChangeCount, 1)
    assert.equal(result.candidateProject.tracks[0]?.name, '低音旋律')
    assert.equal(result.candidateProject.tracks[0]?.instrument, 'Electric Bass')
    assert.deepEqual(result.run.steps.map((step) => step.status), [
      'succeeded',
      'succeeded',
      'succeeded',
    ])
    assert.deepEqual(
      result.run.steps.map((step) => step.toolCalls[0]?.toolName),
      ['inspect_project', 'update_track', 'validate_project'],
    )
    assert.match(result.run.steps[1]?.toolCalls[0]?.inputSummary ?? '', /Electric Bass/)
    assert.doesNotMatch(result.run.steps[1]?.toolCalls[0]?.inputSummary ?? '', /"pitch"/)
    assert.match(result.run.steps[1]?.summary ?? '', /耗时 10ms/)
    assert.equal(agentRunSchema.safeParse(result.run).success, true)
  }
  assert.deepEqual(original, originalSnapshot)
})

test('工具失败后立即停止，返回可解释的部分候选快照和失败 Trace', async () => {
  let afterCalls = 0
  const registry = new AgentToolRegistry()
  registry.register(updateTrackTool)
  registry.register(countingTool('after_tool', () => afterCalls++))
  const executionPlan = plan([
    {
      id: 'update',
      objective: '先完成一个合法修改。',
      toolName: 'update_track',
      arguments: { trackId: 'melody', update: { name: '已修改旋律' } },
    },
    {
      id: 'missing',
      objective: '调用不存在的工具。',
      toolName: 'missing_tool',
      arguments: {},
    },
    {
      id: 'after',
      objective: '失败后不应再执行。',
      toolName: 'after_tool',
      arguments: {},
    },
  ])

  const result = await executeAgentPlan(
    { run: run(), plan: executionPlan, project: project() },
    { registry, now: tickingClock() },
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  if (!result.ok && result.status === 'failed') {
    assert.equal(result.error.code, 'unknown_tool')
    assert.equal(result.executedStepCount, 2)
    assert.equal(result.projectChangeCount, 1)
    assert.equal(result.candidateProject.tracks[0]?.name, '已修改旋律')
    assert.deepEqual(result.run.steps.map((step) => step.status), [
      'succeeded',
      'failed',
    ])
    assert.equal(result.run.status, 'failed')
  }
  assert.equal(afterCalls, 0)
})

test('业务拒绝会终止当前执行并保留稳定业务错误', async () => {
  const registry = new AgentToolRegistry()
  registry.register(removeTrackTool)
  const result = await executeAgentPlan(
    {
      run: run(),
      project: project(),
      plan: plan([{
        id: 'remove-last',
        objective: '尝试删除最后一条轨道。',
        toolName: 'remove_track',
        arguments: { trackId: 'melody' },
      }]),
    },
    { registry, now: tickingClock() },
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  if (!result.ok && result.status === 'failed') {
    assert.equal(result.error.code, 'last_track_removal_forbidden')
    assert.equal(result.error.retryable, false)
    assert.match(result.run.steps[0]?.summary ?? '', /last_track_removal_forbidden/)
  }
})

test('步骤预算不足时不启动任何工具', async () => {
  let calls = 0
  const registry = new AgentToolRegistry()
  registry.register(countingTool('first_tool', () => calls++))
  registry.register(countingTool('second_tool', () => calls++))
  const result = await executeAgentPlan(
    {
      run: run(),
      project: project(),
      maxSteps: 1,
      plan: plan([
        { id: 'first', objective: '第一步。', toolName: 'first_tool', arguments: {} },
        { id: 'second', objective: '第二步。', toolName: 'second_tool', arguments: {} },
      ]),
    },
    { registry, now: tickingClock() },
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  if (!result.ok && result.status === 'failed') {
    assert.equal(result.error.code, 'step_budget_exceeded')
    assert.equal(result.executedStepCount, 0)
    assert.equal(result.run.steps.length, 0)
  }
  assert.equal(calls, 0)
})

test('执行前已经取消时不启动工具，并把 Run 转入 canceled', async () => {
  let calls = 0
  const registry = new AgentToolRegistry()
  registry.register(countingTool('never_called', () => calls++))
  const controller = new AbortController()
  controller.abort()

  const result = await executeAgentPlan(
    {
      run: run(),
      project: project(),
      signal: controller.signal,
      plan: plan([{
        id: 'never',
        objective: '不应执行。',
        toolName: 'never_called',
        arguments: {},
      }]),
    },
    { registry, now: tickingClock() },
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, 'canceled')
  if (!result.ok && result.status === 'canceled') {
    assert.equal(result.error.code, 'runner_canceled')
    assert.equal(result.run.status, 'canceled')
    assert.equal(result.executedStepCount, 0)
  }
  assert.equal(calls, 0)
})

test('执行中取消会中止当前工具，且不再启动下一工具', async () => {
  let slowCalls = 0
  let nextCalls = 0
  const registry = new AgentToolRegistry()
  registry.register(waitTool('slow_tool', () => slowCalls++))
  registry.register(countingTool('next_tool', () => nextCalls++))
  const controller = new AbortController()
  const execution = executeAgentPlan(
    {
      run: run(),
      project: project(),
      signal: controller.signal,
      timeoutMs: 1_000,
      plan: plan([
        { id: 'slow', objective: '等待中的工具。', toolName: 'slow_tool', arguments: {} },
        { id: 'next', objective: '不应执行。', toolName: 'next_tool', arguments: {} },
      ]),
    },
    { registry, now: tickingClock() },
  )
  setTimeout(() => controller.abort(), 10)

  const result = await execution

  assert.equal(result.ok, false)
  assert.equal(result.status, 'canceled')
  if (!result.ok && result.status === 'canceled') {
    assert.equal(result.error.code, 'runner_canceled')
    assert.equal(result.executedStepCount, 1)
    assert.equal(result.run.steps[0]?.status, 'canceled')
  }
  assert.equal(slowCalls, 1)
  assert.equal(nextCalls, 0)
})

test('总超时会中止当前工具并返回 runner_timeout', async () => {
  let calls = 0
  const registry = new AgentToolRegistry()
  registry.register(waitTool('timeout_tool', () => calls++))

  const result = await executeAgentPlan(
    {
      run: run(),
      project: project(),
      timeoutMs: 10,
      plan: plan([{
        id: 'timeout',
        objective: '模拟超时。',
        toolName: 'timeout_tool',
        arguments: {},
      }]),
    },
    { registry, now: tickingClock() },
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  if (!result.ok && result.status === 'failed') {
    assert.equal(result.error.code, 'runner_timeout')
    assert.equal(result.error.retryable, true)
    assert.equal(result.run.status, 'failed')
    assert.equal(result.run.steps[0]?.status, 'failed')
  }
  assert.equal(calls, 1)
})

test('Runner 拒绝非 executing 状态，不执行计划', async () => {
  let calls = 0
  const registry = new AgentToolRegistry()
  registry.register(countingTool('never_called', () => calls++))
  const result = await executeAgentPlan(
    {
      run: run('planning'),
      project: project(),
      plan: plan([{
        id: 'never',
        objective: '不应执行。',
        toolName: 'never_called',
        arguments: {},
      }]),
    },
    { registry },
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, 'rejected')
  if (!result.ok) assert.equal(result.error.code, 'invalid_runner_state')
  assert.equal(calls, 0)
})
