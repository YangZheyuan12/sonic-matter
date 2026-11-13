import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, isCanceled } from '../api/client.ts'
import {
  approveAgentRun,
  cancelAgentRun,
  createAgentRun,
  pollAgentRun,
  rejectAgentRun,
  shouldPollResource,
  type AgentRunResource,
  type CreateAgentRunInput,
} from './run.ts'

export type AgentRunController = {
  resource: AgentRunResource | null
  creating: boolean
  polling: boolean
  canceling: boolean
  deciding: 'approve' | 'reject' | null
  busy: boolean
  error: string | null
  sourceProject: CreateAgentRunInput['project'] | null
  start: (input: CreateAgentRunInput) => Promise<AgentRunResource | null>
  cancel: () => Promise<void>
  approve: () => Promise<AgentRunResource | null>
  reject: () => Promise<AgentRunResource | null>
  pause: () => void
  resume: () => void
  dismissError: () => void
}

/** 管理单个可见 Run；组件卸载或开始新 Run 时会停止旧轮询。 */
export function useAgentRun(): AgentRunController {
  const mounted = useRef(true)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const decisionInFlight = useRef(false)
  const resourceRef = useRef<AgentRunResource | null>(null)
  const [resource, setResource] = useState<AgentRunResource | null>(null)
  const [creating, setCreating] = useState(false)
  const [polling, setPolling] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sourceProject, setSourceProject] = useState<CreateAgentRunInput['project'] | null>(null)

  const updateResource = useCallback((next: AgentRunResource | null) => {
    resourceRef.current = next
    if (mounted.current) setResource(next)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
      controller.current?.abort()
      controller.current = null
    }
  }, [])

  const start = useCallback(async (input: CreateAgentRunInput) => {
    generation.current += 1
    const runGeneration = generation.current
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    updateResource(null)
    setSourceProject(input.project)
    setCreating(true)
    setPolling(false)
    setCanceling(false)
    setDeciding(null)
    setError(null)
    try {
      const created = await createAgentRun(input, { signal: nextController.signal })
      if (!mounted.current || generation.current !== runGeneration) return null
      updateResource(created)
      setCreating(false)
      if (!shouldPollResource(created)) {
        controller.current = null
        return created
      }
      setPolling(true)
      void pollAgentRun(created.run.id, {
        signal: nextController.signal,
        onUpdate: updateResource,
      }).catch((reason: unknown) => {
        if (!mounted.current || generation.current !== runGeneration || isCanceled(reason)) return
        setError(errorMessage(reason, '获取 Agent 执行状态失败。'))
      }).finally(() => {
        if (!mounted.current || generation.current !== runGeneration) return
        setPolling(false)
        if (controller.current === nextController) controller.current = null
      })
      return created
    } catch (reason) {
      if (!mounted.current || generation.current !== runGeneration || isCanceled(reason)) return null
      setError(errorMessage(reason, '创建 Agent Run 失败。'))
      setCreating(false)
      if (controller.current === nextController) controller.current = null
      return null
    }
  }, [updateResource])

  const decide = useCallback(async (decision: 'approve' | 'reject') => {
    if (decisionInFlight.current) return null
    const id = resourceRef.current?.run.id
    if (!id) return null
    decisionInFlight.current = true
    setDeciding(decision)
    setError(null)
    try {
      const decided = await (decision === 'approve' ? approveAgentRun(id) : rejectAgentRun(id))
      if (!mounted.current || resourceRef.current?.run.id !== id) return null
      updateResource(decided)
      return decided
    } catch (reason) {
      if (!mounted.current || isCanceled(reason)) return null
      setError(errorMessage(reason, decision === 'approve'
        ? '批准候选工程失败，请重试。'
        : '拒绝候选工程失败，请重试。'))
      return null
    } finally {
      decisionInFlight.current = false
      if (mounted.current && resourceRef.current?.run.id === id) setDeciding(null)
    }
  }, [updateResource])

  const approve = useCallback(() => decide('approve'), [decide])
  const reject = useCallback(() => decide('reject'), [decide])

  const cancel = useCallback(async () => {
    const id = resourceRef.current?.run.id
    if (!id) return
    generation.current += 1
    const cancelGeneration = generation.current
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    setPolling(false)
    setCanceling(true)
    setError(null)
    try {
      const canceled = await cancelAgentRun(id, { signal: nextController.signal })
      if (!mounted.current || generation.current !== cancelGeneration) return
      updateResource(canceled)
    } catch (reason) {
      if (!mounted.current || generation.current !== cancelGeneration || isCanceled(reason)) return
      setError(errorMessage(reason, '取消 Agent Run 失败。'))
    } finally {
      if (mounted.current && generation.current === cancelGeneration) {
        setCanceling(false)
        if (controller.current === nextController) controller.current = null
      }
    }
  }, [updateResource])

  const pause = useCallback(() => {
    generation.current += 1
    controller.current?.abort()
    controller.current = null
    if (mounted.current) {
      setCreating(false)
      setPolling(false)
      setCanceling(false)
    }
  }, [])

  const resume = useCallback(() => {
    const current = resourceRef.current
    if (!mounted.current || controller.current || !current || !shouldPollResource(current)) return
    generation.current += 1
    const runGeneration = generation.current
    const nextController = new AbortController()
    controller.current = nextController
    setPolling(true)
    setError(null)
    void pollAgentRun(current.run.id, {
      signal: nextController.signal,
      onUpdate: updateResource,
    }).catch((reason: unknown) => {
      if (!mounted.current || generation.current !== runGeneration || isCanceled(reason)) return
      setError(errorMessage(reason, '获取 Agent 执行状态失败。'))
    }).finally(() => {
      if (!mounted.current || generation.current !== runGeneration) return
      setPolling(false)
      if (controller.current === nextController) controller.current = null
    })
  }, [updateResource])

  const dismissError = useCallback(() => setError(null), [])

  return {
    resource,
    creating,
    polling,
    canceling,
    deciding,
    busy: creating || polling || canceling || deciding !== null,
    error,
    sourceProject,
    start,
    cancel,
    approve,
    reject,
    pause,
    resume,
    dismissError,
  }
}
