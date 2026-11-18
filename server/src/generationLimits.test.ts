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
  SFX_DAILY_LIMIT: '3', GENERATION_RATE_PER_MINUTE: '100', GENERATION_MAX_CONCURRENT: '1',
  PROVIDER_RETRY_ATTEMPTS: '3', OPENAI_API_KEY: '',
})
delete process.env.SERVE_WEB
const accounts = new AuthStore(process.env.AUTH_DIR!)
accounts.initializeFixedAccounts({ admin: 'limit-admin-password', user: 'limit-user-password' })
const config = new ServiceConfigStore(process.env.AUTH_DIR!, process.env.SONIC_CONFIG_KEY)
const secret = 'synthetic-platform-secret'
config.update({ elevenlabs: secret })
const { app, closeStores } = await import('./index.ts')
const server = app.listen(0, '127.0.0.1')
const originalFetch = globalThis.fetch
let base = ''
let providerCalls = 0
let mode: 'hold' | 'success' | 'failure' | 'abort' = 'success'
let release: () => void = () => undefined
let entered: () => void = () => undefined
const usagePath = path.join(process.env.AUTH_DIR!, 'generation-usage.db')
const sfx = { description: 'private-test-description', mixer: { length: 2, density: 50, brightness: 50, space: 50, compact: 50 } }
const cookie = (role: 'admin' | 'user') => `sonic-session=${accounts.createSession(role).token}`
const post = (body: unknown, session = cookie('user'), signal?: AbortSignal) => originalFetch(base + '/api/sfx/generate', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-sonic-auth': '1', cookie: session }, body: JSON.stringify(body), signal,
})

before(async () => {
  await new Promise<void>(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  globalThis.fetch = (async (_url, init: RequestInit = {}) => {
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
    return new Response(new Uint8Array([73, 68, 51]), { headers: { 'content-type': 'audio/mpeg' } })
  }) as typeof fetch
})
after(async () => {
  globalThis.fetch = originalFetch
  await new Promise<void>(resolve => server.close(() => resolve()))
  closeStores(); accounts.close(); config.close(); rmSync(dir, { recursive: true, force: true })
})

test('音效接口拒绝未登录、非法参数和未配置请求，且付费并发只允许一个任务', async () => {
  assert.equal((await post(sfx, '')).status, 401)
  assert.equal((await post({ ...sfx, apiKey: secret })).status, 400)
  config.update({ elevenlabs: null })
  assert.equal((await post(sfx)).status, 503)
  config.update({ elevenlabs: secret })
  assert.equal(providerCalls, 0)
  mode = 'hold'
  const started = new Promise<void>(resolve => { entered = resolve })
  const first = post(sfx)
  await started
  const denied = await post(sfx, cookie('admin'))
  assert.equal(denied.status, 429)
  assert.equal((await denied.json()).code, 'generation_busy')
  assert.ok(Number(denied.headers.get('retry-after')) > 0)
  assert.equal(providerCalls, 1)
  mode = 'success'; release()
  assert.equal((await first).status, 200)
})

test('供应商 503 不自动重试且计入全站音效日额度', async () => {
  mode = 'failure'
  const before = providerCalls
  assert.equal((await post(sfx)).status, 502)
  assert.equal((await post(sfx, cookie('admin'))).status, 502)
  assert.equal(providerCalls - before, 2)
  for (const role of ['admin', 'user'] as const) {
    const denied = await post(sfx, cookie(role))
    assert.equal(denied.status, 429); assert.equal((await denied.json()).code, 'quota_exceeded')
    assert.ok(Number(denied.headers.get('retry-after')) > 0)
  }
  assert.equal(providerCalls - before, 2)
})

test('客户端取消会被记录且不写入提示词或密钥', async () => {
  const db = new DatabaseSync(usagePath)
  db.prepare('UPDATE generation_calls SET started_at=started_at-86400000').run()
  mode = 'abort'
  const started = new Promise<void>(resolve => { entered = resolve })
  const canceled = new AbortController()
  const request = post(sfx, cookie('user'), canceled.signal)
  const rejected = assert.rejects(request)
  await started; canceled.abort(); await rejected
  for (let i = 0; i < 100; i++) {
    const running = db.prepare("SELECT COUNT(*) AS n FROM generation_calls WHERE outcome='running'").get()?.n
    if (running === 0) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM generation_calls WHERE outcome='running'").get()?.n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM generation_calls WHERE outcome='canceled'").get()?.n, 1)
  db.close()
  closeStores()
  const file = readFileSync(usagePath)
  for (const value of [secret, sfx.description]) assert.equal(file.includes(Buffer.from(value)), false)
})
