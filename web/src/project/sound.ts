/** 已确认的声音方向，随 Project 保存并影响后续音乐 / 音效生成。 */
export type SoundDirection = {
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

/** 多选标签统一使用这个纯函数，保证取消选择和重复点击行为一致。 */
export function toggleSoundDirectionChoice(values: string[], choice: string): string[] {
  return values.includes(choice) ? values.filter(value => value !== choice) : [...values, choice]
}

/** 把项目级声音偏好转成生成模型可以直接理解的上下文。 */
export function musicDirectionPrompt(direction?: SoundDirection): string {
  if (!direction) return '声音方向：未配置，请基于当前概念和音符骨架保持克制、可编辑的默认音乐方向。'
  const list = (values: string[]) => values.length ? values.join(', ') : '未指定'
  return [
    '项目级声音方向：',
    `音乐风格：${list(direction.musicStyle)}`,
    `情绪：${list(direction.musicMood)}`,
    `主要乐器：${list(direction.primaryInstruments)}`,
    `辅助乐器：${list(direction.secondaryInstruments)}`,
    `节奏强度：${direction.rhythmIntensity}/100`,
    `旋律密度：${direction.melodicDensity}/100`,
    `氛围空间感：${direction.ambienceLevel}/100`,
    `音效风格参考：${list(direction.sfxStyle)}`,
    '请把这些偏好作为创作约束，保持音乐可编辑，并避免与当前概念冲突。',
  ].join('\n')
}

/** 试听素材只作为选择参考，不属于任何一个 Project。 */
export type DemoClip = {
  id: string
  name: string
  category: 'music-style' | 'instrument' | 'sfx-style'
  url: string
  duration: number
  tags: string[]
  description: string
}
