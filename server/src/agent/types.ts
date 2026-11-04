import { z } from 'zod'

export const agentSchemaLimits = {
  idLength: 80,
  instructionLength: 500,
  runSummaryLength: 1_000,
  stepTitleLength: 120,
  stepSummaryLength: 1_000,
  toolNameLength: 80,
  toolInputSummaryLength: 1_000,
  toolOutputSummaryLength: 2_000,
  errorCodeLength: 80,
  errorMessageLength: 500,
  stepsPerRun: 32,
  toolCallsPerStep: 16,
} as const

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(agentSchemaLimits.idLength)
  .regex(/^[A-Za-z0-9_-]+$/, 'ID 只能包含字母、数字、下划线和连字符')

const timestampSchema = z.number().int().nonnegative()

const errorCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(agentSchemaLimits.errorCodeLength)
  .regex(/^[a-z][a-z0-9_]*$/, '错误码必须使用小写 snake_case')

const errorMessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(agentSchemaLimits.errorMessageLength)

export const agentRunStatusSchema = z.enum([
  'planning',
  'executing',
  'validating',
  'revising',
  'awaiting_approval',
  'completed',
  'failed',
  'canceled',
])

export const agentExecutionStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'canceled',
])

export const agentStepKindSchema = z.enum([
  'planning',
  'tool',
  'validation',
  'revision',
])

const toolCallBaseShape = {
  id: idSchema,
  toolName: z
    .string()
    .trim()
    .min(1)
    .max(agentSchemaLimits.toolNameLength)
    .regex(/^[a-z][a-z0-9_]*$/, '工具名必须使用小写 snake_case'),
  inputSummary: z
    .string()
    .trim()
    .min(1)
    .max(agentSchemaLimits.toolInputSummaryLength),
}

const pendingToolCallSchema = z
  .object({
    ...toolCallBaseShape,
    status: z.literal('pending'),
  })
  .strict()

const runningToolCallSchema = z
  .object({
    ...toolCallBaseShape,
    status: z.literal('running'),
    startedAt: timestampSchema,
  })
  .strict()

const succeededToolCallSchema = z
  .object({
    ...toolCallBaseShape,
    status: z.literal('succeeded'),
    outputSummary: z
      .string()
      .trim()
      .min(1)
      .max(agentSchemaLimits.toolOutputSummaryLength),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
  })
  .strict()

const failedToolCallSchema = z
  .object({
    ...toolCallBaseShape,
    status: z.literal('failed'),
    errorCode: errorCodeSchema,
    errorMessage: errorMessageSchema,
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
  })
  .strict()

const canceledToolCallSchema = z
  .object({
    ...toolCallBaseShape,
    status: z.literal('canceled'),
    errorMessage: errorMessageSchema.optional(),
    startedAt: timestampSchema.optional(),
    finishedAt: timestampSchema,
  })
  .strict()

export const agentToolCallSchema = z
  .discriminatedUnion('status', [
    pendingToolCallSchema,
    runningToolCallSchema,
    succeededToolCallSchema,
    failedToolCallSchema,
    canceledToolCallSchema,
  ])
  .superRefine((toolCall, context) => {
    if (
      'startedAt' in toolCall &&
      toolCall.startedAt !== undefined &&
      'finishedAt' in toolCall &&
      toolCall.finishedAt < toolCall.startedAt
    ) {
      context.addIssue({
        code: 'custom',
        message: 'finishedAt 不能早于 startedAt',
        path: ['finishedAt'],
      })
    }
  })

export const agentStepSchema = z
  .object({
    id: idSchema,
    kind: agentStepKindSchema,
    status: agentExecutionStatusSchema,
    title: z
      .string()
      .trim()
      .min(1)
      .max(agentSchemaLimits.stepTitleLength),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(agentSchemaLimits.stepSummaryLength)
      .optional(),
    toolCalls: z
      .array(agentToolCallSchema)
      .max(agentSchemaLimits.toolCallsPerStep),
    startedAt: timestampSchema.optional(),
    finishedAt: timestampSchema.optional(),
    errorCode: errorCodeSchema.optional(),
    errorMessage: errorMessageSchema.optional(),
  })
  .strict()
  .superRefine((step, context) => {
    if (
      step.startedAt !== undefined &&
      step.finishedAt !== undefined &&
      step.finishedAt < step.startedAt
    ) {
      context.addIssue({
        code: 'custom',
        message: 'finishedAt 不能早于 startedAt',
        path: ['finishedAt'],
      })
    }
  })

export const agentRunSchema = z
  .object({
    id: idSchema,
    status: agentRunStatusSchema,
    instruction: z
      .string()
      .trim()
      .min(1)
      .max(agentSchemaLimits.instructionLength),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    steps: z.array(agentStepSchema).max(agentSchemaLimits.stepsPerRun),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(agentSchemaLimits.runSummaryLength)
      .optional(),
    errorCode: errorCodeSchema.optional(),
    errorMessage: errorMessageSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.updatedAt < run.createdAt) {
      context.addIssue({
        code: 'custom',
        message: 'updatedAt 不能早于 createdAt',
        path: ['updatedAt'],
      })
    }
  })

export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>
export type AgentExecutionStatus = z.infer<typeof agentExecutionStatusSchema>
export type AgentStepKind = z.infer<typeof agentStepKindSchema>

export type ToolCall = Readonly<z.infer<typeof agentToolCallSchema>>

type AgentStepValue = z.infer<typeof agentStepSchema>
export type AgentStep = Readonly<
  Omit<AgentStepValue, 'toolCalls'> & { toolCalls: readonly ToolCall[] }
>

type AgentRunValue = z.infer<typeof agentRunSchema>
export type AgentRun = Readonly<
  Omit<AgentRunValue, 'steps'> & { steps: readonly AgentStep[] }
>
