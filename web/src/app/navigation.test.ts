import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NAVIGATION_ITEMS } from './navigation.ts'

test('应用导航完整注册当前页面且页面标识不重复', () => {
  assert.deepEqual(
    NAVIGATION_ITEMS.map(item => item.page),
    ['brief', 'direction', 'studio', 'sfx', 'my'],
  )
  assert.equal(new Set(NAVIGATION_ITEMS.map(item => item.page)).size, NAVIGATION_ITEMS.length)
  assert.ok(NAVIGATION_ITEMS.every(item => item.label.trim().length > 0))
})

test('产品导航使用新的五个工作区名称', () => {
  assert.deepEqual(NAVIGATION_ITEMS.map(item => item.label), ['Game Brief', 'Sound Direction', 'Music Studio', 'SFX Lab', 'My'])
})
