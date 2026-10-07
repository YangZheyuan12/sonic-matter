import assert from 'node:assert/strict'
import test from 'node:test'
import { analysisFromInterpretations, createGameBriefDraft } from './gameBrief.ts'

test('游戏简介草稿包含可编辑的场景和事件', () => {
  const brief = createGameBriefDraft('海底遗迹')
  assert.equal(brief.title, '海底遗迹')
  assert.equal(brief.scenes[0].id, 'scene-1')
  assert.equal(brief.events[0].id, 'event-1')
})

test('概念解释可以整理成游戏理解结果并去重推荐乐器', () => {
  const analysis = analysisFromInterpretations('冰山', [
    { id: 'physical', title: '物理冰山', summary: '材质与重量', music_mapping: { instruments: ['Cello', 'Piano'] } },
    { id: 'psychological', title: '心理冰山', summary: '隐藏情绪', music_mapping: { instruments: ['Piano', 'Pad'] } },
  ])
  assert.match(analysis.summary, /冰山/)
  assert.deepEqual(analysis.recommendedInstruments, ['Cello', 'Piano', 'Pad'])
  assert.equal(analysis.sfxDirections.length, 2)
})
