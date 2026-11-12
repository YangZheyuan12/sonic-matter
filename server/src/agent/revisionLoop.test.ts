import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { inspectProjectTool } from './inspectProjectTool.ts'
import { agentPlanSchema, type AgentPlan } from './planner.ts'
import { executeWithRevisions } from './revisionLoop.ts'
import { AgentRunStore } from './runStore.ts'
import type { RevisionPlanner } from './revisionPlanner.ts'
import { AgentToolRegistry } from './toolRegistry.ts'
import { updateTrackTool } from './trackTools.ts'
import type { AgentRun } from './types.ts'

const project = () => ({
  title: '测试工程',
  tempo: 92,
  key: 'C Major',
  duration: 8,
  tracks: [{
    id: 'melody',
    name: '主旋律',
    kind: 'midi' as const,
    instrument: 'Felt Piano',
    color: '#7dd3fc',
    notes: [{ id: 'n1', pitch: 60, start: 0, duration: 0.5, velocity: 90 }],
  }],
})

const run = (): AgentRun => ({
  id: 'run-revision-1',
  status: 'executing',
  instruction: '把工程调整到满足验收条件。',
  createdAt: 1_000,
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
      userRequest: '把工程调整到满足验收条件。',
      desiredOutcome: '候选工程通过确定性验收。',
    },
    constraints: [{
      id: 'step-budget',
      description: '计划最多八步。',
      subject: 'runner.step_count',
      operator: 'less_than_or_equal',
      expected: 8,
    }],
    steps,
    acceptanceCriteria: [{
      id: 'constraints-pass',
      description: '所有确定性约束通过。',
      check: 'constraints_satisfied',
    }],
  })
}

const initialPlan = () => plan([{
  id: 'inspect',
  objective: '先检查当前工程。',
  toolName: 'inspect_project',
  arguments: {},
}])

function tickingClock(start = 1_000) {
  let value = start
  return () => (value += 10)
}

function tempStore(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sonic-revision-loop-'))
  const store = new AgentRunStore(dir)
  store.create(run())
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

test('验收失败后生成最小修订计划，修复必需乐器并再次验收', async (t) => {
  const store = tempStore(t)
  const registry = new AgentToolRegistry()
  registry.register(inspectProjectTool)
  registry.register(updateTrackTool)

  const result = await executeWithRevisions(
    {
      run: run(),
      initialPlan: initialPlan(),
      project: project(),
      constraints: [{
        id: 'need-cello',
        type: 'required_instrument',
        instrument: 'Cello',
      }],
    },
    { registry, store, now: tickingClock() },
  )

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.status, 'awaiting_approval')
  assert.equal(result.run.status, 'awaiting_approval')
  assert.equal(result.revisionCount, 1)
  assert.equal(result.candidateProject.tracks[0]?.instrument, 'Cello')
  assert.deepEqual(result.rounds.map((round) => round.report?.passed), [false, true])
  assert.deepEqual(
    result.run.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
    ['inspect_project', 'update_track'],
  )

  const stored = store.get(result.run.id)
  assert.deepEqual(stored, result.run)
  assert.deepEqual(
    stored?.steps.filter((step) => step.kind === 'validation').map((step) => step.status),
    ['failed', 'succeeded'],
  )
  assert.equal(stored?.steps.some((step) => step.kind === 'revision'), true)
})

test('无法修复的约束明确进入 failed，不伪装成成功', async (t) => {
  const store = tempStore(t)
  const registry = new AgentToolRegistry()
  registry.register(inspectProjectTool)

  const result = await executeWithRevisions(
    {
      run: run(),
      initialPlan: initialPlan(),
      project: project(),
      constraints: [{
        id: 'too-short',
        type: 'duration_range',
        maxSeconds: 4,
      }],
    },
    { registry, store, now: tickingClock() },
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  if (!result.ok && result.status === 'failed') {
    assert.equal(result.error.code, 'revision_planning_failed')
    assert.equal(result.run.status, 'failed')
    assert.deepEqual(result.rounds[0]?.report?.failedRuleIds, ['too-short'])
    assert.equal(store.get(result.run.id)?.status, 'failed')
  }
})

test('两轮修订后仍未通过时以 revision_limit_reached 终止', async (t) => {
  const store = tempStore(t)
  const registry = new AgentToolRegistry()
  registry.register(inspectProjectTool)
  registry.register(updateTrackTool)
  let plannerCalls = 0
  const ineffectivePlanner: RevisionPlanner = async (input) => {
    plannerCalls += 1
    return {
      ok: true,
      source: 'local',
      plan: plan([{
        id: `rename-${plannerCalls}`,
        objective: '执行一次不能修复乐器约束的重命名。',
        toolName: 'update_track',
        arguments: {
          trackId: 'melody',
          update: { name: `未生效修订 ${input.previousPlans.length}` },
        },
      }]),
    }
  }

  const result = await executeWithRevisions(
    {
      run: run(),
      initialPlan: initialPlan(),
      project: project(),
      constraints: [{
        id: 'need-cello',
        type: 'required_instrument',
        instrument: 'Cello',
      }],
    },
    {
      registry,
      store,
      planRevision: ineffectivePlanner,
      now: tickingClock(),
    },
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  if (!result.ok && result.status === 'failed') {
    assert.equal(result.error.code, 'revision_limit_reached')
    assert.equal(result.revisionCount, 2)
    assert.equal(result.rounds.length, 3)
    assert.equal(result.rounds.every((round) => round.report?.passed === false), true)
    assert.equal(result.run.status, 'failed')
  }
  assert.equal(plannerCalls, 2)
})

test('修订工具失败会保留失败 Tool Call 并立即终止', async (t) => {
  const store = tempStore(t)
  const registry = new AgentToolRegistry()
  registry.register(inspectProjectTool)
  const failingPlanner: RevisionPlanner = async () => ({
    ok: true,
    source: 'model',
    plan: plan([{
      id: 'missing-tool-step',
      objective: '调用未注册工具以模拟修订执行失败。',
      toolName: 'missing_revision_tool',
      arguments: {},
    }]),
  })

  const result = await executeWithRevisions(
    {
      run: run(),
      initialPlan: initialPlan(),
      project: project(),
      constraints: [{
        id: 'need-cello',
        type: 'required_instrument',
        instrument: 'Cello',
      }],
    },
    { registry, store, planRevision: failingPlanner, now: tickingClock() },
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  if (!result.ok && result.status === 'failed') {
    assert.equal(result.error.code, 'unknown_tool')
    assert.equal(result.run.status, 'failed')
    assert.equal(result.rounds.length, 2)
    assert.equal(result.rounds[1]?.report, undefined)
    const failedCall = result.run.steps
      .flatMap((step) => step.toolCalls)
      .find((call) => call.toolName === 'missing_revision_tool')
    assert.equal(failedCall?.status, 'failed')
  }
})

test('修订计划中的已成功无关步骤会被过滤，不重复执行', async (t) => {
  const store = tempStore(t)
  const registry = new AgentToolRegistry()
  registry.register(inspectProjectTool)
  registry.register(updateTrackTool)
  let receivedFailedIds: readonly string[] = []
  const repeatingPlanner: RevisionPlanner = async (input) => {
    receivedFailedIds = input.report.failedRuleIds
    return {
      ok: true,
      source: 'model',
      plan: plan([
        {
          id: 'inspect-again',
          objective: '重复检查工程。',
          toolName: 'inspect_project',
          arguments: {},
        },
        {
          id: 'fix-cello',
          objective: '补上缺少的大提琴。',
          toolName: 'update_track',
          arguments: { trackId: 'melody', update: { instrument: 'Cello' } },
        },
      ]),
    }
  }

  const result = await executeWithRevisions(
    {
      run: run(),
      initialPlan: initialPlan(),
      project: project(),
      constraints: [{
        id: 'need-cello',
        type: 'required_instrument',
        instrument: 'Cello',
      }],
    },
    { registry, store, planRevision: repeatingPlanner, now: tickingClock() },
  )

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(receivedFailedIds, ['need-cello'])
  const toolNames = result.run.steps.flatMap(
    (step) => step.toolCalls.map((call) => call.toolName),
  )
  assert.equal(toolNames.filter((name) => name === 'inspect_project').length, 1)
  assert.equal(toolNames.filter((name) => name === 'update_track').length, 1)
  assert.deepEqual(result.rounds[1]?.plan.steps.map((step) => step.toolName), ['update_track'])
})
