import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { GenerationLimitError, GenerationStore, defaultGenerationLimits, generationDayStart, readGenerationLimits } from './generationStore.ts'

function fixture(t: TestContext, overrides: Partial<typeof defaultGenerationLimits> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sonic-generation-'))
  const limits = { ...defaultGenerationLimits, ...overrides }
  const store = new GenerationStore(dir, limits)
  const other = new GenerationStore(dir, limits)
  t.after(() => { store.close(); other.close(); rmSync(dir, { recursive: true, force: true }) })
  return { dir, store, other }
}
const at = Date.parse('2026-10-09T12:00:00+08:00')
const blocked = (code: string) => (error: unknown) => {
  assert.ok(error instanceof GenerationLimitError)
  assert.equal(error.status, 429); assert.equal(error.code, code)
  assert.ok(error.retryAfter > 0); return true
}

test('全站音乐/音效额度独立，失败与取消计数，管理员与共享使用者均不能绕过', t => {
  const { store, other } = fixture(t, { musicDaily: 2, sfxDaily: 1, perMinute: 20 })
  const failed = store.reserve('user', 'replicate', 1000, at)
  store.finish(failed, 'failed', 'provider_unavailable', at)
  const canceled = other.reserve('admin', 'replicate', 1000, at)
  other.finish(canceled, 'canceled', 'client_closed_request', at)
  for (const account of ['admin', 'user', 'different-session']) {
    assert.throws(() => other.reserve(account, 'replicate', 1000, at), blocked('quota_exceeded'))
  }
  const sfx = store.reserve('user', 'elevenlabs', 1000, at)
  store.finish(sfx, 'succeeded', undefined, at)
  assert.throws(() => store.reserve('user', 'elevenlabs', 1000, at), blocked('quota_exceeded'))
  assert.equal(store.summary(at).calls.reduce((sum, row) => sum + Number(row.calls), 0), 3)
})

test('每日按北京时间零点重置，重启不清除计数或滚动分钟限流', t => {
  const { store, other } = fixture(t, { musicDaily: 1, perMinute: 1 })
  const beforeMidnight = Date.parse('2026-10-09T23:59:59+08:00')
  assert.equal(new Date(generationDayStart(beforeMidnight)).toISOString(), '2026-10-08T16:00:00.000Z')
  store.finish(store.reserve('user', 'replicate', 1000, beforeMidnight), 'succeeded', undefined, beforeMidnight)
  store.close()
  assert.throws(() => other.reserve('admin', 'replicate', 1000, beforeMidnight), blocked('quota_exceeded'))
  assert.throws(() => other.reserve('user', 'replicate', 1000, beforeMidnight + 1000), blocked('generation_rate_limited'))
  assert.ok(other.reserve('user', 'replicate', 1000, beforeMidnight + 60_000))
})

test('并发槽位跨连接/重启保持，完成后释放；崩溃任务过期回收但不退还额度', t => {
  const { store, other } = fixture(t, { concurrent: 1, perMinute: 20 })
  const first = store.reserve('user', 'replicate', 1000, at)
  assert.throws(() => other.reserve('admin', 'elevenlabs', 1000, at), blocked('generation_busy'))
  store.finish(first, 'failed', 'provider_timeout', at)
  const abandoned = other.reserve('admin', 'elevenlabs', 1000, at)
  other.close()
  assert.throws(() => store.reserve('user', 'replicate', 1000, at + 999), blocked('generation_busy'))
  assert.ok(store.reserve('user', 'replicate', 1000, at + 1000))
  const db = new DatabaseSync(store.databasePath)
  try {
    assert.equal(db.prepare('SELECT outcome FROM generation_calls WHERE id=?').get(abandoned)?.outcome, 'interrupted')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_calls').get()?.n, 3)
  } finally { db.close() }
})

test('短时间限流包含两种供应商，拒绝的请求不增加额度，窗口结束恢复', t => {
  const { store, other } = fixture(t, { perMinute: 2 })
  for (const provider of ['replicate', 'elevenlabs'] as const) store.finish(store.reserve('user', provider, 1000, at), 'succeeded', undefined, at)
  assert.throws(() => other.reserve('admin', 'replicate', 1000, at + 59_000), blocked('generation_rate_limited'))
  assert.equal(store.summary(at).calls.reduce((sum, row) => sum + Number(row.calls), 0), 2)
  assert.ok(other.reserve('admin', 'replicate', 1000, at + 60_000))
})

test('额度配置严格校验，允许单项关闭，默认值保守', t => {
  assert.deepEqual(readGenerationLimits({}), defaultGenerationLimits)
  for (const value of ['-1', 'oops', '2.5', '3x', '10001', 'Infinity']) assert.throws(() => readGenerationLimits({ MUSIC_DAILY_LIMIT: value }))
  assert.throws(() => readGenerationLimits({ GENERATION_MAX_CONCURRENT: '0' }))
  assert.throws(() => readGenerationLimits({ GENERATION_RATE_PER_MINUTE: '0' }))
  const { store } = fixture(t, { musicDaily: 0 })
  assert.throws(() => store.reserve('admin', 'replicate', 1000, at), blocked('quota_exceeded'))
})

test('记录只含最小元数据且完成操作幂等，90 天以前的历史自动清理', t => {
  const { store } = fixture(t, { perMinute: 20 })
  const old = store.reserve('user', 'replicate', 1000, at - 91 * 86_400_000)
  store.finish(old, 'failed', 'provider_unavailable', at - 91 * 86_400_000)
  const current = store.reserve('user', 'elevenlabs', 1000, at)
  store.finish(current, 'succeeded', undefined, at)
  store.finish(current, 'failed', 'provider_timeout', at + 1)
  const db = new DatabaseSync(store.databasePath)
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_calls').get()?.n, 1)
    assert.equal(db.prepare('SELECT outcome FROM generation_calls WHERE id=?').get(current)?.outcome, 'succeeded')
    const columns = db.prepare('PRAGMA table_info(generation_calls)').all().map(row => row.name)
    assert.deepEqual(columns, ['id', 'account_id', 'provider', 'started_at', 'expires_at', 'finished_at', 'outcome', 'error_code'])
  } finally { db.close() }
})
