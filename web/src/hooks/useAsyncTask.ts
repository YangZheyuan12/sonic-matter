import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, isApiError, isCanceled } from '../api/client'

export type TaskRunner<T = unknown> = (signal: AbortSignal) => Promise<T>

export type AsyncTask = {
  /** 正在执行 */
  loading: boolean
  /** 给用户看的任务名，例如「概念解释」「真实音效生成」 */
  label: string
  /** 失败原因（中文，可直接展示） */
  error: string | null
  code: string | null
  /** 是否值得给「重试」按钮 */
  retryable: boolean
  /** 被用户取消（不是失败） */
  canceled: boolean
  /** 已经跑了多少秒 */
  elapsed: number
  run: <T>(task: TaskRunner<T>, label: string) => Promise<T | undefined>
  cancel: () => void
  retry: () => void
  dismiss: () => void
}

/**
 * 把「一次异步任务」的 loading / 取消 / 报错 / 耗时收在一个钩子里，
 * 避免每个调用点各写一套 setLoading + catch + notice。
 *
 * - `run` 会拿到一个 AbortSignal，请一路传给 apiFetch。
 * - 用户点取消时任务会以 `canceled: true` 收场，而不是报错。
 * - `retry` 会重新执行上一次的 run。
 */
export function useAsyncTask(): AsyncTask {
  const controller = useRef<AbortController | null>(null)
  const lastRun = useRef<{ task: TaskRunner<never>; label: string } | null>(null)
  const [state, setState] = useState({
    loading: false,
    label: '',
    error: null as string | null,
    code: null as string | null,
    retryable: false,
    canceled: false,
    startedAt: 0,
  })
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!state.loading) return
    const timer = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - state.startedAt) / 1000))
    }, 500)
    return () => window.clearInterval(timer)
  }, [state.loading, state.startedAt])

  const run = useCallback(async <T,>(task: TaskRunner<T>, label: string) => {
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    lastRun.current = { task: task as TaskRunner<never>, label }
    setElapsed(0)
    setState({ loading: true, label, error: null, code: null, retryable: false, canceled: false, startedAt: Date.now() })
    try {
      const result = await task(next.signal)
      if (controller.current === next) {
        setState(current => ({ ...current, loading: false }))
      }
      return result
    } catch (error) {
      if (controller.current !== next) return undefined
      if (isCanceled(error)) {
        setState(current => ({ ...current, loading: false, canceled: true, error: null }))
        return undefined
      }
      setState(current => ({
        ...current,
        loading: false,
        canceled: false,
        error: errorMessage(error, `${label}失败，请稍后重试。`),
        code: isApiError(error) ? error.code : null,
        retryable: isApiError(error) ? error.retryable : true,
      }))
      return undefined
    } finally {
      if (controller.current === next) controller.current = null
    }
  }, [])

  const cancel = useCallback(() => {
    controller.current?.abort()
    controller.current = null
  }, [])

  const dismiss = useCallback(() => {
    setState(current => ({ ...current, error: null, code: null, canceled: false }))
  }, [])

  const retry = useCallback(() => {
    const previous = lastRun.current
    if (!previous) return
    void run(previous.task, previous.label)
  }, [run])

  return { ...state, elapsed, run, cancel, retry, dismiss }
}
