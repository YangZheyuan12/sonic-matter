export type GameBrief = {
  title: string
  genre: string
  coreLoop: string
  world: string
  playerExperience: string
}

export type SoundDirection = {
  mood: string
  pace: string
  texture: string
  avoid: string
}

export type GameDefinition = {
  brief: GameBrief
  sound: SoundDirection
}

export const GAME_DEFINITION_LIMITS = {
  title: 120,
  genre: 160,
  coreLoop: 1000,
  world: 1000,
  playerExperience: 1000,
  mood: 160,
  pace: 160,
  texture: 160,
  avoid: 1000,
} as const

export const emptyGameDefinition = (): GameDefinition => ({
  brief: { title: '', genre: '', coreLoop: '', world: '', playerExperience: '' },
  sound: { mood: '克制而神秘', pace: '舒缓流动', texture: '有机与电子交织', avoid: '' },
})

/** 旧工程可以没有定义；导入的残缺字段则补齐默认值并限制文本长度。 */
export function normalizeGameDefinition(value: unknown): GameDefinition | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as { brief?: unknown; sound?: unknown }
  const brief = input.brief && typeof input.brief === 'object' && !Array.isArray(input.brief)
    ? input.brief as Partial<GameBrief>
    : {}
  const sound = input.sound && typeof input.sound === 'object' && !Array.isArray(input.sound)
    ? input.sound as Partial<SoundDirection>
    : {}
  const defaults = emptyGameDefinition()
  const limit = (field: unknown, max: number, fallback: string) => typeof field === 'string' ? field.slice(0, max) : fallback
  return {
    brief: {
      title: limit(brief.title, GAME_DEFINITION_LIMITS.title, ''),
      genre: limit(brief.genre, GAME_DEFINITION_LIMITS.genre, ''),
      coreLoop: limit(brief.coreLoop, GAME_DEFINITION_LIMITS.coreLoop, ''),
      world: limit(brief.world, GAME_DEFINITION_LIMITS.world, ''),
      playerExperience: limit(brief.playerExperience, GAME_DEFINITION_LIMITS.playerExperience, ''),
    },
    sound: {
      mood: limit(sound.mood, GAME_DEFINITION_LIMITS.mood, defaults.sound.mood),
      pace: limit(sound.pace, GAME_DEFINITION_LIMITS.pace, defaults.sound.pace),
      texture: limit(sound.texture, GAME_DEFINITION_LIMITS.texture, defaults.sound.texture),
      avoid: limit(sound.avoid, GAME_DEFINITION_LIMITS.avoid, ''),
    },
  }
}

export const gameBriefComplete = (brief: GameBrief) => Boolean(
  brief.title.trim() && brief.genre.trim() && brief.coreLoop.trim() && brief.world.trim() && brief.playerExperience.trim(),
)

export const soundDirectionComplete = (sound: SoundDirection) => Boolean(
  sound.mood.trim() && sound.pace.trim() && sound.texture.trim(),
)

export const gameDefinitionComplete = (definition: GameDefinition) => (
  gameBriefComplete(definition.brief) && soundDirectionComplete(definition.sound)
)

export function seedDefinitionFromIdea(definition: GameDefinition, idea: string): GameDefinition {
  const prompt = idea.trim()
  if (!prompt || definition.brief.world.trim()) return definition
  return { ...definition, brief: { ...definition.brief, world: prompt } }
}

export const definitionSummary = (definition: GameDefinition) => {
  const { brief, sound } = definition
  return `${brief.title.trim()}是一款${brief.genre.trim()}。玩家会${brief.coreLoop.trim()}，世界设定为${brief.world.trim()}，核心体验是${brief.playerExperience.trim()}。声音应当${sound.mood.trim()}，以${sound.pace.trim()}的节奏和${sound.texture.trim()}的质感呈现。`
}

export const definitionContext = (definition: GameDefinition) => {
  const fields: Array<[string, string]> = [
    ['游戏名称', definition.brief.title],
    ['游戏类型', definition.brief.genre],
    ['核心玩法', definition.brief.coreLoop],
    ['世界设定', definition.brief.world],
    ['玩家体验', definition.brief.playerExperience],
    ['核心情绪', definition.sound.mood],
    ['节奏倾向', definition.sound.pace],
    ['声音质感', definition.sound.texture],
    ['需要避免', definition.sound.avoid],
  ]
  return fields.filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}：${value.trim()}`)
    .join('\n')
}

/** 音乐工作室使用的短上下文：保留玩法与声音方向，避免把整份工程 JSON 塞进用户提示。 */
export const musicDirectionContext = (definition: GameDefinition) => {
  const context = definitionContext(definition)
  return context ? `创作背景（游戏定义）：\n${context}` : '创作背景：尚未填写完整游戏定义，请先保留开放、可编辑的声音空间。'
}
