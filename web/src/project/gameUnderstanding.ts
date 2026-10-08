import type { Story } from './model.ts'
import { definitionContext, type GameDefinition } from './gameDefinition.ts'

export type ConceptId = 'physical' | 'psychological' | 'climate'
export type Concept = {
  title: string
  summary: string
  story: Story[]
  thesis?: string
  musicMapping?: { tempo: number; key: string; density: number; brightness: number; tension: number; instruments: string[] }
}

type Interpretation = {
  id: ConceptId
  title: string
  summary: string
  thesis: string
  story_arc: Array<{ start: number; end: number; title: string; meaning: string; musical_role: string }>
  music_mapping: Concept['musicMapping']
}

export function buildUnderstandingInput(definition: GameDefinition, focus: string) {
  const title = definition.brief.title.trim()
  const concept = (title || focus.trim() || '未命名游戏').slice(0, 80)
  const context = [definitionContext(definition), focus.trim() && focus.trim() !== title ? `补充焦点：${focus.trim()}` : '']
    .filter(Boolean)
    .join('\n')
    .slice(0, 1200)

  return context ? { concept, context } : { concept }
}

const formatTime = (start: number, end: number) => `${String(Math.round(start)).padStart(2, '0')}—${String(Math.round(end)).padStart(2, '0')}`

export function fallbackConcepts(word: string): Record<ConceptId, Concept> {
  return {
    physical: { title: `物理${word}`, summary: `从可观察的形态、材质和运动理解${word}。声音从表面开始，深入它的内部。`, story: [{ time: '00—03', title: '表面', text: '稀疏的高频像光落在它的轮廓上。', color: '#9ce7ff' }, { time: '03—07', title: '内部', text: '低沉长音慢慢浮现，显露隐藏的重量。', color: '#6aa9ff' }, { time: '07—10', title: '变化', text: '颗粒化的碎片让形态发生一次转折。', color: '#d8f5ff' }] },
    psychological: { title: `心理${word}`, summary: `从记忆、情绪和未被说出的部分理解${word}。`, story: [{ time: '00—03', title: '可见表面', text: '一条克制而留白的旋律保持距离。', color: '#d8f5ff' }, { time: '03—07', title: '水下意识', text: '大提琴与低频脉冲让隐藏的重量逐渐上浮。', color: '#a78bfa' }, { time: '07—10', title: '裂缝出现', text: '和声短暂失衡，真正的情绪穿透表面。', color: '#fb7185' }] },
    climate: { title: `生态${word}`, summary: `从时间、环境和人与世界的关系理解${word}。`, story: [{ time: '00—03', title: '古老平衡', text: '规整的呼吸节奏像漫长的地质时间。', color: '#b6f0e6' }, { time: '03—07', title: '扰动进入', text: '外部压力让节奏变得拥挤，系统开始变化。', color: '#ffd166' }, { time: '07—10', title: '留下回声', text: '主题逐渐稀释，只留下一个开放的提醒。', color: '#7dd3fc' }] },
  }
}

export function mapAgentConcepts(word: string, interpretations: Interpretation[]): Record<ConceptId, Concept> {
  const mapped = fallbackConcepts(word)
  for (const item of interpretations) mapped[item.id] = {
    title: item.title,
    summary: item.summary,
    thesis: item.thesis,
    story: item.story_arc.map(story => ({
      time: formatTime(story.start, story.end),
      title: story.title,
      text: `${story.meaning} ${story.musical_role}`,
      color: item.id === 'physical' ? '#9ce7ff' : item.id === 'psychological' ? '#a78bfa' : '#ffd166',
    })),
    musicMapping: item.music_mapping,
  }
  return mapped
}
