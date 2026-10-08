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

export const emptyGameDefinition = (): GameDefinition => ({
  brief: { title: '', genre: '', coreLoop: '', world: '', playerExperience: '' },
  sound: { mood: '克制而神秘', pace: '舒缓流动', texture: '有机与电子交织', avoid: '' },
})

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
