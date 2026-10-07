import assert from 'node:assert/strict'
import test from 'node:test'
import { toggleSoundDirectionChoice } from './sound.ts'

test('声音方向多选标签可以添加和取消，且不修改原数组', () => {
  const original = ['cinematic']
  assert.deepEqual(toggleSoundDirectionChoice(original, 'organic'), ['cinematic', 'organic'])
  assert.deepEqual(toggleSoundDirectionChoice(original, 'cinematic'), [])
  assert.deepEqual(original, ['cinematic'])
})
