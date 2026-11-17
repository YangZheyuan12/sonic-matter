import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  renderAgentEvalJson,
  renderAgentEvalMarkdown,
  updateReadmeAgentEvalSection,
} from './report.ts'
import { runAgentEvalSuite } from './runner.ts'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const outputDir = path.join(currentDir, 'reports')
const rootReadmePath = path.resolve(currentDir, '../../../..', 'README.md')

const report = await runAgentEvalSuite()
const rootReadme = await readFile(rootReadmePath, 'utf8')
await mkdir(outputDir, { recursive: true })
await Promise.all([
  writeFile(path.join(outputDir, 'baseline.json'), renderAgentEvalJson(report), 'utf8'),
  writeFile(path.join(outputDir, 'README.md'), renderAgentEvalMarkdown(report), 'utf8'),
  writeFile(rootReadmePath, updateReadmeAgentEvalSection(rootReadme, report), 'utf8'),
])

const { summary } = report
console.log(
  `Agent Eval：${summary.passedCases}/${summary.totalCases} 通过；` +
  `工具成功率 ${(summary.toolSuccessRate * 100).toFixed(2)}%；` +
  `报告已写入 ${outputDir}，根 README 指标已同步`,
)

if (summary.failedCases > 0) process.exitCode = 1
