import { musicDirectionContext, type GameDefinition } from './gameDefinition.ts'
import type { Note } from './model.ts'

type MusicPromptInput = {
  title: string
  key: string
  tempo: number
  concept: string
  definition: GameDefinition
  notes: Note[]
}

/** 音乐生成接口的用户提示最多 1000 字符；游戏定义优先于冗长的音符列表。 */
export function buildMusicPrompt({ title, key, tempo, concept, definition, notes }: MusicPromptInput): string {
  const context = musicDirectionContext(definition).slice(0, 680)
  const noteSkeleton = notes.map(note => `${note.pitch}@${note.start.toFixed(2)}s`).join(', ').slice(0, 180)
  return [
    `标题：${title}`,
    `调性：${key}`,
    `速度：${tempo} BPM`,
    `概念：${concept}`,
    context,
    `音符骨架：${noteSkeleton || '暂无，先建立一个清晰动机'}`,
    '生成约 10 秒、可编辑的和弦与旋律工程；保留清晰动机，避免无意义的密集音符。',
  ].join('\n').slice(0, 1000)
}
