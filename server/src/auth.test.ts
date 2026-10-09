import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createAuth } from './auth.ts'
import { AuthStore, SESSION_TTL_MS, LOGIN_WINDOW_MS } from './authStore.ts'
import { errorHandler, requestContext } from './http.ts'

const passwords = { admin: 'test-admin-password-2026!', user: 'test-user-password-2026!' }

async function fixture(t: TestContext, secureCookie = false, origin?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sonic-auth-http-'))
  const store = new AuthStore(dir)
  store.initializeFixedAccounts(passwords)
  let clock = Date.now()
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(requestContext(), express.json())
  const auth = createAuth(store, { secureCookie, origin, now: () => clock })
  app.use('/api/auth', auth.router)
  app.get('/private', auth.requireAccount, (req, res) => res.json(req.auth))
  app.get('/admin', ...auth.requireRole('admin'), (_req, res) => res.json({ ok: true }))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const request = (url: string, init: RequestInit = {}) => fetch(base + url, init)
  const login = (username: string, password: string, headers: Record<string, string> = {}) =>
    request('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-sonic-auth': '1', ...headers },
      body: JSON.stringify({ username, password }),
    })
  return { store, base, request, login, advance: (ms: number) => { clock += ms } }
}

const cookieOf = (response: Response) => {
  const header = response.headers.get('set-cookie')
  assert.ok(header)
  return header.split(';')[0]
}

test('登录、查询身份、退出构成完整会话流程，退出令牌无法重放', async t => {
  const f = await fixture(t)
  const anonymous = await f.request('/api/auth/me')
  assert.deepEqual(await anonymous.json(), { account: null, expiresAt: null })
  const login = await f.login('user', passwords.user)
  assert.equal(login.status, 200)
  assert.equal(login.headers.get('cache-control'), 'no-store')
  assert.match(login.headers.get('set-cookie')!, /HttpOnly/)
  assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/)
  assert.match(login.headers.get('set-cookie')!, /Path=\//)
  const body = await login.json() as { account: { username: string; role: string }; expiresAt: number }
  assert.equal(body.account.username, 'user')
  assert.equal(body.account.role, 'user')
  assert.equal(JSON.stringify(body).includes('password'), false)
  assert.equal(JSON.stringify(body).includes('token'), false)
  const cookie = cookieOf(login)
  const me = await f.request('/api/auth/me', { headers: { cookie } })
  assert.deepEqual(await me.json(), body)
  assert.equal((await f.request('/private', { headers: { cookie } })).status, 200)
  const logout = await f.request('/api/auth/logout', {
    method: 'POST', headers: { cookie, 'x-sonic-auth': '1', 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/)
  assert.equal((await f.request('/private', { headers: { cookie } })).status, 401)
  assert.equal((await f.request('/api/auth/logout', {
    method: 'POST', headers: { 'x-sonic-auth': '1', 'content-type': 'application/json' }, body: '{}',
  })).status, 200)
})

test('错误密码和未知账号均返回统一 401，超长和伪造角色参数被拒绝', async t => {
  const f = await fixture(t)
  for (const [username, password] of [['user', 'wrong'], ['nobody', passwords.user]]) {
    const response = await f.login(username, password)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('set-cookie'), null)
    const body = await response.json() as { code: string; requestId: string }
    assert.equal(body.code, 'unauthorized')
    assert.equal(typeof body.requestId, 'string')
  }
  assert.equal((await f.login('user', 'x'.repeat(257))).status, 400)
  const forgedRole = await f.request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-sonic-auth': '1' },
    body: JSON.stringify({ username: 'user', password: passwords.user, role: 'admin' }),
  })
  assert.equal(forgedRole.status, 400)
})

test('会话角色来自数据库，访客为 401、使用者不能访问管理员接口', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/admin')).status, 401)
  const user = cookieOf(await f.login('user', passwords.user))
  const denied = await f.request('/admin', { headers: { cookie: user } })
  assert.equal(denied.status, 403)
  assert.equal((await denied.json() as { code: string }).code, 'forbidden')
  const admin = cookieOf(await f.login('admin', passwords.admin))
  assert.equal((await f.request('/admin', { headers: { cookie: admin } })).status, 200)
})

test('会话绝对过期、重新登录轮换令牌、独立浏览器会话可并存', async t => {
  const f = await fixture(t)
  const first = cookieOf(await f.login('user', passwords.user))
  const independent = cookieOf(await f.login('user', passwords.user))
  const rotated = cookieOf(await f.login('user', passwords.user, { cookie: first }))
  assert.notEqual(first, rotated)
  assert.equal((await f.request('/private', { headers: { cookie: first } })).status, 401)
  for (const cookie of [independent, rotated]) {
    assert.equal((await f.request('/private', { headers: { cookie } })).status, 200)
  }
  f.advance(SESSION_TTL_MS)
  const expired = await f.request('/api/auth/me', { headers: { cookie: rotated } })
  assert.deepEqual(await expired.json(), { account: null, expiresAt: null })
  assert.match(expired.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/)
  assert.equal((await f.request('/private', { headers: { cookie: independent } })).status, 401)
})

test('跨站请求、普通表单、缺少保护头的登录和退出被拒绝', async t => {
  const f = await fixture(t)
  assert.equal((await f.login('user', passwords.user, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await f.login('user', passwords.user, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await f.request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'user', password: passwords.user }),
  })).status, 403)
  assert.equal((await f.login('user', passwords.user, { 'content-type': 'application/x-www-form-urlencoded' })).status, 400)
  const cookie = cookieOf(await f.login('user', passwords.user, { origin: f.base }))
  assert.equal((await f.request('/api/auth/logout', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-sonic-auth': '1', origin: 'https://evil.example' },
    body: '{}',
  })).status, 403)
  assert.equal((await f.request('/private', { headers: { cookie } })).status, 200)
})

test('生产模式仅允许 HTTPS 登录，Cookie 带 Secure 与 __Host 前缀', async t => {
  const f = await fixture(t, true)
  assert.equal((await f.login('admin', passwords.admin)).status, 403)
  const response = await f.login('admin', passwords.admin, { 'x-forwarded-proto': 'https' })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('set-cookie')!, /^__Host-sonic-session=/)
  assert.match(response.headers.get('set-cookie')!, /; Secure;/)
  assert.equal(response.headers.get('set-cookie')!.includes('Domain='), false)
  const logout = await f.request('/api/auth/logout', {
    method: 'POST', headers: {
      cookie: cookieOf(response), 'content-type': 'application/json', 'x-sonic-auth': '1', 'x-forwarded-proto': 'https',
    }, body: '{}',
  })
  assert.equal(logout.status, 200)
  assert.match(logout.headers.get('set-cookie')!, /^__Host-sonic-session=/)
  assert.match(logout.headers.get('set-cookie')!, /; Secure;/)
})

test('配置生产 Origin 后，伪造 Host 不能改变允许的来源', async t => {
  const f = await fixture(t, true, 'https://8.141.109.141')
  assert.equal((await f.login('admin', passwords.admin, {
    'x-forwarded-proto': 'https', host: 'evil.example', origin: 'https://evil.example',
  })).status, 403)
  assert.equal((await f.login('admin', passwords.admin, {
    'x-forwarded-proto': 'https', origin: 'https://8.141.109.141',
  })).status, 200)
})

test('伪造、重复或损坏的 Cookie 不能获得身份', async t => {
  const f = await fixture(t)
  const valid = cookieOf(await f.login('user', passwords.user))
  for (const cookie of ['sonic-session=broken%', `sonic-session=${'a'.repeat(43)}`, `${valid}; ${valid}`]) {
    assert.equal((await f.request('/private', { headers: { cookie } })).status, 401)
  }
})

test('登录限流返回 429 和 Retry-After，窗口结束后可恢复', async t => {
  const f = await fixture(t)
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await f.login('user', 'wrong')).status, 401)
  }
  const limited = await f.login('admin', passwords.admin)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '900')
  assert.equal((await limited.json() as { code: string }).code, 'login_rate_limited')
  f.advance(LOGIN_WINDOW_MS)
  assert.equal((await f.login('user', passwords.user)).status, 200)
})
