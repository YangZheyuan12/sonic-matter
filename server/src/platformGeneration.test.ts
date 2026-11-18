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
  CORS_ORIGIN: '', AUTH_ORIGIN: '', PROVIDER_RETRY_ATTEMPTS: '1',
  SFX_DAILY_LIMIT: '1000', GENERATION_RATE_PER_MINUTE: '1000', GENERATION_MAX_CONCURRENT: '2',
})
delete process.env.SERVE_WEB
const accounts = new AuthStore(process.env.AUTH_DIR!)
accounts.initializeFixedAccounts({ admin: 'platform-admin-password', user: 'platform-user-password' })
const config = new ServiceConfigStore(process.env.AUTH_DIR!, encryptionKey)
const token = 'test-platform-elevenlabs-secret'
const { app, closeStores } = await import('./index.ts')
const server = app.listen(0, '127.0.0.1')
let base = ''
const actualFetch = globalThis.fetch
const calls: { url: string; init: RequestInit }[] = []
let mode: 'success' | 'denied' = 'success'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

before(async () => {
  await new Promise<void>(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  globalThis.fetch = ((url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url)
    if (target.startsWith(base)) return actualFetch(url, init)
    calls.push({ url: target, init })
    if (target === 'https://api.elevenlabs.io/v1/sound-generation') {
      return Promise.resolve(mode === 'denied' ? json({}, 401) : new Response(new Uint8Array([73, 68, 51]), { headers: { 'content-type': 'audio/mpeg' } }))
    }
    throw new Error(`Unexpected outbound destination: ${target}`)
  }) as typeof fetch
})
after(async () => {
  globalThis.fetch = actualFetch
  await new Promise<void>(resolve => server.close(() => resolve()))
  accounts.close(); config.close(); closeStores(); rmSync(dir, { recursive: true, force: true })
})

const payload = { description: '展示用音效', mixer: { length: 2, density: 50, brightness: 50, space: 50, compact: 50 } }
const cookie = (role: 'admin' | 'user', now = Date.now()) => `sonic-session=${accounts.createSession(role, undefined, now).token}`
const post = (route: string, body: unknown, session?: string, headers: Record<string, string> = {}) => actualFetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-sonic-auth': '1', ...(session ? { cookie: session } : {}), ...headers }, body: JSON.stringify(body),
})

test('旧音乐音频接口已移除，历史 Replicate 环境变量不能恢复能力', async () => {
  calls.length = 0
  const response = await post('/api/music/generate', { prompt: '潮汐', duration_seconds: 10 }, cookie('user'))
  assert.equal(response.status, 404)
  assert.equal((await response.json()).code, 'not_found')
  assert.equal(calls.length, 0)
})

test('真实音效接口拒绝访客、伪造身份、已退出和过期会话', async () => {
  calls.length = 0
  const expired = cookie('user', Date.now() - SESSION_TTL_MS - 1000)
  const revoked = cookie('user'); accounts.revokeSession(revoked.split('=')[1])
  for (const session of [undefined, 'sonic-session=forged', expired, revoked]) {
    const response = await post('/api/sfx/generate', payload, session)
    assert.equal(response.status, 401)
    assert.equal((await response.json()).code, 'unauthorized')
  }
  assert.equal(calls.length, 0)
})

test('有会话仍拒绝跨站、缺少保护头、非 JSON 和客户端供应商配置', async () => {
  calls.length = 0
  const user = cookie('user')
  const invalidHeaders: Record<string, string>[] = [{ 'x-sonic-auth': '' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]
  for (const headers of invalidHeaders) assert.equal((await post('/api/sfx/generate', payload, user, headers)).status, 403)
  assert.equal((await post('/api/sfx/generate', payload, user, { 'content-type': 'text/plain' })).status, 400)
  const response = await post('/api/sfx/generate', { ...payload, sfx: { apiKey: 'malicious-secret', baseUrl: 'https://evil.example', model: 'other-model' } }, user)
  assert.equal(response.status, 400)
  assert.equal((await response.text()).includes('malicious-secret'), false)
  assert.equal(calls.length, 0)
})

test('未配置时返回 503，旧环境密钥不能绕过管理员配置', async () => {
  calls.length = 0
  const response = await post('/api/sfx/generate', payload, cookie('user'))
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'provider_not_configured')
  assert.equal(calls.length, 0)
})

test('管理员和使用者都能使用加密密钥生成音效，密钥只发往官方接口', async () => {
  config.update({ elevenlabs: token })
  for (const role of ['admin', 'user'] as const) {
    calls.length = 0
    const response = await post('/api/sfx/generate', payload, cookie(role))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const generated = await response.json()
    assert.match(generated.url, /^\/generated\//)
    assert.equal(generated.provider, 'elevenlabs')
    assert.equal(generated.source, 'audio-model')
    assert.equal(JSON.stringify(generated).includes(token), false)
    const audio = await actualFetch(base + generated.url)
    assert.equal(audio.status, 200)
    assert.ok((await audio.arrayBuffer()).byteLength)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.elevenlabs.io/v1/sound-generation')
    assert.equal(new Headers(calls[0].init.headers).get('xi-api-key'), token)
    assert.equal(calls[0].init.redirect, 'error')
  }
})

test('更新与清除 ElevenLabs 密钥立即生效', async () => {
  const user = cookie('user')
  config.update({ elevenlabs: 'rotated-platform-test-key' })
  calls.length = 0
  assert.equal((await post('/api/sfx/generate', payload, user)).status, 200)
  assert.equal(new Headers(calls[0].init.headers).get('xi-api-key'), 'rotated-platform-test-key')
  config.update({ elevenlabs: null })
  calls.length = 0
  assert.equal((await post('/api/sfx/generate', payload, user)).status, 503)
  assert.equal(calls.length, 0)
  config.update({ elevenlabs: token })
})

test('供应商拒绝返回统一错误且不泄露密钥', async () => {
  mode = 'denied'
  const response = await post('/api/sfx/generate', payload, cookie('user'))
  assert.equal(response.status, 502)
  const error = await response.json()
  assert.equal(error.code, 'provider_unauthorized')
  assert.ok(error.requestId)
  assert.equal(JSON.stringify(error).includes(token), false)
  mode = 'success'
})

test('访客本地 fallback、声音计划、可编辑音乐计划和 MIDI 导出保持可用', async () => {
  const concept = await post('/api/concept/interpret', { concept: '潮汐' })
  assert.equal(concept.status, 200); assert.equal((await concept.json()).source, 'fallback')
  const plan = await post('/api/sfx/plan', payload)
  assert.equal(plan.status, 200); assert.equal((await plan.json()).source, 'fallback')
  const project = { title: '测试', tempo: 92, key: 'C Major', duration: 2, tracks: [{ id: 'm', name: 'Melody', kind: 'midi', instrument: 'Piano', color: '#fff', notes: [{ id: 'n', pitch: 60, start: 0, duration: .5, velocity: 90 }] }] }
  const musicPlan = await post('/api/music/plan', { project, prompt: '潮汐' })
  assert.equal(musicPlan.status, 200); assert.equal((await musicPlan.json()).source, 'fallback')
  const midi = await post('/api/export/midi', { project })
  assert.equal(midi.status, 200)
  assert.equal(Buffer.from(await midi.arrayBuffer()).subarray(0, 4).toString(), 'MThd')
})

test('密文无法解密时拒绝生成，不使用旧环境密钥或调用供应商', async () => {
  const db = new DatabaseSync(config.databasePath)
  db.prepare('UPDATE service_config SET tag = ? WHERE provider = ?').run(Buffer.alloc(16).toString('base64'), 'elevenlabs')
  db.close()
  calls.length = 0
  const response = await post('/api/sfx/generate', payload, cookie('user'))
  assert.equal(response.status, 500)
  assert.equal((await response.json()).code, 'internal_error')
  assert.equal(calls.length, 0)
})
