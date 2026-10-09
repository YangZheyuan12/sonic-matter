import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { AuthStore, SESSION_TTL_MS } from './authStore.ts'
import { ServiceConfigStore } from './serviceConfigStore.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'sonic-platform-'))
const encryptionKey = 'c'.repeat(64)
Object.assign(process.env, {
  SONIC_MATTER_TEST: '1', NODE_ENV: 'development', LOG_LEVEL: 'error',
  AUTH_DIR: path.join(dir, 'auth'), PROJECTS_DIR: path.join(dir, 'projects'), DATA_DIR: path.join(dir, 'generated'),
  SONIC_CONFIG_KEY: encryptionKey, OPENAI_API_KEY: '', REPLICATE_API_TOKEN: 'ignored-legacy-replicate', ELEVENLABS_API_KEY: 'ignored-legacy-elevenlabs',
  MUSIC_REPLICATE_MODEL: 'meta/musicgen', CORS_ORIGIN: '', AUTH_ORIGIN: '', PROVIDER_RETRY_ATTEMPTS: '1',
  MUSIC_DAILY_LIMIT: '1000', SFX_DAILY_LIMIT: '1000', GENERATION_RATE_PER_MINUTE: '1000', GENERATION_MAX_CONCURRENT: '2',
})
delete process.env.SERVE_WEB
const accounts = new AuthStore(process.env.AUTH_DIR!)
accounts.initializeFixedAccounts({ admin: 'platform-admin-password', user: 'platform-user-password' })
const config = new ServiceConfigStore(process.env.AUTH_DIR!, encryptionKey)
const tokens = { replicate: 'test-platform-replicate-secret', elevenlabs: 'test-platform-elevenlabs-secret' }
const { app, closeStores } = await import('./index.ts')
const server = app.listen(0, '127.0.0.1')
let base = ''
const actualFetch = globalThis.fetch
const calls: { url: string; init: RequestInit }[] = []
let mode: 'success' | 'failure' | 'denied' = 'success'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

before(async () => {
  await new Promise<void>(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  globalThis.fetch = ((url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url)
    if (target.startsWith(base)) return actualFetch(url, init)
    calls.push({ url: target, init })
    if (target.startsWith('https://api.replicate.com/v1/models/')) {
      return Promise.resolve(mode === 'denied' ? json({}, 401) : json(mode === 'failure'
        ? { id: 'test-id', status: 'failed', error: `leaked ${tokens.replicate}` }
        : { id: 'test-id', status: 'succeeded', output: 'https://replicate.delivery/test/audio.wav' }))
    }
    if (target === 'https://replicate.delivery/test/audio.wav') return Promise.resolve(new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'content-type': 'audio/wav' } }))
    if (target === 'https://api.elevenlabs.io/v1/sound-generation') return Promise.resolve(mode === 'denied' ? json({}, 401) : new Response(new Uint8Array([73, 68, 51]), { headers: { 'content-type': 'audio/mpeg' } }))
    throw new Error('Unexpected outbound destination')
  }) as typeof fetch
})
after(async () => {
  globalThis.fetch = actualFetch
  await new Promise<void>(resolve => server.close(() => resolve()))
  accounts.close(); config.close(); closeStores(); rmSync(dir, { recursive: true, force: true })
})

const payloads = {
  '/api/music/generate': { prompt: '展示用音乐', duration_seconds: 10 },
  '/api/sfx/generate': { description: '展示用音效', mixer: { length: 2, density: 50, brightness: 50, space: 50, compact: 50 } },
}
const cookie = (role: 'admin' | 'user', now = Date.now()) => `sonic-session=${accounts.createSession(role, undefined, now).token}`
const post = (route: string, body: unknown, session?: string, headers: Record<string, string> = {}) => actualFetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-sonic-auth': '1', ...(session ? { cookie: session } : {}), ...headers }, body: JSON.stringify(body),
})

test('真实应用两条付费接口均拒绝访客、伪造身份、已退出和过期会话，且不调用上游', async () => {
  calls.length = 0
  const expired = cookie('user', Date.now() - SESSION_TTL_MS - 1000)
  const revoked = cookie('user'); accounts.revokeSession(revoked.split('=')[1])
  for (const [route, body] of Object.entries(payloads)) {
    for (const session of [undefined, 'sonic-session=forged', expired, revoked]) {
      const response = await post(route, body, session)
      assert.equal(response.status, 401)
      assert.equal((await response.json()).code, 'unauthorized')
    }
  }
  assert.equal(calls.length, 0)
})

test('有会话仍拒绝跨站、缺少保护头或非 JSON 请求，拒绝客户端供应商配置且不泄露其值', async () => {
  calls.length = 0
  const user = cookie('user')
  for (const [route, body] of Object.entries(payloads)) {
    const invalidHeaders: Record<string, string>[] = [{ 'x-sonic-auth': '' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]
    for (const headers of invalidHeaders) assert.equal((await post(route, body, user, headers)).status, 403)
    assert.equal((await post(route, body, user, { 'content-type': 'text/plain' })).status, 400)
    const legacy = route.includes('music') ? 'music' : 'sfx'
    const response = await post(route, { ...body, [legacy]: { apiKey: 'malicious-secret', baseUrl: 'https://evil.example', model: 'expensive/other-model' } }, user)
    assert.equal(response.status, 400)
    assert.equal((await response.text()).includes('malicious-secret'), false)
  }
  assert.equal(calls.length, 0)
})

test('未配置时返回 503，旧环境密钥不能绕过管理员配置', async () => {
  calls.length = 0
  const user = cookie('user')
  for (const [route, body] of Object.entries(payloads)) {
    const response = await post(route, body, user)
    assert.equal(response.status, 503)
    assert.equal((await response.json()).code, 'provider_not_configured')
  }
  assert.equal(calls.length, 0)
})

test('管理员和使用者均能用加密平台密钥生成音频，密钥仅送官方接口，不送下载地址或客户端', async () => {
  config.update(tokens)
  for (const role of ['admin', 'user'] as const) {
    calls.length = 0
    const session = cookie(role)
    for (const [route, body] of Object.entries(payloads)) {
      const response = await post(route, body, session)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const generated = await response.json()
      assert.match(generated.url, /^\/generated\//)
      assert.equal(generated.source, 'audio-model')
      assert.equal(JSON.stringify(generated).includes(tokens.replicate), false)
      assert.equal(JSON.stringify(generated).includes(tokens.elevenlabs), false)
      const audio = await actualFetch(base + generated.url)
      assert.equal(audio.status, 200)
      assert.ok((await audio.arrayBuffer()).byteLength)
    }
    assert.equal(calls.length, 3)
    assert.equal(calls[0].url, 'https://api.replicate.com/v1/models/meta/musicgen/predictions')
    assert.equal(new Headers(calls[0].init.headers).get('authorization'), `Bearer ${tokens.replicate}`)
    assert.equal(new Headers(calls[1].init.headers).get('authorization'), null)
    assert.equal(new Headers(calls[2].init.headers).get('xi-api-key'), tokens.elevenlabs)
    for (const call of [calls[0], calls[2]]) assert.equal(call.init.redirect, 'error')
  }
})

test('更新与清除平台密钥立即生效，清除后不退回环境变量，另一服务不受影响', async () => {
  const user = cookie('user')
  config.update({ replicate: 'rotated-platform-test-key' })
  calls.length = 0
  assert.equal((await post('/api/music/generate', payloads['/api/music/generate'], user)).status, 200)
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer rotated-platform-test-key')
  config.update({ replicate: null })
  calls.length = 0
  assert.equal((await post('/api/music/generate', payloads['/api/music/generate'], user)).status, 503)
  assert.equal(calls.length, 0)
  assert.equal((await post('/api/sfx/generate', payloads['/api/sfx/generate'], user)).status, 200)
  config.update(tokens)
})

test('供应商拒绝和失败返回统一错误且不会把供应商原文或密钥返回客户端', async () => {
  const user = cookie('user')
  mode = 'denied'
  for (const [route, body] of Object.entries(payloads)) {
    const response = await post(route, body, user)
    assert.equal(response.status, 502)
    const error = await response.json()
    assert.equal(error.code, 'provider_unauthorized')
    assert.ok(error.requestId)
    assert.equal(JSON.stringify(error).includes(tokens.replicate), false)
  }
  mode = 'failure'
  const response = await post('/api/music/generate', payloads['/api/music/generate'], user)
  assert.equal(response.status, 502)
  const error = await response.json()
  assert.equal(error.code, 'provider_unavailable')
  assert.equal(JSON.stringify(error).includes(tokens.replicate), false)
  mode = 'success'
})

test('访客本地 fallback、声音计划和 MIDI 导出保持可用', async () => {
  const concept = await post('/api/concept/interpret', { concept: '潮汐' })
  assert.equal(concept.status, 200); assert.equal((await concept.json()).source, 'fallback')
  const plan = await post('/api/sfx/plan', payloads['/api/sfx/generate'])
  assert.equal(plan.status, 200); assert.equal((await plan.json()).source, 'fallback')
  const project = { title: '测试', tempo: 92, key: 'C Major', duration: 2, tracks: [{ id: 'm', name: 'Melody', kind: 'midi', instrument: 'Piano', color: '#fff', notes: [{ id: 'n', pitch: 60, start: 0, duration: .5, velocity: 90 }] }] }
  const musicPlan = await post('/api/music/plan', { project, prompt: '潮汐' })
  assert.equal(musicPlan.status, 200); assert.equal((await musicPlan.json()).source, 'fallback')
  const midi = await post('/api/export/midi', { project })
  assert.equal(midi.status, 200)
  assert.equal(Buffer.from(await midi.arrayBuffer()).subarray(0, 4).toString(), 'MThd')
})

test('密文无法解密时拒绝生成而不使用旧环境密钥或调用供应商', async () => {
  const db = new DatabaseSync(config.databasePath)
  db.prepare('UPDATE service_config SET tag = ? WHERE provider = ?').run(Buffer.alloc(16).toString('base64'), 'replicate')
  db.close()
  calls.length = 0
  const response = await post('/api/music/generate', payloads['/api/music/generate'], cookie('user'))
  assert.equal(response.status, 500)
  assert.equal((await response.json()).code, 'internal_error')
  assert.equal(calls.length, 0)
})
