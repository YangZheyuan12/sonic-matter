import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMusicPlanPrompt, buildProjectEditPrompt } from './musicPrompt.ts'

const project = {
  title: '潮汐档案 · 结构草图', tempo: 72, key: 'C minor', tracks: [{ id: 'melody', name: '旋律', kind: 'midi' as const, instrument: 'Piano', color: '#fff', notes: [{ id: 'n1', pitch: 60, start: 0, duration: .5, velocity: 90 }] }],
  gameDefinition: {
    brief: { title: '潮汐档案', genre: '叙事探索', coreLoop: '在退潮后的城市收集记忆', world: '被海水周期性淹没的港口', playerExperience: '从孤独走向释然' },
    sound: { mood: '克制而神秘', pace: '舒缓流动', texture: '有机与电子交织', avoid: '过度英雄化' },
  },
}

test('音乐计划提示明确把游戏定义作为创作约束', () => {
  const prompt = buildMusicPlanPrompt(project, '生成一段留白充足的 BGM')
  assert.match(prompt, /游戏定义（优先创作约束）/)
  assert.match(prompt, /在退潮后的城市收集记忆/)
  assert.match(prompt, /克制而神秘/)
  assert.match(prompt, /生成一段留白充足的 BGM/)
})

test('工程编辑提示也携带游戏定义，旧工程则给出兼容说明', () => {
  assert.match(buildProjectEditPrompt(project, '加入低沉的脉冲'), /过度英雄化/)
  const { gameDefinition: _ignored, ...legacy } = project
  assert.match(buildProjectEditPrompt(legacy, '保留现有动机'), /没有游戏定义/)
})
