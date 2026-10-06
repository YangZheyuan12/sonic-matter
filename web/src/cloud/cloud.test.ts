import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLOUD_TIMEOUT_MS,
  OWNER_HEADER,
  OWNER_STORAGE_KEY,
  formatWhen,
  listCloudProjects,
  loadCloudProject,
  loadOwnerId,
  newOwnerId,
  projectIdFromSearch,
  removeCloudProject,
  saveCloudProject,
  shareLink,
} from './cloud.ts'

type Seen = { url: string; method: string; headers: Record<string, string>; body: string }

/** 临时替换全局 fetch，记录请求并回一个固定 JSON。 */
function stubFetch(handler: (seen: Seen) => { status?: number; body?: unknown } = () => ({})) {
  const calls: Seen[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const seen: Seen = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : '',
    }
    calls.push(seen)
    const { status = 200, body = { ok: true } } = handler(seen)
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** 内存版 localStorage。 */
const fakeStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    raw: data,
  }
}

test('本机标识：第一次生成、之后复用，格式满足服务端要求', () => {
  const storage = fakeStorage()
  const first = loadOwnerId(storage)
  assert.match(first, /^[A-Za-z0-9_-]{8,64}$/)
  assert.equal(storage.raw.get(OWNER_STORAGE_KEY), first)
  assert.equal(loadOwnerId(storage), first, '第二次必须复用同一个标识，否则存过的工程就找不回来了')
  assert.equal(loadOwnerId(fakeStorage({ [OWNER_STORAGE_KEY]: 'saved-owner-1234' })), 'saved-owner-1234')
})

test('本机标识：localStorage 里是脏数据就重新生成，取不到存储也不能崩', () => {
  const dirty = fakeStorage({ [OWNER_STORAGE_KEY]: 'abc' })
  const regenerated = loadOwnerId(dirty)
  assert.notEqual(regenerated, 'abc')
  assert.match(regenerated, /^[A-Za-z0-9_-]{8,64}$/)

  // 隐私模式：setItem 直接抛异常。
  const throwing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } }
  const fallback = loadOwnerId(throwing)
  assert.match(fallback, /^[A-Za-z0-9_-]{8,64}$/)
  assert.equal(loadOwnerId(throwing), fallback, '存不住时至少要在本次会话里保持一致')
  assert.match(newOwnerId(), /^[0-9a-f]{32}$/)
})

test('分享链接：从 search 里取 ID，非法值一律当没有', () => {
  assert.equal(projectIdFromSearch('?p=AbC123xyz'), 'AbC123xyz')
  assert.equal(projectIdFromSearch('p=AbC123xyz'), 'AbC123xyz')
  assert.equal(projectIdFromSearch('?foo=1&p=AbC123xyz&bar=2'), 'AbC123xyz')
  assert.equal(projectIdFromSearch('?p=%20AbC123xyz%20'), 'AbC123xyz', '两边的空格要去掉')
  assert.equal(projectIdFromSearch('?p='), '')
  assert.equal(projectIdFromSearch('?p=abc'), '', '太短的 ID 不当作有效工程')
  assert.equal(projectIdFromSearch('?p=has%2Fslash'), '')
  assert.equal(projectIdFromSearch(''), '')
  assert.equal(projectIdFromSearch(`?p=${'a'.repeat(70)}`), '')
})

test('分享链接就是 Origin + ?p=ID', () => {
  assert.equal(shareLink('AbC123xyz', 'http://47.1.2.3:8080'), 'http://47.1.2.3:8080/?p=AbC123xyz')
  assert.equal(shareLink('AbC123xyz', 'http://47.1.2.3:8080/'), 'http://47.1.2.3:8080/?p=AbC123xyz')
  assert.equal(shareLink('AbC123xyz', 'http://localhost:5173'), 'http://localhost:5173/?p=AbC123xyz')
})

test('列表时间：今天说“多久前”，更早说日期', () => {
  const now = Date.UTC(2025, 9, 6, 12, 0, 0)
  assert.equal(formatWhen(now - 20_000, now), '刚刚')
  assert.equal(formatWhen(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(formatWhen(now - 3 * 3_600_000, now), '3 小时前')
  assert.equal(formatWhen(0, now), '时间未知')
  assert.match(formatWhen(now - 40 * 86_400_000, now), /^\d{4}-\d{2}-\d{2}$/)
})

test('列表请求：GET /api/projects 并带上本机标识请求头', async () => {
  const { calls, restore } = stubFetch(() => ({ body: { projects: [], owned: 0, total: 0, perOwnerLimit: 50, listLimit: 100 } }))
  try {
    const result = await listCloudProjects('owner-aaaaaaaa')
    assert.equal(calls[0].url, '/api/projects')
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].headers[OWNER_HEADER], 'owner-aaaaaaaa')
    assert.equal(calls[0].body, '', 'GET 不该带请求体')
    assert.equal(result.perOwnerLimit, 50)
  } finally {
    restore()
  }
})

test('保存：没有 ID 时 POST 新建，有 ID 时 PUT 覆盖同一个链接', async () => {
  const { calls, restore } = stubFetch(() => ({ status: 201, body: { id: 'cloud-id-1', title: '云端', path: '/?p=cloud-id-1', revision: 1, createdAt: 1, updatedAt: 2 } }))
  try {
    const created = await saveCloudProject('owner-aaaaaaaa', { title: '云端' })
    assert.equal(calls[0].url, '/api/projects')
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].headers['Content-Type'], 'application/json')
    assert.equal(calls[0].headers[OWNER_HEADER], 'owner-aaaaaaaa')
    assert.deepEqual(JSON.parse(calls[0].body), { project: { title: '云端' } })
    assert.equal(created.path, '/?p=cloud-id-1')

    await saveCloudProject('owner-aaaaaaaa', { title: '改过' }, 'cloud-id-1')
    assert.equal(calls[1].url, '/api/projects/cloud-id-1')
    assert.equal(calls[1].method, 'PUT')
    assert.deepEqual(JSON.parse(calls[1].body), { project: { title: '改过' } })
  } finally {
    restore()
  }
})

test('打开与删除：路径要做 URL 编码，删除用 DELETE', async () => {
  const { calls, restore } = stubFetch(seen => (seen.method === 'DELETE' ? { body: { deleted: true, id: 'a b' } } : { body: { id: 'a b', project: { title: 'x' } } }))
  try {
    await loadCloudProject('a b')
    assert.equal(calls[0].url, '/api/projects/a%20b')
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].headers[OWNER_HEADER], undefined, '公开读取不需要带本机标识')

    const removed = await removeCloudProject('owner-aaaaaaaa', 'a b')
    assert.equal(calls[1].url, '/api/projects/a%20b')
    assert.equal(calls[1].method, 'DELETE')
    assert.equal(calls[1].headers[OWNER_HEADER], 'owner-aaaaaaaa')
    assert.equal(removed.deleted, true)
  } finally {
    restore()
  }
})

test('服务端的错误信封会被翻译成能直接显示的中文提示', async () => {
  const { restore } = stubFetch(() => ({ status: 403, body: { error: '这个云端工程不是这台浏览器保存的，无法修改或删除。', code: 'forbidden', status: 403, retryable: false } }))
  try {
    await assert.rejects(() => saveCloudProject('owner-bbbbbbbb', { title: 'x' }, 'someone-elses'), (error: unknown) => {
      const apiError = error as { message: string; code: string; retryable: boolean }
      assert.equal(apiError.code, 'forbidden')
      assert.match(apiError.message, /不是这台浏览器保存的/)
      assert.equal(apiError.retryable, false)
      return true
    })
  } finally {
    restore()
  }
})

test('后端没起 / 断网时，给出的提示是可读的而不是 TypeError', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
  try {
    await assert.rejects(() => listCloudProjects('owner-aaaaaaaa'), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'network_error')
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})

test('云端请求有超时上限，不会把界面永远卡在“保存中”', () => {
  assert.ok(CLOUD_TIMEOUT_MS > 0 && CLOUD_TIMEOUT_MS <= 60_000)
})
