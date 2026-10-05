/**
 * 前端统一的请求层。
 *
 * 所有对后端的请求都从这里发出，集中处理三件事：
 * 1. 超时：避免上游模型卡住时界面永远停在“生成中”。
 * 2. 取消：用户可以主动中止一次生成（AbortSignal 一路传到后端）。
 * 3. 错误文案：把后端的统一错误信封 `{ error, code, detail, retryable, requestId }`
 *    翻译成能直接显示给用户的中文提示，并保留 `code` / `retryable` 供 UI 决定是否给“重试”。
 */

export type ApiErrorCode =
  | 'client_canceled'
  | 'client_timeout'
  | 'network_error'
  | 'bad_response'
  | string

export type ApiErrorInit = {
  code: ApiErrorCode
  status?: number
  retryable?: boolean
  detail?: string
  requestId?: string
}

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status?: number
  readonly retryable: boolean
  readonly detail?: string
  readonly requestId?: string

  constructor(message: string, init: ApiErrorInit) {
    super(message)
    this.name = 'ApiError'
    this.code = init.code
    this.status = init.status
    this.retryable = init.retryable ?? false
    this.detail = init.detail
    this.requestId = init.requestId
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError

/** 用户主动取消。UI 里不该把它当成失败提示。 */
export const isCanceled = (error: unknown) => isApiError(error) && error.code === 'client_canceled'

/** 任何异常 → 可展示的中文文案。 */
export const errorMessage = (error: unknown, fallback = '操作失败，请稍后重试。'): string => {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/** 默认 90 秒：比后端对上游的超时（60 秒）略长，让后端先给出明确错误。 */
export const DEFAULT_TIMEOUT_MS = 90_000

/** 真实音频 / 音乐模型可能跑几分钟。 */
export const LONG_TIMEOUT_MS = 240_000

type ServerErrorBody = {
  error?: string
  message?: string
  detail?: string
  code?: string
  retryable?: boolean
  requestId?: string
}

export type ApiOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

async function send(path: string, init: RequestInit, options: ApiOptions): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: external } = options
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onExternalAbort = () => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
  try {
    return await fetch(path, { ...init, signal: controller.signal })
  } catch (error) {
    if (external?.aborted) throw new ApiError('已取消这次请求。', { code: 'client_canceled' })
    if (timedOut) {
      throw new ApiError(`等待超过 ${Math.round(timeoutMs / 1000)} 秒仍没有响应，已自动中止。`, {
        code: 'client_timeout',
        retryable: true,
      })
    }
    throw new ApiError('无法连接后端服务，请确认后端已在 8787 端口启动（仓库根目录可执行 npm run dev）。', {
      code: 'network_error',
      retryable: true,
      detail: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => '')
  let body: ServerErrorBody | null = null
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object') body = parsed as ServerErrorBody
    } catch {
      body = null
    }
  }
  if (body) {
    const message = body.error ?? body.message ?? `请求失败（HTTP ${response.status}）。`
    return new ApiError(message, {
      code: body.code ?? `http_${response.status}`,
      status: response.status,
      retryable: body.retryable ?? response.status >= 500,
      detail: body.detail,
      requestId: body.requestId,
    })
  }
  const preview = text.replace(/\s+/g, ' ').slice(0, 120)
  if (!preview) {
    return new ApiError(`请求失败（HTTP ${response.status}），服务器没有返回错误详情。`, {
      code: `http_${response.status}`,
      status: response.status,
      retryable: response.status >= 500,
    })
  }
  return new ApiError(`服务器返回的不是有效 JSON（HTTP ${response.status}）：${preview}`, {
    code: `http_${response.status}`,
    status: response.status,
    retryable: response.status >= 500,
  })
}

/** POST JSON 并解析 JSON 响应。 */
export async function apiFetch<T>(
  path: string,
  body?: unknown,
  options: ApiOptions = {},
): Promise<T> {
  const response = await send(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    options,
  )
  if (!response.ok) throw await toApiError(response)
  const text = await response.text()
  if (!text.trim()) {
    throw new ApiError('服务器返回了空响应，请确认后端已启动。', { code: 'bad_response', status: response.status })
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(
      `服务器返回的不是有效 JSON（HTTP ${response.status}）：${text.replace(/\s+/g, ' ').slice(0, 120)}`,
      { code: 'bad_response', status: response.status },
    )
  }
}

/** POST JSON 并取回二进制（MIDI / WAV 之类的导出）。 */
export async function apiFetchBlob(
  path: string,
  body?: unknown,
  options: ApiOptions = {},
): Promise<Blob> {
  const response = await send(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    options,
  )
  if (!response.ok) throw await toApiError(response)
  return response.blob()
}
