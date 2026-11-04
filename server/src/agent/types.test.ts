import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  agentRunSchema,
  agentRunStatusSchema,
  agentSchemaLimits,
  agentToolCallSchema,
} from './types.ts'

const validToolCall = () => ({
  id: 'call-1',
  toolName: 'apply_operation',
  status: 'succeeded' as const,
  inputSummary: '把主旋律整体升高一个八度',
  outputSummary: '已修改 8 个音符',
  startedAt: 1_100,
  finishedAt: 1_200,
})

const validStep = () => ({
  id: 'step-1',
  kind: 'tool' as const,
  status: 'succeeded' as const,
  title: '修改主旋律',
  summary: '主旋律的 8 个音符均已升高一个八度',
  toolCalls: [validToolCall()],
  startedAt: 1_050,
  finishedAt: 1_250,
})

const validRun = () => ({
  id: 'run-1',
  status: 'completed' as const,
  instruction: '把主旋律整体升高一个八度',
  createdAt: 1_000,
  updatedAt: 1_300,
  steps: [validStep()],
  summary: '修改已完成并通过校验',
})

test('接受结构完整的 AgentRun', () => {
  const result = agentRunSchema.safeParse(validRun())

  assert.equal(result.success, true)
  if (result.success) {
    assert.equal(result.data.steps[0]?.toolCalls[0]?.status, 'succeeded')
  }
})

test('AgentRun 支持完整的生命周期状态', () => {
  const statuses = [
    'planning',
    'executing',
    'validating',
    'revising',
    'awaiting_approval',
    'completed',
    'failed',
    'canceled',
  ]

  for (const status of statuses) {
    assert.equal(agentRunStatusSchema.safeParse(status).success, true)
  }
  assert.equal(agentRunStatusSchema.safeParse('done').success, false)
})

test('拒绝缺少必填字段或字段格式错误的记录', () => {
  const { instruction: _instruction, ...withoutInstruction } = validRun()

  assert.equal(agentRunSchema.safeParse(withoutInstruction).success, false)
  assert.equal(
    agentRunSchema.safeParse({ ...validRun(), id: 'run id with spaces' }).success,
    false,
  )
  assert.equal(
    agentRunSchema.safeParse({ ...validRun(), createdAt: -1 }).success,
    false,
  )
})

test('限制指令、步骤和工具调用的最大数量', () => {
  assert.equal(
    agentRunSchema.safeParse({
      ...validRun(),
      instruction: 'a'.repeat(agentSchemaLimits.instructionLength + 1),
    }).success,
    false,
  )
  assert.equal(
    agentRunSchema.safeParse({
      ...validRun(),
      steps: Array.from({ length: agentSchemaLimits.stepsPerRun + 1 }, validStep),
    }).success,
    false,
  )
  assert.equal(
    agentRunSchema.safeParse({
      ...validRun(),
      steps: [
        {
          ...validStep(),
          toolCalls: Array.from(
            { length: agentSchemaLimits.toolCallsPerStep + 1 },
            validToolCall,
          ),
        },
      ],
    }).success,
    false,
  )
})

test('限制步骤和工具调用摘要长度', () => {
  assert.equal(
    agentRunSchema.safeParse({
      ...validRun(),
      steps: [
        {
          ...validStep(),
          summary: 'a'.repeat(agentSchemaLimits.stepSummaryLength + 1),
        },
      ],
    }).success,
    false,
  )
  assert.equal(
    agentToolCallSchema.safeParse({
      ...validToolCall(),
      outputSummary: 'a'.repeat(agentSchemaLimits.toolOutputSummaryLength + 1),
    }).success,
    false,
  )
})

test('拒绝 Run、Step 和 ToolCall 中的未知字段', () => {
  assert.equal(
    agentRunSchema.safeParse({ ...validRun(), unexpected: true }).success,
    false,
  )
  assert.equal(
    agentRunSchema.safeParse({
      ...validRun(),
      steps: [{ ...validStep(), unexpected: true }],
    }).success,
    false,
  )
  assert.equal(
    agentToolCallSchema.safeParse({ ...validToolCall(), unexpected: true })
      .success,
    false,
  )
})

test('ToolCall 按状态要求互斥的结果或错误字段', () => {
  const { outputSummary: _outputSummary, ...succeededWithoutOutput } =
    validToolCall()

  assert.equal(
    agentToolCallSchema.safeParse(succeededWithoutOutput).success,
    false,
  )
  assert.equal(
    agentToolCallSchema.safeParse({
      id: 'call-2',
      toolName: 'apply_operation',
      status: 'failed',
      inputSummary: '删除不存在的轨道',
      startedAt: 1_100,
      finishedAt: 1_200,
    }).success,
    false,
  )
  assert.equal(
    agentToolCallSchema.safeParse({
      id: 'call-3',
      toolName: 'apply_operation',
      status: 'pending',
      inputSummary: '等待执行',
      startedAt: 1_100,
    }).success,
    false,
  )
  assert.equal(
    agentToolCallSchema.safeParse({
      id: 'call-4',
      toolName: 'apply_operation',
      status: 'failed',
      inputSummary: '删除不存在的轨道',
      errorCode: 'track_not_found',
      errorMessage: '未找到目标轨道',
      startedAt: 1_100,
      finishedAt: 1_200,
    }).success,
    true,
  )
})

test('拒绝倒序的运行和执行时间', () => {
  assert.equal(
    agentRunSchema.safeParse({ ...validRun(), updatedAt: 999 }).success,
    false,
  )
  assert.equal(
    agentToolCallSchema.safeParse({
      ...validToolCall(),
      finishedAt: 1_099,
    }).success,
    false,
  )
  assert.equal(
    agentRunSchema.safeParse({
      ...validRun(),
      steps: [{ ...validStep(), finishedAt: 1_049 }],
    }).success,
    false,
  )
})
