import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyGameDefinition } from './gameDefinition.ts'
import { buildMusicPrompt } from './musicPrompt.ts'

test('音乐提示优先带入游戏定义，并控制在直接音乐接口上限内', () => {
  const definition = emptyGameDefinition()
  definition.brief.title = '潮汐档案'
  definition.brief.coreLoop = '在退潮后的城市收集记忆'
  definition.sound.mood = '克制而神秘'
  definition.sound.texture = '原声乐器与电子颗粒'
  const prompt = buildMusicPrompt({ title: '潮汐档案', key: 'C minor', tempo: 72, concept: '心理潮汐', definition, notes: Array.from({ length: 200 }, (_, index) => ({ id: `n${index}`, pitch: 60, start: index / 4, duration: .25, velocity: 90 })) })
  assert.ok(prompt.length <= 1000)
  assert.match(prompt, /游戏名称：潮汐档案/)
  assert.match(prompt, /核心玩法：在退潮后的城市收集记忆/)
  assert.match(prompt, /核心情绪：克制而神秘/)
  assert.match(prompt, /声音质感：原声乐器与电子颗粒/)
})
