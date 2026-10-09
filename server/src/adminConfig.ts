import express from 'express'
import { badRequest } from './errors.ts'
import { createAuth } from './auth.ts'
import { ServiceConfigStore, serviceConfigPatchSchema } from './serviceConfigStore.ts'

export function adminConfigRouter(store: ServiceConfigStore, auth: ReturnType<typeof createAuth>) {
  const router = express.Router()
  router.use(...auth.requireRole('admin'))
  router.get('/', (_req, res) => res.json(store.status()))
  router.put('/', auth.protectMutation, (req, res) => {
    const patch = serviceConfigPatchSchema.safeParse(req.body)
    if (!patch.success) throw badRequest('配置格式不正确：密钥应为 8–500 个可见字符；仅支持音乐和音效服务。')
    res.json(store.update(patch.data))
  })
  return router
}
