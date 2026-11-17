import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AGENT_EVAL_README_END,
  AGENT_EVAL_README_START,
  renderAgentEvalJson,
  renderAgentEvalMarkdown,
  renderAgentEvalReadmeSection,
  updateReadmeAgentEvalSection,
} from './report.ts'
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

test('根 README 指标区块可重复生成且严格来自同一份 Eval 报告', async () => {
  const report = await runAgentEvalSuite()
  const section = renderAgentEvalReadmeSection(report)
  const source = `标题\n\n${AGENT_EVAL_README_START}\n旧数字\n${AGENT_EVAL_README_END}\n\n尾部\n`
  const updated = updateReadmeAgentEvalSection(source, report)

  assert.match(section, /\| 案例通过 \| 20\/20 \|/)
  assert.match(section, /\| 一次完成率 \| 93\.33% \|/)
  assert.match(section, /真实付费调用 \/ 估算成本 \| 0 \/ \$0\.00/)
  assert.match(section, /server\/src\/agent\/evals\/reports\/baseline\.json/)
  assert.equal(updateReadmeAgentEvalSection(updated, report), updated)
  assert.equal(updated.includes('旧数字'), false)
  assert.throws(
    () => updateReadmeAgentEvalSection('没有标记', report),
    /有且仅有一组合法/,
  )
})
