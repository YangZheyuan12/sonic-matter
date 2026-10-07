import type { GameAnalysis, GameBrief } from './game.ts'

export type ConceptInterpretation = {
  id: 'physical' | 'psychological' | 'climate'
  title: string
  summary: string
  music_mapping?: { instruments: string[] }
}

export function createGameBriefDraft(title = '未命名游戏'): GameBrief {
  return {
    title,
    genre: '',
    gameplay: '',
    world: '',
    references: [],
    scenes: [{ id: 'scene-1', name: '主场景', description: '', moods: [] }],
    events: [{ id: 'event-1', name: '关键事件', description: '', category: '' }],
  }
}

/** 将现有概念 Agent 的三种解释保存为项目级游戏理解结果。 */
export function analysisFromInterpretations(word: string, interpretations: ConceptInterpretation[]): GameAnalysis {
  const musicDirections = interpretations.map(item => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    moods: [],
    suitableScenes: [],
    recommendedInstruments: item.music_mapping?.instruments ?? [],
  }))
  const recommendedInstruments = Array.from(new Set(interpretations.flatMap(item => item.music_mapping?.instruments ?? [])))
  return {
    summary: `围绕“${word}”形成 ${interpretations.length} 种声音理解。`,
    moods: [],
    musicDirections,
    sfxDirections: interpretations.map(item => ({ id: `${item.id}-sfx`, title: `${item.title} 音效`, summary: item.summary, tags: [] })),
    recommendedInstruments,
    recommendedMaterials: [],
    avoidDirections: [],
  }
}
