/** 用户提供的游戏信息，是 Agent 理解声音方向的输入。 */
export type SceneBrief = {
  id: string
  name: string
  description: string
  moods?: string[]
}

export type EventBrief = {
  id: string
  name: string
  description: string
  category?: string
}

export type GameBrief = {
  title: string
  genre: string
  gameplay: string
  world: string
  references: string[]
  scenes: SceneBrief[]
  events: EventBrief[]
}

export type MusicDirection = {
  id: string
  title: string
  summary: string
  moods: string[]
  suitableScenes: string[]
  recommendedInstruments: string[]
  demoIds?: string[]
}

export type SfxDirection = {
  id: string
  title: string
  summary: string
  tags: string[]
  demoIds?: string[]
}

export type GameAnalysis = {
  summary: string
  moods: string[]
  musicDirections: MusicDirection[]
  sfxDirections: SfxDirection[]
  recommendedInstruments: string[]
  recommendedMaterials: string[]
  avoidDirections: string[]
}
