/**
 * 云端工程的前端数据层（纯逻辑，不碰 React）。
 *
 * 身份怎么来：**没有账号系统**。第一次打开时在 localStorage 里生成一个随机串当 owner，
 * 之后所有写操作都带上它；服务端只校验"和保存时是同一个 owner"。
 * 所以它是"防误改的钥匙"，不是密码——文案里不许写成"登录/账号"。
 *
 * 分享链接：`?p=<id>`。服务端读取是公开的，别人打开链接就能看到工程。
 * 前端不用 pushState/路由，所以这里只需要"从 search 里取 id"这一个能力。
 */
import { apiJson } from '../api/client.ts'

export const OWNER_STORAGE_KEY = 'sonic-matter-owner'
export const OWNER_HEADER = 'x-sonic-owner'
/** 把 JSON 存上云端的超时：比生成接口短，因为这只是存一段文本。 */
export const CLOUD_TIMEOUT_MS = 20_000

export type CloudSummary = {
  id: string
  title: string
  tempo: number
  trackCount: number
  createdAt: number
  updatedAt: number
  revision: number
}

export type CloudSaved = {
  id: string
  title: string
  path: string
  createdAt: number
  updatedAt: number
  revision: number
}

export type CloudProject = CloudSummary & { project: unknown }

export type CloudList = {
  projects: CloudSummary[]
  owned: number
  total: number
  perOwnerLimit: number
  listLimit: number
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/** 32 位十六进制：服务端要求 8–64 位 `[A-Za-z0-9_-]`，这个格式稳定满足。 */
export function newOwnerId(): string {
  const globals = globalThis as { crypto?: Crypto }
  if (typeof globals.crypto?.randomUUID === 'function') return globals.crypto.randomUUID().replace(/-/g, '')
  const bytes = new Uint8Array(16)
  if (typeof globals.crypto?.getRandomValues === 'function') globals.crypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** localStorage 在隐私模式/被禁用时会直接抛异常，所以永远走 try/catch。 */
function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

let sessionOwner = ''

/** 取（必要时生成）本机标识。storage 可注入，方便测试。 */
export function loadOwnerId(storage: StorageLike | null = browserStorage()): string {
  try {
    const existing = storage?.getItem(OWNER_STORAGE_KEY) ?? ''
    if (/^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing
    const created = newOwnerId()
    storage?.setItem(OWNER_STORAGE_KEY, created)
    if (storage) return created
  } catch {
    // 存不进去（配额/隐私模式）：退回"本次会话内有效"的内存串，功能仍然可用。
  }
  sessionOwner = sessionOwner || newOwnerId()
  return sessionOwner
}

/** 从 `?p=<id>` 里取工程 ID；没有或不合法就返回空串。 */
export function projectIdFromSearch(search: string): string {
  const raw = new URLSearchParams(search.startsWith('?') ? search : `?${search}`).get('p') ?? ''
  const id = raw.trim()
  return /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : ''
}

/** 分享链接：Origin + `?p=<id>`。 */
export function shareLink(id: string, origin: string): string {
  return `${origin.replace(/\/+$/, '')}/?p=${encodeURIComponent(id)}`
}

/** 列表里的时间：今天给"x 分钟前"，更早给日期。 */
export function formatWhen(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '时间未知'
  const diff = now - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return diff < 7 * 86_400_000 ? `${ymd} ${pad(date.getHours())}:${pad(date.getMinutes())}` : ymd
}

const ownerHeaders = (owner: string) => ({ [OWNER_HEADER]: owner })

/** 我的云端工程列表（只有元信息）。 */
export const listCloudProjects = (owner: string) =>
  apiJson<CloudList>('/api/projects', { headers: ownerHeaders(owner), timeoutMs: CLOUD_TIMEOUT_MS })

/** 打开一个云端工程（公开读取，分享链接不需要 owner）。 */
export const loadCloudProject = (id: string) =>
  apiJson<CloudProject>(`/api/projects/${encodeURIComponent(id)}`, { timeoutMs: CLOUD_TIMEOUT_MS })

/** 保存：已有 id 就覆盖那个链接，否则新建一个。 */
export const saveCloudProject = (owner: string, project: unknown, id = '') =>
  id
    ? apiJson<CloudSaved>(`/api/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: { project }, headers: ownerHeaders(owner), timeoutMs: CLOUD_TIMEOUT_MS })
    : apiJson<CloudSaved>('/api/projects', { method: 'POST', body: { project }, headers: ownerHeaders(owner), timeoutMs: CLOUD_TIMEOUT_MS })

/** 删除云端工程（只有原 owner 能删）。 */
export const removeCloudProject = (owner: string, id: string) =>
  apiJson<{ deleted: boolean; id: string }>(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE', headers: ownerHeaders(owner), timeoutMs: CLOUD_TIMEOUT_MS })

/** 复制到剪贴板：navigator.clipboard 在非 HTTPS 下不可用（我们就是 http://IP:8080），必须留退路。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到下面的兜底方案
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'true')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}
