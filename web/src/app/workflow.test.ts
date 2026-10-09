import assert from 'node:assert/strict'
import test from 'node:test'
import { activeWorkflow, workflowItems } from './workflow.ts'

test('高保真工作流按开始、简报、方向、音乐和音效排列', () => {
  assert.deepEqual(workflowItems.map(item => item.label), ['开始', '游戏简报', '声音方向', '音乐工作室', '音效实验室'])
  assert.equal(new Set(workflowItems.map(item => item.id)).size, workflowItems.length)
})

test('游戏定义的两个步骤分别点亮简报和声音方向', () => {
  assert.equal(activeWorkflow('explore', 'brief'), 'start')
  assert.equal(activeWorkflow('concept', 'brief'), 'brief')
  assert.equal(activeWorkflow('concept', 'sound'), 'sound')
  assert.equal(activeWorkflow('studio', 'brief'), 'studio')
  assert.equal(activeWorkflow('sound', 'brief'), 'sfx')
  assert.equal(activeWorkflow('settings', 'brief'), null)
})

