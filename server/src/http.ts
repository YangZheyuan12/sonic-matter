import crypto from 'node:crypto'
import type {
  NextFunction,
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
} from 'express'
import { AppError, badRequest, errorPayload, forbiddenOrigin, notFound, toAppError } from './errors.ts'
import { logger } from './logger.ts'

declare module 'express-serve-static-core' {
  interface Request {
    /** 每次请求的追踪 ID，同时写进响应头 X-Request-Id 与错误信封 */
    requestId: string
    /** 客户端断开或整体超时时会被 abort，一路传给上游请求 */
    abortSignal: AbortSignal
    /** abort 的原因，只用于日志 */
    abortReason: () => 'client_closed' | 'request_timeout' | null
  }
}

export function readEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** 允许访问的浏览器来源（CORS_ORIGIN，逗号分隔）。留空 = 不限制来源，方便本地开发。 */
export const allowedOrigins = (process.env.CORS_ORIGIN ?? '')
  .split(',').map(value => value.trim()).filter(Boolean)

/** 请求体上限（JSON_BODY_LIMIT）。超过上限 body-parser 会抛 entity.too.large，最终变成 413。 */
export const jsonBodyLimit = process.env.JSON_BODY_LIMIT ?? '2mb'

/** cors 中间件的 origin 回调：来源不在白名单时抛 403，交给 errorHandler 转成统一信封。 */
export function corsOrigin(
  origin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void,
) {
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
  return callback(forbiddenOrigin(origin))
}

/** 单个上游请求的超时（毫秒）。音频模型很慢，所以默认给到 3 分钟。 */
export const providerTimeoutMs = readEnvInt('PROVIDER_TIMEOUT_MS', 180_000, 1_000, 900_000)
/** Agent（OpenAI 兼容接口）的超时，比音频模型短。 */
export const agentTimeoutMs = readEnvInt('AGENT_TIMEOUT_MS', 60_000, 1_000, 900_000)
/** 上游请求最多尝试几次（含首次）。 */
export const providerAttempts = readEnvInt('PROVIDER_RETRY_ATTEMPTS', 3, 1, 5)
/** 单次 HTTP 请求的整体上限，兜住所有上游调用的组合耗时。 */
export const requestTimeoutMs = readEnvInt('REQUEST_TIMEOUT_MS', 300_000, 1_000, 1_800_000)

/** requestId + 访问日志 + 客户端断开时的取消信号。 */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const requestId = (req.header('x-request-id') || crypto.randomUUID()).slice(0, 64)
    req.requestId = requestId
    res.setHeader('X-Request-Id', requestId)

    const controller = new AbortController()
    let reason: 'client_closed' | 'request_timeout' | null = null
    req.abortSignal = controller.signal
    req.abortReason = () => reason

    const deadline = setTimeout(() => {
      reason ??= 'request_timeout'
      controller.abort()
      logger.warn('请求整体超时，已取消上游调用', { requestId, url: req.originalUrl, timeoutMs: requestTimeoutMs })
    }, requestTimeoutMs)
    deadline.unref?.()

    const startedAt = Date.now()
    res.on('close', () => {
      clearTimeout(deadline)
      // !writableEnded 说明响应还没写完，是客户端提前断开
      if (!res.writableEnded) {
        reason ??= 'client_closed'
        controller.abort()
        logger.info('客户端提前断开连接', { requestId, method: req.method, url: req.originalUrl })
        return
      }
      logger.info('请求完成', {
        requestId,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - startedAt,
      })
    })
    next()
  }
}

/** 包一层 catch，让所有路由错误都进到统一的 errorHandler。 */
export function asyncHandler<T extends ExpressRequest>(
  handler: (req: T, res: ExpressResponse) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req as T, res).catch(next)
  }
}

const isJsonSyntaxError = (error: unknown): boolean =>
  error instanceof SyntaxError && 'body' in error

export function notFoundHandler(req: ExpressRequest) {
  throw notFound(`接口不存在：${req.method} ${req.path}`)
}

/** 统一错误出口：所有响应都长成 { error, code, status, retryable, detail?, requestId }。 */
export function errorHandler(
  error: unknown,
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction,
) {
  if (res.headersSent) return next(error)
  const appError: AppError = isJsonSyntaxError(error)
    ? badRequest('请求体不是有效 JSON，请检查 JSON 格式。')
    : toAppError(error)
  const meta = {
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl,
    code: appError.code,
    status: appError.status,
    detail: appError.detail,
  }
  if (appError.status >= 500) logger.error(appError.message, meta)
  else logger.warn(appError.message, meta)
  // 客户端已经走了就当无事发生，只留日志
  if (res.writableEnded) return
  res.status(appError.status).json(errorPayload(appError, req.requestId))
}

const RETRYABLE_STATUS = (status: number) => status === 408 || status === 429 || status >= 500

/** 退避基数（毫秒）。重试会等 base * 2^(n-1) 再加一点抖动，避免同时打上游。 */
const backoffMs = (attempt: number) =>
  Math.min(8_000, readEnvInt('PROVIDER_RETRY_BASE_MS', 500, 0, 30_000) * 2 ** (attempt - 1))
  + Math.floor(Math.random() * 250)

/** 上游给了 Retry-After 就听它的（但最多等 10 秒，别把前端挂太久）。 */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after')
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.min(10_000, Math.max(0, seconds * 1000))
  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.min(10_000, Math.max(0, date - Date.now()))
  return null
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export type FetchWithRetryOptions = {
  label: string
  timeoutMs?: number
  attempts?: number
  signal?: AbortSignal
}

/**
 * 带超时与指数退避重试的 fetch。
 *
 * - 只在「网络错误 / 408 / 429 / 5xx」时重试，别把 400 这类参数错误也重试一遍。
 * - 每次尝试都是独立超时；`signal`（客户端断开或整体超时）会立刻中止。
 * - 返回最后一次的 Response（可能 !ok），由调用方按状态码转成错误。
 */
export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit = {},
  options: FetchWithRetryOptions,
): Promise<Response> {
  const { label, timeoutMs = providerTimeoutMs, attempts = providerAttempts, signal } = options
  let lastError: unknown = new Error('PROVIDER_TIMEOUT')

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw new Error('PROVIDER_TIMEOUT')
    const attemptController = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      attemptController.abort()
    }, timeoutMs)
    const forwardAbort = () => attemptController.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })

    let response: Response | null = null
    try {
      response = await fetch(input, { ...init, signal: attemptController.signal })
    } catch (error) {
      lastError = timedOut || signal?.aborted ? new Error('PROVIDER_TIMEOUT') : error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }

    if (response) {
      if (response.ok || !RETRYABLE_STATUS(response.status) || attempt === attempts) return response
      const waitMs = retryAfterMs(response) ?? backoffMs(attempt)
      logger.warn('上游返回可重试状态，准备重试', { label, attempt, status: response.status, waitMs })
      await sleep(waitMs, signal)
      continue
    }

    if (attempt === attempts || signal?.aborted) break
    const waitMs = backoffMs(attempt)
    logger.warn('上游请求失败，准备重试', {
      label,
      attempt,
      waitMs,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    })
    await sleep(waitMs, signal)
  }

  throw lastError
}
