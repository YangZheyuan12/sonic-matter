import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readConcept = (name: string) => readFileSync(new URL(`../../concepts/${name}`, import.meta.url), 'utf8')

test('首页概念稿保留品牌声场并提供主要创作入口', () => {
  const html = readConcept('home.html')
  assert.match(html, /SONIC \/ MATTER/)
  assert.match(html, /定义你的游戏/)
  assert.match(html, /与 Agent 迸发灵感/)
  assert.match(html, /sound-orbit/)
  assert.match(html, /最近工程/)
})

test('Music Studio 概念稿包含完整 DAW 工作区', () => {
  const html = readConcept('music-studio.html')
  assert.match(html, /音乐工作室/)
  assert.match(html, /编排时间线/)
  assert.match(html, /钢琴卷帘/)
  assert.match(html, /声音编排建议/)
  assert.match(html, /导出音频/)
})

