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

test('Game Brief 概念稿包含分步简报、实时摘要与 Agent 建议', () => {
  const html = readConcept('game-brief.html')
  assert.match(html, /GAME DEFINITION/)
  assert.match(html, /核心玩法/)
  assert.match(html, /希望玩家获得的体验/)
  assert.match(html, /实时游戏摘要/)
  assert.match(html, /AGENT 提示/)
})

test('Sound Direction 概念稿包含真实方向字段与声音指纹', () => {
  const html = readConcept('sound-direction.html')
  assert.match(html, /核心情绪/)
  assert.match(html, /节奏倾向/)
  assert.match(html, /声音质感/)
  assert.match(html, /需要避免/)
  assert.match(html, /声音指纹/)
  assert.match(html, /三种创作视角/)
})

test('Music Studio 概念稿包含完整 DAW 工作区', () => {
  const html = readConcept('music-studio.html')
  assert.match(html, /音乐工作室/)
  assert.match(html, /编排时间线/)
  assert.match(html, /钢琴卷帘/)
  assert.match(html, /声音编排建议/)
  assert.match(html, /导出音频/)
})

test('SFX Lab 概念稿包含素材库、波形版本和语义混音器', () => {
  const html = readConcept('sfx-lab.html')
  assert.match(html, /声音素材库/)
  assert.match(html, /生成声音计划/)
  assert.match(html, /wave-stage/)
  assert.match(html, /V3 · 当前选择/)
  assert.match(html, /语义混音器/)
  assert.match(html, /加入当前工程/)
})

test('My 设置概念稿包含项目、外观、服务和存储状态', () => {
  const html = readConcept('my-settings.html')
  assert.match(html, /项目与创作环境/)
  assert.match(html, /最近工程/)
  assert.match(html, /外观预览/)
  assert.match(html, /服务状态/)
  assert.match(html, /存储与安全/)
  assert.match(html, /创作偏好/)
})
