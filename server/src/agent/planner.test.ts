import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import {
  MAX_PLAN_STEPS,
  agentPlanJsonSchema,
  agentPlanSchema,
  createAgentPlan,
  type AgentPlannerModel,
  type PlannerModelRequest,
} from './planner.ts'
import { AgentToolRegistry, type AgentTool } from './toolRegistry.ts'

function registryWithTools(
  names: readonly string[] = ['inspect_project', 'update_track', 'validate_project'],
  onExecute: () => void = () => undefined,
): AgentToolRegistry {
  const registry = new AgentToolRegistry()
  for (const name of names) {
    const tool: AgentTool<Record<string, unknown>, { ok: boolean }> = {
      name,
      description: `${name} 的测试工具`,
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.object({ ok: z.boolean() }).strict(),
      execute: () => {
        onExecute()
        return { ok: true }
      },
    }
    registry.register(tool)
  }
  return registry
}

function validPlan(
  instruction = '增加一条低音轨，但不要使用鼓组。',
  steps: unknown[] = [
    {
      id: 'step-1',
      objective: '检查当前工程摘要。',
      toolName: 'inspect_project',
      argumentsJson: '{}',
    },
    {
      id: 'step-2',
      objective: '修改目标轨道。',
      toolName: 'update_track',
      argumentsJson: JSON.stringify({ trackId: 'bass', update: { instrument: 'Bass' } }),
    },
    {
      id: 'step-3',
      objective: '验收候选工程。',
      toolName: 'validate_project',
      argumentsJson: '{}',
    },
  ],
) {
  return {
    goal: {
      userRequest: instruction,
      desiredOutcome: '工程包含低音轨，同时不包含鼓组音色。',
    },
    constraints: [
      {
        id: 'no-drums',
        description: '最终工程不能包含鼓组。',
        subject: 'project.instruments',
        operator: 'excludes',
        expected: ['drums'],
      },
      {
        id: 'step-budget',
        description: '计划不超过八步。',
        subject: 'runner.step_count',
        operator: 'less_than_or_equal',
        expected: MAX_PLAN_STEPS,
      },
    ],
    steps,
    acceptanceCriteria: [
      {
        id: 'constraints-pass',
        description: '所有结构化约束都满足。',
        check: 'constraints_satisfied',
      },
      {
        id: 'schema-pass',
        description: '候选工程通过 Project Schema。',
        check: 'project_schema_valid',
      },
    ],
  }
}

function modelReturning(
  output: unknown,
  onRequest: (request: PlannerModelRequest) => void = () => undefined,
): AgentPlannerModel {
  return {
    async generateStructured(request) {
      onRequest(request)
      return output
    },
  }
}

test('Planner 使用 Structured Output 请求生成目标、约束、步骤和验收条件', async () => {
  const instruction = '增加一条低音轨，但不要使用鼓组。'
  let capturedRequest: PlannerModelRequest | undefined
  let executionCount = 0
  const registry = registryWithTools(undefined, () => executionCount++)

  const result = await createAgentPlan(
    { instruction, agentKeyAvailable: true },
    {
      registry,
      model: modelReturning(JSON.stringify(validPlan(instruction)), (request) => {
        capturedRequest = request
      }),
    },
  )

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.source, 'model')
    assert.equal(result.plan.goal.userRequest, instruction)
    assert.equal(result.plan.constraints[0]?.subject, 'project.instruments')
    assert.deepEqual(result.plan.steps.map((step) => step.toolName), [
      'inspect_project',
      'update_track',
      'validate_project',
    ])
    assert.deepEqual(result.plan.steps[1]?.arguments, {
      trackId: 'bass',
      update: { instrument: 'Bass' },
    })
    assert.equal(result.plan.acceptanceCriteria[0]?.check, 'constraints_satisfied')
    assert.equal(agentPlanSchema.safeParse(result.plan).success, true)
  }

  assert.equal(executionCount, 0)
  assert.equal(capturedRequest?.outputName, 'agent_plan')
  assert.match(capturedRequest?.systemPrompt ?? '', /只负责生成计划，不执行工具/)
  assert.match(capturedRequest?.userPrompt ?? '', /update_track 的测试工具/)
  const serializedSchema = JSON.stringify(capturedRequest?.outputSchema)
  assert.match(serializedSchema, /inspect_project/)
  assert.match(serializedSchema, /validate_project/)
})

test('无 Agent Key 时返回固定本地计划，不调用模型或执行工具', async () => {
  let modelCalls = 0
  let toolCalls = 0
  const registry = registryWithTools(undefined, () => toolCalls++)
  const model = modelReturning(validPlan(), () => modelCalls++)

  const first = await createAgentPlan(
    { instruction: '离线检查工程', agentKeyAvailable: false },
    { registry, model },
  )
  const second = await createAgentPlan(
    { instruction: '离线检查工程', agentKeyAvailable: false },
    { registry, model },
  )

  assert.equal(first.ok, true)
  assert.deepEqual(second, first)
  if (first.ok) {
    assert.equal(first.source, 'local')
    assert.deepEqual(first.plan.steps.map((step) => step.toolName), [
      'inspect_project',
      'validate_project',
    ])
  }
  assert.equal(modelCalls, 0)
  assert.equal(toolCalls, 0)
})

test('Planner 拒绝非法 JSON，失败结果不携带可执行计划', async () => {
  const result = await createAgentPlan(
    { instruction: '检查工程', agentKeyAvailable: true },
    {
      registry: registryWithTools(),
      model: modelReturning('{"goal":'),
    },
  )

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'invalid_model_output',
      message: 'Planner 模型没有返回合法 JSON。',
    },
  })
  assert.equal('plan' in result, false)
})

test('Planner 在服务端再次拒绝模型计划中的未知工具', async () => {
  const instruction = '删除整个工程'
  const plan = validPlan(instruction, [
    {
      id: 'step-1',
      objective: '调用不存在且不允许的工具。',
      toolName: 'delete_project',
      argumentsJson: '{}',
    },
  ])
  const result = await createAgentPlan(
    { instruction, agentKeyAvailable: true },
    {
      registry: registryWithTools(),
      model: modelReturning(plan),
    },
  )

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'unknown_planned_tool')
    assert.deepEqual(result.error.issues?.[0]?.path, ['steps', 0, 'toolName'])
  }
  assert.equal('plan' in result, false)
})

test('Planner Schema 拒绝超过八步的超长计划', async () => {
  const instruction = '重复检查工程'
  const steps = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, index) => ({
    id: `step-${index + 1}`,
    objective: `第 ${index + 1} 次检查工程。`,
    toolName: 'inspect_project',
    argumentsJson: '{}',
  }))
  const result = await createAgentPlan(
    { instruction, agentKeyAvailable: true },
    {
      registry: registryWithTools(),
      model: modelReturning(validPlan(instruction, steps)),
    },
  )

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid_model_output')
    assert.ok(result.error.issues?.some((issue) => issue.path[0] === 'steps'))
  }
})

test('Planner 拒绝无法解码为对象的执行参数', async () => {
  const instruction = '检查工程'
  const result = await createAgentPlan(
    { instruction, agentKeyAvailable: true },
    {
      registry: registryWithTools(),
      model: modelReturning(validPlan(instruction, [
        {
          id: 'step-1',
          objective: '检查当前工程。',
          toolName: 'inspect_project',
          argumentsJson: '[]',
        },
      ])),
    },
  )

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'invalid_model_output')
})

test('Planner 保留用户原始目标，拒绝模型改写需求', async () => {
  const result = await createAgentPlan(
    { instruction: '只调整低音轨', agentKeyAvailable: true },
    {
      registry: registryWithTools(),
      model: modelReturning(validPlan('删除所有轨道')),
    },
  )

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid_model_output')
    assert.match(result.error.message, /不得改写用户原始要求/)
  }
})

test('Planner 缺少工具或模型适配器时返回稳定错误', async () => {
  const emptyRegistry = new AgentToolRegistry()
  const noTools = await createAgentPlan(
    { instruction: '检查工程', agentKeyAvailable: false },
    { registry: emptyRegistry },
  )
  const noModel = await createAgentPlan(
    { instruction: '检查工程', agentKeyAvailable: true },
    { registry: registryWithTools() },
  )

  assert.equal(noTools.ok, false)
  if (!noTools.ok) assert.equal(noTools.error.code, 'no_tools_registered')
  assert.equal(noModel.ok, false)
  if (!noModel.ok) assert.equal(noModel.error.code, 'model_unavailable')
})

test('动态 JSON Schema 只向模型开放注册工具并固定用户目标', () => {
  const schema = agentPlanJsonSchema('保持 20 秒以内', [
    'inspect_project',
    'validate_project',
  ])
  const serialized = JSON.stringify(schema)

  assert.match(serialized, /"const":"保持 20 秒以内"/)
  assert.match(serialized, /"enum":\["inspect_project","validate_project"\]/)
  assert.doesNotMatch(serialized, /delete_project/)
})
