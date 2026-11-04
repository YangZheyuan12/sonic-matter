import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import {
  AgentToolRegistrationError,
  AgentToolRegistry,
  type AgentTool,
  type AgentToolExecutionResult,
} from './toolRegistry.ts'

const addTool = (
  execute: AgentTool<{ left: number; right: number }, { total: number }>['execute'] =
    ({ left, right }) => ({ total: left + right }),
): AgentTool<{ left: number; right: number }, { total: number }> => ({
  name: 'add_numbers',
  description: '将两个数相加',
  inputSchema: z
    .object({ left: z.coerce.number(), right: z.coerce.number() })
    .strict(),
  outputSchema: z.object({ total: z.number() }).strict(),
  execute,
})

function assertFailure(
  result: AgentToolExecutionResult,
): asserts result is Extract<AgentToolExecutionResult, { ok: false }> {
  assert.equal(result.ok, false)
}

test('注册表可以查询和列出工具元数据', () => {
  const registry = new AgentToolRegistry()
  registry.register(addTool())

  const metadata = registry.get('add_numbers')

  assert.equal(metadata?.name, 'add_numbers')
  assert.equal(metadata?.description, '将两个数相加')
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ['add_numbers'],
  )
  assert.equal(registry.get('missing_tool'), undefined)
})

test('拒绝非法工具名和重复工具名', () => {
  const registry = new AgentToolRegistry()
  registry.register(addTool())

  assert.throws(
    () => registry.register(addTool()),
    (error: unknown) =>
      error instanceof AgentToolRegistrationError &&
      error.code === 'duplicate_tool_name',
  )
  assert.throws(
    () => registry.register({ ...addTool(), name: 'Add Numbers' }),
    (error: unknown) =>
      error instanceof AgentToolRegistrationError &&
      error.code === 'invalid_tool_name',
  )
  assert.equal(registry.list().length, 1)
})

test('未注册工具无法执行', async () => {
  const result = await new AgentToolRegistry().execute('delete_project', {})

  assertFailure(result)
  assert.deepEqual(result, {
    ok: false,
    toolName: 'delete_project',
    error: {
      code: 'unknown_tool',
      message: '工具 delete_project 未注册，无法执行。',
      retryable: false,
    },
  })
})

test('参数只有通过 Schema 后才会进入执行函数', async () => {
  let executionCount = 0
  const registry = new AgentToolRegistry()
  registry.register(
    addTool(({ left, right }) => {
      executionCount += 1
      return { total: left + right }
    }),
  )

  const invalidResult = await registry.execute('add_numbers', {
    left: 1,
    right: 2,
    unexpected: true,
  })

  assertFailure(invalidResult)
  assert.equal(invalidResult.error.code, 'invalid_tool_input')
  assert.equal(invalidResult.error.issues?.[0]?.path[0], 'unexpected')
  assert.equal(executionCount, 0)

  const validResult = await registry.execute('add_numbers', {
    left: '2',
    right: 3,
  })

  assert.equal(validResult.ok, true)
  assert.equal(executionCount, 1)
  if (validResult.ok) {
    assert.deepEqual(validResult.output, { total: 5 })
  }
})

test('返回值也必须通过输出 Schema', async () => {
  const registry = new AgentToolRegistry()
  const invalidOutputTool: AgentTool<{ value: number }, { doubled: number }> = {
    name: 'double_number',
    description: '将数字加倍',
    inputSchema: z.object({ value: z.number() }).strict(),
    outputSchema: z.object({ doubled: z.number() }).strict(),
    execute: () => ({ doubled: Number.NaN }),
  }
  registry.register(invalidOutputTool)

  const result = await registry.execute('double_number', { value: 2 })

  assertFailure(result)
  assert.equal(result.error.code, 'invalid_tool_output')
  assert.equal(result.error.retryable, false)
  assert.deepEqual(result.error.issues?.[0]?.path, ['doubled'])
})

test('执行异常会转换为统一的可重试错误且不泄露内部信息', async () => {
  const registry = new AgentToolRegistry()
  registry.register(
    addTool(() => {
      throw new Error('database-password=secret')
    }),
  )

  const result = await registry.execute('add_numbers', { left: 1, right: 2 })

  assertFailure(result)
  assert.deepEqual(result.error, {
    code: 'tool_execution_failed',
    message: '工具 add_numbers 执行失败。',
    retryable: true,
  })
  assert.equal(result.error.message.includes('secret'), false)
})

test('执行前已取消时不会调用工具', async () => {
  let executed = false
  const registry = new AgentToolRegistry()
  registry.register(
    addTool(() => {
      executed = true
      return { total: 0 }
    }),
  )
  const controller = new AbortController()
  controller.abort()

  const result = await registry.execute(
    'add_numbers',
    { left: 1, right: 2 },
    { signal: controller.signal },
  )

  assertFailure(result)
  assert.equal(result.error.code, 'tool_execution_canceled')
  assert.equal(result.error.retryable, false)
  assert.equal(executed, false)
})

test('执行中取消时返回统一的取消错误', async () => {
  const registry = new AgentToolRegistry()
  registry.register(
    addTool(
      () =>
        new Promise(() => {
          // 用永不完成的假工具验证 Registry 本身的取消竞速。
        }),
    ),
  )
  const controller = new AbortController()

  const execution = registry.execute(
    'add_numbers',
    { left: 1, right: 2 },
    { signal: controller.signal },
  )
  controller.abort()
  const result = await execution

  assertFailure(result)
  assert.deepEqual(result.error, {
    code: 'tool_execution_canceled',
    message: '工具 add_numbers 的执行已取消。',
    retryable: false,
  })
})
