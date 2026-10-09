import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../api/client.ts'
import { buildConfigPatch, loadSession, loginAccount, logoutAccount, loadServiceConfig, runPlatformGeneration, saveServiceConfig } from './api.ts'

function stub(t: TestContext, handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string, init: RequestInit) => Promise.resolve(handler(String(url), init))) as typeof fetch
  t.after(() => { globalThis.fetch = original })
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

test('会话与配置读取使用同源 GET；登录密码原样传递，用户名去除首尾空白', async t => {
  const calls: { url: string; init: RequestInit }[] = []
  stub(t, (url, init) => { calls.push({ url, init }); return json({ account: null, expiresAt: null }) })
  await loadSession()
  await loadServiceConfig()
  await loginAccount(' admin ', ' spaces-in-password ')
  assert.deepEqual(calls.map(call => call.url), ['/api/auth/me', '/api/admin/service-config', '/api/auth/login'])
  for (const call of calls.slice(0, 2)) { assert.equal(call.init.method, 'GET'); assert.equal(call.init.body, undefined) }
  assert.equal(calls[2].init.method, 'POST')
  assert.equal(new Headers(calls[2].init.headers).get('x-sonic-auth'), '1')
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { username: 'admin', password: ' spaces-in-password ' })
})

test('退出和保存均带 JSON 与保护头；退出发送空对象而非空请求体', async t => {
  const calls: { url: string; init: RequestInit }[] = []
  stub(t, (url, init) => { calls.push({ url, init }); return json({ ok: true }) })
  await logoutAccount()
  await saveServiceConfig({ replicate: 'synthetic-test-key', elevenlabs: null })
  assert.equal(calls[0].url, '/api/auth/logout')
  assert.equal(calls[0].init.body, '{}')
  assert.equal(calls[1].url, '/api/admin/service-config')
  assert.equal(calls[1].init.method, 'PUT')
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { replicate: 'synthetic-test-key', elevenlabs: null })
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get('content-type'), 'application/json')
    assert.equal(new Headers(call.init.headers).get('x-sonic-auth'), '1')
  }
})

test('平台音乐与音效生成统一发送登录保护头且不附带浏览器平台配置', async t => {
  const calls: { url: string; init: RequestInit }[] = []
  stub(t, (url, init) => { calls.push({ url, init }); return json({ url: '/generated/test.wav' }) })
  await runPlatformGeneration('/api/music/generate', { prompt: '潮汐', duration_seconds: 10 })
  await runPlatformGeneration('/api/sfx/generate', { description: '水滴', mixer: { length: 2 } })
  assert.deepEqual(calls.map(call => call.url), ['/api/music/generate', '/api/sfx/generate'])
  for (const call of calls) {
    assert.equal(call.init.method, 'POST')
    assert.equal(new Headers(call.init.headers).get('x-sonic-auth'), '1')
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>
    assert.equal('apiKey' in body, false)
    assert.equal('baseUrl' in body, false)
    assert.equal('model' in body, false)
  }
})

test('空白保留已有配置，清除优先于输入，单项更新不触碰另一项', () => {
  assert.deepEqual(buildConfigPatch({ replicate: ' ', elevenlabs: '' }, { replicate: false, elevenlabs: false }), {})
  assert.deepEqual(buildConfigPatch({ replicate: ' new-key ', elevenlabs: '' }, { replicate: false, elevenlabs: false }), { replicate: 'new-key' })
  assert.deepEqual(buildConfigPatch({ replicate: 'new-key', elevenlabs: ' other-key ' }, { replicate: true, elevenlabs: false }), { replicate: null, elevenlabs: 'other-key' })
})

test('生成额度、频率和并发限制的中文原因原样传给界面，禁止自动重试', async t => {
  let code = 'quota_exceeded'
  stub(t, () => json({ error: '生成额度已用完，请在北京时间明日零点后再试。', code, retryable: false }, 429))
  for (code of ['quota_exceeded', 'generation_rate_limited', 'generation_busy']) {
    await assert.rejects(runPlatformGeneration('/api/music/generate', { prompt: '潮汐' }), (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, 429); assert.equal(error.code, code); assert.equal(error.retryable, false)
      assert.match(error.message, /北京时间明日零点/)
      return true
    })
  }
})

test('401、403 和 503 保留统一错误信息，供界面退出与配置错误提示使用', async t => {
  let status = 401
  stub(t, () => json({ error: '请检查服务器配置。', code: 'provider_not_configured', requestId: 'config-test' }, status))
  for (status of [401, 403, 503]) {
    await assert.rejects(loadServiceConfig(), (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.status, status)
      assert.equal(error.requestId, 'config-test')
      assert.equal(error.message, '请检查服务器配置。')
      return true
    })
  }
})
