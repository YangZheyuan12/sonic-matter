import { z } from 'zod'
import { projectSchema } from '../projectSchema.ts'

const constraintIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, '约束 ID 只能包含字母、数字、下划线和连字符')

const instrumentSchema = z.string().trim().min(1).max(60)

const requiredInstrumentConstraintSchema = z.object({
  id: constraintIdSchema,
  type: z.literal('required_instrument'),
  instrument: instrumentSchema,
}).strict()

const forbiddenInstrumentConstraintSchema = z.object({
  id: constraintIdSchema,
  type: z.literal('forbidden_instrument'),
  instrument: instrumentSchema,
}).strict()

const durationRangeConstraintSchema = z.object({
  id: constraintIdSchema,
  type: z.literal('duration_range'),
  minSeconds: z.number().finite().min(1).max(120).optional(),
  maxSeconds: z.number().finite().min(1).max(120).optional(),
}).strict().superRefine((constraint, context) => {
  if (constraint.minSeconds === undefined && constraint.maxSeconds === undefined) {
    context.addIssue({
      code: 'custom',
      message: '时长范围至少需要 minSeconds 或 maxSeconds',
    })
  }
  if (
    constraint.minSeconds !== undefined &&
    constraint.maxSeconds !== undefined &&
    constraint.minSeconds > constraint.maxSeconds
  ) {
    context.addIssue({
      code: 'custom',
      path: ['maxSeconds'],
      message: 'maxSeconds 不能小于 minSeconds',
    })
  }
})

const trackCountConstraintSchema = z.object({
  id: constraintIdSchema,
  type: z.literal('track_count'),
  min: z.number().int().min(1).max(32).optional(),
  max: z.number().int().min(1).max(32).optional(),
}).strict().superRefine((constraint, context) => {
  if (constraint.min === undefined && constraint.max === undefined) {
    context.addIssue({
      code: 'custom',
      message: '轨道数量范围至少需要 min 或 max',
    })
  }
  if (
    constraint.min !== undefined &&
    constraint.max !== undefined &&
    constraint.min > constraint.max
  ) {
    context.addIssue({
      code: 'custom',
      path: ['max'],
      message: 'max 不能小于 min',
    })
  }
})

const sectionNoteDensityConstraintSchema = z.object({
  id: constraintIdSchema,
  type: z.literal('section_note_density'),
  startSeconds: z.number().finite().min(0).max(120),
  endSeconds: z.number().finite().positive().max(120),
  minNotesPerSecond: z.number().finite().min(0).max(4096).optional(),
  maxNotesPerSecond: z.number().finite().min(0).max(4096).optional(),
  trackIds: z.array(z.string().trim().min(1).max(80)).min(1).max(32).optional(),
}).strict().superRefine((constraint, context) => {
  if (constraint.endSeconds <= constraint.startSeconds) {
    context.addIssue({
      code: 'custom',
      path: ['endSeconds'],
      message: 'endSeconds 必须大于 startSeconds',
    })
  }
  if (
    constraint.minNotesPerSecond === undefined &&
    constraint.maxNotesPerSecond === undefined
  ) {
    context.addIssue({
      code: 'custom',
      message: '音符密度至少需要 minNotesPerSecond 或 maxNotesPerSecond',
    })
  }
  if (
    constraint.minNotesPerSecond !== undefined &&
    constraint.maxNotesPerSecond !== undefined &&
    constraint.minNotesPerSecond > constraint.maxNotesPerSecond
  ) {
    context.addIssue({
      code: 'custom',
      path: ['maxNotesPerSecond'],
      message: 'maxNotesPerSecond 不能小于 minNotesPerSecond',
    })
  }
  if (constraint.trackIds !== undefined) {
    const ids = new Set<string>()
    constraint.trackIds.forEach((id, index) => {
      if (ids.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['trackIds', index],
          message: `轨道 ID“${id}”重复`,
        })
      }
      ids.add(id)
    })
  }
})

export const evaluationConstraintSchema = z.union([
  requiredInstrumentConstraintSchema,
  forbiddenInstrumentConstraintSchema,
  durationRangeConstraintSchema,
  trackCountConstraintSchema,
  sectionNoteDensityConstraintSchema,
])

export const evaluationConstraintsSchema = z
  .array(evaluationConstraintSchema)
  .min(1)
  .max(32)
  .superRefine((constraints, context) => {
    const ids = new Set<string>()
    constraints.forEach((constraint, index) => {
      if (ids.has(constraint.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `约束 ID“${constraint.id}”重复`,
        })
      }
      ids.add(constraint.id)
    })
  })

const actualValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
])

export const evaluationRuleResultSchema = z.object({
  id: constraintIdSchema,
  type: z.enum([
    'required_instrument',
    'forbidden_instrument',
    'duration_range',
    'track_count',
    'section_note_density',
  ]),
  passed: z.boolean(),
  actual: z.record(z.string(), actualValueSchema),
  reason: z.string().trim().min(1).max(4_000),
}).strict()

export const evaluationReportSchema = z.object({
  passed: z.boolean(),
  failedRuleIds: z.array(constraintIdSchema),
  rules: z.array(evaluationRuleResultSchema).min(1).max(32),
}).strict().superRefine((report, context) => {
  const expectedFailedIds = report.rules
    .filter((rule) => !rule.passed)
    .map((rule) => rule.id)
  if (report.passed !== (expectedFailedIds.length === 0)) {
    context.addIssue({ code: 'custom', path: ['passed'], message: '汇总状态与规则结果不一致' })
  }
  if (
    report.failedRuleIds.length !== expectedFailedIds.length ||
    report.failedRuleIds.some((id, index) => id !== expectedFailedIds[index])
  ) {
    context.addIssue({
      code: 'custom',
      path: ['failedRuleIds'],
      message: '失败规则 ID 与规则结果不一致',
    })
  }
})

export type EvaluationConstraint = Readonly<z.infer<typeof evaluationConstraintSchema>>
export type EvaluationRuleResult = Readonly<z.infer<typeof evaluationRuleResultSchema>>
export type EvaluationReport = Readonly<z.infer<typeof evaluationReportSchema>>

export type EvaluateProjectInput = Readonly<{
  project: unknown
  constraints: unknown
}>

export type EvaluatorResult =
  | Readonly<{ ok: true; report: EvaluationReport }>
  | Readonly<{
      ok: false
      error: Readonly<{
        code: 'invalid_evaluator_input'
        message: string
        issues: readonly Readonly<{
          path: readonly (string | number)[]
          message: string
        }>[]
      }>
    }>

const evaluatorInputSchema = z.object({
  project: projectSchema,
  constraints: evaluationConstraintsSchema,
}).strict()

type Project = z.infer<typeof projectSchema>

function schemaIssues(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) =>
      typeof part === 'symbol' ? part.description ?? part.toString() : part,
    ),
    message: issue.message,
  }))
}

function normalizedInstrument(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase()
}

function projectInstruments(project: Project): string[] {
  const seen = new Set<string>()
  const instruments: string[] = []
  for (const track of project.tracks) {
    const instrument = track.instrument.trim()
    const normalized = normalizedInstrument(instrument)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      instruments.push(instrument)
    }
  }
  return instruments
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

function rangeText(min: number | undefined, max: number | undefined, unit: string): string {
  if (min !== undefined && max !== undefined) {
    return `${formatNumber(min)}–${formatNumber(max)}${unit}`
  }
  if (min !== undefined) return `至少 ${formatNumber(min)}${unit}`
  return `至多 ${formatNumber(max!)}${unit}`
}

function withinRange(value: number, min: number | undefined, max: number | undefined): boolean {
  return (min === undefined || value >= min) && (max === undefined || value <= max)
}

function instrumentRule(
  project: Project,
  constraint: Extract<
    EvaluationConstraint,
    { type: 'required_instrument' | 'forbidden_instrument' }
  >,
): EvaluationRuleResult {
  const instruments = projectInstruments(project)
  const expected = normalizedInstrument(constraint.instrument)
  const matchCount = project.tracks.filter(
    (track) => normalizedInstrument(track.instrument) === expected,
  ).length
  const required = constraint.type === 'required_instrument'
  const passed = required ? matchCount > 0 : matchCount === 0
  const list = instruments.length > 0 ? instruments.join('、') : '无'
  const reason = required
    ? passed
      ? `找到 ${matchCount} 条使用“${constraint.instrument}”的轨道。`
      : `缺少必需乐器“${constraint.instrument}”；当前乐器：${list}。`
    : passed
      ? `未发现禁用乐器“${constraint.instrument}”；当前乐器：${list}。`
      : `发现 ${matchCount} 条使用禁用乐器“${constraint.instrument}”的轨道。`
  return {
    id: constraint.id,
    type: constraint.type,
    passed,
    actual: { instruments, matchCount },
    reason,
  }
}

function durationRule(
  project: Project,
  constraint: Extract<EvaluationConstraint, { type: 'duration_range' }>,
): EvaluationRuleResult {
  const durationSeconds = project.duration ?? 10
  const passed = withinRange(
    durationSeconds,
    constraint.minSeconds,
    constraint.maxSeconds,
  )
  const expected = rangeText(constraint.minSeconds, constraint.maxSeconds, ' 秒')
  return {
    id: constraint.id,
    type: constraint.type,
    passed,
    actual: { durationSeconds },
    reason: passed
      ? `工程时长为 ${formatNumber(durationSeconds)} 秒，满足${expected}的要求。`
      : `工程时长为 ${formatNumber(durationSeconds)} 秒，不满足${expected}的要求。`,
  }
}

function trackCountRule(
  project: Project,
  constraint: Extract<EvaluationConstraint, { type: 'track_count' }>,
): EvaluationRuleResult {
  const trackCount = project.tracks.length
  const passed = withinRange(trackCount, constraint.min, constraint.max)
  const expected = rangeText(constraint.min, constraint.max, ' 条')
  return {
    id: constraint.id,
    type: constraint.type,
    passed,
    actual: { trackCount },
    reason: passed
      ? `工程包含 ${trackCount} 条轨道，满足${expected}的要求。`
      : `工程包含 ${trackCount} 条轨道，不满足${expected}的要求。`,
  }
}

function densityRule(
  project: Project,
  constraint: Extract<EvaluationConstraint, { type: 'section_note_density' }>,
): EvaluationRuleResult {
  const allTrackIds = new Set(project.tracks.map((track) => track.id))
  const requestedTrackIds = constraint.trackIds
  const missingTrackIds = requestedTrackIds?.filter((id) => !allTrackIds.has(id)) ?? []
  const selectedTracks = requestedTrackIds === undefined
    ? project.tracks.filter((track) => track.kind === 'midi')
    : project.tracks.filter(
        (track) => requestedTrackIds.includes(track.id) && track.kind === 'midi',
      )
  const noteCount = selectedTracks.reduce(
    (count, track) => count + (track.notes ?? []).filter(
      (note) =>
        note.start >= constraint.startSeconds &&
        note.start < constraint.endSeconds,
    ).length,
    0,
  )
  const sectionDurationSeconds = constraint.endSeconds - constraint.startSeconds
  const notesPerSecond = noteCount / sectionDurationSeconds
  const densityInRange = withinRange(
    notesPerSecond,
    constraint.minNotesPerSecond,
    constraint.maxNotesPerSecond,
  )
  const passed = missingTrackIds.length === 0 && densityInRange
  const expected = rangeText(
    constraint.minNotesPerSecond,
    constraint.maxNotesPerSecond,
    ' 个起音/秒',
  )
  let reason: string
  if (missingTrackIds.length > 0) {
    reason = `无法评测段落密度：未找到轨道 ${missingTrackIds.join('、')}。`
  } else {
    const measured = `${noteCount} 个起音，${formatNumber(notesPerSecond)} 个起音/秒`
    reason = passed
      ? `${formatNumber(constraint.startSeconds)}–${formatNumber(constraint.endSeconds)} 秒内共有${measured}，满足${expected}的要求。`
      : `${formatNumber(constraint.startSeconds)}–${formatNumber(constraint.endSeconds)} 秒内共有${measured}，不满足${expected}的要求。`
  }
  return {
    id: constraint.id,
    type: constraint.type,
    passed,
    actual: {
      startSeconds: constraint.startSeconds,
      endSeconds: constraint.endSeconds,
      sectionDurationSeconds,
      noteCount,
      notesPerSecond,
      selectedTrackIds: selectedTracks.map((track) => track.id),
      missingTrackIds,
    },
    reason,
  }
}

function evaluateConstraint(
  project: Project,
  constraint: EvaluationConstraint,
): EvaluationRuleResult {
  switch (constraint.type) {
    case 'required_instrument':
    case 'forbidden_instrument':
      return instrumentRule(project, constraint)
    case 'duration_range':
      return durationRule(project, constraint)
    case 'track_count':
      return trackCountRule(project, constraint)
    case 'section_note_density':
      return densityRule(project, constraint)
  }
}

/** 纯确定性验收：不调用模型，不读取环境状态，也不生成时间戳。 */
export function evaluateProject(rawInput: EvaluateProjectInput): EvaluatorResult {
  const inputResult = evaluatorInputSchema.safeParse(rawInput)
  if (!inputResult.success) {
    return {
      ok: false,
      error: {
        code: 'invalid_evaluator_input',
        message: 'Evaluator 输入未通过校验。',
        issues: schemaIssues(inputResult.error),
      },
    }
  }

  const rules = inputResult.data.constraints.map((constraint) =>
    evaluateConstraint(inputResult.data.project, constraint),
  )
  const failedRuleIds = rules.filter((rule) => !rule.passed).map((rule) => rule.id)
  return {
    ok: true,
    report: evaluationReportSchema.parse({
      passed: failedRuleIds.length === 0,
      failedRuleIds,
      rules,
    }),
  }
}
