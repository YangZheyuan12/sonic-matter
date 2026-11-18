import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MAX_PLAN_STEPS } from './planner.ts'
import { MAX_REVISION_ROUNDS } from './revisionLoop.ts'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(currentDir, '../../..')

async function repositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8')
}

test('最终验收报告与 Eval 基线、执行上限保持一致', async () => {
  const [acceptance, baselineSource] = await Promise.all([
    repositoryFile('docs/agent/final-acceptance.md'),
    repositoryFile('server/src/agent/evals/reports/baseline.json'),
  ])
  const baseline = JSON.parse(baselineSource) as {
    summary: {
      totalCases: number
      passedCases: number
      constraintSatisfactionRate: number
      toolSuccessRate: number
      firstPassCompletionRate: number
      revisionSuccessRate: number
      paidCallCount: number
    }
  }
  const { summary } = baseline

  assert.ok(summary.totalCases >= 20)
  assert.ok(summary.constraintSatisfactionRate >= 0.85)
  assert.match(acceptance, new RegExp(`\\| Eval 数量 \\| ≥ 20 \\| ${summary.totalCases} \\|`))
  assert.match(acceptance, new RegExp(`${summary.passedCases}/${summary.totalCases}`))
  assert.match(acceptance, new RegExp(`${(summary.constraintSatisfactionRate * 100).toFixed(2)}%`))
  assert.match(acceptance, new RegExp(`${(summary.toolSuccessRate * 100).toFixed(2)}%`))
  assert.match(acceptance, new RegExp(`${(summary.firstPassCompletionRate * 100).toFixed(2)}%`))
  assert.match(acceptance, new RegExp(`${(summary.revisionSuccessRate * 100).toFixed(2)}%`))
  assert.match(acceptance, new RegExp(`真实付费调用 \\| 0 \\| ${summary.paidCallCount} \\|`))
  assert.match(acceptance, new RegExp(`计划步数上限[\\s\\S]*${MAX_PLAN_STEPS} 步`))
  assert.match(acceptance, new RegExp(`自动修订上限[\\s\\S]*${MAX_REVISION_ROUNDS} 轮`))
})

test('最终交付包含三条人工复核路径、面试薄弱点和可播放 WebM', async () => {
  const [acceptance, interview, packageSource, video, videoInfo] = await Promise.all([
    repositoryFile('docs/agent/final-acceptance.md'),
    repositoryFile('docs/agent/interview-qa.md'),
    repositoryFile('package.json'),
    readFile(path.join(repositoryRoot, 'docs/agent/demo-video.webm')),
    stat(path.join(repositoryRoot, 'docs/agent/demo-video.webm')),
  ])
  const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> }

  assert.match(acceptance, /create-01-cello-track/)
  assert.match(acceptance, /modify-02-change-instrument/)
  assert.match(acceptance, /adversarial-01-tool-injection/)
  assert.match(acceptance, /三个最严重风险与防护/)
  assert.match(acceptance, /已知限制与下一阶段/)

  assert.match(interview, /0–5 分钟/)
  assert.match(interview, /25–30 分钟/)
  assert.match(interview, /最容易被追问、还需要补强/)
  assert.match(interview, /真实模型 A\/B/)
  assert.match(interview, /服务重启/)
  assert.match(interview, /音乐好不好听/)

  assert.equal(packageJson.scripts['demo:agent'], 'node tools/record-agent-demo.mjs')
  assert.ok(videoInfo.size > 10_000)
  assert.deepEqual([...video.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3])
})
