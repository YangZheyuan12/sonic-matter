/**
 * 云端工程的存储层。
 *
 * 为什么用 `node:sqlite`：Node 24 自带，不需要任何新依赖，也不需要单独装数据库进程
 * （目标机器上跑着队友的宝塔和 MySQL，我们不想再动它）。一个文件就是全部数据，备份=复制文件。
 *
 * 设计取舍：
 * - **懒打开**：只有真的用到云端工程才建目录、建库。纯前端 / 纯生成接口的场景不产生任何副作用。
 * - **库文件放在公开静态目录之外**：`/generated/*` 是公开的（导出的音频要能被 `audio` 标签直接取），
 *   所以数据库绝不能放进去，否则 `projects.db` 会被直接下载。
 * - **写入需要 owner 匹配**：owner 是浏览器本地生成的随机 ID，只用来防"误改别人的工程"，
 *   **不是账号认证**（没有密码、没有登录）。读取是公开的——分享链接就是这个用途。
 */
import crypto from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 单个工程的 JSON 上限。比请求体上限（默认 2MB）小，避免一个超大工程把列表和磁盘拖慢。 */
export const MAX_PROJECT_BYTES = 512 * 1024
/** 每个浏览器身份最多保存多少个云端工程。 */
export const MAX_PROJECTS_PER_OWNER = 50
/** 全库上限，防止脚本刷爆磁盘（2 核 2G 的机器上磁盘只剩 24G）。 */
export const MAX_PROJECTS_TOTAL = 2000
/** 列表接口一次最多返回多少条。 */
export const LIST_LIMIT = 100

export type ProjectSummary = {
  id: string
  title: string
  tempo: number
  trackCount: number
  createdAt: number
  updatedAt: number
  revision: number
}

export type ProjectRecord = ProjectSummary & {
  owner: string
  project: unknown
}

export type SaveOutcome =
  | { ok: true; record: ProjectRecord }
  | { ok: false; reason: 'owner_quota' | 'global_quota' }

export type MutateOutcome =
  | { ok: true; record: ProjectRecord }
  | { ok: false; reason: 'missing' | 'forbidden' }

export type RemoveOutcome =
  | { ok: true; id: string }
  | { ok: false; reason: 'missing' | 'forbidden' }

type Row = {
  id: string
  owner: string
  title: string
  payload: string
  tempo: number
  track_count: number
  created_at: number
  updated_at: number
  revision: number
}

export type SaveInput = {
  owner: string
  title: string
  tempo: number
  trackCount: number
  project: unknown
}

/** 分享链接里的 ID：12 字节随机数 → 16 个 URL 安全字符，猜不出来。 */
export const newProjectId = () => crypto.randomBytes(12).toString('base64url')

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    title       TEXT NOT NULL,
    payload     TEXT NOT NULL,
    tempo       INTEGER NOT NULL,
    track_count INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    revision    INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner, updated_at DESC);
`

export class ProjectStore {
  readonly dir: string
  #db: DatabaseSync | null = null

  constructor(dir: string) {
    this.dir = dir
  }

  /** 懒打开：第一次真正用到时才建目录 + 建库。 */
  #open(): DatabaseSync {
    if (this.#db) return this.#db
    mkdirSync(this.dir, { recursive: true })
    const db = new DatabaseSync(path.join(this.dir, 'projects.db'))
    // WAL 让读写不互相阻塞，busy_timeout 兜住偶发锁等待（单进程也不会卡太久）。
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA busy_timeout = 3000;')
    db.exec(SCHEMA)
    this.#db = db
    return db
  }

  #count(db: DatabaseSync, sql: string, ...params: string[]): number {
    const row = db.prepare(sql).get(...params) as { n: number } | undefined
    return Number(row?.n ?? 0)
  }

  /** 数据库文件路径（日志 / 排错用）。 */
  get databasePath(): string {
    return path.join(this.dir, 'projects.db')
  }

  save(input: SaveInput, now = Date.now()): SaveOutcome {
    const db = this.#open()
    if (this.#count(db, 'SELECT COUNT(*) AS n FROM projects') >= MAX_PROJECTS_TOTAL) {
      return { ok: false, reason: 'global_quota' }
    }
    if (this.#count(db, 'SELECT COUNT(*) AS n FROM projects WHERE owner = ?', input.owner) >= MAX_PROJECTS_PER_OWNER) {
      return { ok: false, reason: 'owner_quota' }
    }
    const id = newProjectId()
    db.prepare(
      `INSERT INTO projects (id, owner, title, payload, tempo, track_count, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(id, input.owner, input.title, JSON.stringify(input.project), Math.round(input.tempo), input.trackCount, now, now)
    return {
      ok: true,
      record: { id, owner: input.owner, title: input.title, tempo: input.tempo, trackCount: input.trackCount, project: input.project, createdAt: now, updatedAt: now, revision: 1 },
    }
  }

  get(id: string): ProjectRecord | null {
    const row = this.#open().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    return row ? toRecord(row) : null
  }

  update(id: string, owner: string, input: Omit<SaveInput, 'owner'>, now = Date.now()): MutateOutcome {
    const db = this.#open()
    const existing = db.prepare('SELECT owner, revision FROM projects WHERE id = ?').get(id) as { owner: string; revision: number } | undefined
    if (!existing) return { ok: false, reason: 'missing' }
    if (existing.owner !== owner) return { ok: false, reason: 'forbidden' }
    const revision = Number(existing.revision) + 1
    db.prepare(
      `UPDATE projects SET title = ?, payload = ?, tempo = ?, track_count = ?, updated_at = ?, revision = ? WHERE id = ?`,
    ).run(input.title, JSON.stringify(input.project), Math.round(input.tempo), input.trackCount, now, revision, id)
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    const record = row ? toRecord(row) : null
    return record ? { ok: true, record } : { ok: false, reason: 'missing' }
  }

  remove(id: string, owner: string): RemoveOutcome {
    const db = this.#open()
    const existing = db.prepare('SELECT owner FROM projects WHERE id = ?').get(id) as { owner: string } | undefined
    if (!existing) return { ok: false, reason: 'missing' }
    if (existing.owner !== owner) return { ok: false, reason: 'forbidden' }
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return { ok: true, id }
  }

  /** 只返回元信息，不返回工程正文——列表接口不该把 50 个工程的 JSON 全塞给前端。 */
  list(owner: string, limit = LIST_LIMIT): ProjectSummary[] {
    const rows = this.#open()
      .prepare('SELECT id, title, tempo, track_count, created_at, updated_at, revision FROM projects WHERE owner = ? ORDER BY updated_at DESC LIMIT ?')
      .all(owner, limit) as Array<Omit<Row, 'owner' | 'payload'>>
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      tempo: Number(row.tempo),
      trackCount: Number(row.track_count),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      revision: Number(row.revision),
    }))
  }

  counts(owner: string): { owned: number; total: number; perOwnerLimit: number } {
    const db = this.#open()
    return {
      owned: this.#count(db, 'SELECT COUNT(*) AS n FROM projects WHERE owner = ?', owner),
      total: this.#count(db, 'SELECT COUNT(*) AS n FROM projects'),
      perOwnerLimit: MAX_PROJECTS_PER_OWNER,
    }
  }

  close(): void {
    this.#db?.close()
    this.#db = null
  }
}

/** payload 是 JSON 文本，这里解析回对象；解析失败说明库里的数据坏了，当成"不存在"。 */
function toRecord(row: Row): ProjectRecord | null {
  let project: unknown
  try {
    project = JSON.parse(row.payload) as unknown
  } catch {
    return null
  }
  return {
    id: row.id,
    owner: row.owner,
    title: row.title,
    project,
    tempo: Number(row.tempo),
    trackCount: Number(row.track_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    revision: Number(row.revision),
  }
}
