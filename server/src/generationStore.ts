import crypto from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AppError, type ErrorCode } from './errors.ts'
import type { ProviderName } from './serviceConfigStore.ts'

export type GenerationLimits = { musicDaily: number; sfxDaily: number; perMinute: number; concurrent: number }
export const defaultGenerationLimits: GenerationLimits = { musicDaily: 20, sfxDaily: 50, perMinute: 3, concurrent: 2 }
const dayMs = 86_400_000
const chinaOffset = 8 * 60 * 60 * 1000
export const generationDayStart = (now: number) => Math.floor((now + chinaOffset) / dayMs) * dayMs - chinaOffset

/** 无效配置拒绝启动，0 仅用于关闭某供应商的每日额度。 */
export function readGenerationLimits(env: NodeJS.ProcessEnv = process.env): GenerationLimits {
  const read = (name: string, fallback: number, min: number, max: number) => {
    const value = env[name]
    if (value === undefined || value === '') return fallback
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
      throw new Error(`${name} 必须是 ${min}–${max} 范围内的整数。`)
    }
    return Number(value)
  }
  return {
    musicDaily: read('MUSIC_DAILY_LIMIT', 20, 0, 10000), sfxDaily: read('SFX_DAILY_LIMIT', 50, 0, 10000),
    perMinute: read('GENERATION_RATE_PER_MINUTE', 3, 1, 1000), concurrent: read('GENERATION_MAX_CONCURRENT', 2, 1, 20),
  }
}

export class GenerationLimitError extends AppError {
  readonly retryAfter: number
  constructor(message: string, code: 'quota_exceeded' | 'generation_rate_limited' | 'generation_busy', retryAfter: number) {
    super(message, { code, status: 429 })
    this.retryAfter = Math.max(1, Math.ceil(retryAfter))
  }
}

type Outcome = 'succeeded' | 'failed' | 'canceled'
/** 全站共享额度，先原子预占再调用供应商；失败/取消不退款，避免已扣费却重复放行。 */
export class GenerationStore {
  readonly databasePath: string
  #db: DatabaseSync | null = null
  #dir: string
  readonly limits: GenerationLimits
  constructor(dir: string, limits: GenerationLimits = readGenerationLimits()) {
    this.#dir = dir
    this.databasePath = path.join(dir, 'generation-usage.db')
    this.limits = limits
  }

  #open() {
    if (this.#db) return this.#db
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.databasePath)
    if (process.platform !== 'win32') chmodSync(this.databasePath, 0o600)
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS generation_calls (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('replicate','elevenlabs')),
        started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, finished_at INTEGER,
        outcome TEXT NOT NULL CHECK(outcome IN ('running','succeeded','failed','canceled','interrupted')),
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_generation_started ON generation_calls(started_at);
      CREATE INDEX IF NOT EXISTS idx_generation_provider ON generation_calls(provider, started_at);
      CREATE INDEX IF NOT EXISTS idx_generation_running ON generation_calls(outcome, expires_at);`)
    this.#db = db
    return db
  }

  reserve(accountId: string, provider: ProviderName, leaseMs: number, now = Date.now()): string {
    const db = this.#open()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare("UPDATE generation_calls SET outcome='interrupted', finished_at=?, error_code='provider_timeout' WHERE outcome='running' AND expires_at<=?").run(now, now)
      db.prepare("DELETE FROM generation_calls WHERE started_at<? AND outcome!='running'").run(now - 90 * dayMs)
      const used = (db.prepare('SELECT COUNT(*) AS n FROM generation_calls WHERE provider=? AND started_at>=?').get(provider, generationDayStart(now)) as { n: number }).n
      const dailyLimit = provider === 'replicate' ? this.limits.musicDaily : this.limits.sfxDaily
      if (used >= dailyLimit) throw new GenerationLimitError(
        `${provider === 'replicate' ? '音乐' : '音效'}今日生成额度已用完（全站每天 ${dailyLimit} 次），请在北京时间明日零点后再试。`,
        'quota_exceeded', (generationDayStart(now) + dayMs - now) / 1000)
      const recent = db.prepare('SELECT COUNT(*) AS n, MIN(started_at) AS first FROM generation_calls WHERE started_at>?').get(now - 60_000) as { n: number; first: number | null }
      if (recent.n >= this.limits.perMinute) throw new GenerationLimitError('生成请求过于频繁，请稍后再试。', 'generation_rate_limited', ((recent.first ?? now) + 60_000 - now) / 1000)
      const active = db.prepare("SELECT COUNT(*) AS n FROM generation_calls WHERE outcome='running'").get() as { n: number }
      if (active.n >= this.limits.concurrent) throw new GenerationLimitError('当前生成任务已满，请等待正在进行的音乐或音效完成后再试。', 'generation_busy', 10)
      const id = crypto.randomUUID()
      db.prepare("INSERT INTO generation_calls(id,account_id,provider,started_at,expires_at,outcome) VALUES (?,?,?,?,?,'running')").run(id, accountId, provider, now, now + leaseMs)
      db.exec('COMMIT')
      return id
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }

  finish(id: string, outcome: Outcome, errorCode?: ErrorCode, now = Date.now()) {
    this.#open().prepare("UPDATE generation_calls SET outcome=?,error_code=?,finished_at=? WHERE id=? AND outcome='running'").run(outcome, errorCode ?? null, now, id)
  }

  summary(now = Date.now()) {
    const rows = this.#open().prepare(`SELECT provider, outcome, COUNT(*) AS calls FROM generation_calls
      WHERE started_at>=? GROUP BY provider,outcome ORDER BY provider,outcome`).all(generationDayStart(now))
    return { day: new Date(now + chinaOffset).toISOString().slice(0, 10), timezone: 'Asia/Shanghai', limits: this.limits, calls: rows }
  }

  close() { this.#db?.close(); this.#db = null }
}
