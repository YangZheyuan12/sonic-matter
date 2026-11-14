import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderAgentEvalJson, renderAgentEvalMarkdown } from './report.ts'
import { runAgentEvalSuite } from './runner.ts'

test('报告生成器输出可解析 JSON 和包含口径的 Markdown 汇总表', async () => {
  const report = await runAgentEvalSuite()
  const json = renderAgentEvalJson(report)
  const markdown = renderAgentEvalMarkdown(report)

  assert.deepEqual(JSON.parse(json), report)
  assert.match(markdown, /本文件由 `npm run eval:agent` 自动生成/)
  assert.match(markdown, /\| 总成功率 \| 100\.00% \|/)
  assert.match(markdown, /\| 一次完成率 \| 93\.33% \|/)
  assert.match(markdown, /\| 修订成功率 \| 100\.00% \|/)
  assert.match(markdown, /最常见失败类型为“无”/)
  assert.match(markdown, /真实付费调用：0/)
  assert.equal(markdown.split('\n').filter((line) => line.startsWith('| create-')).length, 5)
})
