import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { test, type TestContext } from 'node:test'
import express from 'express'
import { createAuth } from './auth.ts'
import { AuthStore } from './authStore.ts'
import { errorHandler, requestContext } from './http.ts'
import { agentRunsRouter } from './agentRuns.ts'
import { createAgentPlan } from './agent/planner.ts'
import { AgentRunStore } from './agent/runStore.ts'

const passwords = {
  admin: 'agent-run-admin-password-2026!',
  user: 'agent-run-user-password-2026!',
}

const project = () => ({
  title: 'Run API 测试工程',
  tempo: 92,
  key: 'C Major',
  duration: 10,
  tracks: [{
    id: 'melody',
    name: '主旋律',
    kind: 'midi' as const,
    instrument: 'Synth Lead',
    color: '#7dd3fc',
    notes: [{ id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 90 }],
  }],
})

const constraints = [{
  id: 'need-cello',
  type: 'required_instrument' as const,
  instrument: 'Cello',
}]

type RunResponse = {
  run: { id: string; status: string; updatedAt: number; errorCode?: string; errorMessage?: string }
  candidateProject?: ReturnType<typeof project>
  approvedProject?: ReturnType<typeof project>
  decision?: 'approved' | 'rejected'
  idempotent?: boolean
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sonic-agent-run-api-'))
  const authStore = new AuthStore(dir)
  authStore.initializeFixedAccounts(passwords)
  const runStore = new AgentRunStore(dir)
  let clock = 10_000
  let sequence = 0
  const now = () => ++clock
  const app = express()
  app.use(requestContext(), express.json())
  const auth = createAuth(authStore, { secureCookie: false, now })
  app.use('/api/auth', auth.router)
  app.use('/api/agent/runs', agentRunsRouter({
    store: runStore,
    auth,
    now,
    newId: () => `http-run-${++sequence}`,
    plan: async (input, dependencies) => {
      if (input.instruction === '等待取消') {
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) return resolve()
          input.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      if (input.instruction === '模拟供应商永久挂起') {
        await new Promise<void>(() => undefined)
      }
      return createAgentPlan(input, dependencies)
    },
    plannerTimeoutMs: 30,
  }))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', resolve))
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    runStore.close()
    authStore.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const request = (url: string, init: RequestInit = {}) => fetch(base + url, init)
  const login = async (username: 'admin' | 'user') => {
    const response = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sonic-auth': '1' },
      body: JSON.stringify({ username, password: passwords[username] }),
    })
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie')
    assert.ok(cookie)
    return cookie.split(';')[0]!
  }
  const mutation = (url: string, cookie: string, body: unknown = {}) => request(url, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-sonic-auth': '1' },
    body: JSON.stringify(body),
  })
  const waitFor = async (id: string, cookie: string, status: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await request(`/api/agent/runs/${id}`, { headers: { cookie } })
      assert.equal(response.status, 200)
      const body = await response.json() as RunResponse
      if (body.run.status === status) return body
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.fail(`Run ${id} 没有进入 ${status}`)
  }
  return { request, login, mutation, waitFor }
}

test('只通过 HTTP 可创建、查询并幂等批准一次完整 Run', async (t) => {
  const f = await fixture(t)
  const user = await f.login('user')
  const admin = await f.login('admin')

  const guest = await f.request('/api/agent/runs/http-run-1')
  assert.equal(guest.status, 401)
  assert.equal((await guest.json() as { code: string }).code, 'unauthorized')
  const guestCreate = await f.request('/api/agent/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sonic-auth': '1' },
    body: JSON.stringify({ instruction: '访客请求', project: project(), constraints }),
  })
  assert.equal(guestCreate.status, 401)

  const created = await f.mutation('/api/agent/runs', user, {
    instruction: '把主旋律乐器改成大提琴',
    project: project(),
    constraints,
  })
  assert.equal(created.status, 202)
  assert.equal(created.headers.get('location'), '/api/agent/runs/http-run-1')
  const createdBody = await created.json() as RunResponse
  assert.equal(createdBody.run.status, 'planning')

  const ready = await f.waitFor(createdBody.run.id, user, 'awaiting_approval')
  assert.equal(ready.candidateProject?.tracks[0]?.instrument, 'Cello')

  const otherAccount = await f.request(`/api/agent/runs/${createdBody.run.id}`, {
    headers: { cookie: admin },
  })
  assert.equal(otherAccount.status, 404)
  assert.equal((await otherAccount.json() as { code: string }).code, 'not_found')

  const approved = await f.mutation(`/api/agent/runs/${createdBody.run.id}/approve`, user)
  assert.equal(approved.status, 200)
  const approvedBody = await approved.json() as RunResponse
  assert.equal(approvedBody.run.status, 'completed')
  assert.equal(approvedBody.decision, 'approved')
  assert.equal(approvedBody.idempotent, false)
  assert.equal(approvedBody.approvedProject?.tracks[0]?.instrument, 'Cello')

  const approvedAgain = await f.mutation(`/api/agent/runs/${createdBody.run.id}/approve`, user)
  assert.equal(approvedAgain.status, 200)
  const repeatedBody = await approvedAgain.json() as RunResponse
  assert.equal(repeatedBody.idempotent, true)
  assert.equal(repeatedBody.run.updatedAt, approvedBody.run.updatedAt)
  assert.deepEqual(repeatedBody.approvedProject, approvedBody.approvedProject)

  const cancelCompleted = await f.mutation(`/api/agent/runs/${createdBody.run.id}/cancel`, user)
  assert.equal(cancelCompleted.status, 409)
  assert.equal((await cancelCompleted.json() as { code: string }).code, 'conflict')

  const invalidId = await f.request('/api/agent/runs/bad%20id', { headers: { cookie: user } })
  assert.equal(invalidId.status, 400)
  const missingId = await f.request('/api/agent/runs/run-does-not-exist', { headers: { cookie: user } })
  assert.equal(missingId.status, 404)
})

test('拒绝操作可安全重放，批准已拒绝 Run 会明确冲突', async (t) => {
  const f = await fixture(t)
  const user = await f.login('user')
  const created = await f.mutation('/api/agent/runs', user, {
    instruction: '准备一个可拒绝的候选工程',
    project: project(),
    constraints,
  })
  const id = (await created.json() as RunResponse).run.id
  await f.waitFor(id, user, 'awaiting_approval')

  const rejected = await f.mutation(`/api/agent/runs/${id}/reject`, user)
  assert.equal(rejected.status, 200)
  const rejectedBody = await rejected.json() as RunResponse
  assert.equal(rejectedBody.run.status, 'canceled')
  assert.equal(rejectedBody.decision, 'rejected')
  assert.equal(rejectedBody.idempotent, false)

  const rejectedAgain = await f.mutation(`/api/agent/runs/${id}/reject`, user)
  assert.equal(rejectedAgain.status, 200)
  assert.equal((await rejectedAgain.json() as RunResponse).idempotent, true)

  const approveRejected = await f.mutation(`/api/agent/runs/${id}/approve`, user)
  assert.equal(approveRejected.status, 409)
})

test('运行中的 Run 可以取消，重复取消幂等，取消后不能批准', async (t) => {
  const f = await fixture(t)
  const user = await f.login('user')
  const created = await f.mutation('/api/agent/runs', user, {
    instruction: '等待取消',
    project: project(),
    constraints,
  })
  const id = (await created.json() as RunResponse).run.id

  const canceled = await f.mutation(`/api/agent/runs/${id}/cancel`, user)
  assert.equal(canceled.status, 200)
  const canceledBody = await canceled.json() as RunResponse
  assert.equal(canceledBody.run.status, 'canceled')
  assert.equal(canceledBody.idempotent, false)

  const canceledAgain = await f.mutation(`/api/agent/runs/${id}/cancel`, user)
  assert.equal(canceledAgain.status, 200)
  assert.equal((await canceledAgain.json() as RunResponse).idempotent, true)

  const approveCanceled = await f.mutation(`/api/agent/runs/${id}/approve`, user)
  assert.equal(approveCanceled.status, 409)
})

test('Planner 供应商永久挂起时达到独立截止时间并安全失败', async (t) => {
  const f = await fixture(t)
  const user = await f.login('user')
  const created = await f.mutation('/api/agent/runs', user, {
    instruction: '模拟供应商永久挂起',
    project: project(),
    constraints,
  })
  assert.equal(created.status, 202)
  const id = (await created.json() as RunResponse).run.id

  const failed = await f.waitFor(id, user, 'failed')
  assert.equal(failed.run.errorCode, 'planner_timeout')
  assert.match(failed.run.errorMessage ?? '', /执行时限/)
  assert.equal(failed.candidateProject, undefined)
})

test('客户端自定义 Agent 地址不能指向环回、内网或云元数据服务', async (t) => {
  const f = await fixture(t)
  const user = await f.login('user')

  for (const baseUrl of [
    'http://127.0.0.1:9000/v1',
    'https://10.0.0.8/v1',
    'https://169.254.169.254/latest/meta-data',
  ]) {
    const response = await f.mutation('/api/agent/runs', user, {
      instruction: '检查工程',
      project: project(),
      constraints,
      agent: { baseUrl, apiKey: 'not-a-real-secret', model: 'test-model' },
    })
    assert.equal(response.status, 400, baseUrl)
    const body = await response.json() as { code: string; error: string; detail?: string }
    assert.equal(body.code, 'bad_request')
    assert.doesNotMatch(JSON.stringify(body), /127\.0\.0\.1|10\.0\.0\.8|169\.254\.169\.254/)
  }
})
