import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AppError } from './errors.ts'
import { ServiceConfigStore } from './serviceConfigStore.ts'

const key = crypto.randomBytes(32).toString('hex')
const token = 'test-elevenlabs-only-not-a-real-key'
function fixture(t: TestContext, protection = key) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sonic-config-'))
  const store = new ServiceConfigStore(dir, protection)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, store }
}

test('ElevenLabs 密钥加密持久化，数据库、WAL 和状态响应不含明文', t => {
  const { dir, store } = fixture(t)
  const status = store.update({ elevenlabs: token })
  assert.equal(status.encryptionReady, true)
  assert.equal(store.readKey('elevenlabs'), token)
  assert.equal(status.providers.elevenlabs.configured, true)
  assert.ok(status.providers.elevenlabs.updatedAt)
  assert.equal(JSON.stringify(status).includes(token), false)
  for (const file of readdirSync(dir)) assert.equal(readFileSync(path.join(dir, file)).includes(Buffer.from(token)), false)
  if (process.platform !== 'win32') assert.equal(statSync(store.databasePath).mode & 0o777, 0o600)
  store.close()
  const reopened = new ServiceConfigStore(dir, key)
  try { assert.equal(reopened.readKey('elevenlabs'), token) } finally { reopened.close() }
})

test('每次更新使用随机 IV，显式 null 才清除密钥', t => {
  const { store } = fixture(t)
  store.update({ elevenlabs: token })
  const db = new DatabaseSync(store.databasePath)
  try {
    const before = db.prepare('SELECT * FROM service_config WHERE provider = ?').get('elevenlabs')!
    store.update({ elevenlabs: ` ${token} ` })
    const after = db.prepare('SELECT * FROM service_config WHERE provider = ?').get('elevenlabs')!
    assert.notEqual(before.iv, after.iv)
    assert.notEqual(before.ciphertext, after.ciphertext)
    assert.equal(store.readKey('elevenlabs'), token)
    store.update({ elevenlabs: null })
    assert.equal(store.readKey('elevenlabs'), null)
    assert.deepEqual(store.status().providers.elevenlabs, { configured: false, updatedAt: null })
  } finally { db.close() }
})

test('旧版数据库中的 Replicate 密钥记录会在打开时删除', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sonic-legacy-config-'))
  const databasePath = path.join(dir, 'service-config.db')
  const db = new DatabaseSync(databasePath)
  db.exec(`CREATE TABLE service_config (
    provider TEXT PRIMARY KEY CHECK(provider IN ('replicate', 'elevenlabs')),
    ciphertext TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  db.prepare('INSERT INTO service_config VALUES (?, ?, ?, ?, ?)').run('replicate', 'legacy', 'legacy', 'legacy', new Date().toISOString())
  db.close()
  const store = new ServiceConfigStore(dir, key)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  assert.deepEqual(Object.keys(store.status().providers), ['elevenlabs'])
  const check = new DatabaseSync(databasePath)
  try { assert.equal(check.prepare("SELECT COUNT(*) AS n FROM service_config WHERE provider='replicate'").get()?.n, 0) } finally { check.close() }
})

test('缺少或无效保护参数拒绝保存；合法 32 字节 base64 可重开配置', t => {
  for (const invalid of ['', 'short', 'x'.repeat(64), crypto.randomBytes(16).toString('base64')]) {
    const { store } = fixture(t, invalid)
    assert.equal(store.status().encryptionReady, false)
    assert.throws(() => store.update({ elevenlabs: token }), (error: unknown) => error instanceof AppError && error.status === 503)
    assert.equal(store.status().providers.elevenlabs.configured, false)
  }
  const { dir, store } = fixture(t)
  store.update({ elevenlabs: token })
  const base64 = new ServiceConfigStore(dir, Buffer.from(key, 'hex').toString('base64'))
  try { assert.equal(base64.readKey('elevenlabs'), token) } finally { base64.close() }
})

test('保护密钥错误或密文损坏时不能读取、覆盖或清除现有配置', t => {
  const { dir, store } = fixture(t)
  store.update({ elevenlabs: token })
  const wrong = new ServiceConfigStore(dir, crypto.randomBytes(32).toString('hex'))
  const rejected = (error: unknown) => error instanceof AppError && error.status === 500 && !error.message.includes(token)
  try {
    assert.throws(() => wrong.readKey('elevenlabs'), rejected)
    assert.throws(() => wrong.update({ elevenlabs: null }), rejected)
    assert.equal(store.readKey('elevenlabs'), token)
  } finally { wrong.close() }
  const db = new DatabaseSync(store.databasePath)
  db.prepare('UPDATE service_config SET tag = ? WHERE provider = ?').run(Buffer.alloc(16).toString('base64'), 'elevenlabs')
  db.close()
  assert.throws(() => store.readKey('elevenlabs'), AppError)
  assert.throws(() => store.update({ elevenlabs: 'replacement-key-for-test' }), AppError)
})

test('空对象、已移除的 Replicate 字段和非法密钥不会修改配置', t => {
  const { store } = fixture(t)
  store.update({ elevenlabs: token })
  for (const patch of [{}, { replicate: token }, { elevenlabs: '' }, { elevenlabs: 'tiny' }, { elevenlabs: 'x'.repeat(501) }, { elevenlabs: 'embedded\nnewline' }]) {
    assert.throws(() => store.update(patch))
    assert.equal(store.readKey('elevenlabs'), token)
  }
})
