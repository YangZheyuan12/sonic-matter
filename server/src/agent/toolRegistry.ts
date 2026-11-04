import { z } from 'zod'

export const agentToolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9_]*$/, '工具名必须使用小写 snake_case')

export type AgentToolContext = Readonly<{
  signal?: AbortSignal
}>

export interface AgentTool<Input, Output> {
  readonly name: string
  readonly description: string
  readonly inputSchema: z.ZodType<Input>
  readonly outputSchema: z.ZodType<Output>
  execute(input: Input, context: AgentToolContext): Output | Promise<Output>
}

export type AgentToolMetadata = Readonly<{
  name: string
  description: string
  inputSchema: z.ZodType<unknown>
  outputSchema: z.ZodType<unknown>
}>

export type AgentToolErrorCode =
  | 'unknown_tool'
  | 'invalid_tool_input'
  | 'invalid_tool_output'
  | 'tool_execution_failed'
  | 'tool_execution_canceled'

export type AgentToolValidationIssue = Readonly<{
  path: readonly (string | number)[]
  message: string
}>

export type AgentToolExecutionError = Readonly<{
  code: AgentToolErrorCode
  message: string
  retryable: boolean
  issues?: readonly AgentToolValidationIssue[]
}>

export type AgentToolExecutionResult =
  | Readonly<{
      ok: true
      toolName: string
      output: unknown
    }>
  | Readonly<{
      ok: false
      toolName: string
      error: AgentToolExecutionError
    }>

export class AgentToolRegistrationError extends Error {
  readonly code: 'invalid_tool_name' | 'duplicate_tool_name'

  constructor(
    code: 'invalid_tool_name' | 'duplicate_tool_name',
    message: string,
  ) {
    super(message)
    this.name = 'AgentToolRegistrationError'
    this.code = code
  }
}

type RegisteredAgentTool = Readonly<{
  metadata: AgentToolMetadata
  execute(input: unknown, context: AgentToolContext): Promise<unknown>
}>

function validationIssues(error: z.ZodError): AgentToolValidationIssue[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.map((part) =>
      typeof part === 'symbol' ? part.description ?? part.toString() : part,
    )

    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: [...path, key],
        message: issue.message,
      }))
    }

    return [{ path, message: issue.message }]
  })
}

function failure(
  toolName: string,
  code: AgentToolErrorCode,
  message: string,
  options: Readonly<{
    retryable?: boolean
    issues?: readonly AgentToolValidationIssue[]
  }> = {},
): AgentToolExecutionResult {
  return {
    ok: false,
    toolName,
    error: {
      code,
      message,
      retryable: options.retryable ?? false,
      ...(options.issues === undefined ? {} : { issues: options.issues }),
    },
  }
}

function canceled(toolName: string): AgentToolExecutionResult {
  return failure(
    toolName,
    'tool_execution_canceled',
    `工具 ${toolName} 的执行已取消。`,
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isSignalAborted(context: AgentToolContext): boolean {
  return context.signal?.aborted === true
}

function executeWithSignal(
  tool: RegisteredAgentTool,
  input: unknown,
  context: AgentToolContext,
): Promise<unknown> {
  const execution = tool.execute(input, context)
  const signal = context.signal

  if (signal === undefined) {
    return execution
  }

  return new Promise((resolve, reject) => {
    const removeAbortListener = () => {
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      removeAbortListener()
      reject(new DOMException('工具执行已取消', 'AbortError'))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }

    execution.then(
      (output) => {
        removeAbortListener()
        resolve(output)
      },
      (error: unknown) => {
        removeAbortListener()
        reject(error)
      },
    )
  })
}

export class AgentToolRegistry {
  readonly #tools = new Map<string, RegisteredAgentTool>()

  register<Input, Output>(tool: AgentTool<Input, Output>): void {
    const nameResult = agentToolNameSchema.safeParse(tool.name)

    if (!nameResult.success || nameResult.data !== tool.name) {
      throw new AgentToolRegistrationError(
        'invalid_tool_name',
        `无法注册工具“${tool.name}”：工具名必须使用小写 snake_case。`,
      )
    }

    if (this.#tools.has(tool.name)) {
      throw new AgentToolRegistrationError(
        'duplicate_tool_name',
        `无法重复注册工具“${tool.name}”。`,
      )
    }

    this.#tools.set(tool.name, {
      metadata: {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as z.ZodType<unknown>,
        outputSchema: tool.outputSchema as z.ZodType<unknown>,
      },
      execute: async (input, context) => tool.execute(input as Input, context),
    })
  }

  get(toolName: string): AgentToolMetadata | undefined {
    return this.#tools.get(toolName)?.metadata
  }

  list(): readonly AgentToolMetadata[] {
    return Array.from(this.#tools.values(), ({ metadata }) => metadata)
  }

  async execute(
    toolName: string,
    rawInput: unknown,
    context: AgentToolContext = {},
  ): Promise<AgentToolExecutionResult> {
    const tool = this.#tools.get(toolName)

    if (tool === undefined) {
      return failure(
        toolName,
        'unknown_tool',
        `工具 ${toolName} 未注册，无法执行。`,
      )
    }

    if (isSignalAborted(context)) {
      return canceled(toolName)
    }

    const inputResult = await tool.metadata.inputSchema.safeParseAsync(rawInput)

    if (!inputResult.success) {
      return failure(
        toolName,
        'invalid_tool_input',
        `工具 ${toolName} 的参数未通过校验。`,
        { issues: validationIssues(inputResult.error) },
      )
    }

    if (isSignalAborted(context)) {
      return canceled(toolName)
    }

    let rawOutput: unknown
    try {
      rawOutput = await executeWithSignal(tool, inputResult.data, context)
    } catch (error) {
      if (isSignalAborted(context) || isAbortError(error)) {
        return canceled(toolName)
      }

      return failure(
        toolName,
        'tool_execution_failed',
        `工具 ${toolName} 执行失败。`,
        { retryable: true },
      )
    }

    const outputResult = await tool.metadata.outputSchema.safeParseAsync(rawOutput)

    if (!outputResult.success) {
      return failure(
        toolName,
        'invalid_tool_output',
        `工具 ${toolName} 的返回值未通过校验。`,
        { issues: validationIssues(outputResult.error) },
      )
    }

    return {
      ok: true,
      toolName,
      output: outputResult.data,
    }
  }
}
