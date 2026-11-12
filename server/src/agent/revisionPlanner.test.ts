import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluateProject, type EvaluationConstraint } from './evaluator.ts'
import { agentPlanSchema, type AgentPlan, type PlannerModelRequest } from './planner.ts'
import { createRevisionPlan } from './revisionPlanner.ts'
import { AgentToolRegistry } from './toolRegistry.ts'
import { updateTrackTool } from './trackTools.ts'

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
    notes: [],
  }],
})

const previousPlan = (): AgentPlan => agentPlanSchema.parse({
  goal: {
    userRequest: '修复工程。',
    desiredOutcome: '工程通过验收。',
  },
  constraints: [{
    id: 'budget',
    description: '最多八步。',
    subject: 'runner.step_count',
    operator: 'less_than_or_equal',
    expected: 8,
  }],
  steps: [{
    id: 'inspect',
    objective: '检查工程。',
    toolName: 'update_track',
    arguments: { trackId: 'melody', update: { name: '主旋律' } },
  }],
  acceptanceCriteria: [{
    id: 'pass',
    description: '约束通过。',
    check: 'constraints_satisfied',
  }],
})

function failedReport(constraints: readonly EvaluationConstraint[]) {
  const result = evaluateProject({ project: project(), constraints })
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('测试验收报告生成失败')
  assert.equal(result.report.passed, false)
  return result.report
}

test('本地 Revision Planner 根据失败报告生成最小乐器修订', async () => {
  const registry = new AgentToolRegistry()
  registry.register(updateTrackTool)
  const constraints: EvaluationConstraint[] = [{
    id: 'need-cello',
    type: 'required_instrument',
    instrument: 'Cello',
  }]

  const result = await createRevisionPlan(
    {
      instruction: '修复工程。',
      project: project(),
      constraints,
      report: failedReport(constraints),
      previousPlans: [previousPlan()],
    },
    { registry },
  )

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, 'local')
    assert.deepEqual(result.plan.steps.map((step) => step.toolName), ['update_track'])
    assert.deepEqual(result.plan.steps[0]?.arguments, {
      trackId: 'melody',
      update: { instrument: 'Cello' },
    })
  }
})

test('本地无法修复时把结构化失败报告和历史计划交给模型', async () => {
  const registry = new AgentToolRegistry()
  registry.register(updateTrackTool)
  const constraints: EvaluationConstraint[] = [{
    id: 'duration-too-long',
    type: 'duration_range',
    maxSeconds: 4,
  }]
  let received: PlannerModelRequest | undefined
  const model = {
    async generateStructured(request: PlannerModelRequest) {
      received = request
      return {
        goal: {
          userRequest: '修复工程。',
          desiredOutcome: '尝试修复未通过的时长约束。',
        },
        constraints: [{
          id: 'failed-only',
          description: '只处理失败规则。',
          subject: 'runner.tool_names',
          operator: 'includes',
          expected: ['update_track'],
        }],
        steps: [{
          id: 'model-revision',
          objective: '生成模型修订步骤。',
          toolName: 'update_track',
          argumentsJson: JSON.stringify({
            trackId: 'melody',
            update: { name: '模型修订' },
          }),
        }],
        acceptanceCriteria: [{
          id: 'recheck',
          description: '重新执行确定性验收。',
          check: 'constraints_satisfied',
        }],
      }
    },
  }

  const result = await createRevisionPlan(
    {
      instruction: '修复工程。',
      project: project(),
      constraints,
      report: failedReport(constraints),
      previousPlans: [previousPlan()],
    },
    { registry, model },
  )

  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.source, 'model')
  assert.equal(received?.outputName, 'agent_plan')
  const prompt = JSON.parse(received?.userPrompt ?? '{}') as {
    failedRuleIds?: string[]
    failedRules?: unknown[]
    previousSuccessfulPlans?: unknown[]
  }
  assert.deepEqual(prompt.failedRuleIds, ['duration-too-long'])
  assert.equal(prompt.failedRules?.length, 1)
  assert.equal(prompt.previousSuccessfulPlans?.length, 1)
})

test('已通过报告不生成修订，模型异常返回稳定错误', async () => {
  const registry = new AgentToolRegistry()
  registry.register(updateTrackTool)
  const passedConstraints: EvaluationConstraint[] = [{
    id: 'duration-ok',
    type: 'duration_range',
    minSeconds: 8,
    maxSeconds: 8,
  }]
  const evaluation = evaluateProject({ project: project(), constraints: passedConstraints })
  assert.equal(evaluation.ok, true)
  if (!evaluation.ok) return

  const unnecessary = await createRevisionPlan(
    {
      instruction: '修复工程。',
      project: project(),
      constraints: passedConstraints,
      report: evaluation.report,
      previousPlans: [previousPlan()],
    },
    { registry },
  )
  assert.equal(unnecessary.ok, false)
  if (!unnecessary.ok) assert.equal(unnecessary.error.code, 'no_failed_constraints')

  const failedConstraints: EvaluationConstraint[] = [{
    id: 'duration-fail',
    type: 'duration_range',
    maxSeconds: 4,
  }]
  const modelFailure = await createRevisionPlan(
    {
      instruction: '修复工程。',
      project: project(),
      constraints: failedConstraints,
      report: failedReport(failedConstraints),
      previousPlans: [previousPlan()],
    },
    {
      registry,
      model: { generateStructured: async () => { throw new Error('provider failed') } },
    },
  )
  assert.equal(modelFailure.ok, false)
  if (!modelFailure.ok) assert.equal(modelFailure.error.code, 'revision_model_failed')
})
