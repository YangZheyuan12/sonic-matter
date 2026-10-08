import assert from 'node:assert/strict'
import test from 'node:test'
import { definitionContext, emptyGameDefinition } from './gameDefinition.ts'
import { buildUnderstandingInput, fallbackConcepts, mapAgentConcepts } from './gameUnderstanding.ts'

test('游戏理解请求包含游戏资料和 Sound Direction，不把完整摘要塞进概念标题', () => {
  const definition = emptyGameDefinition()
  definition.brief = {
    title: '潮汐档案',
    genre: '叙事探索',
    coreLoop: '在退潮后的城市收集记忆',
    world: '被海水周期性淹没的近未来港口',
    playerExperience: '孤独、好奇，最后获得释然',
  }
  definition.sound = { mood: '温暖而怀旧', pace: '稳定推进', texture: '原声乐器与环境录音', avoid: '过度英雄化' }

  const input = buildUnderstandingInput(definition, '潮汐与遗忘')
  assert.equal(input.concept, '潮汐档案')
  assert.ok(input.context)
  assert.match(input.context, /核心玩法：在退潮后的城市收集记忆/)
  assert.match(input.context, /声音质感：原声乐器与环境录音/)
  assert.match(input.context, /补充焦点：潮汐与遗忘/)
  assert.ok(input.context.length <= 1200)
  assert.match(definitionContext(definition), /游戏名称：潮汐档案/)
})

test('缺少游戏名称时使用焦点作为概念，并限制概念字段长度', () => {
  const input = buildUnderstandingInput(emptyGameDefinition(), '潮汐'.repeat(60))
  assert.equal(input.concept.length, 80)
  assert.ok(input.context)
  assert.match(input.context, /核心情绪：克制而神秘/)
  assert.match(input.context, /补充焦点：潮汐/)
  assert.ok(input.context.length <= 1200)
})

test('本地 fallback 和 Agent 映射都提供三种视角与 10 秒故事弧线', () => {
  const fallback = fallbackConcepts('潮汐档案')
  assert.deepEqual(Object.keys(fallback), ['physical', 'psychological', 'climate'])
  const mapped = mapAgentConcepts('潮汐档案', [{
    id: 'physical',
    title: '潮汐的重量',
    summary: '潮水塑造了空间。',
    thesis: '每次退潮都留下新的边界。',
    story_arc: [
      { start: 0, end: 3, title: '涨潮', meaning: '水位上升。', musical_role: '低頻持續音' },
      { start: 3, end: 7, title: '停驻', meaning: '城市安静。', musical_role: '留白' },
      { start: 7, end: 10, title: '退去', meaning: '记忆浮现。', musical_role: '高频泛音' },
    ],
    music_mapping: { tempo: 68, key: 'D minor', density: .4, brightness: .5, tension: .6, instruments: ['cello'] },
  }])

  assert.equal(mapped.physical.story[0].time, '00—03')
  assert.equal(mapped.physical.story.length, 3)
  assert.equal(mapped.physical.musicMapping?.tempo, 68)
  assert.equal(mapped.psychological.title, fallback.psychological.title)
})
