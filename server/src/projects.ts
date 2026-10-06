/**
 * 云端工程接口（`/api/projects`）。
 *
 * 定位要说清楚：这是 **Demo 级实现，没有账号、没有密码、没有登录**。
 * - 读取：公开。拿到 ID 就能打开，这正是"分享链接"的用途。
 * - 写入 / 删除：需要请求头 `x-sonic-owner` 与保存时的 owner 一致。owner 是浏览器本地生成的
 *   随机串，形同"防误改的钥匙"，**不是安全边界**——谁拿到 owner 串谁就能改。
 * - 用请求头而不是查询参数传 owner：服务端会记录每个请求的 url，放 query 里会把 owner 写进日志。
 *
 * 写操作全部走 `mutate` 小助手，避免每条路由重复"先查 owner 再判断"的样板代码。
 */
import express from 'express'
import { z } from 'zod'
import { badRequest, forbidden, notFound, payloadTooLarge, quotaExceeded, zodDetail } from './errors.ts'
import { asyncHandler } from './http.ts'
import { projectSchema } from './projectSchema.ts'
import { LIST_LIMIT, MAX_PROJECT_BYTES, MAX_PROJECTS_TOTAL, ProjectStore, type SaveInput } from './projectStore.ts'

export const OWNER_HEADER = 'x-sonic-owner'

/** owner 是浏览器生成的随机串；长度下限 8 是为了别把 "1" 这种值当成身份。 */
const ownerSchema = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/)
const saveBodySchema = z.object({ project: projectSchema })

/** 请求体校验：必须自己 safeParse。把 ZodError 抛给 errorHandler 会变成 502（那是给模型输出准备的）。 */
const readSaveBody = (req: express.Request) => {
  const parsed = saveBodySchema.safeParse(req.body)
  if (!parsed.success) throw badRequest('工程数据不正确，无法保存到云端。', zodDetail(parsed.error))
  return parsed.data.project
}

/** Express 的 params 在类型上是 string | string[]，这里统一收敛成 string。 */
const idOf = (req: express.Request): string => {
  const value = req.params.id
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
}

const readOwner = (req: express.Request): string => {
  const raw = req.get(OWNER_HEADER)?.trim() ?? ''
  const parsed = ownerSchema.safeParse(raw)
  if (!parsed.success) {
    throw badRequest(
      '缺少或无法识别的本机标识，请刷新页面后重试。',
      raw ? 'x-sonic-owner 格式不合法' : '请求缺少 x-sonic-owner 请求头',
    )
  }
  return parsed.data
}

/** 从已经过 zod 校验的工程里取出列表页需要的元信息。 */
const metaOf = (project: z.infer<typeof projectSchema>) => ({
  title: project.title,
  tempo: project.tempo,
  trackCount: project.tracks.length,
})

const payloadOf = (project: z.infer<typeof projectSchema>): Omit<SaveInput, 'owner'> => {
  const payload = JSON.stringify(project)
  const bytes = Buffer.byteLength(payload, 'utf8')
  if (bytes > MAX_PROJECT_BYTES) {
    throw payloadTooLarge(
      `工程数据太大（${Math.round(bytes / 1024)} KB），云端最多存 ${Math.round(MAX_PROJECT_BYTES / 1024)} KB；请先减少音频片段或音符数量。`,
      '云端工程单条上限',
    )
  }
  return { project: JSON.parse(payload) as unknown, ...metaOf(project) }
}

export function projectsRouter(store: ProjectStore) {
  const router = express.Router()

  /** 我的云端工程列表（只返回元信息）。 */
  router.get('/', asyncHandler(async (req, res) => {
    const owner = readOwner(req)
    res.json({ projects: store.list(owner, LIST_LIMIT), listLimit: LIST_LIMIT, ...store.counts(owner) })
  }))

  /** 新建（不覆盖已有的本地工程）。 */
  router.post('/', asyncHandler(async (req, res) => {
    const owner = readOwner(req)
    const outcome = store.save({ owner, ...payloadOf(readSaveBody(req)) })
    if (!outcome.ok) {
      throw outcome.reason === 'global_quota'
        ? quotaExceeded(`服务器上的云端工程总量已达上限（${MAX_PROJECTS_TOTAL} 个），请稍后再试或联系我们清理。`, '全局配额')
        : quotaExceeded(`${outcome.reason === 'owner_quota' ? '这台浏览器' : '当前身份'}最多保存 ${store.counts(owner).perOwnerLimit} 个云端工程，请先删掉一些再保存。`, '个人配额')
    }
    const { record } = outcome
    res.status(201).json({
      id: record.id,
      title: record.title,
      path: `/?p=${record.id}`,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    })
  }))

  /** 打开：公开，任何人拿到分享链接都能读到工程内容。 */
  router.get('/:id', asyncHandler(async (req, res) => {
    const record = store.get(idOf(req))
    if (!record) throw notFound('这个云端工程不存在，可能已被删除，或者链接不完整。')
    res.json({
      id: record.id,
      title: record.title,
      project: record.project,
      tempo: record.tempo,
      trackCount: record.trackCount,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
    })
  }))

  /** 覆盖保存（同一个 ID 更新），只有保存它的浏览器能改。 */
  router.put('/:id', asyncHandler(async (req, res) => {
    const owner = readOwner(req)
    const outcome = store.update(idOf(req), owner, payloadOf(readSaveBody(req)))
    if (!outcome.ok) throw mutateError(outcome.reason)
    res.json({
      id: outcome.record.id,
      title: outcome.record.title,
      path: `/?p=${outcome.record.id}`,
      createdAt: outcome.record.createdAt,
      updatedAt: outcome.record.updatedAt,
      revision: outcome.record.revision,
    })
  }))

  /** 删除，只有保存它的浏览器能删。 */
  router.delete('/:id', asyncHandler(async (req, res) => {
    const owner = readOwner(req)
    const outcome = store.remove(idOf(req), owner)
    if (!outcome.ok) throw mutateError(outcome.reason)
    res.json({ deleted: true, id: outcome.id })
  }))

  return router
}

function mutateError(reason: 'missing' | 'forbidden') {
  return reason === 'missing'
    ? notFound('这个云端工程不存在，可能已被删除。')
    : forbidden('这个云端工程不是这台浏览器保存的，无法修改或删除。', 'owner 不匹配')
}
