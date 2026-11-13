import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluationConstraintsSchema } from '../evaluator.ts'
import { inspectProjectTool } from '../inspectProjectTool.ts'
import { noteTools } from '../noteTools.ts'
import { trackTools } from '../trackTools.ts'
import { projectSchema } from '../../projectSchema.ts'
import {
  AGENT_EVAL_CASES,
  AGENT_EVAL_MODE,
  AGENT_EVAL_TOOL_NAMES,
  type AgentEvalCase,
  type AgentEvalCategory,
} from './cases.ts'

const categoryCounts: Readonly<Record<AgentEvalCategory, number>> = {
  basic_creation: 5,
  modification: 5,
  constrained: 5,
  conflict: 3,
  adversarial: 2,
}

function objectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeys)
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, item]) => [key, ...objectKeys(item)])
}

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const item of Object.values(value as Record<string, unknown>)) assertDeepFrozen(item)
}

test('固定评测集严格包含 20 例并满足 5/5/5/3/2 分类配额', () => {
  assert.equal(AGENT_EVAL_CASES.length, 20)
  const ids = new Set(AGENT_EVAL_CASES.map(item => item.id))
  assert.equal(ids.size, 20)
  assert.deepEqual(
    Object.fromEntries(Object.keys(categoryCounts).map(category => [
      category,
      AGENT_EVAL_CASES.filter(item => item.category === category).length,
    ])),
    categoryCounts,
  )
  assert.deepEqual(
    AGENT_EVAL_CASES.slice(0, 5).map(item => item.category),
    Array(5).fill('basic_creation'),
  )
})

test('每个案例都是合法、固定且不携带真实服务配置的离线输入', () => {
  const projectReferences = new Set<object>()
  for (const evalCase of AGENT_EVAL_CASES) {
    assert.equal(evalCase.mode, AGENT_EVAL_MODE)
    assert.match(evalCase.id, /^(create|modify|constraint|conflict|adversarial)-\d{2}-[a-z0-9-]+$/)
    assert.ok(evalCase.title.length > 0)
    assert.ok(evalCase.instruction.length > 0 && evalCase.instruction.length <= 500)
    assert.equal(projectSchema.safeParse(evalCase.inputProject).success, true, evalCase.id)
    assert.equal(evaluationConstraintsSchema.safeParse(evalCase.constraints).success, true, evalCase.id)
    assert.equal(projectReferences.has(evalCase.inputProject), false, `${evalCase.id} 复用了可变工程引用`)
    projectReferences.add(evalCase.inputProject)

    const keys = objectKeys(evalCase).map(key => key.toLowerCase())
    for (const forbidden of ['apikey', 'authorization', 'baseurl', 'provider', 'model']) {
      assert.equal(keys.includes(forbidden), false, `${evalCase.id} 不应声明 ${forbidden} 配置`)
    }
  }
  assertDeepFrozen(AGENT_EVAL_CASES)
})

test('工具白名单与生产 Registry 完全对齐，案例不能引用不存在的工具', () => {
  const registered = [inspectProjectTool, ...trackTools, ...noteTools]
    .map(tool => tool.name)
    .sort()
  assert.deepEqual([...AGENT_EVAL_TOOL_NAMES].sort(), registered)
  const known = new Set<string>(AGENT_EVAL_TOOL_NAMES)
  for (const evalCase of AGENT_EVAL_CASES) {
    assert.ok(evalCase.allowedTools.length > 0)
    assert.equal(new Set(evalCase.allowedTools).size, evalCase.allowedTools.length)
    for (const name of evalCase.allowedTools) assert.equal(known.has(name), true, `${evalCase.id}: ${name}`)
    const subset = evalCase.expected.assertions.find(item => item.type === 'tool_calls_subset')
    assert.ok(subset, `${evalCase.id} 缺少工具白名单断言`)
    assert.deepEqual(subset.toolNames, evalCase.allowedTools)
  }
})

test('正常案例都有可机器检查的候选结果、约束满足和人工审批条件', () => {
  const normal = AGENT_EVAL_CASES.filter(item => item.expected.outcome === 'candidate')
  assert.equal(normal.length, 15)
  for (const evalCase of normal) {
    const assertionTypes = new Set(evalCase.expected.assertions.map(item => item.type))
    assert.equal(assertionTypes.has('project_schema_valid'), true, evalCase.id)
    assert.equal(assertionTypes.has('approval_required'), true, evalCase.id)
    assert.ok(
      evalCase.expected.assertions.some(item =>
        ['track_matches', 'track_absent', 'track_count', 'note_count', 'project_field_equals'].includes(item.type),
      ),
      `${evalCase.id} 缺少具体工程成功条件`,
    )
    const constraints = evalCase.expected.assertions.find(item => item.type === 'constraints_satisfied')
    assert.ok(constraints, `${evalCase.id} 缺少确定性约束断言`)
    assert.deepEqual(constraints.constraintIds, evalCase.constraints.map(item => item.id))
    const status = evalCase.expected.assertions.find(item => item.type === 'run_status')
    assert.deepEqual(status?.anyOf, ['awaiting_approval'])
  }
})

test('冲突和恶意案例要求安全失败、源快照不变，恶意案例还要求无敏感输出', () => {
  const rejected = AGENT_EVAL_CASES.filter(item => item.expected.outcome === 'safe_rejection')
  assert.equal(rejected.length, 5)
  for (const evalCase of rejected) {
    const assertionTypes = new Set(evalCase.expected.assertions.map(item => item.type))
    assert.equal(assertionTypes.has('source_snapshot_unchanged'), true, evalCase.id)
    const status = evalCase.expected.assertions.find(item => item.type === 'run_status')
    assert.deepEqual(status?.anyOf, ['failed', 'canceled'])
    if (evalCase.category === 'adversarial') {
      assert.equal(assertionTypes.has('no_sensitive_output'), true, evalCase.id)
      assert.deepEqual(evalCase.allowedTools, ['inspect_project', 'validate_project'])
    }
  }
})

test('评测案例序列化结果稳定，可作为后续 Runner 的固定数据集', () => {
  const serialize = (cases: readonly AgentEvalCase[]) => JSON.stringify(cases)
  const first = serialize(AGENT_EVAL_CASES)
  const second = serialize(AGENT_EVAL_CASES)
  assert.equal(first, second)
  assert.ok(first.length > 10_000)
})
