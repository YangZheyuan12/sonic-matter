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

const list = (values: string[]) => values.length ? values.join(', ') : '未指定'

/** 项目级音效约束，供结构化计划与真实音频模型共用。 */
export function sfxDirectionPrompt(direction?: SoundDirectionInput): string {
  if (!direction) return '项目级音效方向：未配置，以用户描述和调音台参数为准。'
  return [
    '项目级音效方向：',
    `音效风格：${list(direction.sfxStyle)}`,
    `整体音乐风格：${list(direction.musicStyle)}`,
    `情绪参考：${list(direction.musicMood)}`,
    `氛围空间感：${direction.ambienceLevel}/100`,
    `参考 Demo：${list(direction.selectedDemos)}`,
    '保持音效与项目整体声音语言一致，但以用户当前描述为主要事件。',
  ].join('\n')
}

export function sfxGenerationDescription(description: string, direction?: SoundDirectionInput): string {
  return `${description}\n${sfxDirectionPrompt(direction)}`
}
