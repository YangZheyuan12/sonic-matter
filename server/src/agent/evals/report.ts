import type { AgentEvalSuiteReport } from './runner.ts'

export const AGENT_EVAL_README_START = '<!-- agent-eval:start -->'
export const AGENT_EVAL_README_END = '<!-- agent-eval:end -->'

function percent(value: number | null): string {
  return value === null ? '无修订样本' : `${(value * 100).toFixed(2)}%`
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function renderAgentEvalMarkdown(report: AgentEvalSuiteReport): string {
  const { summary } = report
  const lines = [
    '# Agent Eval 离线基线',
    '',
    '> 本文件由 `npm run eval:agent` 自动生成，请勿手工修改统计数字。',
    '',
    `固定适配器：\`${report.adapter}\`；真实付费调用：${summary.paidCallCount}；估算成本：$${summary.estimatedCostUsd.toFixed(2)}。`,
    '',
    '## 汇总指标',
    '',
    '| 指标 | 结果 | 口径 |',
    '| --- | ---: | --- |',
    `| 总成功率 | ${percent(summary.successRate)} | 通过全部机器断言的案例 / ${summary.totalCases} 个案例 |`,
    `| 约束满足率 | ${percent(summary.constraintSatisfactionRate)} | 候选工程的约束断言 |`,
    `| 工具成功率 | ${percent(summary.toolSuccessRate)} | 成功 Tool Call / 全部 Tool Call |`,
    `| 一次完成率 | ${percent(summary.firstPassCompletionRate)} | 无修订即通过的候选任务 / 全部候选任务 |`,
    `| 修订成功率 | ${percent(summary.revisionSuccessRate)} | 修订后通过的任务 / 发生修订的任务 |`,
    `| 平均工具步骤 | ${summary.averageSteps.toFixed(2)} | 全部案例 |`,
    `| 修订总次数 | ${summary.totalRevisions} | 全部案例 |`,
    `| 平均逻辑耗时 | ${summary.averageDurationMs.toFixed(2)} ms | 固定逻辑时钟，保证离线基线可复现 |`,
    `| 可导出率 | ${percent(summary.exportabilityRate)} | 结构合法且音符未越界的候选工程 |`,
    '',
    '## 案例明细',
    '',
    '| 案例 | 分类 | 结果 | 状态 | 步骤 | 修订 | 耗时 | 可导出 |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- |',
    ...report.cases.map((item) =>
      `| ${markdownCell(item.caseId)} | ${item.category} | ${item.passed ? '通过' : '失败'} | ${item.observedStatus} | ${item.stepCount} | ${item.revisionCount} | ${item.durationMs} ms | ${item.exportable ? '是' : '否'} |`),
    '',
    '## 失败分布',
    '',
  ]

  if (summary.mostCommonFailureType === null) {
    lines.push('当前基线没有失败案例，最常见失败类型为“无”。')
  } else {
    lines.push(`最常见失败类型：\`${summary.mostCommonFailureType}\`。`, '')
    lines.push('| 失败类型 | 次数 |', '| --- | ---: |')
    for (const [failureType, count] of Object.entries(summary.failureTypeCounts)) {
      lines.push(`| ${markdownCell(failureType)} | ${count} |`)
    }
  }

  lines.push('', '## 失败案例摘要', '')
  if (report.failures.length === 0) {
    lines.push('无。')
  } else {
    for (const failure of report.failures) {
      lines.push(
        `- **${markdownCell(failure.caseId)}**：${markdownCell(failure.failedAssertions.join('；'))}`,
      )
    }
  }

  return `${lines.join('\n')}\n`
}

export function renderAgentEvalJson(report: AgentEvalSuiteReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

export function renderAgentEvalReadmeSection(report: AgentEvalSuiteReport): string {
  const { summary } = report
  return [
    AGENT_EVAL_README_START,
    '## 可重复的 Agent Eval 基线',
    '',
    '> 本节由 `npm run eval:agent` 自动更新。基线使用固定离线适配器，不产生付费调用，也不把离线满分等同于真实模型在所有输入上都正确。',
    '',
    '| 指标 | 当前基线 |',
    '| --- | ---: |',
    `| 案例通过 | ${summary.passedCases}/${summary.totalCases} |`,
    `| 总成功率 | ${percent(summary.successRate)} |`,
    `| 约束满足率 | ${percent(summary.constraintSatisfactionRate)} |`,
    `| 工具成功率 | ${percent(summary.toolSuccessRate)} |`,
    `| 一次完成率 | ${percent(summary.firstPassCompletionRate)} |`,
    `| 修订成功率 | ${percent(summary.revisionSuccessRate)} |`,
    `| 可导出率 | ${percent(summary.exportabilityRate)} |`,
    `| 平均工具步骤 / 修订总次数 | ${summary.averageSteps.toFixed(2)} / ${summary.totalRevisions} |`,
    `| 真实付费调用 / 估算成本 | ${summary.paidCallCount} / $${summary.estimatedCostUsd.toFixed(2)} |`,
    '',
    '复现命令：`npm run eval:agent`。查看[完整报告](server/src/agent/evals/reports/README.md)、[机器可读结果](server/src/agent/evals/reports/baseline.json)与[三个演示案例](docs/agent/cases.md)。',
    AGENT_EVAL_README_END,
  ].join('\n')
}

export function updateReadmeAgentEvalSection(
  readme: string,
  report: AgentEvalSuiteReport,
): string {
  const startIndex = readme.indexOf(AGENT_EVAL_README_START)
  const endIndex = readme.indexOf(AGENT_EVAL_README_END)
  const hasDuplicateStart = readme.indexOf(AGENT_EVAL_README_START, startIndex + 1) !== -1
  const hasDuplicateEnd = readme.indexOf(AGENT_EVAL_README_END, endIndex + 1) !== -1

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex || hasDuplicateStart || hasDuplicateEnd) {
    throw new Error('README 中必须有且仅有一组合法的 Agent Eval 自动生成标记')
  }

  const afterEnd = endIndex + AGENT_EVAL_README_END.length
  return `${readme.slice(0, startIndex)}${renderAgentEvalReadmeSection(report)}${readme.slice(afterEnd)}`
}
