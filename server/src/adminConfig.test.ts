import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { AuthStore } from './authStore.ts'
import { createAuth } from './auth.ts'
import { adminConfigRouter } from './adminConfig.ts'
import { ServiceConfigStore } from './serviceConfigStore.ts'
import { errorHandler, requestContext } from './http.ts'

const tokens = { replicate: 'test-replicate-provider-key', elevenlabs: 'test-elevenlabs-provider-key' }
async function fixture(t: TestContext, protection = 'a'.repeat(64)) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sonic-admin-config-'))
  const accounts = new AuthStore(dir)
  accounts.initializeFixedAccounts({ admin: 'admin-test-password', user: 'user-test-password' })
  const config = new ServiceConfigStore(dir, protection)
  const auth = createAuth(accounts, { secureCookie: false })
  const app = express()
  app.use(requestContext(), express.json())
  app.use('/api/auth', auth.router)
  app.use('/api/admin/service-config', adminConfigRouter(config, auth))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    config.close(); accounts.close(); rmSync(dir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const request = (init: RequestInit = {}) => fetch(`${base}/api/admin/service-config`, init)
  const cookie = (role: 'admin' | 'user') => `sonic-session=${accounts.createSession(role).token}`
  const save = (body: unknown, cookieValue = cookie('admin'), headers: Record<string, string> = {}) => request({
    method: 'PUT', headers: { cookie: cookieValue, 'content-type': 'application/json', 'x-sonic-auth': '1', ...headers }, body: JSON.stringify(body),
  })
  return { config, accounts, request, cookie, save, base }
}

test('管理员配置 GET 和 PUT 均拒绝访客与普通用户，伪造角色无法提权', async t => {
  const f = await fixture(t)
  for (const method of ['GET', 'PUT']) {
    assert.equal((await f.request({ method })).status, 401)
    const response = await f.request({ method, headers: { cookie: f.cookie('user'), 'x-role': 'admin' } })
    assert.equal(response.status, 403)
    assert.equal((await response.json() as { code: string }).code, 'forbidden')
  }
  assert.equal(f.config.status().providers.replicate.configured, false)
})

test('管理员保存、读取状态、更新和删除只返回元数据，不返回任何密钥', async t => {
  const f = await fixture(t)
  const admin = f.cookie('admin')
  const saved = await f.save(tokens, admin)
  assert.equal(saved.status, 200)
  assert.equal(saved.headers.get('cache-control'), 'no-store')
  const state = await saved.json()
  assert.deepEqual(Object.keys(state).sort(), ['encryptionReady', 'providers'])
  assert.equal(state.providers.replicate.configured, true)
  const read = await f.request({ headers: { cookie: admin } })
  assert.deepEqual(await read.json(), state)
  assert.equal(JSON.stringify(state).includes(tokens.replicate), false)
  assert.equal(JSON.stringify(state).includes('ciphertext'), false)
  assert.equal((await f.save({ replicate: 'replacement-replicate-key' }, admin)).status, 200)
  assert.equal(f.config.readKey('elevenlabs'), tokens.elevenlabs)
  assert.equal((await f.save({ replicate: null }, admin)).status, 200)
  assert.equal(f.config.readKey('replicate'), null)
})

test('管理员写配置仍需保护头、同源和 JSON；拒绝 CSRF 不会修改数据', async t => {
  const f = await fixture(t)
  const admin = f.cookie('admin')
  const rejectedHeaders: Record<string, string>[] = [{ 'x-sonic-auth': '' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]
  for (const headers of rejectedHeaders) {
    assert.equal((await f.save(tokens, admin, headers)).status, 403)
  }
  assert.equal((await f.save(tokens, admin, { 'content-type': 'text/plain' })).status, 400)
  assert.equal(f.config.status().providers.replicate.configured, false)
  assert.equal((await f.save(tokens, admin, { origin: f.base })).status, 200)
})

test('非法输入错误使用统一信封，未知字段及其值不会出现在响应中', async t => {
  const f = await fixture(t)
  const admin = f.cookie('admin')
  for (const body of [{}, { replicate: 'tiny' }, { replicate: 'x'.repeat(501) }, { [tokens.replicate]: tokens.elevenlabs }, { replicate: tokens.replicate, openai: tokens.elevenlabs }]) {
    const response = await f.save(body, admin)
    assert.equal(response.status, 400)
    const payload = await response.json()
    assert.equal(payload.code, 'bad_request')
    assert.ok(payload.requestId)
    assert.equal(JSON.stringify(payload).includes(tokens.replicate), false)
    assert.equal(JSON.stringify(payload).includes(tokens.elevenlabs), false)
  }
  assert.equal(f.config.status().providers.replicate.configured, false)
})

test('缺少保护参数返回 503；撤销的管理员会话不能读取或修改配置', async t => {
  const f = await fixture(t, '')
  const admin = f.cookie('admin')
  const state = await f.request({ headers: { cookie: admin } })
  assert.equal((await state.json()).encryptionReady, false)
  const response = await f.save(tokens, admin)
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'provider_not_configured')
  f.accounts.revokeSession(admin.split('=')[1])
  assert.equal((await f.request({ headers: { cookie: admin } })).status, 401)
  assert.equal((await f.save(tokens, admin)).status, 401)
})
