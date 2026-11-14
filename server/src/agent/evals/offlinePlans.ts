import { agentPlanSchema, type AgentPlan } from '../planner.ts'
import type { AgentEvalCase, AgentEvalToolName } from './cases.ts'

type PlanStep = Readonly<{
  toolName: AgentEvalToolName
  arguments?: Readonly<Record<string, unknown>>
}>

const note = (id: string, pitch: number, start: number, duration = .35) => ({
  id,
  pitch,
  start,
  duration,
  velocity: 88,
})

const track = (
  id: string,
  name: string,
  instrument: string,
  notes: readonly ReturnType<typeof note>[] = [],
) => ({
  id,
  name,
  kind: 'midi' as const,
  instrument,
  color: '#7dd3fc',
  notes,
  gain: .8,
  pan: 0,
  muted: false,
  solo: false,
  start: 0,
})

function plan(evalCase: AgentEvalCase, steps: readonly PlanStep[]): AgentPlan {
  return agentPlanSchema.parse({
    goal: {
      userRequest: evalCase.instruction,
      desiredOutcome: `离线完成评测案例 ${evalCase.id}，并交给确定性 Evaluator 验收。`,
    },
    constraints: [{
      id: 'offline-step-budget',
      description: '固定离线计划最多执行八个工具步骤。',
      subject: 'runner.step_count',
      operator: 'less_than_or_equal',
      expected: 8,
    }],
    steps: steps.map((step, index) => ({
      id: `offline-step-${index + 1}`,
      objective: `执行固定离线步骤 ${index + 1}：${step.toolName}。`,
      toolName: step.toolName,
      arguments: step.arguments ?? {},
    })),
    acceptanceCriteria: [
      { id: 'tools-pass', description: '所有工具步骤成功。', check: 'all_steps_succeeded' },
      { id: 'constraints-pass', description: '全部确定性约束通过。', check: 'constraints_satisfied' },
      { id: 'approval-gate', description: '候选工程必须等待用户批准。', check: 'user_approval_required' },
    ],
  })
}

/**
 * 固定本地适配器相当于被冻结的“模型输出”。它只使用正式工具，既不读取环境变量，
 * 也不访问网络；更新模型或 Prompt 时，可以替换这个适配器并复用同一 Runner。
 */
export function createOfflineEvalPlan(evalCase: AgentEvalCase): AgentPlan | null {
  const plans: Readonly<Record<string, readonly PlanStep[]>> = {
    'create-01-cello-track': [{
      toolName: 'add_track',
      arguments: { track: track('cello', '低沉大提琴', 'Cello') },
    }],
    'create-02-bass-track': [{
      toolName: 'add_track',
      arguments: { track: track('bass', '电贝司', 'Electric Bass', [note('bass-1', 36, 0)]) },
    }],
    'create-03-drum-track': [{
      toolName: 'add_track',
      arguments: {
        track: track('drums', '鼓组', 'Drum Kit', [
          note('drums-1', 36, 0),
          note('drums-2', 42, .5),
          note('drums-3', 38, 1),
          note('drums-4', 42, 1.5),
        ]),
      },
    }],
    'create-04-melody-notes': [{
      toolName: 'replace_track_notes',
      arguments: {
        trackId: 'melody',
        notes: [
          note('melody-eval-1', 60, 0),
          note('melody-eval-2', 62, .5),
          note('melody-eval-3', 64, 1),
          note('melody-eval-4', 67, 1.5),
        ],
      },
    }],
    'create-05-pad-track': [{
      toolName: 'add_track',
      arguments: { track: track('pad', '氛围铺底', 'Warm Pad') },
    }],
    'modify-01-rename-track': [{
      toolName: 'update_track',
      arguments: { trackId: 'melody', update: { name: '冰层主旋律' } },
    }],
    // 这一例故意先只检查工程，由正式 Revision Planner 修复乐器约束。
    'modify-02-change-instrument': [{ toolName: 'inspect_project' }],
    'modify-03-mix-track': [{
      toolName: 'update_track',
      arguments: { trackId: 'melody', update: { gain: .6, pan: -.25 } },
    }],
    'modify-04-densify-notes': [{
      toolName: 'replace_track_notes',
      arguments: {
        trackId: 'melody',
        notes: [0, .3, .6, .9, 1.2, 1.5].map((start, index) =>
          note(`dense-${index + 1}`, 60 + index, start, .2)),
      },
    }],
    'modify-05-remove-track': [{
      toolName: 'remove_track',
      arguments: { trackId: 'pad' },
    }],
    'constraint-01-required-instrument': [{
      toolName: 'update_track',
      arguments: { trackId: 'melody', update: { instrument: 'Cello' } },
    }],
    'constraint-02-forbidden-instrument': [{
      toolName: 'remove_track',
      arguments: { trackId: 'synth' },
    }],
    'constraint-03-track-count': [
      { toolName: 'add_track', arguments: { track: track('bass', '贝司', 'Electric Bass') } },
      { toolName: 'add_track', arguments: { track: track('drums', '鼓组', 'Drum Kit') } },
    ],
    'constraint-04-section-density': [{
      toolName: 'replace_track_notes',
      arguments: {
        trackId: 'melody',
        notes: [2, 2.5, 3, 3.5].map((start, index) =>
          note(`section-${index + 1}`, 64 + index, start)),
      },
    }],
    'constraint-05-combined': [{
      toolName: 'add_track',
      arguments: { track: track('bass', '组合约束贝司', 'Electric Bass') },
    }],
  }

  const steps = plans[evalCase.id]
  return steps === undefined ? null : plan(evalCase, steps)
}
