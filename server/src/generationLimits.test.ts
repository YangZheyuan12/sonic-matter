import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { AuthStore } from './authStore.ts'
import { ServiceConfigStore } from './serviceConfigStore.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'sonic-limit-api-'))
Object.assign(process.env, {
  SONIC_MATTER_TEST: '1', NODE_ENV: 'development', LOG_LEVEL: 'error',
  AUTH_DIR: path.join(dir, 'auth'), PROJECTS_DIR: path.join(dir, 'projects'), DATA_DIR: path.join(dir, 'generated'),
  SONIC_CONFIG_KEY: 'e'.repeat(64), CORS_ORIGIN: '', AUTH_ORIGIN: '',
  MUSIC_DAILY_LIMIT: '2', SFX_DAILY_LIMIT: '3', GENERATION_RATE_PER_MINUTE: '4', GENERATION_MAX_CONCURRENT: '1',
  PROVIDER_RETRY_ATTEMPTS: '3', OPENAI_API_KEY: '', MUSIC_REPLICATE_MODEL: 'meta/musicgen',
})
delete process.env.SERVE_WEB
const accounts = new AuthStore(process.env.AUTH_DIR!)
accounts.initializeFixedAccounts({ admin: 'limit-admin-password', user: 'limit-user-password' })
const config = new ServiceConfigStore(process.env.AUTH_DIR!, process.env.SONIC_CONFIG_KEY)
const secret = 'synthetic-platform-secret'
config.update({ replicate: secret, elevenlabs: secret })
const { app, closeStores } = await import('./index.ts')
const server = app.listen(0, '127.0.0.1')
const originalFetch = globalThis.fetch
let base = ''
let providerCalls = 0
let mode: 'hold' | 'success' | 'failure' | 'abort' = 'success'
let release: () => void = () => undefined
let entered: () => void = () => undefined
const usagePath = path.join(process.env.AUTH_DIR!, 'generation-usage.db')
const music = { prompt: 'private-test-prompt', duration_seconds: 10 }
const sfx = { description: 'private-test-description', mixer: { length: 2, density: 50, brightness: 50, space: 50, compact: 50 } }
const cookie = (role: 'admin' | 'user') => `sonic-session=${accounts.createSession(role).token}`
const post = (route: string, body: unknown, session = cookie('user'), signal?: AbortSignal) => originalFetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-sonic-auth': '1', cookie: session }, body: JSON.stringify(body), signal,
})

before(async () => {
  await new Promise<void>(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  globalThis.fetch = (async (url, init: RequestInit = {}) => {
    providerCalls++
    if (mode === 'hold') { entered(); await new Promise<void>(resolve => { release = resolve }) }
    if (mode === 'abort') {
      entered()
      await new Promise<void>((_resolve, reject) => {
        if (init.signal?.aborted) return reject(init.signal.reason)
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })
    }
    if (mode === 'failure') return new Response('{}', { status: 503 })
    if (String(url).includes('api.replicate.com')) return new Response(JSON.stringify({ status: 'succeeded', output: 'https://replicate.delivery/limit.wav' }), { headers: { 'content-type': 'application/json' } })
    return new Response(new Uint8Array([82, 73, 70, 70]))
  }) as typeof fetch
})
after(async () => {
  globalThis.fetch = originalFetch
  await new Promise<void>(resolve => server.close(() => resolve()))
  closeStores(); accounts.close(); config.close(); rmSync(dir, { recursive: true, force: true })
})

test('接口拒绝未登录/非法参数/未配置时不占额度，付费并发只允许一个任务', async () => {
  assert.equal((await post('/api/music/generate', music, '')).status, 401)
  assert.equal((await post('/api/music/generate', { ...music, apiKey: secret })).status, 400)
  config.update({ replicate: null })
  assert.equal((await post('/api/music/generate', music)).status, 503)
  config.update({ replicate: secret })
  assert.equal(providerCalls, 0)
  mode = 'hold'
  const started = new Promise<void>(resolve => { entered = resolve })
  const first = post('/api/music/generate', music)
  await started
  const denied = await post('/api/sfx/generate', sfx, cookie('admin'))
  assert.equal(denied.status, 429)
  assert.equal((await denied.json()).code, 'generation_busy')
  assert.ok(Number(denied.headers.get('retry-after')) > 0)
  assert.equal(providerCalls, 1)
  mode = 'success'; release()
  assert.equal((await first).status, 200)
})

test('供应商 503 仅调用一次且计数，管理员和使用者共享全站每日音乐额度', async () => {
  mode = 'failure'
  const before = providerCalls
  assert.equal((await post('/api/music/generate', music)).status, 502)
  assert.equal(providerCalls - before, 1)
  for (const role of ['admin', 'user'] as const) {
    const denied = await post('/api/music/generate', music, cookie(role))
    assert.equal(denied.status, 429); assert.equal((await denied.json()).code, 'quota_exceeded')
    assert.ok(Number(denied.headers.get('retry-after')) > 0)
  }
  assert.equal(providerCalls - before, 1)
})

test('音效独立额度，失败后槽位释放，两种服务共享分钟限流且拒绝不会打上游', async () => {
  mode = 'failure'
  assert.equal((await post('/api/sfx/generate', sfx)).status, 502)
  mode = 'success'
  assert.equal((await post('/api/sfx/generate', sfx)).status, 200)
  const before = providerCalls
  const denied = await post('/api/sfx/generate', sfx)
  assert.equal(denied.status, 429); assert.equal((await denied.json()).code, 'generation_rate_limited')
  assert.equal(providerCalls, before)
})

test('客户端取消被记录且不退额度，数据库不记录提示词或密钥', async () => {
  const db = new DatabaseSync(usagePath)
  db.prepare('UPDATE generation_calls SET started_at=started_at-61000').run()
  mode = 'abort'
  const started = new Promise<void>(resolve => { entered = resolve })
  const canceled = new AbortController()
  const request = post('/api/sfx/generate', sfx, cookie('user'), canceled.signal)
  const rejected = assert.rejects(request)
  await started; canceled.abort(); await rejected
  // 等待服务器收到 TCP 断连并落盘，超时会明确失败。
  for (let i = 0; i < 100; i++) {
    const running = db.prepare("SELECT COUNT(*) AS n FROM generation_calls WHERE outcome='running'").get()?.n
    if (running === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM generation_calls WHERE outcome='running'").get()?.n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM generation_calls WHERE outcome='canceled'").get()?.n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_calls').get()?.n, 5)
  const denied = await post('/api/sfx/generate', sfx)
  assert.equal(denied.status, 429); assert.equal((await denied.json()).code, 'quota_exceeded')
  db.close()
  closeStores()
  const file = readFileSync(usagePath)
  for (const value of [secret, music.prompt, sfx.description]) assert.equal(file.includes(Buffer.from(value)), false)
})
