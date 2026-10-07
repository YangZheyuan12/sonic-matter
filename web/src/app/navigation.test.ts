import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NAVIGATION_ITEMS } from './navigation.ts'

test('应用导航完整注册当前页面且页面标识不重复', () => {
  assert.deepEqual(
    NAVIGATION_ITEMS.map(item => item.page),
    ['explore', 'concept', 'studio', 'sound', 'settings'],
  )
  assert.equal(new Set(NAVIGATION_ITEMS.map(item => item.page)).size, NAVIGATION_ITEMS.length)
  assert.ok(NAVIGATION_ITEMS.every(item => item.label.trim().length > 0))
})
