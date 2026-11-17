import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  AGENT_EVAL_README_END,
  AGENT_EVAL_README_START,
} from './evals/report.ts'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(currentDir, '../../..')

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8')
}

test('README 首屏说明 Agent 目标、执行、评估和单 Agent 取舍', async () => {
  const readme = await readRepositoryFile('README.md')

  assert.match(readme, /Audio Director Agent/)
  assert.match(readme, /白名单工具/)
  assert.match(readme, /确定性评估器/)
  assert.match(readme, /为什么不使用多 Agent|当前不使用多 Agent/)
  assert.equal(readme.split(AGENT_EVAL_README_START).length, 2)
  assert.equal(readme.split(AGENT_EVAL_README_END).length, 2)
  assert.match(readme, /npm run eval:agent/)
})

test('README 自动指标与机器可读 Eval 基线一致', async () => {
  const [readme, baselineSource] = await Promise.all([
    readRepositoryFile('README.md'),
    readRepositoryFile('server/src/agent/evals/reports/baseline.json'),
  ])
  const baseline = JSON.parse(baselineSource) as {
    summary: {
      passedCases: number
      totalCases: number
      successRate: number
      firstPassCompletionRate: number
      paidCallCount: number
    }
  }
  const { summary } = baseline

  assert.match(readme, new RegExp(`\\| 案例通过 \\| ${summary.passedCases}/${summary.totalCases} \\|`))
  assert.match(readme, new RegExp(`\\| 总成功率 \\| ${(summary.successRate * 100).toFixed(2)}% \\|`))
  assert.match(readme, new RegExp(`\\| 一次完成率 \\| ${(summary.firstPassCompletionRate * 100).toFixed(2)}% \\|`))
  assert.match(readme, new RegExp(`真实付费调用 / 估算成本 \\| ${summary.paidCallCount} /`))
  assert.match(readme, /server\/src\/agent\/evals\/reports\/baseline\.json/)
})

test('架构、案例和演示文档包含第 19 天要求的可复现证据', async () => {
  const [architecture, cases, demo] = await Promise.all([
    readRepositoryFile('docs/agent/architecture.md'),
    readRepositoryFile('docs/agent/cases.md'),
    readRepositoryFile('docs/agent/demo-script.md'),
  ])

  assert.match(architecture, /```mermaid\nflowchart/)
  assert.match(architecture, /```mermaid\nstateDiagram-v2/)
  for (const status of ['planning', 'executing', 'validating', 'revising', 'awaiting_approval', 'completed', 'failed', 'canceled']) {
    assert.match(architecture, new RegExp(`\\b${status}\\b`))
  }
  assert.match(architecture, /为什么不使用多 Agent/)

  assert.match(cases, /create-01-cello-track/)
  assert.match(cases, /modify-02-change-instrument/)
  assert.match(cases, /adversarial-01-tool-injection/)
  assert.match(cases, /0 次工具调用/)
  assert.match(cases, /baseline\.json/)

  assert.match(demo, /2–3 分钟/)
  assert.match(demo, /0:00–0:20/)
  assert.match(demo, /2:20–2:40/)
  assert.match(demo, /npm run eval:agent/)
})
