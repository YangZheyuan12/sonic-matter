import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { AuthStore, createRandomPassword, isStrongPassword, lockCredentialsFile, LOGIN_WINDOW_MS, SESSION_TTL_MS } from './authStore.ts'

const tempAuthDir = () => mkdtempSync(path.join(tmpdir(), 'sonic-auth-'))

test('会话及登录限流重启后仍有效，数据库仅存令牌哈希，禁用账号即时失效', t => {
  const dir = tempAuthDir()
  let store = new AuthStore(dir)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  store.initializeFixedAccounts({ admin: createRandomPassword(), user: createRandomPassword() })
  const session = store.createSession('user', undefined, 1000)
  for (let i = 0; i < 10; i++) assert.equal(store.consumeLoginAttempt('127.0.0.1', 'user', 1000), 0)
  store.close()
  assert.equal(readFileSync(path.join(dir, 'auth.db')).includes(Buffer.from(session.token)), false)
  store = new AuthStore(dir)
  assert.equal(store.getSession(session.token, 1001)?.account.role, 'user')
  assert.equal(store.getSession(session.token, 1000 + SESSION_TTL_MS), null)
  assert.equal(store.consumeLoginAttempt('127.0.0.1', 'admin', 1001), 900)
  assert.equal(store.consumeLoginAttempt('127.0.0.1', 'user', 1000 + LOGIN_WINDOW_MS), 0)
  const db = new DatabaseSync(path.join(dir, 'auth.db'))
  db.exec("UPDATE users SET enabled = 0 WHERE username = 'user'")
  db.close()
  assert.equal(store.getSession(session.token, 1002), null)
})

test('跨 IP 尝试仍受账号限流约束，会话数量有上限', t => {
  const dir = tempAuthDir()
  const store = new AuthStore(dir)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  store.initializeFixedAccounts({ admin: createRandomPassword(), user: createRandomPassword() })
  for (let i = 0; i < 30; i++) assert.equal(store.consumeLoginAttempt(`ip-${i}`, 'user', 1000), 0)
  assert.equal(store.consumeLoginAttempt('new-ip', 'user', 1001), 900)
  assert.equal(store.consumeLoginAttempt('new-ip', 'admin', 1001), 0)
  const sessions = Array.from({ length: 21 }, (_, i) => store.createSession('user', undefined, 1000 + i))
  assert.equal(store.getSession(sessions[0].token, 1021), null)
  assert.equal(store.getSession(sessions[20].token, 1021)?.account.username, 'user')
})

test('固定账号初始化只创建 admin 和 user，并且重复运行不重置密码', () => {
  const dir = tempAuthDir()
  const adminPassword = 'admin-password-2026!'
  const userPassword = 'user-password-2026!'
  const first = new AuthStore(dir)
  const created = first.initializeFixedAccounts({ admin: adminPassword, user: userPassword })
  assert.deepEqual(created.created, ['admin', 'user'])
  assert.deepEqual(created.accounts.map(account => [account.username, account.role]), [['admin', 'admin'], ['user', 'user']])
  assert.equal(first.verifyPassword('admin', adminPassword), true)
  assert.equal(first.verifyPassword('user', userPassword), true)
  assert.equal(first.verifyPassword('user', 'wrong-password'), false)
  first.close()

  const second = new AuthStore(dir)
  const repeated = second.initializeFixedAccounts({ admin: 'a-different-password-2026!', user: 'a-different-password-2026!' })
  assert.deepEqual(repeated.created, [])
  assert.equal(second.verifyPassword('admin', adminPassword), true)
  assert.equal(second.verifyPassword('user', userPassword), true)
  assert.equal(second.listAccounts().length, 2)
  second.close()
  rmSync(dir, { recursive: true, force: true })
})

test('缺少新账号密码时拒绝初始化，不写入半个账号', () => {
  const dir = tempAuthDir()
  const store = new AuthStore(dir)
  assert.throws(() => store.initializeFixedAccounts({ admin: 'admin-password-2026!' }), /user.*密码/)
  assert.deepEqual(store.listAccounts(), [])
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('凭据落盘失败时回滚账号事务', () => {
  const dir = tempAuthDir()
  const store = new AuthStore(dir)
  assert.throws(
    () => store.initializeFixedAccounts(
      { admin: 'admin-password-2026!', user: 'user-password-2026!' },
      () => { throw new Error('模拟凭据写入失败') },
    ),
    /模拟凭据写入失败/,
  )
  assert.deepEqual(store.listAccounts(), [])
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('凭据文件已存在时初始化命令拒绝创建账号', () => {
  const dir = tempAuthDir()
  const credentialsPath = path.join(dir, 'initial-credentials.txt')
  writeFileSync(credentialsPath, 'do not overwrite')
  const scriptPath = fileURLToPath(new URL('./auth-init.ts', import.meta.url))
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: dir,
    env: { ...process.env, AUTH_DIR: dir, AUTH_CREDENTIAL_FILE: credentialsPath },
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(credentialsPath, 'utf8'), 'do not overwrite')
  const store = new AuthStore(dir)
  assert.deepEqual(store.listAccounts(), [])
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('密码哈希不落明文，随机密码满足初始化长度，凭据文件可锁定', () => {
  const dir = tempAuthDir()
  const store = new AuthStore(dir)
  const password = createRandomPassword()
  assert.equal(isStrongPassword(password), true)
  store.initializeFixedAccounts({ admin: password, user: createRandomPassword() })
  store.close()
  const database = readFileSync(path.join(dir, 'auth.db'), 'utf8')
  assert.equal(database.includes(password), false)
  const credentials = path.join(dir, 'credentials.txt')
  writeFileSync(credentials, `admin: ${password}`)
  lockCredentialsFile(credentials)
  assert.equal(existsSync(credentials), true)
  if (process.platform !== 'win32') assert.equal(statSync(credentials).mode & 0o777, 0o600)
  rmSync(dir, { recursive: true, force: true })
})
