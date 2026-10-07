import assert from 'node:assert/strict'
import test from 'node:test'
import { musicDirectionPrompt, toggleSoundDirectionChoice } from './sound.ts'

test('声音方向多选标签可以添加和取消，且不修改原数组', () => {
  const original = ['cinematic']
  assert.deepEqual(toggleSoundDirectionChoice(original, 'organic'), ['cinematic', 'organic'])
  assert.deepEqual(toggleSoundDirectionChoice(original, 'cinematic'), [])
  assert.deepEqual(original, ['cinematic'])
})

test('音乐生成上下文包含项目声音方向，未配置时也有默认约束', () => {
  const prompt = musicDirectionPrompt({
    musicStyle: ['cinematic'],
    musicMood: ['mysterious'],
    primaryInstruments: ['Piano'],
    secondaryInstruments: [],
    rhythmIntensity: 20,
    melodicDensity: 70,
    ambienceLevel: 85,
    sfxStyle: ['organic'],
    selectedDemos: [],
  })
  assert.match(prompt, /音乐风格：cinematic/)
  assert.match(prompt, /主要乐器：Piano/)
  assert.match(prompt, /旋律密度：70\/100/)
  assert.match(musicDirectionPrompt(), /声音方向：未配置/)
})
