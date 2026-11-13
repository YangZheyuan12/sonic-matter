import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Project } from '../project/model.ts'
import {
  cancelAgentRun,
  canCancelRun,
  constraintText,
  createAgentRun,
  elapsedText,
  getAgentRun,
  pollAgentRun,
  safeTraceText,
  shouldPollRun,
  traceSummary,
  type AgentRunResource,
  type AgentRunStatus,
} from './run.ts'

const project = { id: 'project-1', name: '测试工程' } as unknown as Project

const resource = (status: AgentRunStatus): AgentRunResource => ({
  run: {
    id: 'run / 1',
    status,
    instruction: '增加鼓点',
    createdAt: 1,
    updatedAt: 2,
    steps: [],
  },
  constraints: [],
})

test('Run API 使用统一客户端、保护头和编码后的资源地址', async () => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(resource('planning')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    await createAgentRun({
      instruction: '增加鼓点',
      project,
      constraints: [{ id: 'duration', type: 'duration_range', minSeconds: 1, maxSeconds: 120 }],
    })
    await getAgentRun('run / 1')
    await cancelAgentRun('run / 1')

    assert.deepEqual(calls.map(call => [call.url, call.init.method]), [
      ['/api/agent/runs', 'POST'],
      ['/api/agent/runs/run%20%2F%201', 'GET'],
      ['/api/agent/runs/run%20%2F%201/cancel', 'POST'],
    ])
    assert.equal(new Headers(calls[0].init.headers).get('X-Sonic-Auth'), '1')
    assert.equal(new Headers(calls[2].init.headers).get('X-Sonic-Auth'), '1')
    assert.equal(JSON.parse(String(calls[0].init.body)).instruction, '增加鼓点')
  } finally {
    globalThis.fetch = original
  }
})

test('轮询持续同步活动状态，并在等待审批时停止', async () => {
  const statuses: AgentRunStatus[] = ['planning', 'executing', 'awaiting_approval']
  const updates: AgentRunStatus[] = []
  let requestCount = 0
  const result = await pollAgentRun('run-1', {
    signal: new AbortController().signal,
    intervalMs: 0,
    request: async () => resource(statuses[requestCount++] ?? 'failed'),
    onUpdate: next => updates.push(next.run.status),
  })

  assert.equal(result?.run.status, 'awaiting_approval')
  assert.deepEqual(updates, statuses)
  assert.equal(requestCount, 3)
})

test('取消信号会清除轮询等待，不再发起无意义请求', async () => {
  const controller = new AbortController()
  let requestCount = 0
  const pending = pollAgentRun('run-1', {
    signal: controller.signal,
    intervalMs: 10_000,
    request: async () => {
      requestCount += 1
      return resource('executing')
    },
  })
  setTimeout(() => controller.abort(), 10)

  assert.equal(await pending, null)
  assert.equal(requestCount, 1)
})

test('运行态决定轮询与取消按钮，终态不会继续轮询', () => {
  assert.equal(shouldPollRun('planning'), true)
  assert.equal(shouldPollRun('revising'), true)
  assert.equal(canCancelRun('awaiting_approval'), true)
  assert.equal(shouldPollRun('completed'), false)
  assert.equal(canCancelRun('failed'), false)
  assert.equal(canCancelRun('canceled'), false)
})

test('Trace 文本会二次脱敏、压缩空白并限制展示长度', () => {
  const raw = '{"apiKey":"sk-secret","prompt":"完整提示词","result":"安全结果"} Authorization=Bearer-secret Bearer leaked-token'
  const safe = safeTraceText(raw, 70)
  assert.doesNotMatch(safe, /sk-secret|完整提示词|Bearer-secret|leaked-token/)
  assert.match(safe, /\*\*\*/)
  assert.ok(safe.length <= 70)
})

test('Trace 把计划、验收、约束和耗时转换为用户可读摘要', () => {
  assert.equal(
    traceSummary(JSON.stringify({ round: 0, steps: [{ toolName: 'add_notes' }, { toolName: 'set_tempo' }] })),
    '第 1 轮计划包含 2 个工具步骤：add_notes、set_tempo。',
  )
  assert.equal(
    traceSummary(JSON.stringify({ passed: false, failedRuleIds: ['duration', 'track-count'] })),
    '未通过规则：duration、track-count。',
  )
  assert.equal(
    constraintText({ id: 'tracks', type: 'track_count', min: 1, max: 32 }),
    '轨道数量：1–32 条',
  )
  assert.equal(elapsedText(1_000, 2_250), '1.3s')
  assert.equal(elapsedText(1_000), '进行中')
})
