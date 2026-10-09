import type { Request, Response } from 'express'
import { GenerationLimitError, GenerationStore } from './generationStore.ts'
import { requestTimeoutMs } from './http.ts'
import { AppError, isAbortError, toAppError } from './errors.ts'
import type { ProviderName } from './serviceConfigStore.ts'

/** 验证参数与平台配置后调用；所有结果均记录，槽位在 finally 中释放。 */
export async function runGeneration<T>(store: GenerationStore, req: Request, res: Response, provider: ProviderName, generate: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let id: string
  try {
    // 任务有独立截止时间；崩溃后仅在截止时间到期时回收，重启不能绕过并发保护。
    id = store.reserve(req.auth!.account.id, provider, requestTimeoutMs + 30_000)
  } catch (error) {
    if (error instanceof GenerationLimitError) res.setHeader('Retry-After', error.retryAfter)
    throw error
  }
  const signal = AbortSignal.any([req.abortSignal, AbortSignal.timeout(requestTimeoutMs)])
  try {
    signal.throwIfAborted()
    const result = await generate(signal)
    signal.throwIfAborted()
    store.finish(id, 'succeeded')
    return result
  } catch (error) {
    const canceled = req.abortReason() === 'client_closed'
    const parsed = canceled
      ? new AppError('请求已取消。', { code: 'client_closed_request', status: 499 })
      : toAppError(signal.aborted || isAbortError(error) ? new Error('PROVIDER_TIMEOUT') : error)
    // 不转发供应商解析错误原文或未知异常 detail，日志和响应仅含中文消息及错误码。
    const safeError = new AppError(parsed.message, { code: parsed.code, status: parsed.status, retryable: parsed.retryable })
    store.finish(id, canceled ? 'canceled' : 'failed', safeError.code)
    throw safeError
  }
}
