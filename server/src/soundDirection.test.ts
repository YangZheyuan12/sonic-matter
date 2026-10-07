import assert from 'node:assert/strict'
import test from 'node:test'
import { sfxDirectionPrompt, sfxGenerationDescription } from './soundDirection.ts'

const direction = {
  musicStyle: ['ambient'], musicMood: ['mysterious'], primaryInstruments: ['Piano'], secondaryInstruments: [],
  rhythmIntensity: 20, melodicDensity: 30, ambienceLevel: 85, sfxStyle: ['organic', 'cinematic'], selectedDemos: ['underwater ruins'],
}
const context = {
  gameBrief: {
    title: '海底遗迹', genre: '探索解谜', gameplay: '潜入遗迹寻找机关', world: '被潮汐覆盖的古文明', references: [],
    scenes: [{ name: '沉没大厅', description: '空旷石质空间', moods: ['神秘'] }],
    events: [{ name: '石门开启', description: '古老机关启动', category: '机关' }],
  },
  gameAnalysis: {
    summary: '从材质进入隐藏的心理重量。', moods: ['神秘'], musicDirections: [], sfxDirections: [],
    recommendedInstruments: ['Cello'], recommendedMaterials: ['石材', '水下回声'], avoidDirections: ['过度明亮'],
  },
}

test('音效方向上下文包含风格、情绪、空间感和参考 Demo', () => {
  const prompt = sfxDirectionPrompt(direction)
  assert.match(prompt, /音效风格：organic, cinematic/)
  assert.match(prompt, /情绪参考：mysterious/)
  assert.match(prompt, /氛围空间感：85\/100/)
  assert.match(prompt, /参考 Demo：underwater ruins/)
})

test('真实音效描述保留用户事件，并兼容未配置方向的旧请求', () => {
  assert.match(sfxGenerationDescription('石门缓慢开启', direction, context), /^石门缓慢开启/)
  assert.match(sfxGenerationDescription('石门缓慢开启', direction, context), /游戏类型：探索解谜/)
  assert.match(sfxGenerationDescription('石门缓慢开启'), /项目级音效方向：未配置/)
})
