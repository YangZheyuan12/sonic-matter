import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Request, Response } from 'express'
import { DatabaseSync } from 'node:sqlite'

process.env.REQUEST_TIMEOUT_MS = '1000'
const { runGeneration } = await import('./generation.ts')
const { GenerationStore, defaultGenerationLimits } = await import('./generationStore.ts')
const { AppError } = await import('./errors.ts')

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sonic-task-'))
  const store = new GenerationStore(dir, { ...defaultGenerationLimits, concurrent: 1, perMinute: 20 })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const req = { auth: { account: { id: 'user' } }, abortSignal: new AbortController().signal, abortReason: () => null } as unknown as Request
  const res = { setHeader: () => undefined } as unknown as Response
  return { store, req, res }
}

test('独立任务截止时间能中止上游、计入失败并释放槽位', async t => {
  const { store, req, res } = fixture(t)
  // 模拟供应商请求监听 AbortSignal；无需真实网络或计费。
  const keepAlive = setTimeout(() => undefined, 2000)
  try {
    await assert.rejects(runGeneration(store, req, res, 'replicate', signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })), (error: unknown) => {
      assert.ok(error instanceof AppError); assert.equal(error.status, 504); assert.equal(error.code, 'provider_timeout'); return true
    })
  } finally { clearTimeout(keepAlive) }
  assert.equal(await runGeneration(store, req, res, 'elevenlabs', async () => 'next'), 'next')
  assert.deepEqual(store.summary().calls.map(row => row.outcome).sort(), ['failed', 'succeeded'])
})

test('供应商解析异常不会在响应、错误日志元数据或用量库中保留原文', async t => {
  const { store, req, res } = fixture(t)
  const secret = 'synthetic-sensitive-provider-response'
  await assert.rejects(runGeneration(store, req, res, 'replicate', async () => { throw new SyntaxError(secret) }), (error: unknown) => {
    assert.ok(error instanceof AppError); assert.equal(error.code, 'internal_error')
    assert.equal(error.detail, undefined); assert.equal(error.message.includes(secret), false); return true
  })
  const db = new DatabaseSync(store.databasePath)
  try {
    const rows = db.prepare('SELECT * FROM generation_calls').all()
    assert.equal(JSON.stringify(rows).includes(secret), false)
    assert.equal(rows[0].error_code, 'internal_error')
  } finally { db.close() }
})
