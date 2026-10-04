import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { badRequest } from './errors.ts'
import { asyncHandler, errorHandler, fetchWithRetry, notFoundHandler, readEnvInt, requestContext } from './http.ts'

// 测重试逻辑时会故意制造失败，别把过程日志刷到测试输出里
process.env.LOG_LEVEL = 'error'

/** 起一个和 index.ts 同构的最小应用：中间件 → 路由 → 404 → 错误出口。 */
async function startApp() {
  const app = express()
  app.use(requestContext())
  app.use(express.json({ limit: '2mb' }))
  app.post('/api/boom', asyncHandler(async () => {
    throw badRequest('参数不对。', 'concept: Required')
  }))
  app.get('/api/crash', asyncHandler(async () => {
    throw new Error('意外崩溃')
  }))
  app.post('/api/echo', asyncHandler(async (req, res) => {
    res.json({ ok: true, requestId: req.requestId })
  }))
  app.use(notFoundHandler)
  app.use(errorHandler)
  const server = app.listen(0)
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  const address = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${address.port}` }
}

type Started = Awaited<ReturnType<typeof startApp>>

async function withApp(run: (started: Started) => Promise<void>) {
  const started = await startApp()
  try {
    await run(started)
  } finally {
    await new Promise<void>(resolve => started.server.close(() => resolve()))
  }
}

test('业务错误统一成 { error, code, status, retryable, detail, requestId } 信封', async () => {
  await withApp(async ({ base }) => {
    const response = await fetch(`${base}/api/boom`, { method: 'POST' })
    assert.equal(response.status, 400)
    assert.ok(response.headers.get('x-request-id'))
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.error, '参数不对。')
    assert.equal(body.code, 'bad_request')
    assert.equal(body.status, 400)
    assert.equal(body.retryable, false)
    assert.equal(body.detail, 'concept: Required')
    assert.equal(body.requestId, response.headers.get('x-request-id'))
  })
})

test('意外异常不泄漏堆栈，只给 500 + internal_error', async () => {
  await withApp(async ({ base }) => {
    const response = await fetch(`${base}/api/crash`)
    assert.equal(response.status, 500)
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.code, 'internal_error')
    assert.equal(body.retryable, false)
    assert.equal(body.detail, '意外崩溃')
  })
})

test('未知 /api 路径返回 JSON 404 而不是 HTML', async () => {
  await withApp(async ({ base }) => {
    const response = await fetch(`${base}/api/nope`)
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.code, 'not_found')
  })
})

test('请求体不是合法 JSON 时给出可读的 400', async () => {
  await withApp(async ({ base }) => {
    const response = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    })
    assert.equal(response.status, 400)
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.code, 'bad_request')
    assert.match(String(body.error), /JSON/)
  })
})

test('客户端自带的 X-Request-Id 会被沿用，方便串联前后端日志', async () => {
  await withApp(async ({ base }) => {
    const response = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'trace-123' },
      body: '{}',
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-request-id'), 'trace-123')
    assert.deepEqual(await response.json(), { ok: true, requestId: 'trace-123' })
  })
})

test('readEnvInt 只接受范围内的整数', () => {
  process.env.TEST_ENV_INT = '42'
  assert.equal(readEnvInt('TEST_ENV_INT', 1, 0, 100), 42)
  process.env.TEST_ENV_INT = '999'
  assert.equal(readEnvInt('TEST_ENV_INT', 1, 0, 100), 100)
  process.env.TEST_ENV_INT = 'abc'
  assert.equal(readEnvInt('TEST_ENV_INT', 7, 0, 100), 7)
  delete process.env.TEST_ENV_INT
  assert.equal(readEnvInt('TEST_ENV_INT', 7, 0, 100), 7)
})

type Handler = (url: string, init: RequestInit) => Promise<Response>

function stubFetch(handler: Handler) {
  const original = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

test('fetchWithRetry 对 5xx 退避重试，成功后直接返回', async () => {
  process.env.PROVIDER_RETRY_BASE_MS = '1'
  let count = 0
  const stub = stubFetch(async () => {
    count += 1
    return count < 3 ? new Response('', { status: 503 }) : new Response('ok', { status: 200 })
  })
  try {
    const response = await fetchWithRetry('https://example.test/x', { method: 'POST' }, { label: '测试上游' })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'ok')
    assert.equal(stub.calls.length, 3)
  } finally {
    stub.restore()
    delete process.env.PROVIDER_RETRY_BASE_MS
  }
})

test('fetchWithRetry 不重试 4xx（参数错误重试也没用）', async () => {
  process.env.PROVIDER_RETRY_BASE_MS = '1'
  const stub = stubFetch(async () => new Response('', { status: 400 }))
  try {
    const response = await fetchWithRetry('https://example.test/x', {}, { label: '测试上游' })
    assert.equal(response.status, 400)
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
    delete process.env.PROVIDER_RETRY_BASE_MS
  }
})

test('fetchWithRetry 会用尽重试次数后把最后一次响应交给调用方', async () => {
  process.env.PROVIDER_RETRY_BASE_MS = '1'
  const stub = stubFetch(async () => new Response('', { status: 500 }))
  try {
    const response = await fetchWithRetry('https://example.test/x', {}, { label: '测试上游', attempts: 2 })
    assert.equal(response.status, 500)
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
    delete process.env.PROVIDER_RETRY_BASE_MS
  }
})

test('fetchWithRetry 尊重 Retry-After', async () => {
  process.env.PROVIDER_RETRY_BASE_MS = '0'
  let count = 0
  const stub = stubFetch(async () => {
    count += 1
    if (count === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } })
    return new Response('ok', { status: 200 })
  })
  try {
    const response = await fetchWithRetry('https://example.test/x', {}, { label: '测试上游' })
    assert.equal(response.status, 200)
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
    delete process.env.PROVIDER_RETRY_BASE_MS
  }
})

test('fetchWithRetry 超时抛 PROVIDER_TIMEOUT 哨兵（会翻成 504）', async () => {
  process.env.PROVIDER_RETRY_BASE_MS = '1'
  const stub = stubFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
  )
  try {
    await assert.rejects(
      () => fetchWithRetry('https://example.test/slow', {}, { label: '测试上游', timeoutMs: 30, attempts: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'PROVIDER_TIMEOUT')
        return true
      },
    )
    assert.equal(stub.calls.length, 2)
  } finally {
    stub.restore()
    delete process.env.PROVIDER_RETRY_BASE_MS
  }
})

test('fetchWithRetry 在客户端已断开时不再发请求', async () => {
  const stub = stubFetch(async () => new Response('ok', { status: 200 }))
  const controller = new AbortController()
  controller.abort()
  try {
    await assert.rejects(
      () =>
        fetchWithRetry('https://example.test/x', {}, { label: '测试上游', signal: controller.signal }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, 'PROVIDER_TIMEOUT')
        return true
      },
    )
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})
