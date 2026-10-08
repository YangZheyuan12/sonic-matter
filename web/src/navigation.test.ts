import assert from 'node:assert/strict'
import test from 'node:test'
import { homeActions, myPage, primaryNavigation } from './navigation.ts'

test('主导航只有四个创作区域，“我的”不占用主导航位置', () => {
  assert.deepEqual(primaryNavigation, [
    { page: 'explore', label: '首页' },
    { page: 'concept', label: '定义你的游戏' },
    { page: 'studio', label: '音乐工作室' },
    { page: 'sound', label: '音效实验室' },
  ])
  assert.equal(primaryNavigation.some(item => item.page === myPage), false)
  assert.equal(myPage, 'settings')
})

test('主导航页面互不重复，且不会包含“我的”设置页', () => {
  const pages: string[] = primaryNavigation.map(item => item.page)
  assert.equal(new Set(pages).size, pages.length)
  assert.equal(pages.includes('settings'), false)
})

test('首页保留两个明确的主入口', () => {
  assert.deepEqual(homeActions, {
    define: '定义你的游戏',
    brainstorm: '对话迸发灵感',
  })
})
