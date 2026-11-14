import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AGENT_EVAL_CASES } from './cases.ts'
import {
  runAgentEvalCase,
  runAgentEvalSuite,
  summarizeAgentEvalResults,
  type AgentEvalCaseResult,
} from './runner.ts'

test('固定离线 Runner 执行全部 20 个案例且不产生付费调用', async () => {
  const first = await runAgentEvalSuite()
  const second = await runAgentEvalSuite()

  assert.deepEqual(first, second)
  assert.equal(first.cases.length, 20)
  assert.equal(first.summary.passedCases, 20)
  assert.equal(first.summary.failedCases, 0)
  assert.equal(first.summary.successRate, 1)
  assert.equal(first.summary.constraintSatisfactionRate, 1)
  assert.equal(first.summary.toolSuccessRate, 1)
  assert.equal(first.summary.exportabilityRate, 1)
  assert.equal(first.summary.paidCallCount, 0)
  assert.equal(first.summary.estimatedCostUsd, 0)
})

test('候选任务经过真实工具与断言判分，且保留一次自动修订样本', async () => {
  const report = await runAgentEvalSuite()
  const candidates = report.cases.filter((item) => item.expectedOutcome === 'candidate')
  const revised = report.cases.find((item) => item.caseId === 'modify-02-change-instrument')

  assert.equal(candidates.length, 15)
  assert.equal(candidates.every((item) => item.observedStatus === 'awaiting_approval'), true)
  assert.equal(candidates.every((item) => item.assertionResults.every((assertion) => assertion.passed)), true)
  assert.equal(revised?.revisionCount, 1)
  assert.equal(report.summary.totalRevisions, 1)
  assert.equal(report.summary.firstPassCompletionRate, .9333)
  assert.equal(report.summary.revisionSuccessRate, 1)
})

test('冲突与恶意输入安全失败，不调用工具、不泄漏敏感输出', async () => {
  const rejectedCases = AGENT_EVAL_CASES.filter((item) => item.expected.outcome === 'safe_rejection')
  const results = await Promise.all(rejectedCases.map((item, index) => runAgentEvalCase(item, index)))

  assert.equal(results.length, 5)
  assert.equal(results.every((item) => item.passed), true)
  assert.equal(results.every((item) => item.observedStatus === 'failed'), true)
  assert.equal(results.every((item) => item.toolCalls.length === 0), true)
  assert.deepEqual(
    results.filter((item) => item.category === 'adversarial')
      .flatMap((item) => item.assertionResults)
      .filter((item) => item.type === 'no_sensitive_output')
      .map((item) => item.passed),
    [true, true],
  )
})

test('汇总按失败分布排序并保留失败案例类型', () => {
  const base = (id: string, failureTypes: readonly string[]): AgentEvalCaseResult => ({
    caseId: id,
    title: id,
    category: 'modification',
    passed: failureTypes.length === 0,
    expectedOutcome: 'candidate',
    observedStatus: 'failed',
    assertionResults: [{ type: 'run_status', passed: false, message: '失败' }],
    toolCalls: [{ name: 'update_track', status: 'failed' }],
    stepCount: 1,
    successfulToolCallCount: 0,
    revisionCount: 0,
    durationMs: 10,
    exportable: false,
    paidCallCount: 0,
    estimatedCostUsd: 0,
    failureTypes,
  })
  const summary = summarizeAgentEvalResults([
    base('one', ['assertion:run_status']),
    base('two', ['assertion:run_status', 'status:failed']),
    base('three', ['status:failed']),
  ])

  assert.equal(summary.mostCommonFailureType, 'assertion:run_status')
  assert.deepEqual(summary.failureTypeCounts, {
    'assertion:run_status': 2,
    'status:failed': 2,
  })
})
