import type { z } from 'zod'
import { projectSchema } from './projectSchema.ts'

type MusicProject = z.infer<typeof projectSchema>

export function buildProjectEditPrompt(project: MusicProject, instruction: string): string {
  return [
    '你是音乐工程编辑 Agent。只根据用户指令提出安全、可执行的工程操作。',
    '优先返回 update_project、update_track 或 add_track；不要删除轨道，不要生成不可编辑的二进制音频。',
    project.gameDefinition ? `游戏定义（必须尊重）：${JSON.stringify(project.gameDefinition)}` : '当前工程没有游戏定义，请根据现有工程和用户指令保持开放。',
    `当前工程 JSON：${JSON.stringify(project)}`,
    `用户指令：${instruction}`,
  ].join('\n')
}

export function buildMusicPlanPrompt(project: MusicProject, prompt: string): string {
  return [
    '你是可编辑音乐工程 Agent。请把用户的音乐意图转换为一个 10 秒左右、可编辑的 MIDI/和弦 Project JSON。',
    '只输出结构化 JSON，不要 Markdown，不要音频 URL，不要二进制音频。',
    '至少生成一条 MIDI 轨道；可以生成旋律、和弦、低音或打击乐轨道。每个音符都必须包含 pitch、start、duration、velocity。',
    '请保持音高在 MIDI 0-127，时间不超过 duration，避免不必要的密集重叠。和弦请用同一时间起始的多个音符表达。',
    project.gameDefinition ? `游戏定义（优先创作约束）：${JSON.stringify(project.gameDefinition)}` : '当前工程没有游戏定义，请从现有工程提炼音乐方向。',
    `当前工程：${JSON.stringify(project)}`,
    `用户意图：${prompt}`,
  ].join('\n')
}
