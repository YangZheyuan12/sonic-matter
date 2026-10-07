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
