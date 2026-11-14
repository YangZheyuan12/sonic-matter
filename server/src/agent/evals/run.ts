import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderAgentEvalJson, renderAgentEvalMarkdown } from './report.ts'
import { runAgentEvalSuite } from './runner.ts'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const outputDir = path.join(currentDir, 'reports')

const report = await runAgentEvalSuite()
await mkdir(outputDir, { recursive: true })
await Promise.all([
  writeFile(path.join(outputDir, 'baseline.json'), renderAgentEvalJson(report), 'utf8'),
  writeFile(path.join(outputDir, 'README.md'), renderAgentEvalMarkdown(report), 'utf8'),
])

const { summary } = report
console.log(
  `Agent Eval：${summary.passedCases}/${summary.totalCases} 通过；` +
  `工具成功率 ${(summary.toolSuccessRate * 100).toFixed(2)}%；` +
  `报告已写入 ${outputDir}`,
)

if (summary.failedCases > 0) process.exitCode = 1
