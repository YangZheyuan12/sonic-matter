import assert from 'node:assert/strict'
import test from 'node:test'
import { definitionSummary, emptyGameDefinition, gameBriefComplete, gameDefinitionComplete, seedDefinitionFromIdea, soundDirectionComplete } from './gameDefinition.ts'

test('空白定义带有可直接选择的声音方向，但游戏资料尚未完成', () => {
  const definition = emptyGameDefinition()
  assert.equal(gameBriefComplete(definition.brief), false)
  assert.equal(soundDirectionComplete(definition.sound), true)
  assert.equal(gameDefinitionComplete(definition), false)
})

test('游戏资料必须完整填写，纯空格不算完成', () => {
  const definition = emptyGameDefinition()
  definition.brief = {
    title: '潮汐档案',
    genre: '叙事探索',
    coreLoop: '在退潮后的城市收集记忆',
    world: '被海水周期性淹没的近未来港口',
    playerExperience: '孤独、好奇，最后获得释然',
  }
  assert.equal(gameBriefComplete(definition.brief), true)
  definition.brief.world = '   '
  assert.equal(gameBriefComplete(definition.brief), false)
})

test('完整定义可以整理为后续游戏理解使用的摘要', () => {
  const definition = emptyGameDefinition()
  definition.brief = {
    title: '潮汐档案',
    genre: '叙事探索游戏',
    coreLoop: '在退潮后的城市收集记忆',
    world: '被海水周期性淹没的港口',
    playerExperience: '从孤独走向释然',
  }
  assert.equal(gameDefinitionComplete(definition), true)
  assert.match(definitionSummary(definition), /潮汐档案/)
  assert.match(definitionSummary(definition), /克制而神秘/)
  assert.match(definitionSummary(definition), /有机与电子交织/)
})

test('首页灵感只预填空白世界设定，不覆盖用户已有资料', () => {
  const empty = emptyGameDefinition()
  const seeded = seedDefinitionFromIdea(empty, '一款关于潮汐与记忆的探索游戏')
  assert.equal(seeded.brief.world, '一款关于潮汐与记忆的探索游戏')
  assert.equal(empty.brief.world, '')
  assert.equal(seedDefinitionFromIdea(seeded, '另一条灵感'), seeded)
  assert.equal(seedDefinitionFromIdea(empty, '   '), empty)
})
