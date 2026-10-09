import crypto from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { AppError } from './errors.ts'

export const providerNames = ['replicate', 'elevenlabs'] as const
export type ProviderName = typeof providerNames[number]
const keySchema = z.string().trim().min(8).max(500).regex(/^[\x21-\x7e]+$/)
export const serviceConfigPatchSchema = z.object({
  replicate: keySchema.nullable().optional(),
  elevenlabs: keySchema.nullable().optional(),
}).strict().refine(patch => Object.keys(patch).length > 0)
export type ServiceConfigPatch = z.infer<typeof serviceConfigPatchSchema>
export type ServiceConfigStatus = {
  encryptionReady: boolean
  providers: Record<ProviderName, { configured: boolean; updatedAt: string | null }>
}

/** 管理员密钥单独加密落库，不自动启用尚未接入权限控制的创作接口。 */
export class ServiceConfigStore {
  readonly databasePath: string
  #dir: string
  #key: Buffer | null
  #db: DatabaseSync | null = null

  constructor(dir: string, encryptionKey = process.env.SONIC_CONFIG_KEY ?? '') {
    this.#dir = dir
    this.databasePath = path.join(dir, 'service-config.db')
    // 接受 32 字节 hex 或标准 base64；不会为缺失/错误配置生成临时密钥。
    const candidate = /^[a-fA-F0-9]{64}$/.test(encryptionKey)
      ? Buffer.from(encryptionKey, 'hex')
      : /^[A-Za-z0-9+/]{43}=$/.test(encryptionKey) ? Buffer.from(encryptionKey, 'base64') : null
    this.#key = candidate?.length === 32 ? candidate : null
  }

  #open() {
    if (this.#db) return this.#db
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 })
    this.#db = new DatabaseSync(this.databasePath)
    if (process.platform !== 'win32') chmodSync(this.databasePath, 0o600)
    this.#db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS service_config (
        provider TEXT PRIMARY KEY CHECK(provider IN ('replicate', 'elevenlabs')),
        ciphertext TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, updated_at TEXT NOT NULL
      )`)
    return this.#db
  }

  #requireKey(): Buffer {
    if (!this.#key) throw new AppError('服务器尚未配置有效的密钥保护参数，请联系管理员检查 SONIC_CONFIG_KEY。', {
      code: 'provider_not_configured', status: 503,
    })
    return this.#key
  }

  status(): ServiceConfigStatus {
    const db = this.#open()
    const providers = Object.fromEntries(providerNames.map(provider => {
      const row = db.prepare('SELECT updated_at FROM service_config WHERE provider = ?').get(provider) as { updated_at: string } | undefined
      return [provider, { configured: Boolean(row), updatedAt: row?.updated_at ?? null }]
    })) as ServiceConfigStatus['providers']
    return { encryptionReady: Boolean(this.#key), providers }
  }

  update(input: ServiceConfigPatch): ServiceConfigStatus {
    const patch = serviceConfigPatchSchema.parse(input)
    const key = this.#requireKey()
    // 错误保护密钥不可覆盖现有配置；先验证所有现有记录能够解密。
    for (const provider of providerNames) this.readKey(provider)
    const db = this.#open()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const provider of providerNames) {
        const value = patch[provider]
        if (value === undefined) continue
        if (value === null) {
          db.prepare('DELETE FROM service_config WHERE provider = ?').run(provider)
          continue
        }
        const iv = crypto.randomBytes(12)
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
        cipher.setAAD(Buffer.from(`sonic-matter:${provider}:v1`))
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
        db.prepare(`INSERT INTO service_config(provider, ciphertext, iv, tag, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv,
          tag = excluded.tag, updated_at = excluded.updated_at`).run(
          provider, encrypted.toString('base64'), iv.toString('base64'), cipher.getAuthTag().toString('base64'), new Date().toISOString(),
        )
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return this.status()
  }

  /** 只供后续服务器供应商调用使用，HTTP 接口永不返回此值。 */
  readKey(provider: ProviderName): string | null {
    const key = this.#requireKey()
    const row = this.#open().prepare('SELECT ciphertext, iv, tag FROM service_config WHERE provider = ?').get(provider) as {
      ciphertext: string; iv: string; tag: string
    } | undefined
    if (!row) return null
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'))
      decipher.setAAD(Buffer.from(`sonic-matter:${provider}:v1`))
      decipher.setAuthTag(Buffer.from(row.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8')
    } catch {
      throw new AppError('服务配置无法解密，请检查服务器保护密钥或恢复配置备份。', { code: 'internal_error', status: 500 })
    }
  }

  close() { this.#db?.close(); this.#db = null }
}
