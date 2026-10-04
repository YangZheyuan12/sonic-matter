import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, DEFAULT_TIMEOUT_MS, apiFetch, apiFetchBlob, errorMessage, isCanceled } from './client.ts'

type Handler = (url: string, init: RequestInit) => Promise<Response>

/** 临时替换全局 fetch，返回恢复函数。 */
function stubFetch(handler: Handler) {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string, init: RequestInit) => handler(String(url), init)) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('apiFetch 成功时解析 JSON 并带上请求体', async () => {
  let seenMethod = ''
  let seenBody = ''
  const restore = stubFetch(async (_url, init) => {
    seenMethod = init.method ?? ''
    seenBody = String(init.body)
    return json({ message: 'ok', requestId: 'r1' })
  })
  try {
    const data = await apiFetch<{ message: string }>('/api/agent/test', { agent: { model: 'gpt-4.1-mini' } })
    assert.equal(data.message, 'ok')
    assert.equal(seenMethod, 'POST')
    assert.deepEqual(JSON.parse(seenBody), { agent: { model: 'gpt-4.1-mini' } })
  } finally {
    restore()
  }
})

test('后端错误信封被翻译成 ApiError（保留 code / retryable / requestId）', async () => {
  const restore = stubFetch(async () =>
    json({ error: '当前工程没有 MIDI 轨道。', code: 'bad_request', retryable: false, requestId: 'req-9' }, 400),
  )
  try {
    await assert.rejects(
      () => apiFetch('/api/export/midi', {}),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.message, '当前工程没有 MIDI 轨道。')
        assert.equal(error.code, 'bad_request')
        assert.equal(error.status, 400)
        assert.equal(error.retryable, false)
        assert.equal(error.requestId, 'req-9')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('5xx 且没有 JSON 体时给出可重试的兜底错误', async () => {
  const restore = stubFetch(async () => new Response('', { status: 500 }))
  try {
    await assert.rejects(
      () => apiFetch('/api/music/plan', {}),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, 'http_500')
        assert.equal(error.retryable, true)
        assert.match(error.message, /HTTP 500/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('200 但响应体不是 JSON 时提示原始片段', async () => {
  const restore = stubFetch(async () => new Response('<html>proxy error</html>', { status: 200 }))
  try {
    await assert.rejects(
      () => apiFetch('/api/concept/interpret', {}),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, 'bad_response')
        assert.match(error.message, /proxy error/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('200 但响应体为空时提示后端可能没启动', async () => {
  const restore = stubFetch(async () => new Response('', { status: 200 }))
  try {
    await assert.rejects(
      () => apiFetch('/api/agent/test', {}),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, 'bad_response')
        assert.match(error.message, /空响应/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('连不上后端时给出 network_error 并保留底层原因', async () => {
  const restore = stubFetch(async () => {
    throw new TypeError('fetch failed')
  })
  try {
    await assert.rejects(
      () => apiFetch('/api/agent/test', {}),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, 'network_error')
        assert.equal(error.retryable, true)
        assert.match(error.message, /8787/)
        assert.equal(error.detail, 'fetch failed')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('超时会自动中止请求并给出 client_timeout', async () => {
  const restore = stubFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
  )
  try {
    const started = Date.now()
    await assert.rejects(
      () => apiFetch('/api/music/generate', {}, { timeoutMs: 30 }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, 'client_timeout')
        assert.equal(error.retryable, true)
        return true
      },
    )
    assert.ok(Date.now() - started < 2_000)
  } finally {
    restore()
  }
})

test('用户取消时标记为 client_canceled，可供 UI 忽略', async () => {
  const restore = stubFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
  )
  try {
    const controller = new AbortController()
    const pending = apiFetch('/api/music/generate', {}, { signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'client_canceled')
      assert.equal(isCanceled(error), true)
      return true
    })
  } finally {
    restore()
  }
})

test('apiFetchBlob 原样返回二进制内容', async () => {
  const restore = stubFetch(
    async () => new Response(new Uint8Array([0x4d, 0x54, 0x68, 0x64]), { status: 200, headers: { 'Content-Type': 'audio/midi' } }),
  )
  try {
    const blob = await apiFetchBlob('/api/export/midi', { project: {} })
    assert.equal(blob.size, 4)
    assert.equal(new TextDecoder().decode(await blob.arrayBuffer()), 'MThd')
  } finally {
    restore()
  }
})

test('errorMessage 兜住各种异常类型', () => {
  assert.equal(errorMessage(new ApiError('明确文案', { code: 'x' })), '明确文案')
  assert.equal(errorMessage(new Error('普通错误')), '普通错误')
  assert.equal(errorMessage('字符串'), '操作失败，请稍后重试。')
  assert.equal(errorMessage(undefined, '自定义兜底'), '自定义兜底')
  assert.equal(DEFAULT_TIMEOUT_MS, 90_000)
})
