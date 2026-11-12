import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { AgentRunStore } from './runStore.ts'
import type { AgentRun, AgentStep } from './types.ts'

function tempStore(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sonic-agent-runs-'))
  const store = new AgentRunStore(dir)
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, store }
}

const runningStep = (): AgentStep => ({
  id: 'step-1',
  kind: 'tool',
  status: 'running',
  title: '更新主旋律',
  toolCalls: [{
    id: 'call-1',
    toolName: 'update_track',
    status: 'running',
    inputSummary: '{"trackId":"melody"}',
    startedAt: 1_100,
  }],
  startedAt: 1_100,
})

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: 'run-1',
  status: 'executing',
  instruction: '把主旋律改成低音乐器',
  createdAt: 1_000,
  updatedAt: 1_100,
  steps: [runningStep()],
  ...overrides,
})

test('创建 Run 后可按 ID 读取完整的 Step 和 Tool Call', (t) => {
  const { store } = tempStore(t)
  const created = store.create(run())

  assert.deepEqual(created, run())
  assert.deepEqual(store.get('run-1'), run())
  assert.equal(store.get('missing-run'), null)
})

test('关闭并重新打开 Store 后仍能查询已完成 Run', (t) => {
  const { dir, store } = tempStore(t)
  const finished: AgentRun = run({
    status: 'completed',
    updatedAt: 1_300,
    summary: '候选工程已通过验收',
    steps: [{
      ...runningStep(),
      status: 'succeeded',
      summary: '轨道更新完成',
      finishedAt: 1_200,
      toolCalls: [{
        id: 'call-1',
        toolName: 'update_track',
        status: 'succeeded',
        inputSummary: '{"trackId":"melody"}',
        outputSummary: '{"changed":true}',
        startedAt: 1_100,
        finishedAt: 1_200,
      }],
    }],
  })
  store.create(finished)
  store.close()

  const reopened = new AgentRunStore(dir)
  try {
    assert.deepEqual(reopened.get(finished.id), finished)
  } finally {
    reopened.close()
  }
})

test('重复更新同一步骤时替换 Trace，不生成重复 Tool Call', (t) => {
  const { store } = tempStore(t)
  store.create(run())
  const finished: AgentRun = run({
    status: 'validating',
    updatedAt: 1_200,
    steps: [{
      ...runningStep(),
      status: 'succeeded',
      summary: '轨道更新完成',
      finishedAt: 1_200,
      toolCalls: [{
        id: 'call-1',
        toolName: 'update_track',
        status: 'succeeded',
        inputSummary: '{"trackId":"melody"}',
        outputSummary: '{"changed":true}',
        startedAt: 1_100,
        finishedAt: 1_200,
      }],
    }],
  })

  assert.deepEqual(store.update(finished), finished)
  assert.deepEqual(store.update(finished), finished)
  assert.deepEqual(store.get(finished.id), finished)

  const db = new DatabaseSync(store.databasePath, { readOnly: true })
  try {
    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM agent_steps WHERE run_id = ?) AS steps,
        (SELECT COUNT(*) FROM agent_tool_calls WHERE run_id = ?) AS calls
    `).get(finished.id, finished.id) as { steps: number; calls: number }
    assert.equal(counts.steps, 1)
    assert.equal(counts.calls, 1)
  } finally {
    db.close()
  }
})

test('创建和更新不会隐式创建另一个 Run', (t) => {
  const { store } = tempStore(t)
  assert.equal(store.update(run({ id: 'not-created' })), null)
  store.create(run())
  assert.throws(() => store.create(run()), /UNIQUE constraint failed/)
})

test('数据库和查询结果均不包含 API Key 或 Authorization 值', (t) => {
  const { store } = tempStore(t)
  const secret = 'sk-super-secret-value'
  const authorization = 'Bearer private-authorization-value'
  const unsafe: AgentRun = run({
    instruction: `更新工程；apiKey=${secret}`,
    steps: [{
      ...runningStep(),
      title: `调用工具；Authorization: ${authorization}`,
      toolCalls: [{
        ...runningStep().toolCalls[0]!,
        inputSummary: JSON.stringify({
          trackId: 'melody',
          Authorization: authorization,
          apiKey: secret,
        }),
      }],
    }],
  })

  const created = store.create(unsafe)
  const loaded = store.get(unsafe.id)
  for (const value of [JSON.stringify(created), JSON.stringify(loaded)]) {
    assert.doesNotMatch(value, /super-secret-value|private-authorization-value/)
    assert.match(value, /\*\*\*/)
  }

  store.close()
  const databaseBytes = readFileSync(store.databasePath).toString('utf8')
  assert.doesNotMatch(databaseBytes, /super-secret-value|private-authorization-value/)
})

test('账号绑定的 Run 持久化工程快照，并以事务保证审批幂等', (t) => {
  const { dir, store } = tempStore(t)
  const project = {
    title: '待审批工程',
    tempo: 90,
    key: 'C Major',
    duration: 10,
    tracks: [{
      id: 'melody',
      name: '主旋律',
      kind: 'midi' as const,
      instrument: 'Cello',
      color: '#ffffff',
      notes: [],
    }],
  }
  const awaiting = run({
    status: 'awaiting_approval',
    updatedAt: 1_200,
    steps: [],
  })
  store.createOwned({
    run: awaiting,
    ownerId: 'account-user',
    sourceProject: project,
    constraints: [{
      id: 'need-cello',
      type: 'required_instrument',
      instrument: 'Cello',
    }],
  })
  store.setCandidateProject(awaiting.id, 'account-user', project)

  const first = store.decideOwned(awaiting.id, 'account-user', 'approved', 1_300)
  const second = store.decideOwned(awaiting.id, 'account-user', 'approved', 1_400)
  assert.equal(first.kind, 'updated')
  assert.equal(second.kind, 'idempotent')
  if (first.kind === 'updated' && second.kind === 'idempotent') {
    assert.equal(first.resource.run.status, 'completed')
    assert.deepEqual(second.resource.approvedProject, project)
    assert.equal(second.resource.run.updatedAt, first.resource.run.updatedAt)
  }
  assert.equal(store.getOwned(awaiting.id, 'another-account'), null)

  store.close()
  const reopened = new AgentRunStore(dir)
  try {
    const loaded = reopened.getOwned(awaiting.id, 'account-user')
    assert.equal(loaded?.decision, 'approved')
    assert.deepEqual(loaded?.approvedProject, project)
  } finally {
    reopened.close()
  }
})
