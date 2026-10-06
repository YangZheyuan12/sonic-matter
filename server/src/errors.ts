import { z } from 'zod'

/**
 * 统一错误模型。
 *
 * 约定：路由里只抛 `AppError`（或用下面的工厂函数），
 * 由 http.ts 里的 errorHandler 统一翻译成响应信封：
 *
 *   { error: string, code: string, status: number, retryable: boolean, detail?: string, requestId?: string }
 *
 * `retryable` 是给前端用的：为 true 时界面会给出「重试」按钮。
 */

export type ErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'forbidden'
  | 'quota_exceeded'
  | 'payload_too_large'
  | 'cors_not_allowed'
  | 'provider_not_configured'
  | 'provider_unauthorized'
  | 'provider_rate_limited'
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'provider_bad_response'
  | 'client_closed_request'
  | 'internal_error'

export type ErrorPayload = {
  error: string
  code: ErrorCode
  status: number
  retryable: boolean
  detail?: string
  requestId?: string
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly retryable: boolean
  readonly detail?: string

  constructor(
    message: string,
    options: { code: ErrorCode; status: number; retryable?: boolean; detail?: string; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.code = options.code
    this.status = options.status
    this.retryable = options.retryable ?? false
    this.detail = options.detail
  }
}

export const badRequest = (message: string, detail?: string) =>
  new AppError(message, { code: 'bad_request', status: 400, detail })

export const notFound = (message = '接口不存在。') => new AppError(message, { code: 'not_found', status: 404 })

/** 不允许修改别人的东西（云端工程不是本机浏览器保存的）。注意这不是账号认证，只是防误改。 */
export const forbidden = (message: string, detail?: string) =>
  new AppError(message, { code: 'forbidden', status: 403, detail })

/** 配额用尽（云端工程数量上限）：重试没有意义，要用户先删掉一些。 */
export const quotaExceeded = (message: string, detail?: string) =>
  new AppError(message, { code: 'quota_exceeded', status: 429, detail })

export const payloadTooLarge = (message = '请求体过大，请减少数据量后重试。', detail?: string) =>
  new AppError(message, { code: 'payload_too_large', status: 413, detail })

/** 浏览器来源不在 CORS_ORIGIN 名单里。这是配置问题，重试没有意义。 */
export const forbiddenOrigin = (origin: string) =>
  new AppError(
    `当前来源（${origin}）不在允许的 CORS_ORIGIN 列表中，请把它加进 server/.env 后重启服务。`,
    { code: 'cors_not_allowed', status: 403, detail: origin },
  )

export const providerNotConfigured = (message: string, detail?: string) =>
  new AppError(message, { code: 'provider_not_configured', status: 503, detail })

/** 空值 / 非法值与「服务器故障」要分开说，方便用户知道是自己填错了还是稍后再试。 */
export const isClientGone = (error: unknown) => error instanceof AppError && error.code === 'client_closed_request'

/** 把 zod 校验错误压成一行，方便放进 detail。 */
export function zodDetail(error: z.ZodError, limit = 3): string {
  return error.issues
    .slice(0, limit)
    .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

/** 上游返回的 HTTP 状态码 → AppError。 */
export function fromProviderStatus(status: number, label: string, detail?: string, cause?: unknown): AppError {
  if (status === 408) {
    return new AppError(`${label} 响应超时（HTTP 408），请稍后重试。`, {
      code: 'provider_timeout',
      status: 504,
      retryable: true,
      detail,
      cause,
    })
  }
  if (status === 429) {
    return new AppError(`${label} 触发了速率限制，请稍后重试。`, {
      code: 'provider_rate_limited',
      status: 429,
      retryable: true,
      detail,
      cause,
    })
  }
  if (status === 401 || status === 403) {
    return new AppError(`${label} 拒绝了这次请求：API Key 无效或没有权限。`, {
      code: 'provider_unauthorized',
      status: 502,
      detail,
      cause,
    })
  }
  if (status === 404) {
    return new AppError(`${label} 找不到指定的模型或资源，请检查模型名称。`, {
      code: 'provider_bad_response',
      status: 502,
      detail,
      cause,
    })
  }
  if (status >= 500) {
    return new AppError(`${label} 暂时不可用（HTTP ${status}），请稍后重试。`, {
      code: 'provider_unavailable',
      status: 502,
      retryable: true,
      detail,
      cause,
    })
  }
  return new AppError(`${label} 拒绝了这次请求（HTTP ${status}），请检查参数。`, {
    code: 'provider_bad_response',
    status: 502,
    detail,
    cause,
  })
}

const SENTINELS: Record<string, { code: ErrorCode; status: number; message: string; retryable?: boolean }> = {
  OPENAI_API_KEY_MISSING: {
    code: 'provider_not_configured',
    status: 503,
    message: '未配置 Agent API Key，无法执行真实 Agent 请求。',
  },
  REPLICATE_API_TOKEN_MISSING: {
    code: 'provider_not_configured',
    status: 503,
    message: '未配置 REPLICATE_API_TOKEN，无法生成真实音乐。',
  },
  ELEVENLABS_API_KEY_MISSING: {
    code: 'provider_not_configured',
    status: 503,
    message: '未配置 ELEVENLABS_API_KEY，无法生成真实音效。',
  },
  OPENAI_EMPTY_OUTPUT: {
    code: 'provider_bad_response',
    status: 502,
    message: 'Agent 返回了空内容，请重试或更换模型。',
    retryable: true,
  },
  REPLICATE_EMPTY_OUTPUT: {
    code: 'provider_bad_response',
    status: 502,
    message: '音乐生成服务没有返回音频地址。',
    retryable: true,
  },
  PROVIDER_TIMEOUT: {
    code: 'provider_timeout',
    status: 504,
    message: '上游服务响应超时，请稍后重试。',
    retryable: true,
  },
}

/** `PREFIX_503` 这类哨兵错误 → 上游状态码 → AppError。 */
const STATUS_SENTINEL = /^(AUDIO_DOWNLOAD|REPLICATE_POLL|REPLICATE_CREATE|ELEVENLABS_GENERATE)_(\d{3})$/

const LABELS: Record<string, string> = {
  AUDIO_DOWNLOAD: '音频下载',
  REPLICATE_POLL: '音乐生成任务轮询',
  REPLICATE_CREATE: '音乐生成任务创建',
  ELEVENLABS_GENERATE: '音效生成',
}

export const isAbortError = (error: unknown) =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')

/** 任何异常 → AppError。日志与响应都基于它的 code / status。 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (error instanceof z.ZodError) {
    return new AppError('返回的数据不符合预期结构。', {
      code: 'provider_bad_response',
      status: 502,
      retryable: true,
      detail: zodDetail(error),
      cause: error,
    })
  }
  if (isAbortError(error)) {
    return new AppError('客户端已断开连接。', { code: 'client_closed_request', status: 499, cause: error })
  }
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const sentinel = SENTINELS[raw]
  if (sentinel) {
    return new AppError(sentinel.message, {
      code: sentinel.code,
      status: sentinel.status,
      retryable: sentinel.retryable ?? false,
      detail: raw,
      cause: error,
    })
  }
  const statusSentinel = STATUS_SENTINEL.exec(raw)
  if (statusSentinel) {
    const status = Number(statusSentinel[2])
    return fromProviderStatus(status, LABELS[statusSentinel[1]] ?? '上游服务', raw, error)
  }
  if (raw.startsWith('OPENAI_INCOMPLETE_')) {
    return new AppError('Agent 的输出被截断（模型没有生成完整 JSON），可以换个模型或直接重试。', {
      code: 'provider_bad_response',
      status: 502,
      retryable: true,
      detail: raw,
      cause: error,
    })
  }
  if (raw.startsWith('REPLICATE_')) {
    return new AppError('音乐生成没有成功完成，请稍后重试。', {
      code: 'provider_unavailable',
      status: 502,
      retryable: true,
      detail: raw,
      cause: error,
    })
  }
  // body-parser 超限：错误对象上带 type: 'entity.too.large'（也带 status 413，
  // 但那是「请求体太大」而不是上游拒绝，必须在通用的 .status 分支之前拦下来）。
  const bodyParserType = (error as { type?: unknown } | null)?.type
  if (bodyParserType === 'entity.too.large') return payloadTooLarge(undefined, String(bodyParserType))
  // OpenAI SDK 的错误带 .status
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number') return fromProviderStatus(status, '上游 Agent', raw, error)
  return new AppError('服务器内部错误，请稍后重试。', {
    code: 'internal_error',
    status: 500,
    detail: raw || undefined,
    cause: error,
  })
}

export function errorPayload(error: AppError, requestId?: string): ErrorPayload {
  const payload: ErrorPayload = {
    error: error.message,
    code: error.code,
    status: error.status,
    retryable: error.retryable,
  }
  if (error.detail) payload.detail = error.detail
  if (requestId) payload.requestId = requestId
  return payload
}
