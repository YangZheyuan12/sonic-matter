import assert from 'node:assert/strict'
import test from 'node:test'
import { audioContextPrompt } from './audioContext.ts'

test('统一生成上下文包含游戏资料和理解结果', () => {
  const prompt = audioContextPrompt({
    title: '海底遗迹', tempo: 72, key: 'D minor', tracks: [],
    gameBrief: {
      title: '海底遗迹', genre: '探索解谜', gameplay: '潜入遗迹寻找失落的机关', world: '被潮汐覆盖的古文明遗址', references: [],
      scenes: [{ id: 'ruins', name: '沉没大厅', description: '空旷的石质空间', moods: ['神秘', '空旷'] }],
      events: [{ id: 'gate', name: '石门开启', description: '古老机关被启动', category: '机关' }],
    },
    gameAnalysis: {
      summary: '声音从材质进入隐藏的心理重量。', moods: ['神秘'], musicDirections: [], sfxDirections: [],
      recommendedInstruments: ['Cello'], recommendedMaterials: ['石材', '水下回声'], avoidDirections: ['过度明亮'],
    },
  })
  assert.match(prompt, /游戏类型：探索解谜/)
  assert.match(prompt, /场景：沉没大厅（神秘、空旷）/)
  assert.match(prompt, /游戏理解：声音从材质进入隐藏的心理重量。/)
  assert.match(prompt, /推荐材质：石材、水下回声/)
})

test('没有新上下文时仍然返回可用的默认提示', () => {
  const prompt = audioContextPrompt({ title: '旧工程', tempo: 92, key: 'C Major', tracks: [] })
  assert.match(prompt, /游戏名称：旧工程/)
  assert.match(prompt, /游戏类型：未指定/)
  assert.match(prompt, /游戏理解：未生成/)
})

test('上下文有长度上限，不会挤爆音乐生成请求', () => {
  const prompt = audioContextPrompt({
    title: '大型工程', tempo: 92, key: 'C Major', tracks: [],
    gameBrief: {
      title: '大型工程', genre: 'x'.repeat(120), gameplay: 'x'.repeat(2000), world: 'x'.repeat(2000), references: [],
      scenes: Array.from({ length: 32 }, (_, index) => ({ id: String(index), name: 'x'.repeat(120), description: 'x'.repeat(800), moods: ['x'.repeat(60)] })),
      events: Array.from({ length: 64 }, (_, index) => ({ id: String(index), name: 'x'.repeat(120), description: 'x'.repeat(800), category: 'x'.repeat(80) })),
    },
    gameAnalysis: { summary: 'x'.repeat(2000), moods: Array(16).fill('x'.repeat(60)), musicDirections: [], sfxDirections: [], recommendedInstruments: Array(32).fill('x'.repeat(80)), recommendedMaterials: Array(32).fill('x'.repeat(80)), avoidDirections: Array(24).fill('x'.repeat(160)) },
  })
  assert.ok(prompt.length <= 800)
})
