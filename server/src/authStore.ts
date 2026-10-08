/**
 * 固定双账号的持久化模型。
 *
 * 这一步只负责账号表和一次性初始化；登录会话、管理员服务配置与用量记录
 * 在后续步骤中接入。密码只以 scrypt 哈希落库，明文只由初始化命令写入一次性
 * 凭据文件，且该文件默认权限为 0600。
 */
import crypto from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const FIXED_ACCOUNTS = [
  { username: 'admin', role: 'admin' },
  { username: 'user', role: 'user' },
] as const

export type FixedRole = (typeof FIXED_ACCOUNTS)[number]['role']
export type FixedUsername = (typeof FIXED_ACCOUNTS)[number]['username']

export type AccountSummary = {
  id: string
  username: FixedUsername
  role: FixedRole
  enabled: boolean
  createdAt: string
}

export type FixedPasswordInput = Partial<Record<FixedUsername, string>>
export type AccountInitialization = {
  accounts: AccountSummary[]
  created: FixedUsername[]
}

type AccountRow = {
  id: string
  username: FixedUsername
  role: FixedRole
  password_salt: string
  password_hash: string
  enabled: number
  created_at: string
}

const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }
const passwordBytes = 64

/** 初始化用的高熵密码；不会写进源码、日志或 API 响应。 */
export const createRandomPassword = () => crypto.randomBytes(18).toString('base64url')

/** 凭据文件和管理员手工输入都至少要有 12 个字符。 */
export const isStrongPassword = (value: string) => value.length >= 12 && value.length <= 256

export class AuthStore {
  readonly dir: string
  readonly databasePath: string
  #db: DatabaseSync | null = null

  constructor(dir: string) {
    this.dir = dir
    this.databasePath = path.join(dir, 'auth.db')
  }

  #open(): DatabaseSync {
    if (this.#db) return this.#db
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.databasePath)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_role ON users (role);
    `)
    this.#db = db
    return db
  }

  /** 创建缺失的固定账号；已有账号不会被覆盖或重置。 */
  initializeFixedAccounts(
    passwords: FixedPasswordInput,
    beforeCommit?: (created: readonly FixedUsername[]) => void,
  ): AccountInitialization {
    const db = this.#open()
    const missing = FIXED_ACCOUNTS.filter(account => !db.prepare('SELECT 1 FROM users WHERE username = ?').get(account.username))
    for (const account of missing) {
      const password = passwords[account.username]
      if (!password || !isStrongPassword(password)) {
        throw new Error(`创建 ${account.username} 账号需要 12–256 个字符的密码。`)
      }
    }
    const created: FixedUsername[] = []
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const account of FIXED_ACCOUNTS) {
        const existing = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(account.username) as { id: string; username: FixedUsername; role: FixedRole } | undefined
        if (existing) {
          if (existing.role !== account.role) throw new Error(`固定账号 ${account.username} 的角色不匹配，拒绝继续初始化。`)
          continue
        }
        const password = passwords[account.username]!
        const salt = crypto.randomBytes(16)
        db.prepare(`
          INSERT INTO users (id, username, role, password_salt, password_hash, enabled, created_at)
          VALUES (?, ?, ?, ?, ?, 1, ?)
        `).run(crypto.randomUUID(), account.username, account.role, salt.toString('base64url'), hashPassword(password, salt), new Date().toISOString())
        created.push(account.username)
      }
      if (created.length) beforeCommit?.(created)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { accounts: this.listAccounts(), created }
  }

  listAccounts(): AccountSummary[] {
    const rows = this.#open().prepare("SELECT id, username, role, enabled, created_at FROM users ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END").all() as Array<Omit<AccountRow, 'password_salt' | 'password_hash'>>
    return rows.map(row => ({
      id: row.id,
      username: row.username,
      role: row.role,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
    }))
  }

  /** 第三步登录实现会复用这个校验；这里先用单测锁住哈希行为。 */
  verifyPassword(username: FixedUsername, password: string): boolean {
    const row = this.#open().prepare('SELECT password_salt, password_hash, enabled FROM users WHERE username = ?').get(username) as Pick<AccountRow, 'password_salt' | 'password_hash' | 'enabled'> | undefined
    if (!row || row.enabled !== 1) return false
    const actual = hashPassword(password, Buffer.from(row.password_salt, 'base64url'))
    const expected = Buffer.from(row.password_hash, 'hex')
    const actualBytes = Buffer.from(actual, 'hex')
    return actualBytes.length === expected.length && crypto.timingSafeEqual(actualBytes, expected)
  }

  close() {
    this.#db?.close()
    this.#db = null
  }
}

function hashPassword(password: string, salt: Buffer): string {
  return crypto.scryptSync(password, salt, passwordBytes, SCRYPT_OPTIONS).toString('hex')
}

/** 设置凭据文件权限；Windows 测试环境不保证 POSIX mode，chmod 失败时不阻断初始化。 */
export function lockCredentialsFile(filePath: string) {
  try { chmodSync(filePath, 0o600) } catch { /* Windows 或受限文件系统忽略 mode */ }
}
