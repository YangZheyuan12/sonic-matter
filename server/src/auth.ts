import express, { type CookieOptions, type Request, type RequestHandler } from 'express'
import { z } from 'zod'
import { AppError, badRequest, forbidden } from './errors.ts'
import { AuthStore, SESSION_TTL_MS, type AuthSession, type FixedRole, type FixedUsername } from './authStore.ts'

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthSession
  }
}

type AuthOptions = {
  secureCookie?: boolean
  origin?: string
  now?: () => number
}

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
}).strict()

const unauthorized = () => new AppError('请先登录后再使用此功能。', { code: 'unauthorized', status: 401 })

/** 没有第三方 Cookie 依赖；拒绝重复和非标准令牌，避免 Cookie 解析歧义。 */
function readCookie(req: Request, name: string): string | undefined {
  const values = (req.headers.cookie ?? '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
  if (values.length !== 1) return undefined
  const value = values[0].slice(name.length + 1)
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined
}

export function createAuth(store: AuthStore, options: AuthOptions = {}) {
  const secureCookie = options.secureCookie ?? process.env.NODE_ENV === 'production'
  const cookieName = secureCookie ? '__Host-sonic-session' : 'sonic-session'
  const origin = options.origin ? new URL(options.origin).origin : undefined
  const now = options.now ?? Date.now
  const cookieOptions: CookieOptions = {
    httpOnly: true, secure: secureCookie, sameSite: 'strict', path: '/',
  }
  const router = express.Router()
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Pragma', 'no-cache')
    next()
  })

  /** 自定义请求头阻断普通表单 CSRF；校验 Origin 阻断跨站 fetch 和登录 CSRF。 */
  const protectMutation: RequestHandler = (req, _res, next) => {
    if (secureCookie && !req.secure) throw forbidden('此操作必须通过 HTTPS 访问。')
    const expectedOrigin = origin ?? `${req.protocol}://${req.get('host')}`
    if (req.get('x-sonic-auth') !== '1' || req.get('sec-fetch-site') === 'cross-site'
      || (req.get('origin') && req.get('origin') !== expectedOrigin)) {
      throw forbidden('请求来源无效，请在本站页面重试。')
    }
    if (!req.is('application/json')) throw badRequest('请使用 JSON 格式提交请求。')
    next()
  }

  const requireAccount: RequestHandler = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    const token = readCookie(req, cookieName)
    const session = token ? store.getSession(token, now()) : null
    if (!session) throw unauthorized()
    req.auth = session
    next()
  }

  const requireRole = (role: FixedRole): RequestHandler[] => [requireAccount, (req, _res, next) => {
    if (req.auth?.account.role !== role) throw forbidden('当前账号没有此操作权限。')
    next()
  }]

  router.post('/login', protectMutation, (req, res) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) throw badRequest('请输入账号和密码（账号最多 64 字符，密码最多 256 字符）。')
    const { username, password } = parsed.data
    const retryAfter = store.consumeLoginAttempt(req.ip ?? req.socket.remoteAddress ?? 'unknown', username, now())
    if (retryAfter) {
      res.setHeader('Retry-After', retryAfter)
      throw new AppError('登录尝试过于频繁，请稍后再试。', { code: 'login_rate_limited', status: 429 })
    }
    if (!store.verifyPassword(username, password)) {
      throw new AppError('账号或密码不正确，请检查后重试。', { code: 'unauthorized', status: 401 })
    }
    const session = store.createSession(username as FixedUsername, readCookie(req, cookieName), now())
    res.cookie(cookieName, session.token, { ...cookieOptions, maxAge: SESSION_TTL_MS })
    res.json({ account: session.account, expiresAt: session.expiresAt })
  })

  router.get('/me', (req, res) => {
    const token = readCookie(req, cookieName)
    const session = token ? store.getSession(token, now()) : null
    if (!session) {
      if (req.headers.cookie) res.clearCookie(cookieName, cookieOptions)
      return res.json({ account: null, expiresAt: null })
    }
    return res.json(session)
  })

  router.post('/logout', protectMutation, (req, res) => {
    const token = readCookie(req, cookieName)
    if (token) store.revokeSession(token)
    res.clearCookie(cookieName, cookieOptions)
    res.json({ ok: true })
  })

  return { router, requireAccount, requireRole, protectMutation }
}
