export type SoundDirectionInput = {
  musicStyle: string[]
  musicMood: string[]
  primaryInstruments: string[]
  secondaryInstruments: string[]
  rhythmIntensity: number
  melodicDensity: number
  ambienceLevel: number
  sfxStyle: string[]
  selectedDemos: string[]
}

export type GameBriefInput = {
  title: string
  genre: string
  gameplay: string
  world: string
  references: string[]
  scenes: Array<{ name: string; description: string; moods?: string[] }>
  events: Array<{ name: string; description: string; category?: string }>
}

export type GameAnalysisInput = {
  summary: string
  moods: string[]
  musicDirections: Array<{ title: string; summary: string; recommendedInstruments: string[] }>
  sfxDirections: Array<{ title: string; summary: string; tags: string[] }>
  recommendedInstruments: string[]
  recommendedMaterials: string[]
  avoidDirections: string[]
}

export type GameAudioContext = {
  gameBrief?: GameBriefInput
  gameAnalysis?: GameAnalysisInput
}

const list = (values: string[]) => values.length ? values.join(', ') : '未指定'
const compact = (value: string | undefined, max: number) => (value ?? '').trim().slice(0, max)

/** 将 Game Brief 与 Game Analysis 压缩成音效模型可复用的项目语境。 */
export function gameAudioContextPrompt(context?: GameAudioContext): string {
  const brief = context?.gameBrief
  const analysis = context?.gameAnalysis
  const scenes = brief?.scenes.slice(0, 3).map(scene => `${compact(scene.name, 40)}${scene.moods?.length ? ` (${list(scene.moods.slice(0, 3))})` : ''}`).filter(Boolean).join(', ')
  const events = brief?.events.slice(0, 3).map(event => `${compact(event.name, 40)}${event.category ? ` (${compact(event.category, 30)})` : ''}`).filter(Boolean).join(', ')
  return [
    '游戏创作上下文：',
    `游戏名称：${compact(brief?.title, 80) || '未指定'}`,
    `游戏类型：${compact(brief?.genre, 80) || '未指定'}`,
    `核心玩法：${compact(brief?.gameplay, 180) || '未指定'}`,
    `世界观：${compact(brief?.world, 180) || '未指定'}`,
    `场景：${scenes || '未指定'}`,
    `关键事件：${events || '未指定'}`,
    `游戏理解：${compact(analysis?.summary, 180) || '未生成'}`,
    `情绪：${list(analysis?.moods?.slice(0, 5) ?? [])}`,
    `推荐材质：${list(analysis?.recommendedMaterials?.slice(0, 6) ?? [])}`,
    `避免方向：${list(analysis?.avoidDirections?.slice(0, 3) ?? [])}`,
  ].join('\n')
}

/** 项目级音效约束，供结构化计划与真实音频模型共用。 */
export function sfxDirectionPrompt(direction?: SoundDirectionInput, context?: GameAudioContext): string {
  return [
    direction ? [
      '项目级音效方向：',
      `音效风格：${list(direction.sfxStyle)}`,
      `整体音乐风格：${list(direction.musicStyle)}`,
      `情绪参考：${list(direction.musicMood)}`,
      `氛围空间感：${direction.ambienceLevel}/100`,
      `参考 Demo：${list(direction.selectedDemos)}`,
      '保持音效与项目整体声音语言一致，但以用户当前描述为主要事件。',
    ].join('\n') : '项目级音效方向：未配置，以用户描述和调音台参数为准。',
    gameAudioContextPrompt(context),
  ].join('\n')
}

export function sfxGenerationDescription(description: string, direction?: SoundDirectionInput, context?: GameAudioContext): string {
  return `${description}\n${sfxDirectionPrompt(direction, context)}`
}
