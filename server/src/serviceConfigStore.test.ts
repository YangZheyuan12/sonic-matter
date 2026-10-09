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
const tokens = { replicate: 'test-replicate-only-not-a-real-key', elevenlabs: 'test-elevenlabs-only-not-a-real-key' }
function fixture(t: TestContext, protection = key) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sonic-config-'))
  const store = new ServiceConfigStore(dir, protection)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, store }
}

test('密钥加密持久化，数据库、WAL 和状态响应不含明文', t => {
  const { dir, store } = fixture(t)
  const status = store.update(tokens)
  assert.equal(status.encryptionReady, true)
  for (const provider of ['replicate', 'elevenlabs'] as const) {
    assert.equal(store.readKey(provider), tokens[provider])
    assert.equal(status.providers[provider].configured, true)
    assert.ok(status.providers[provider].updatedAt)
    assert.equal(JSON.stringify(status).includes(tokens[provider]), false)
    for (const file of readdirSync(dir)) assert.equal(readFileSync(path.join(dir, file)).includes(Buffer.from(tokens[provider])), false)
  }
  if (process.platform !== 'win32') assert.equal(statSync(store.databasePath).mode & 0o777, 0o600)
  store.close()
  const reopened = new ServiceConfigStore(dir, key)
  try { assert.equal(reopened.readKey('elevenlabs'), tokens.elevenlabs) } finally { reopened.close() }
})

test('每次加密随机 IV，单项更新保留另一项，显式 null 才清除', t => {
  const { store } = fixture(t)
  store.update(tokens)
  const db = new DatabaseSync(store.databasePath)
  try {
    const before = db.prepare('SELECT * FROM service_config WHERE provider = ?').get('replicate')!
    const other = store.status().providers.elevenlabs
    store.update({ replicate: ` ${tokens.replicate} ` })
    const after = db.prepare('SELECT * FROM service_config WHERE provider = ?').get('replicate')!
    assert.notEqual(before.iv, after.iv)
    assert.notEqual(before.ciphertext, after.ciphertext)
    assert.equal(store.readKey('replicate'), tokens.replicate)
    assert.deepEqual(store.status().providers.elevenlabs, other)
    store.update({ replicate: null })
    assert.equal(store.readKey('replicate'), null)
    assert.deepEqual(store.status().providers.replicate, { configured: false, updatedAt: null })
    assert.equal(store.readKey('elevenlabs'), tokens.elevenlabs)
  } finally { db.close() }
})

test('缺少或无效保护参数拒绝保存；合法 32 字节 base64 可重开配置', t => {
  for (const invalid of ['', 'short', 'x'.repeat(64), crypto.randomBytes(16).toString('base64')]) {
    const { store } = fixture(t, invalid)
    assert.equal(store.status().encryptionReady, false)
    assert.throws(() => store.update(tokens), (error: unknown) => error instanceof AppError && error.status === 503)
    assert.equal(store.status().providers.replicate.configured, false)
  }
  const { dir, store } = fixture(t)
  store.update(tokens)
  const base64 = new ServiceConfigStore(dir, Buffer.from(key, 'hex').toString('base64'))
  try { assert.equal(base64.readKey('replicate'), tokens.replicate) } finally { base64.close() }
})

test('保护密钥错误时不能读取、覆盖或清除现有配置', t => {
  const { dir, store } = fixture(t)
  store.update(tokens)
  const wrong = new ServiceConfigStore(dir, crypto.randomBytes(32).toString('hex'))
  const rejected = (error: unknown) => error instanceof AppError && error.status === 500 && !error.message.includes(tokens.replicate)
  try {
    assert.throws(() => wrong.readKey('replicate'), rejected)
    assert.throws(() => wrong.update({ replicate: 'replacement-key-for-test', elevenlabs: null }), rejected)
    assert.equal(store.readKey('replicate'), tokens.replicate)
    assert.equal(store.readKey('elevenlabs'), tokens.elevenlabs)
  } finally { wrong.close() }
})

test('密文损坏或服务记录被交换时 GCM 认证拒绝读取和更新', t => {
  const { store } = fixture(t)
  store.update(tokens)
  const db = new DatabaseSync(store.databasePath)
  try {
    const row = db.prepare('SELECT ciphertext, iv, tag FROM service_config WHERE provider = ?').get('replicate')!
    db.prepare('UPDATE service_config SET ciphertext = ?, iv = ?, tag = ? WHERE provider = ?').run(row.ciphertext, row.iv, row.tag, 'elevenlabs')
    assert.throws(() => store.readKey('elevenlabs'), AppError)
    assert.throws(() => store.update({ replicate: 'should-never-be-saved' }), AppError)
    assert.equal(store.readKey('replicate'), tokens.replicate)
    db.prepare('UPDATE service_config SET tag = ? WHERE provider = ?').run(Buffer.alloc(16).toString('base64'), 'replicate')
    assert.throws(() => store.readKey('replicate'), AppError)
  } finally { db.close() }
})

test('第二项数据库写入失败会回滚整个配置更新', t => {
  const { store } = fixture(t)
  store.update(tokens)
  const db = new DatabaseSync(store.databasePath)
  try {
    db.exec(`CREATE TRIGGER reject_elevenlabs BEFORE UPDATE ON service_config
      WHEN NEW.provider = 'elevenlabs' BEGIN SELECT RAISE(ABORT, 'test-trigger'); END;`)
    assert.throws(() => store.update({ replicate: 'new-replicate-test-key', elevenlabs: 'new-elevenlabs-test-key' }))
    assert.equal(store.readKey('replicate'), tokens.replicate)
    assert.equal(store.readKey('elevenlabs'), tokens.elevenlabs)
  } finally { db.close() }
})

test('空对象、未知字段、短密钥、超长和包含空白字符的输入不会修改配置', t => {
  const { store } = fixture(t)
  store.update(tokens)
  for (const patch of [{}, { unknown: tokens.replicate }, { replicate: '' }, { replicate: 'tiny' }, { replicate: 'x'.repeat(501) }, { replicate: 'embedded\nnewline' }]) {
    assert.throws(() => store.update(patch))
    assert.equal(store.readKey('replicate'), tokens.replicate)
  }
})
